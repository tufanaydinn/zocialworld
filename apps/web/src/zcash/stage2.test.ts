import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { isTexAddress, texAddressNetwork } from "./texAddress.ts";
import { isSqliteWalletSave, readStage1Accounts, stage1SaveBirthday } from "./stage1Save.ts";
import { MIGRATION_PROGRESS_CAP, formatElapsed, migrationProgress } from "./migrationProgress.ts";
import { walletErrorMessage } from "./engineErrors.ts";

/**
 * ADR-018 § 3 (Stage 2) — the client on the Stage 2 "Ironwood" engine:
 *  - TEX (ZIP 320) addresses are validated for real (bech32m checksum, 20-byte payload, network HRP) against
 *    known-good test addresses;
 *  - address kinds: TEX is its own kind (a withdrawal only, never "shielded");
 *  - the adapter follows the Stage 2 engine API: per-pool balances (shielded = Ironwood + Sapling + legacy Orchard), the five addresses;
 *  - the Stage-1 save: its birthday is read from the protobuf dump of the memory backend; a SQLite (Stage-2) save is told
 *    apart; damaged bytes give null;
 *  - the MIGRATION: a Stage-1 save makes the engine throw `wallet_format_unsupported`; unlock restores the wallet from the
 *    encrypted seed + the birthday (stored, else read from the save, else asked as a date — never the seed), runs the
 *    rescan, refuses sends meanwhile, keeps the Stage-1 save until the rescanned wallet replaces it, and remembers the
 *    birthday;
 *  - the estimated progress of that rescan.
 */

if (typeof localStorage === "undefined") {
  const store: Record<string, string> = {};
  (global as any).localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => void (store[key] = value),
    removeItem: (key: string) => void delete store[key],
    clear: () => {
      for (const key in store) delete store[key];
    },
  };
}

/**
 * Test addresses of a regtest-only key (never funded): one TEX address per network and a mainnet Orchard-only
 * Unified Address. Only their encodings matter here.
 */
const ADDRESSES: Record<"main" | "test" | "regtest", { tex: string; orchardOnlyUa: string }> = {
  main: { tex: "tex1qsxle9gn7xt26cmzqvs0xaj6mpdc6a6cnw4jse", orchardOnlyUa: "u1zk72nlz2j200yhhlhtyaxkuzyfc0n4nns3p8kcu5e6sq0cv0wce9upf6lz33fhgguxl28nt4u38003ha4t2yzvdwr4c05kfmhsjkxrwz" },
  test: { tex: "textest1ptc8z4ca3x2t2cnl97a3as9vaj4hfru5cqzdh0", orchardOnlyUa: "utest1wqmr0th06au8p8uama6ztzhqj5sf4samv58u6c8za8532hnrcw3v8haxljej472dp39d7ulzy4kewm77k82w0aznghz0vdu7m5h6dg2k" },
  regtest: { tex: "texregtest1ptc8z4ca3x2t2cnl97a3as9vaj4hfru5jkjncm", orchardOnlyUa: "uregtest1cez9jrf5jlulchz4wnqsszm9recdey22l3jku2uezkjz6rcj20ly87284kh96hralwqwcf7gjx2sufj3es7kker02dpgu50dzvjjlj5l" },
};

// ------------------------------------------------------------------ TEX addresses and address kinds

