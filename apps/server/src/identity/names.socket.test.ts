import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { NAME_DEV_ADDRESS } from "@project/shared";
import { WorldServer } from "../WorldServer.js";
import { NameRegistry } from "./nameRegistry.js";
import { DevNameScanner } from "./nameScanner.js";
import { MemoryNameStore } from "./nameStore.js";
import { NameService } from "./nameService.js";
import { testNameKey } from "./testKeys.js";

/**
 * Owned names (ADR-016) through real sockets: a holder reserves, the dev registry confirms, everyone gets the
 * nickname_updated broadcast; guests are refused; set_nickname is off while a registry runs; a name confirmed or
 * claimed before join is the join's name; a returning player claims without paying; the dev mode refuses
 * NODE_ENV=production.
 */

type Message = Record<string, unknown>;

interface Client {
  messages: Message[];
  send(message: Message): void;
  waitFor(predicate: (m: Message) => boolean, timeoutMs?: number): Promise<Message>;
  close(): void;
}

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: Message[] = [];
  const waiters: { predicate: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data as string) as Message;
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
  return {
    messages,
    send: (message) => socket.send(JSON.stringify(message)),
    waitFor: (predicate, timeoutMs = 4000) => {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), timeoutMs);
        waiters.push({ predicate, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
    close: () => socket.close(),
  };
}

async function start(mode: "dev" | "off" = "dev") {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const registry = new NameRegistry({ now: Date.now, store: new MemoryNameStore(), address: NAME_DEV_ADDRESS, feeZat: 1_000_000, minConfirmations: 1 });
  const names = mode === "dev" ? new NameService({ mode: "dev", registry, scanner: new DevNameScanner(Date.now, 200) }) : NameService.off();
  const world = new WorldServer(wss, { names });
  const clients: Client[] = [];
  return {
    port,
    world,
    registry,
    client: async () => {
      const client = await connect(port);
      clients.push(client);
      return client;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) client.close();
        world.dispose();
        wss.close(() => resolve());
      }),
  };
}

const isStatus = (status: string) => (m: Message) => m.type === "name_status" && m.status === status;

test("a holder reserves, the dev registry confirms (pending → seen → confirmed), and everyone gets nickname_updated", async () => {
  const server = await start();
  try {
    const ana = await server.client();
    ana.send({ type: "join", wallet: true, nickname: "Nadia" });
    const welcome = await ana.waitFor((m) => m.type === "welcome");
    assert.match(String(welcome.nickname), /^Guest-\d{4}$/, "a requested name alone is not granted while a registry runs");
    const ben = await server.client();
    ben.send({ type: "join" });
    await ben.waitFor((m) => m.type === "welcome");

    const key = await testNameKey();
    ana.send({ type: "name_reserve", nickname: "Nadia", keyHash: key.keyHash });
    const quote = await ana.waitFor((m) => m.type === "name_quote");
    assert.equal(quote.address, NAME_DEV_ADDRESS);
    assert.equal(quote.amountZat, 1_000_000);
    assert.match(String(quote.memo), new RegExp(`^zw-name:v1:[0-9a-f]{32}:${key.keyHash.slice(0, 16)}$`));
    await ana.waitFor(isStatus("pending"));
    await ana.waitFor(isStatus("seen"));
    const confirmed = await ana.waitFor(isStatus("confirmed"));
    assert.equal(confirmed.reservationId, quote.reservationId);
    const update = await ben.waitFor((m) => m.type === "nickname_updated");
    assert.deepEqual(update, { type: "nickname_updated", playerId: welcome.playerId, nickname: "Nadia" });
    await ana.waitFor((m) => m.type === "nickname_updated" && m.nickname === "Nadia");
    // Owner-only: Ben never saw the quote, the memo or any name_status.
    assert.equal(ben.messages.some((m) => m.type === "name_quote" || m.type === "name_status"), false);
    // Registered now: taken for everyone else.
    ben.send({ type: "nickname_check", nickname: "nadia" });
    assert.equal((await ben.waitFor((m) => m.type === "nickname_check_result")).status, "taken");
  } finally {
    await server.stop();
  }
});

test("guests are refused (disabled); set_nickname is ignored for holders while a registry runs; a second key gets taken", async () => {
  const server = await start();
  try {
    const guest = await server.client();
    guest.send({ type: "join" });
    await guest.waitFor((m) => m.type === "welcome");
    guest.send({ type: "name_reserve", nickname: "Guesty", keyHash: "a".repeat(64) });
    assert.deepEqual(await guest.waitFor((m) => m.type === "name_status"), { type: "name_status", status: "disabled", nickname: "Guesty" });
    guest.send({ type: "name_claim_request", nickname: "Guesty" });
    assert.equal((await guest.waitFor((m) => m.type === "name_status" && m !== guest.messages.find((x) => x.type === "name_status"))).status, "disabled");

    const holder = await server.client();
    holder.send({ type: "join", wallet: true });
    const welcome = await holder.waitFor((m) => m.type === "welcome");
    holder.send({ type: "set_nickname", nickname: "Freebie" });
    holder.send({ type: "name_reserve", nickname: "Zed", keyHash: "b".repeat(64) });
    await holder.waitFor((m) => m.type === "name_quote");
    const rival = await server.client();
    rival.send({ type: "name_reserve", nickname: "ZED", keyHash: "c".repeat(64) });
    assert.equal((await rival.waitFor((m) => m.type === "name_status")).status, "taken");
    await holder.waitFor(isStatus("confirmed"));
    const updates = holder.messages.filter((m) => m.type === "nickname_updated" && m.playerId === welcome.playerId);
    assert.deepEqual(updates.map((m) => m.nickname), ["Zed"], "Freebie was never applied");
  } finally {
    await server.stop();
  }
});

