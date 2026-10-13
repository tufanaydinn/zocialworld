import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileNameStore, parseStoreData, type NameStoreData } from "./nameStore.js";

/** ADR-016: the JSON file store — round trip, atomic replace, refusing a corrupt file. */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "zw-names-"));
}

const DATA: NameStoreData = {
  names: [
    { nameKey: "nadia", displayName: "Nadia", keyHash: "a".repeat(64), publicKey: "x".repeat(43), alg: "ed25519", avatar: { model: "knight", color: 3 }, createdAt: 1, lastSeen: 2 },
    { nameKey: "ada", displayName: "Ada", keyHash: "b".repeat(64), publicKey: null, alg: null, avatar: null, createdAt: 3, lastSeen: 3 },
  ],
  usedNotes: ["c".repeat(64)],
};

test("a missing file is an empty registry; save → load round-trips every field; the directory is created", () => {
  const dir = tempDir();
  try {
    const store = new FileNameStore(join(dir, "data", "names.json"));
    assert.deepEqual(store.load(), { names: [], usedNotes: [] });
    store.save(DATA);
    assert.deepEqual(store.load(), DATA);
    assert.equal(statSync(join(dir, "data", "names.json")).mode & 0o777, 0o600, "readable by the server's user only");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save writes a temp file and renames it over the old one: no temp file is left, and readers never see a partial file", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "names.json");
    const store = new FileNameStore(path);
    store.save(DATA);
    store.save({ ...DATA, usedNotes: [...DATA.usedNotes, "d".repeat(64)] });
    assert.deepEqual(readdirSync(dir), ["names.json"]);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { v: number; usedNotes: string[] };
    assert.equal(parsed.v, 1);
    assert.equal(parsed.usedNotes.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed write leaves the previous file intact and removes its temp file", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "names.json");
    const store = new FileNameStore(path);
    store.save(DATA);
    const before = readFileSync(path, "utf8");
    // Make the rename fail: the target becomes a non-empty directory.
    rmSync(path);
    mkdirSync(path);
    writeFileSync(join(path, "keep"), "x");
    assert.throws(() => store.save({ names: [], usedNotes: [] }));
    assert.deepEqual(readdirSync(dir), ["names.json"], "no temp file left behind");
    rmSync(path, { recursive: true });
    writeFileSync(path, before);
    assert.deepEqual(store.load(), DATA);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt or invalid file is refused at load (the server must not start and overwrite it) without quoting its content", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "names.json");
    writeFileSync(path, '{"v":1,"names":[{"nameKey":"Secret');
    assert.throws(() => new FileNameStore(path).load(), (error: Error) => !error.message.includes("Secret"));
    writeFileSync(path, JSON.stringify({ v: 1, names: [{ nameKey: "x" }], usedNotes: [] }));
    assert.throws(() => new FileNameStore(path).load(), /not a valid registry file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseStoreData drops unknown fields and rejects bad hashes", () => {
  const withExtra = { v: 1, names: [{ ...DATA.names[0], ip: "1.2.3.4", address: "u1…" }], usedNotes: [] };
  const parsed = parseStoreData(withExtra)!;
  assert.equal("ip" in parsed.names[0]!, false);
  assert.equal("address" in parsed.names[0]!, false);
  assert.equal(parseStoreData({ v: 1, names: [], usedNotes: ["not-a-hash"] }), null);
  assert.equal(parseStoreData({ v: 2, names: [], usedNotes: [] }), null);
});
