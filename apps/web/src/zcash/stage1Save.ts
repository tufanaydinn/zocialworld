/**
 * ADR-018 § 3: reading a saved wallet from before the Stage 2 engine.
 *
 * The Stage-1 ("Sapling beta") engine saved its wallet as a protobuf dump of the `zcash_client_memory` database
 * (`MemoryWallet`, red-dev-inc/zcash_client_memory @ 1feb38d, proto/memory_wallet.proto). The Stage-2 engine refuses
 * those bytes (`wallet_format_unsupported`): the game restores the wallet from the encrypted seed and its birthday (a
 * rescan). Before Stage 2 the game never stored the birthday on its own, so it is read here from the old save:
 *
 *   MemoryWallet { uint32 version = 1; Accounts accounts = 2; … }
 *   Accounts     { repeated Account accounts = 1; uint32 account_nonce = 2; }
 *   Account      { uint32 account_id = 1; …; AccountBirthday birthday = 7; … }
 *   AccountBirthday { ChainState prior_chain_state = 1; optional uint32 recover_until = 2; }
 *   ChainState   { uint32 block_height = 1; bytes block_hash = 2; … }
 *
 * The account's birthday height is `prior_chain_state.block_height + 1` (zcash_client_backend AccountBirthday::height;
 * WebZjs builds the prior chain state at `birthday - 1`).
 *
 * Only these few fields are read: the save also holds the account's viewing key, notes and transactions, which this
 * code never touches. Pure: no DOM, no wallet engine, nothing leaves the device.
 */

/** The first 16 bytes of every SQLite database file — what a Stage-2 save starts with. */
const SQLITE_HEADER = "SQLite format 3\u0000";

/** Whether `bytes` is a Stage-2 (SQLite) wallet save. */
export function isSqliteWalletSave(bytes: Uint8Array | null | undefined): boolean {
  if (!bytes || bytes.length < SQLITE_HEADER.length) return false;
  for (let i = 0; i < SQLITE_HEADER.length; i++) if (bytes[i] !== SQLITE_HEADER.charCodeAt(i)) return false;
  return true;
}

/** Lowest and highest heights a mainnet/test-chain birthday may have (Sapling activation is 419,200 on mainnet). */
const MIN_BIRTHDAY = 1;
const MAX_BIRTHDAY = 100_000_000;

type Field = { readonly number: number; readonly wire: number; readonly value: number | Uint8Array };

/** A minimal protobuf reader: varints (wire 0) and length-delimited fields (wire 2); fixed 32/64 skipped. Throws on damage. */
function* fields(buf: Uint8Array): Generator<Field> {
  let pos = 0;
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (pos >= buf.length) throw new Error("truncated varint");
      const byte = buf[pos++]!;
      if (shift < 49) result += (byte & 0x7f) * 2 ** shift;
      else if ((byte & 0x7f) !== 0) throw new Error("varint too large");
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new Error("varint too long");
    }
  };
  while (pos < buf.length) {
    const key = varint();
    const number = Math.floor(key / 8);
    const wire = key % 8;
    if (number < 1) throw new Error("bad field number");
    if (wire === 0) yield { number, wire, value: varint() };
    else if (wire === 2) {
      const length = varint();
      if (length > buf.length - pos) throw new Error("truncated field");
      yield { number, wire, value: buf.subarray(pos, pos + length) };
      pos += length;
    } else if (wire === 1) {
      if (pos + 8 > buf.length) throw new Error("truncated fixed64");
      pos += 8;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) throw new Error("truncated fixed32");
      pos += 4;
    } else throw new Error("unsupported wire type");
  }
}

function message(buf: Uint8Array, number: number): Uint8Array | null {
  let found: Uint8Array | null = null;
  for (const f of fields(buf)) if (f.number === number && f.wire === 2) found = f.value as Uint8Array;
  return found;
}

function uint(buf: Uint8Array, number: number): number | null {
  let found: number | null = null;
  for (const f of fields(buf)) if (f.number === number && f.wire === 0) found = f.value as number;
  return found;
}

/** One account of a Stage-1 save: its id and birthday height. */
export interface Stage1Account {
  readonly accountId: number;
  readonly birthdayHeight: number;
}

/**
 * The accounts of a Stage-1 (memory backend) save with their birthday heights, or null when the bytes are not a
 * readable Stage-1 save (a SQLite file, damaged bytes, another version).
 */
export function readStage1Accounts(bytes: Uint8Array | null | undefined): Stage1Account[] | null {
  if (!bytes || bytes.length === 0 || isSqliteWalletSave(bytes)) return null;
  try {
    const version = uint(bytes, 1);
    if (version !== 1) return null;
    const accounts = message(bytes, 2);
    if (!accounts) return null;
    const out: Stage1Account[] = [];
    for (const f of fields(accounts)) {
      if (f.number !== 1 || f.wire !== 2) continue;
      const account = f.value as Uint8Array;
      const accountId = uint(account, 1) ?? 0; // proto3: 0 is not encoded
      const birthday = message(account, 7);
      const prior = birthday ? message(birthday, 1) : null;
      const priorHeight = prior ? (uint(prior, 1) ?? 0) : null;
      if (priorHeight === null) continue;
      const birthdayHeight = priorHeight + 1;
      if (birthdayHeight < MIN_BIRTHDAY || birthdayHeight > MAX_BIRTHDAY) continue;
      out.push({ accountId, birthdayHeight });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * The birthday height to restore a Stage-1 save from: that of `accountId` (the account the game stored), else of the
 * save's only account; null when it cannot be read (the game then asks the player for the wallet's creation date —
 * never for the seed, which the keystore holds).
 */
export function stage1SaveBirthday(bytes: Uint8Array | null | undefined, accountId: number | null): number | null {
  const accounts = readStage1Accounts(bytes);
  if (!accounts) return null;
  const match = accounts.find((a) => a.accountId === (accountId ?? 0));
  if (match) return match.birthdayHeight;
  return accounts.length === 1 ? accounts[0]!.birthdayHeight : null;
}