describe("TEX addresses (ZIP 320): a real bech32m check", () => {
  it("accepts valid TEX addresses with their network", () => {
    assert.equal(texAddressNetwork(ADDRESSES.main.tex), "main");
    assert.equal(texAddressNetwork(ADDRESSES.test.tex), "test");
    assert.equal(texAddressNetwork(ADDRESSES.regtest.tex), "regtest");
    assert.equal(texAddressNetwork(`  ${ADDRESSES.main.tex}  `), "main", "surrounding spaces are trimmed");
    assert.equal(texAddressNetwork(ADDRESSES.main.tex.toUpperCase()), "main", "all upper case is valid bech32");
  });

  it("refuses a changed character, a mixed-case, truncated or extended address, and non-TEX addresses", () => {
    const tex = ADDRESSES.main.tex;
    const flipped = tex.slice(0, 10) + (tex[10] === "q" ? "p" : "q") + tex.slice(11);
    assert.equal(isTexAddress(flipped), false, "checksum");
    assert.equal(isTexAddress(tex.slice(0, -1)), false, "truncated");
    assert.equal(isTexAddress(tex + "q"), false, "extended");
    assert.equal(isTexAddress(tex.slice(0, 6) + tex.slice(6).toUpperCase()), false, "mixed case");
    assert.equal(isTexAddress(tex.replace(/^tex1/, "tez1")), false, "unknown HRP");
    assert.equal(isTexAddress("t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU"), false);
    assert.equal(isTexAddress(ADDRESSES.main.orchardOnlyUa), false);
    assert.equal(isTexAddress("tex1"), false);
    assert.equal(isTexAddress(""), false);
  });

  it("detectAddressKind: TEX is its own kind — not shielded, valid with a public-amount note", async () => {
    const { detectAddressKind, isShieldedKind, validateAddress } = await import("./core/wallet-types.ts");
    assert.equal(detectAddressKind(ADDRESSES.main.tex), "tex");
    assert.equal(isShieldedKind("tex"), false);
    const v = validateAddress(ADDRESSES.main.tex);
    assert.equal(v.ok, true);
    assert.match(v.message ?? "", /public/);
    assert.equal(detectAddressKind(ADDRESSES.main.orchardOnlyUa), "unified", "an Orchard-only u1 is a unified address");
    assert.equal(detectAddressKind("t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU"), "transparent");
    // A broken TEX is not mistaken for anything payable.
    assert.equal(validateAddress(ADDRESSES.main.tex.slice(0, -1)).ok, false);
  });

  it("the withdraw form's live hint: t1/t3/tm are transparent, tex1… is TEX, shielded addresses make nothing public", async () => {
    const { publicAddressInput } = await import("./WalletPanel.ts");
    assert.equal(publicAddressInput(ADDRESSES.main.tex), "tex");
    assert.equal(publicAddressInput("TEX1abc"), "tex", "while typing, any case");
    assert.equal(publicAddressInput(ADDRESSES.test.tex), "tex");
    assert.equal(publicAddressInput(" t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU"), "transparent");
    assert.equal(publicAddressInput("t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd"), "transparent");
    assert.equal(publicAddressInput(ADDRESSES.main.orchardOnlyUa), null);
    assert.equal(publicAddressInput("zs1" + "q".repeat(75)), null);
  });

  it("engine error sentences follow Stage 2: TEX in the transparent rule, the retired codes still mapped, the new codes", () => {
    assert.match(walletErrorMessage({ code: "recipient_transparent_not_allowed" }), /TEX \(tex1…\)/);
    assert.match(walletErrorMessage({ code: "memo_not_allowed" }), /TEX/);
    assert.doesNotMatch(walletErrorMessage({ code: "recipient_unsupported" }), /TEX/, "TEX is payable (as a withdrawal) now");
    assert.match(walletErrorMessage({ code: "pool_policy_violation" }), /Nothing was sent/);
    assert.match(walletErrorMessage({ code: "wallet_migrating" }), /one-time rescan/);
    assert.match(walletErrorMessage({ code: "migration_birthday_unknown" }), /month and year/);
    assert.match(walletErrorMessage({ code: "sapling_only_violation" }), /Nothing was sent/);
    assert.doesNotMatch(walletErrorMessage({ code: "recipient_no_sapling_receiver" }), /beta/i);
  });
});

// ------------------------------------------------------------------ the Stage-1 save (protobuf) and its birthday

/** A minimal protobuf writer for the fields the reader needs (proto/memory_wallet.proto of zcash_client_memory). */
function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}
const uintField = (field: number, value: number): number[] => (value === 0 ? [] : [...varint(field * 8), ...varint(value)]); // proto3: 0 omitted
const lenField = (field: number, bytes: number[]): number[] => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];

