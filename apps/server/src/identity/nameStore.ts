import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { NAME_KEY_ALGS, NAME_KEY_HASH_PATTERN, PLAYER_AVATAR_COLOR_COUNT, PLAYER_AVATAR_MODELS, type NameKeyAlg, type PlayerAvatar, type PlayerAvatarModel } from "@project/shared";

/**
 * The game server's FIRST persistence (ADR-016 § 5): the owned-name registry, as one small JSON file.
 * What is stored, why, for how long and how to delete it: docs/privacy/IDENTITY_THREAT_MODEL.md.
 *
 * A record holds exactly the fields below — never an address, a balance, a txid, an IP, a session id or a payment
 * amount. `usedNotes` holds one-way hashes of payment notes that were already consumed (replay protection: a note
 * can confirm one reservation, once), never the txid itself.
 */

export interface NameRecord {
  /** NFKC + case-folded name (the uniqueness key). */
  readonly nameKey: string;
  /** The name as the player chose it (what everyone sees). */
  readonly displayName: string;
  /** SHA-256 of the owner's name-key public key, hex. */
  readonly keyHash: string;
  /** The owner's raw public key (base64url) — learned at the first successful claim; null until then. */
  publicKey: string | null;
  alg: NameKeyAlg | null;
  /** The character the owner last had (cosmetic; restored on a new device is a possible later use). */
  avatar: PlayerAvatar | null;
  readonly createdAt: number;
  /** Last confirmation or claim (ms since epoch) — what the retention policy looks at. */
  lastSeen: number;
  /**
   * ADR-019 § 4: a moderator's ban of 24 hours or more on this name (ms since epoch; MOD_BAN_FOREVER:
   * until lifted). The end time only — never a reason or a moderator. Absent when the name isn't banned.
   */
  bannedUntil?: number;
}

export interface NameStoreData {
  readonly names: NameRecord[];
  /** Hashes of consumed payment notes (see nameRegistry.noteHash). */
  readonly usedNotes: string[];
}

export interface NameStore {
  /** Reads everything once, at startup. An unreadable or corrupt store throws: the server must not start and overwrite it. */
  load(): NameStoreData;
  /** Replaces the stored data. */
  save(data: NameStoreData): void;
  /** Where the data lives, for the startup log ("memory" for the in-memory store). */
  readonly description: string;
}

const EMPTY: NameStoreData = { names: [], usedNotes: [] };

/** Keeps everything in memory: the `dev` backend's default (dev registrations are forgotten on restart) and tests. */
export class MemoryNameStore implements NameStore {
  readonly description = "memory (forgotten on restart)";
  private data: NameStoreData;
  saves = 0;

  constructor(initial: NameStoreData = EMPTY) {
    this.data = cloneData(initial);
  }

  load(): NameStoreData {
    return cloneData(this.data);
  }

  save(data: NameStoreData): void {
    this.data = cloneData(data);
    this.saves++;
  }
}

/**
 * A JSON file written atomically: the new content goes to a temporary file in the same directory, is flushed to disk
 * (fsync), and then renamed over the old file — a crash leaves either the old or the new file, never half of one.
 * The file is created readable by the server's user only (0600). A missing file is an empty registry.
 */
export class FileNameStore implements NameStore {
  readonly description: string;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.description = path;
  }

  load(): NameStoreData {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return cloneData(EMPTY);
      throw new Error(`name store unreadable (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not the parser's message: it can quote file content (names) into the log.
      throw new Error("name store is not valid JSON");
    }
    const data = parseStoreData(parsed);
    if (!data) throw new Error("name store is not a valid registry file");
    return data;
  }

  save(data: NameStoreData): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    const body = `${JSON.stringify({ v: 1, names: data.names, usedNotes: data.usedNotes }, null, 1)}\n`;
    let fd: number | null = null;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeSync(fd, body);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temp, this.path);
    } catch (error) {
      if (fd !== null) closeSync(fd);
      rmSync(temp, { force: true });
      throw error;
    }
  }
}

/** Validates a parsed store file; unknown fields are dropped, a malformed record rejects the whole file (never silently lose names). */
export function parseStoreData(raw: unknown): NameStoreData | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.v !== 1 || !Array.isArray(value.names) || !Array.isArray(value.usedNotes)) return null;
  const names: NameRecord[] = [];
  for (const entry of value.names as unknown[]) {
    const record = parseRecord(entry);
    if (!record) return null;
    names.push(record);
  }
  if (!(value.usedNotes as unknown[]).every((note) => typeof note === "string" && /^[0-9a-f]{64}$/.test(note))) return null;
  return { names, usedNotes: [...(value.usedNotes as string[])] };
}

function parseRecord(raw: unknown): NameRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.nameKey !== "string" || r.nameKey.length === 0 || typeof r.displayName !== "string" || r.displayName.length === 0) return null;
  if (typeof r.keyHash !== "string" || !NAME_KEY_HASH_PATTERN.test(r.keyHash)) return null;
  if (r.publicKey !== null && (typeof r.publicKey !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(r.publicKey))) return null;
  if (r.alg !== null && (typeof r.alg !== "string" || !(NAME_KEY_ALGS as readonly string[]).includes(r.alg))) return null;
  if (!Number.isFinite(r.createdAt) || !Number.isFinite(r.lastSeen)) return null;
  if (r.bannedUntil !== undefined && (typeof r.bannedUntil !== "number" || !Number.isFinite(r.bannedUntil) || r.bannedUntil < 0)) return null;
  return {
    nameKey: r.nameKey,
    displayName: r.displayName,
    keyHash: r.keyHash,
    publicKey: r.publicKey as string | null,
    alg: r.alg as NameKeyAlg | null,
    avatar: parseStoredAvatar(r.avatar),
    createdAt: r.createdAt as number,
    lastSeen: r.lastSeen as number,
    ...(typeof r.bannedUntil === "number" ? { bannedUntil: r.bannedUntil } : {}),
  };
}

function parseStoredAvatar(raw: unknown): PlayerAvatar | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.model !== "string" || !(PLAYER_AVATAR_MODELS as readonly string[]).includes(a.model)) return null;
  if (typeof a.color !== "number" || !Number.isInteger(a.color) || a.color < 0 || a.color >= PLAYER_AVATAR_COLOR_COUNT) return null;
  return { model: a.model as PlayerAvatarModel, color: a.color };
}

function cloneData(data: NameStoreData): NameStoreData {
  return { names: data.names.map((record) => ({ ...record, avatar: record.avatar ? { ...record.avatar } : null })), usedNotes: [...data.usedNotes] };
}