test("before join: a name confirmed during onboarding is the join's name; the faucet can resolve the pending reservation", async () => {
  const server = await start();
  try {
    const player = await server.client();
    const key = await testNameKey();
    player.send({ type: "name_reserve", nickname: "Onboarder", keyHash: key.keyHash });
    const quote = await player.waitFor((m) => m.type === "name_quote");
    const sessionId = server.world.resolveNameReservationSession(String(quote.reservationId));
    assert.ok(sessionId, "a pending reservation proves a live connection to the faucet");
    assert.equal(server.world.resolveNameReservationSession("x".repeat(22)), null);
    await player.waitFor(isStatus("confirmed"));
    assert.equal(player.messages.some((m) => m.type === "nickname_updated"), false, "nobody sees a player before join");
    player.send({ type: "join", wallet: true, avatar: { model: "mage", color: 2 } });
    const welcome = await player.waitFor((m) => m.type === "welcome");
    assert.equal(welcome.nickname, "Onboarder");
    assert.equal(welcome.playerId, sessionId);
    assert.deepEqual(server.registry.record("onboarder")?.avatar, { model: "mage", color: 2 }, "the record remembers the look");
  } finally {
    await server.stop();
  }
});

test("a returning player claims its name with the key — no payment — and joins with it; a bad proof fails", async () => {
  const server = await start();
  try {
    const key = await testNameKey();
    const first = await server.client();
    first.send({ type: "name_reserve", nickname: "Returner", keyHash: key.keyHash });
    await first.waitFor(isStatus("confirmed"));
    first.close();

    const stranger = await server.client();
    stranger.send({ type: "name_claim_request", nickname: "Returner" });
    const strangerChallenge = await stranger.waitFor((m) => m.type === "name_challenge");
    const imposter = await testNameKey();
    stranger.send(await imposter.proof(String(strangerChallenge.nonce), "Returner"));
    assert.deepEqual(await stranger.waitFor((m) => m.type === "name_status"), { type: "name_status", status: "failed", nickname: "Returner" });

    const back = await server.client();
    back.send({ type: "name_claim_request", nickname: "returner" });
    const challenge = await back.waitFor((m) => m.type === "name_challenge");
    assert.equal(challenge.nickname, "returner");
    back.send(await key.proof(String(challenge.nonce), "returner"));
    assert.deepEqual(await back.waitFor((m) => m.type === "name_status"), { type: "name_status", status: "confirmed", nickname: "Returner" });
    back.send({ type: "join", wallet: true });
    assert.equal((await back.waitFor((m) => m.type === "welcome")).nickname, "Returner");
    assert.equal(back.messages.some((m) => m.type === "name_quote"), false, "never quoted: nothing to pay");
  } finally {
    await server.stop();
  }
});

test("the owner's newest session takes the name over from its older one (which becomes a guest name)", async () => {
  const server = await start();
  try {
    const key = await testNameKey();
    const tab1 = await server.client();
    tab1.send({ type: "join", wallet: true });
    const w1 = await tab1.waitFor((m) => m.type === "welcome");
    tab1.send({ type: "name_reserve", nickname: "Twice", keyHash: key.keyHash });
    await tab1.waitFor((m) => m.type === "nickname_updated" && m.nickname === "Twice");
    const tab2 = await server.client();
    tab2.send({ type: "join", wallet: true });
    const w2 = await tab2.waitFor((m) => m.type === "welcome");
    tab2.send({ type: "name_claim_request", nickname: "Twice" });
    const challenge = await tab2.waitFor((m) => m.type === "name_challenge");
    tab2.send(await key.proof(String(challenge.nonce), "Twice"));
    await tab2.waitFor((m) => m.type === "nickname_updated" && m.playerId === w2.playerId && m.nickname === "Twice");
    const bumped = await tab2.waitFor((m) => m.type === "nickname_updated" && m.playerId === w1.playerId);
    assert.match(String(bumped.nickname), /^Guest-\d{4}$/);
  } finally {
    await server.stop();
  }
});

test("without a registry (NAME_REGISTRY=off) name requests are disabled and holders keep set_nickname (ADR-015 honour mode)", async () => {
  const server = await start("off");
  try {
    const holder = await server.client();
    holder.send({ type: "join", wallet: true, nickname: "Honour" });
    assert.equal((await holder.waitFor((m) => m.type === "welcome")).nickname, "Honour");
    holder.send({ type: "name_reserve", nickname: "Paid", keyHash: "a".repeat(64) });
    assert.equal((await holder.waitFor((m) => m.type === "name_status")).status, "disabled");
    holder.send({ type: "set_nickname", nickname: "Renamed" });
    assert.equal((await holder.waitFor((m) => m.type === "nickname_updated")).nickname, "Renamed");
    assert.deepEqual(server.world.nameInfo, { mode: "off", feeZat: 0 });
  } finally {
    await server.stop();
  }
});

test("the server refuses to start with NAME_REGISTRY=dev and NODE_ENV=production", () => {
  const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serverDir,
    env: { ...process.env, NODE_ENV: "production", NAME_REGISTRY: "dev", ALLOWED_ORIGINS: "https://play.example.org", PORT: "0", LIGHTWALLETD_URL: "off" },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to start: NAME_REGISTRY=dev/);
});