/** A Stage-1 save: MemoryWallet { version, accounts { account { id, …, birthday { prior_chain_state { height, hash } } } }, blocks… }. */
function stage1Save(accounts: { id: number; birthday: number }[], version = 1): Uint8Array {
  const accountMessages = accounts.map((a) => {
    const chainState = [...uintField(1, a.birthday - 1), ...lenField(2, new Array(32).fill(7)), ...lenField(3, [1, 2, 3])];
    const birthday = lenField(1, chainState);
    const account = [...uintField(1, a.id), ...uintField(2, 0), ...lenField(6, [...Buffer.from("uview1notreallyakey")]), ...lenField(7, birthday), ...lenField(10, [...Buffer.from("Zocial World")])];
    return lenField(1, account);
  });
  const accountsMessage = [...accountMessages.flat(), ...uintField(2, accounts.length)];
  // A few unrelated top-level fields around it (blocks, trees), as a real dump has.
  return Uint8Array.from([...uintField(1, version), ...lenField(3, [8, 1, 18, 2, 0, 0]), ...lenField(2, accountsMessage), ...lenField(11, new Array(40).fill(9))]);
}

describe("the Stage-1 save: birthday from the memory backend's protobuf dump", () => {
  it("reads each account's birthday (prior chain state + 1)", () => {
    assert.deepEqual(readStage1Accounts(stage1Save([{ id: 0, birthday: 3_510_100 }])), [{ accountId: 0, birthdayHeight: 3_510_100 }]);
    assert.deepEqual(readStage1Accounts(stage1Save([{ id: 0, birthday: 2_000_000 }, { id: 1, birthday: 3_400_000 }])), [
      { accountId: 0, birthdayHeight: 2_000_000 },
      { accountId: 1, birthdayHeight: 3_400_000 },
    ]);
  });

  it("picks the stored account, else the only one; null when it is ambiguous or unreadable", () => {
    const two = stage1Save([{ id: 0, birthday: 2_000_000 }, { id: 1, birthday: 3_400_000 }]);
    assert.equal(stage1SaveBirthday(two, 1), 3_400_000);
    assert.equal(stage1SaveBirthday(two, null), 2_000_000, "no stored id = account 0");
    assert.equal(stage1SaveBirthday(two, 7), null, "an unknown account among several");
    assert.equal(stage1SaveBirthday(stage1Save([{ id: 3, birthday: 3_000_000 }]), 0), 3_000_000, "the only account");
    assert.equal(stage1SaveBirthday(stage1Save([{ id: 0, birthday: 3_510_100 }], 2), 0), null, "another dump version");
    assert.equal(stage1SaveBirthday(new Uint8Array([0xff, 0xff, 0xff]), 0), null, "garbage");
    assert.equal(stage1SaveBirthday(stage1Save([{ id: 0, birthday: 3_510_100 }]).slice(0, 25), 0), null, "truncated");
    assert.equal(stage1SaveBirthday(null, 0), null);
  });

  it("a Stage-2 save (SQLite file) is told apart and never parsed", () => {
    const sqlite = new Uint8Array(4096);
    sqlite.set([..."SQLite format 3"].map((c) => c.charCodeAt(0)), 0);
    assert.equal(isSqliteWalletSave(sqlite), true);
    assert.equal(readStage1Accounts(sqlite), null);
    assert.equal(isSqliteWalletSave(stage1Save([{ id: 0, birthday: 3_510_100 }])), false);
  });
});

describe("the migration's estimated progress", () => {
  it("estimates from the blocks to scan, capped until the rescan has finished", () => {
    const start = 1_000_000;
    const m = { fromHeight: 3_480_000, tipHeight: 3_513_000, startedAt: start };
    const p0 = migrationProgress(m, start);
    assert.equal(p0.blocks, 33_000);
    assert.equal(p0.fraction, 0);
    assert.equal(p0.etaMinutes, 17, "33,000 blocks at 33 blocks/s ≈ 17 minutes");
    assert.ok(Math.abs(migrationProgress(m, start + 500_000).fraction - 0.5) < 0.01);
    assert.equal(migrationProgress(m, start + 10 * 3_600_000).fraction, MIGRATION_PROGRESS_CAP, "never 100 % before it is done");
    assert.deepEqual(migrationProgress({ ...m, tipHeight: null }, start + 61_000), { blocks: null, fraction: 0, etaMinutes: null, elapsedSeconds: 61 });
    assert.equal(formatElapsed(75), "1:15");
    assert.equal(formatElapsed(3725), "1:02:05");
  });
});

// ------------------------------------------------------------------ the adapter on the Stage 2 engine API, and the migration

type Opts = { seedPhrase: string; dbBytes?: Uint8Array | null; birthdayHeight?: number | null; knownAccountId?: number | null };
const SQLITE_SAVE = Uint8Array.from([..."SQLite format 3\0"].map((c) => c.charCodeAt(0)).concat([1, 2, 3]));

/**
 * The engine's database lock, as the real engine behaves — a sync holds it for its whole scan, and
 * `addresses()` (cached once, like core/wallet.ts `addressesOnce`) waits for it.
 */
type EngineLock = { held: boolean; waiters: (() => void)[] };

function stage2Wallet(opts: Opts, log: { syncs: number; sends: number }, gate: { release: (() => void) | null }, lock: EngineLock | null = null) {
  const ADDRS = { unified: "u1fullstub", unifiedShielded: "u1shieldedstub", unifiedSaplingTransparent: "u1stage1stub", sapling: "zs1stub", transparent: "t1stub" };
  let addressesOnce: Promise<typeof ADDRS> | null = null;
  const acquire = async (): Promise<void> => {
    while (lock?.held) await new Promise<void>((resolve) => lock.waiters.push(resolve));
  };
  const releaseLock = (): void => {
    if (!lock) return;
    lock.held = false;
    for (const waiter of lock.waiters.splice(0)) waiter();
  };
  return {
    accountId: 0,
    createdWithBirthday: opts.dbBytes ? null : (opts.birthdayHeight ?? 3_513_000),
    address: async () => "u1fullstub",
    transparentAddress: async () => "t1stub",
    exportDb: async () => SQLITE_SAVE,
    sync: async () => {
      log.syncs++;
      if (lock) lock.held = true; // the scan holds the database lock until it ends
      try {
        if (gate.release === null) return;
        await new Promise<void>((resolve) => (gate.release = resolve));
      } finally {
        releaseLock();
      }
    },
    balances: async () => ({ totalZec: 0.0042, pendingZec: 0, transparentZec: 0, shieldableZec: 0, chainTipHeight: 3_513_000, fullyScannedHeight: 3_513_000, raw: null }),
    sendWithMemo: async () => "aa".repeat(32),
    send: async () => "aa".repeat(32),
    shield: async () => true,
    tip: async () => 3_513_000,
    getTransactionHistory: async () => ({ transactions: [] }),
    mainnetEngine: {
      addresses: () =>
        (addressesOnce ??= (async () => {
          await acquire();
          return ADDRS;
        })()),
      sendingStatus: async () => ({ allowed: true, expectedBranch: "37a5165b", chainBranch: "37a5165b", code: null, reason: null, pendingUpgrade: null }),
      previewSend: async () => ({ txids: [], feeZat: 25_000, amountZat: 0, outputs: [{ to: "t1resolved", pool: "transparent", amountZat: 5000, hasMemo: false, tex: true }] }),
      send: async () => (log.sends++, { txids: ["11".repeat(32), "22".repeat(32)], feeZat: 25_000, amountZat: 0, outputs: [] }),
      previewShield: async () => ({ txid: "", utxos: 1, transparentInZat: 100_000, feeZat: 15_000, shieldedZat: 85_000, pool: "ironwood" }),
      shield: async () => ({ txid: "33".repeat(32), utxos: 1, transparentInZat: 100_000, feeZat: 15_000, shieldedZat: 85_000, pool: "ironwood" }),
    },
  };
}

describe("Stage 2 adapter: the engine API and the Stage 1 migration (stubbed engine)", () => {
  const PASS = "a passphrase of length";
  let opened: Opts[] = [];
  let log = { syncs: 0, sends: 0 };
  const gate: { release: (() => void) | null } = { release: null };
  let engineLock: EngineLock | null = null;

  beforeEach(async () => {
    localStorage.clear();
    opened = [];
    log = { syncs: 0, sends: 0 };
    gate.release = null;
    engineLock = null;
    const walletMod = await import("./core/wallet.ts");
    walletMod.__testSeam.walletFactory = async (opts: Opts) => {
      opened.push(opts);
      // The Stage-2 engine refuses anything that is not a SQLite wallet: what its constructor throws.
      if (opts.dbBytes && !isSqliteWalletSave(opts.dbBytes)) throw Object.assign(new Error("wallet_format_unsupported: not a Stage-2 wallet database"), { code: "wallet_format_unsupported" });
      return stage2Wallet(opts, log, gate, engineLock) as any;
    };
    const adapterMod = await import("./ZcashWalletAdapter.ts");
    adapterMod.__walletPolicyTestSeam.network = "main";
    await adapterMod.ZcashWalletAdapter.clearAllData();
  });

  afterEach(async () => {
    gate.release?.();
    const walletMod = await import("./core/wallet.ts");
    walletMod.__testSeam.walletFactory = null;
    const adapterMod = await import("./ZcashWalletAdapter.ts");
    adapterMod.__walletPolicyTestSeam.network = null;
    await adapterMod.ZcashWalletAdapter.clearAllData();
  });

  /** A wallet as Stage 1 left it: the encrypted seed, the account id and a memory-backend save — no stored birthday. */
  async function stage1Wallet(save: Uint8Array): Promise<string> {
    const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter.ts");
    const store = await import("./core/store.ts");
    await ZcashWalletAdapter.importSeed((await import("./core/keys.ts")).realGenerateMnemonic(), PASS, 3_494_959);
    await ZcashWalletAdapter.lock();
    await store.saveWalletDb(save);
    store.setBirthday(null); // Stage 1 never stored it
    const envelope = localStorage.getItem("zw.wallet.seed.v1") ?? localStorage.getItem("zw.wallet.seed.main.v1");
    assert.ok(envelope, "the encrypted seed is stored");
    await ZcashWalletAdapter.initialize("http://bridge.invalid/zcash/lwd");
    opened = [];
    return envelope!;
  }

  it("balances: shielded = Ironwood + Sapling + legacy Orchard spendable; pending; waiting to be shielded", async () => {
    const { mainnetBalances } = await import("./core/wallet.ts");
    const b = mainnetBalances({
      saplingSpendableZat: 100_000, ironwoodSpendableZat: 250_000, orchardSpendableZat: 50_000, shieldedSpendableZat: 400_000,
      shieldedPendingZat: 30_000, transparentTotalZat: 120_000, transparentShieldableZat: 90_000, chainTipHeight: 10, fullyScannedHeight: 9,
    });
    assert.equal(b.totalZec, 0.004, "shieldedSpendableZat — not the Sapling-only figure Stage 1 showed");
    assert.equal(b.pendingZec, 0.0003);
    assert.equal(b.transparentZec, 0.0012);
    assert.equal(b.shieldableZec, 0.0009);
    assert.deepEqual(b.shieldedPools, { ironwoodZec: 0.0025, saplingZec: 0.001, orchardZec: 0.0005 });
    assert.equal(mainnetBalances({}).totalZec, 0, "missing fields read as zero");
    const { mainnetAddresses } = await import("./core/wallet.ts");
    assert.throws(() => mainnetAddresses({ unified: "u1x", sapling: "zs1x", transparent: "t1x" }), /unifiedShielded/, "a Stage-1 engine's answer is refused");
  });

  it("addresses: the full UA is the main address; a player payment seals the shielded-only UA; TEX withdrawals report both txids", async () => {
    const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter.ts");
    await ZcashWalletAdapter.importSeed((await import("./core/keys.ts")).realGenerateMnemonic(), PASS, 3_494_959);
    const a = await ZcashWalletAdapter.getAddresses();
    assert.equal(a.unified, "u1fullstub");
    assert.equal(await ZcashWalletAdapter.getPaymentAddress(), "u1shieldedstub", "no transparent receiver");
    const request = { purpose: "withdrawal" as const, to: ADDRESSES.main.tex, amountZat: 5000n };
    const preview = await ZcashWalletAdapter.previewSend(request);
    assert.equal(preview.recipientPool, "transparent");
    assert.equal(preview.recipientTex, true);
    assert.deepEqual(await ZcashWalletAdapter.sendRequestTxids(request), ["11".repeat(32), "22".repeat(32)]);
    assert.equal(await ZcashWalletAdapter.sendRequest(request), "11".repeat(32), "the first txid");
  });

  it("create and restore remember the birthday (a later restore from the seed needs nothing else)", async () => {
    const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter.ts");
    const store = await import("./core/store.ts");
    await ZcashWalletAdapter.importSeed((await import("./core/keys.ts")).realGenerateMnemonic(), PASS, 3_494_959);
    assert.equal(store.getBirthday(), 3_494_959);
    await ZcashWalletAdapter.clearAllData();
    assert.equal(store.getBirthday(), null, "forgotten with the wallet");
    await ZcashWalletAdapter.createWallet(PASS);
    assert.equal(store.getBirthday(), 3_513_000, "a new wallet's birthday (the stub's tip − 100 stand-in)");
  });

  it("MIGRATION: a Stage-1 save is restored from the encrypted seed + the birthday read from the save; sends wait; the save is replaced only when the rescan is done", async () => {
    const { ZcashWalletAdapter, getWalletState } = await import("./ZcashWalletAdapter.ts");
    const store = await import("./core/store.ts");
    const save = stage1Save([{ id: 0, birthday: 3_480_000 }]);
    const envelope = await stage1Wallet(save);
    gate.release = () => undefined; // hold the rescan until released
    await ZcashWalletAdapter.unlock(PASS);
    // The engine refused the Stage-1 save, then a NEW wallet was opened from the seed at the save's birthday.
    assert.equal(opened.length, 2);
    assert.ok(opened[0]!.dbBytes && !isSqliteWalletSave(opened[0]!.dbBytes));
    assert.equal(opened[1]!.dbBytes, null);
    assert.equal(opened[1]!.birthdayHeight, 3_480_000);
    assert.equal(opened[0]!.seedPhrase, opened[1]!.seedPhrase, "the same seed, decrypted once with the passphrase — never asked for");
    const state = getWalletState();
    assert.equal(state.status === "ready" || state.status === "syncing", true);
    assert.equal(state.migration?.fromHeight, 3_480_000);
    assert.equal(store.getBirthday(), 3_480_000, "remembered at once");
    // While the rescan runs: no send, no shield, no preview; a payment can still be ACCEPTED (addresses are cached).
    await assert.rejects(ZcashWalletAdapter.sendRequest({ purpose: "withdrawal", to: "t1x", amountZat: 1000n }), /wallet_migrating/);
    await assert.rejects(ZcashWalletAdapter.previewSend({ purpose: "withdrawal", to: "t1x", amountZat: 1000n }), /wallet_migrating/);
    await assert.rejects(ZcashWalletAdapter.shieldTransparent(), /wallet_migrating/);
    assert.equal(await ZcashWalletAdapter.getPaymentAddress(), "u1shieldedstub");
    assert.equal(log.sends, 0);
    for (let i = 0; i < 50 && log.syncs === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(log.syncs, 1, "the rescan started by itself");
    assert.deepEqual(await store.loadWalletDb(), save, "the Stage-1 save stays until the rescanned wallet replaces it");
    assert.equal(getWalletState().migration?.tipHeight, 3_513_000, "the tip for the progress line");
    // The rescan finishes → the SQLite wallet replaces the Stage-1 save, the migration ends, the balance shows.
    const release = gate.release!;
    gate.release = null;
    release();
    for (let i = 0; i < 100 && getWalletState().migration !== null; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(getWalletState().migration, null);
    assert.deepEqual(await store.loadWalletDb(), SQLITE_SAVE);
    assert.equal(getWalletState().balance?.totalZec, 0.0042);
    assert.equal(localStorage.getItem("zw.wallet.seed.v1") ?? localStorage.getItem("zw.wallet.seed.main.v1"), envelope, "the encrypted seed is untouched");
    // Next time it opens normally (no migration).
    await ZcashWalletAdapter.lock();
    opened = [];
    await ZcashWalletAdapter.unlock(PASS);
    assert.equal(opened.length, 1);
    assert.equal(getWalletState().migration, null);
  });

  it("MIGRATION: the addresses are cached before the rescan holds the engine's lock — accepting a payment and Add funds never wait for it", async () => {
    const { ZcashWalletAdapter, subscribeToWalletState } = await import("./ZcashWalletAdapter.ts");
    await stage1Wallet(stage1Save([{ id: 0, birthday: 3_480_000 }]));
    engineLock = { held: false, waiters: [] };
    gate.release = () => undefined; // hold the rescan until released (afterEach)
    // Like the wallet panel (built for every session): start syncing the moment the wallet turns ready.
    let wasOpen = false;
    const unsubscribe = subscribeToWalletState((state) => {
      const open = state.status === "ready" || state.status === "syncing";
      if (open && !wasOpen) void ZcashWalletAdapter.sync().catch(() => undefined);
      wasOpen = open;
    });
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    try {
      await ZcashWalletAdapter.unlock(PASS);
      for (let i = 0; i < 50 && !engineLock.held; i++) await sleep(5);
      assert.equal(engineLock.held, true, "the rescan holds the engine's database lock");
      const address = await Promise.race([ZcashWalletAdapter.getPaymentAddress(), sleep(300).then(() => "still waiting for the rescan")]);
      assert.equal(address, "u1shieldedstub");
      const all = await Promise.race([ZcashWalletAdapter.getAddresses(), sleep(300).then(() => null)]);
      assert.equal(all?.unified, "u1fullstub");
      assert.equal(engineLock.held, true, "…while the rescan is still running");
    } finally {
      unsubscribe();
    }
  });

  it("MIGRATION: locking mid-rescan keeps the Stage-1 save; the next unlock starts again with the remembered birthday", async () => {
    const { ZcashWalletAdapter, getWalletState } = await import("./ZcashWalletAdapter.ts");
    const store = await import("./core/store.ts");
    const save = stage1Save([{ id: 0, birthday: 3_480_000 }]);
    await stage1Wallet(save);
    gate.release = () => undefined;
    await ZcashWalletAdapter.unlock(PASS);
    for (let i = 0; i < 50 && log.syncs === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await ZcashWalletAdapter.lock();
    assert.deepEqual(await store.loadWalletDb(), save, "not overwritten by an unfinished wallet");
    assert.equal(getWalletState().migration, null);
    gate.release?.();
    gate.release = null;
    opened = [];
    await ZcashWalletAdapter.unlock(PASS);
    assert.equal(opened[1]?.birthdayHeight, 3_480_000);
  });

  it("MIGRATION: an unreadable save asks for the creation DATE (never the seed), then migrates from it", async () => {
    const { ZcashWalletAdapter, getWalletState } = await import("./ZcashWalletAdapter.ts");
    await stage1Wallet(new Uint8Array([0x0a, 0xff, 0xff, 0x01, 0x02]));
    await assert.rejects(ZcashWalletAdapter.unlock(PASS), /migration_birthday_unknown/);
    const state = getWalletState();
    assert.equal(state.status, "locked");
    assert.equal(state.migrationNeedsBirthday, true);
    assert.match(state.error ?? "", /month and year/);
    assert.equal(opened.length, 1, "nothing was opened from the seed yet");
    await ZcashWalletAdapter.unlock(PASS, { birthdayHeight: 3_300_000 });
    assert.equal(opened.at(-1)!.birthdayHeight, 3_300_000);
    assert.equal(getWalletState().migrationNeedsBirthday, false);
    assert.equal(getWalletState().migration?.fromHeight, 3_300_000);
  });

  it("MIGRATION: a wrong passphrase stays a wrong passphrase (no migration, data preserved)", async () => {
    const { ZcashWalletAdapter, getWalletState } = await import("./ZcashWalletAdapter.ts");
    const store = await import("./core/store.ts");
    const save = stage1Save([{ id: 0, birthday: 3_480_000 }]);
    await stage1Wallet(save);
    await assert.rejects(ZcashWalletAdapter.unlock("not the passphrase!"));
    assert.equal(getWalletState().status, "locked");
    assert.equal(getWalletState().migration, null);
    assert.equal(opened.length, 0);
    assert.deepEqual(await store.loadWalletDb(), save);
  });
});
