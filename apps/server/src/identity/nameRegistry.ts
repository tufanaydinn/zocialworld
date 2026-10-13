import { createHash, createHmac, randomBytes as nodeRandomBytes } from "node:crypto";
import {
  MOD_NICKNAME_LABEL_MAX,
  NAME_CHALLENGE_TTL_MS,
  NAME_KEY_HASH_PATTERN,
  NAME_MEMO_KEY_PREFIX_LENGTH,
  NAME_RESERVATION_TTL_MS,
  buildNameMemo,
  nameClaimMessage,
  parseNameMemo,
  type NameClaimProofMessage,
  type NameQuoteMessage,
  type PlayerAvatar,
} from "@project/shared";
import { isReservedNickname, nicknameKey, sanitizeNickname } from "../nickname.js";
import { nameKeyHash, verifyNameSignature } from "./nameKeyVerify.js";
import type { NameRecord, NameStore } from "./nameStore.js";

/**
 * The owned-name registry (ADR-016) — pure logic with an injected clock and random source; no
 * sockets, no timers, no chain access (WorldServer, namePoller and the scanners do those).
 *
 *  - Reservations: a name is held for NAME_RESERVATION_TTL_MS for one name-key hash, bound to the session that
 *    asked (one per session, one per key, a global cap). A name is free only if nobody has registered it, no other
 *    key has it reserved, and no other online session shows it (NFKC, case-insensitive — ADR-015's rules).
 *  - Payments: a scanner hands in the notes it sees at the registry address; a note confirms a reservation when its
 *    memo carries the reservation's nonce and the key-hash prefix, its value is at least the fee, it has the
 *    required confirmations, and it was never used before (each note confirms at most one reservation, once).
 *  - Claims: a returning player signs a fresh, single-use, session-bound nonce with its name key; the key must hash
 *    to the registered key hash.
 *
 * Results that concern a session (seen / expired / confirmed) are queued in an outbox (`takeUpdates`), keyed by the
 * session's playerId; WorldServer delivers them. Nothing here logs anything: names and payment data never meet in a
 * log line.
 */

export interface ReceivedNote {
  /** Unique id of the note: `txid:pool:outindex` from zcashd (dev: synthetic). Only its hash is ever remembered. */
  readonly ref: string;
  /** The memo as UTF-8 text (ZIP 302); anything else is ignored. */
  readonly memo: string;
  readonly amountZat: number;
  readonly confirmations: number;
}

/** What a scanner may know about a pending reservation (the dev backend fakes payments from it). */
export interface PendingReservationView {
  readonly reservationId: string;
  readonly memo: string;
  readonly amountZat: number;
  readonly createdAt: number;
}

export type NameUpdate =
  | { readonly kind: "status"; readonly sessionId: string; readonly reservationId: string; readonly nickname: string; readonly status: "seen" | "expired" }
  | { readonly kind: "confirmed"; readonly sessionId: string; readonly reservationId: string; readonly record: NameRecord };

export type ReserveOutcome =
  | { readonly ok: true; readonly quote: NameQuoteMessage; readonly seen: boolean }
  | { readonly ok: false; readonly status: "taken" | "invalid" | "rate_limited" };

export interface NameRegistryOptions {
  readonly now: () => number;
  readonly store: NameStore;
  /** The registry's shielded address (or NAME_DEV_ADDRESS for the dev backend) — carried by quotes, never logged. */
  readonly address: string;
  readonly feeZat: number;
  /** A matching note confirms with at least this many confirmations (ADR-016: 0 on the test chain). */
  readonly minConfirmations: number;
  /** At most this many pending reservations at once (default 256). */
  readonly maxPending?: number;
  /** Injectable for deterministic tests (default: node:crypto). */
  readonly randomBytes?: (size: number) => Uint8Array;
  /** The key of the v2 (HMAC) note hashes — `noteKeyForViewingKey(ufvk)` on the lightwalletd backend; null = v1. */
  readonly noteKey?: Uint8Array | null;
}

interface Reservation {
  readonly id: string;
  readonly nameKey: string;
  readonly displayName: string;
  readonly keyHash: string;
  readonly nonce: string;
  readonly memo: string;
  sessionId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** A matching payment arrived but lacks confirmations (it then gets one more TTL before expiring). */
  seen: boolean;
}

interface ExpiredReservation {
  readonly sessionId: string;
  readonly reservationId: string;
  readonly nickname: string;
  readonly keyHashPrefix: string;
  readonly at: number;
}

interface Challenge {
  readonly nonce: string;
  readonly nameKey: string;
  readonly expiresAt: number;
}

const DEFAULT_MAX_PENDING = 256;
/** A payment arriving this long after its reservation expired is still recognised (and consumed, never reused). */
const EXPIRED_MEMORY_MS = 24 * 60 * 60 * 1000;
const EXPIRED_MEMORY_MAX = 4096;
/** Notes that can never match (foreign memos, too small) are skipped on later polls; the set is reset beyond this. */
const IGNORED_NOTES_MAX = 10_000;

/**
 * The one-way id under which a consumed note is remembered (the store never holds a txid).
 *
 *  - v1 (no key): the test-chain backends (dev, zcashd), whose candidate txids are not public.
 *  - v2 (lightwalletd/mainnet): an HMAC under a key derived from the registry's viewing key. On mainnet
 *    every txid is public, so an unkeyed hash in names.json (a backup, a volume snapshot) could be reversed by hashing
 *    every txid × output index. The key never sits in names.json or on the data volume; whoever holds the viewing key
 *    can already link registrations (it decrypts every registry memo), so the key reveals nothing new.
 */
export function noteHash(ref: string, key: Uint8Array | null = null): string {
  if (key === null) return createHash("sha256").update(`zocial-world/name-note/v1:${ref}`).digest("hex");
  return createHmac("sha256", key).update(`zocial-world/name-note/v2:${ref}`).digest("hex");
}

/** The v2 note-hash key for a registry viewing key (deterministic: a restart keeps replay protection). */
export function noteKeyForViewingKey(ufvk: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`zocial-world/name-note-key/v1:${ufvk}`).digest());
}

/**
 * The moderation label for a stored ban on a key that owns these names — joined while they
 * fit MOD_NICKNAME_LABEL_MAX, then " +N more" ("Alice, Alicia +3 more").
 */
export function banLabel(names: readonly string[]): string {
  let label = names[0] ?? "";
  let shown = names.length > 0 ? 1 : 0;
  for (let i = 1; i < names.length; i++) {
    const next = `${label}, ${names[i]}`;
    const rest = names.length - i - 1;
    if (next.length + (rest > 0 ? ` +${rest} more`.length : 0) > MOD_NICKNAME_LABEL_MAX) break;
    label = next;
    shown++;
  }
  const hidden = names.length - shown;
  return (hidden > 0 ? `${label} +${hidden} more` : label).slice(0, MOD_NICKNAME_LABEL_MAX);
}

export class NameRegistry {
  private readonly now: () => number;
  private readonly store: NameStore;
  private readonly random: (size: number) => Uint8Array;
  private readonly maxPending: number;
  readonly address: string;
  readonly feeZat: number;
  readonly minConfirmations: number;

  private readonly records = new Map<string, NameRecord>();
  private readonly usedNotes = new Set<string>();
  private readonly noteKey: Uint8Array | null;
  private readonly ignoredNotes = new Set<string>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly byNonce = new Map<string, Reservation>();
  private readonly byName = new Map<string, Reservation>();
  private readonly byKey = new Map<string, Reservation>();
  private readonly bySession = new Map<string, Reservation>();
  private readonly expired = new Map<string, ExpiredReservation>();
  private readonly challenges = new Map<string, Challenge>();
  private outbox: NameUpdate[] = [];

  constructor(options: NameRegistryOptions) {
    this.now = options.now;
    this.store = options.store;
    this.random = options.randomBytes ?? ((size) => new Uint8Array(nodeRandomBytes(size)));
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.address = options.address;
    this.feeZat = options.feeZat;
    this.minConfirmations = options.minConfirmations;
    this.noteKey = options.noteKey ?? null;
    const data = this.store.load();
    for (const record of data.names) this.records.set(record.nameKey, record);
    for (const note of data.usedNotes) this.usedNotes.add(note);
  }

  /** Updates for sessions (seen / expired / confirmed) since the last call. */
  takeUpdates(): NameUpdate[] {
    const updates = this.outbox;
    this.outbox = [];
    return updates;
  }

  get registeredCount(): number {
    return this.records.size;
  }

  get pendingCount(): number {
    return this.reservations.size;
  }

  hasPending(): boolean {
    return this.reservations.size > 0;
  }

  /** The registered record for a name key (NFKC + case fold), or null. */
  record(nameKey: string): NameRecord | null {
    return this.records.get(nameKey) ?? null;
  }

  isRegistered(nameKey: string): boolean {
    return this.records.has(nameKey);
  }

  /** Whether a pending reservation of ANOTHER session holds this name (so nobody else may show or reserve it). */
  isReservedForOther(nameKey: string, sessionId: string): boolean {
    const reservation = this.byName.get(nameKey);
    return reservation !== undefined && reservation.sessionId !== sessionId && !this.isDue(reservation);
  }

  /** The session a pending reservation is bound to — the faucet's pre-join proof of a live connection. */
  reservationSession(reservationId: string): string | null {
    return this.reservations.get(reservationId)?.sessionId ?? null;
  }

  /** What the scanner may know about pending reservations. */
  pendingViews(): PendingReservationView[] {
    return [...this.reservations.values()].map((r) => ({ reservationId: r.id, memo: r.memo, amountZat: this.feeZat, createdAt: r.createdAt }));
  }

  /**
   * Reserves `rawNickname` for `keyHash`, bound to `sessionId`. Asking again with the same key for the same name
   * returns the SAME reservation (same nonce and memo), re-bound to the asking session — a reload or a reconnect
   * must never lead to a second payment. A name already registered is `taken` even for its owner (who claims it
   * instead of paying again).
   */
  reserve(sessionId: string, rawNickname: string, keyHash: string, isOnlineElsewhere: (nameKey: string) => boolean): ReserveOutcome {
    const nickname = sanitizeNickname(rawNickname);
    if (nickname === null || isReservedNickname(nickname) || !NAME_KEY_HASH_PATTERN.test(keyHash)) return { ok: false, status: "invalid" };
    this.expireDue();
    const nameKey = nicknameKey(nickname);
    if (this.records.has(nameKey)) return { ok: false, status: "taken" };
    const existing = this.byName.get(nameKey);
    if (existing && existing.keyHash !== keyHash) return { ok: false, status: "taken" };
    if (isOnlineElsewhere(nameKey)) return { ok: false, status: "taken" };
    if (existing) {
      const other = this.bySession.get(sessionId);
      if (other && other !== existing) {
        if (other.seen) return { ok: false, status: "rate_limited" };
        this.retire(other);
      }
      if (this.bySession.get(existing.sessionId) === existing) this.bySession.delete(existing.sessionId);
      existing.sessionId = sessionId;
      this.bySession.set(sessionId, existing);
      return { ok: true, quote: this.quoteOf(existing), seen: existing.seen };
    }
    // One pending reservation per session and per key: a new name replaces an unpaid one — never one whose payment is on its way.
    // (Replaced ones are retired: their session hears `expired`, and a payment that still arrives is consumed.)
    const previous = [...new Set([this.bySession.get(sessionId), this.byKey.get(keyHash)])].filter((r): r is Reservation => r !== undefined);
    if (previous.some((reservation) => reservation.seen)) return { ok: false, status: "rate_limited" };
    for (const reservation of previous) this.retire(reservation);
    if (this.reservations.size >= this.maxPending) return { ok: false, status: "rate_limited" };
    const now = this.now();
    const nonce = this.hex(16);
    const reservation: Reservation = {
      id: Buffer.from(this.random(16)).toString("base64url"),
      nameKey,
      displayName: nickname,
      keyHash,
      nonce,
      memo: buildNameMemo(nonce, keyHash),
      sessionId,
      createdAt: now,
      expiresAt: now + NAME_RESERVATION_TTL_MS,
      seen: false,
    };
    this.reservations.set(reservation.id, reservation);
    this.byNonce.set(nonce, reservation);
    this.byName.set(nameKey, reservation);
    this.byKey.set(keyHash, reservation);
    this.bySession.set(sessionId, reservation);
    return { ok: true, quote: this.quoteOf(reservation), seen: false };
  }

  /**
   * Applies the notes a scanner saw at the registry address (all of them, every poll — a note is evaluated until it
   * is consumed or proven useless). Queues `seen`, `confirmed` and late `expired` updates.
   */
  processNotes(notes: readonly ReceivedNote[]): void {
    this.expireDue();
    for (const note of notes) {
      const hash = noteHash(note.ref, this.noteKey);
      if (this.usedNotes.has(hash) || this.ignoredNotes.has(hash)) continue;
      // A store written before the keyed hashes (v1) still protects its notes from replay; new entries are v2 only.
      if (this.noteKey !== null && this.usedNotes.has(noteHash(note.ref))) continue;
      const memo = parseNameMemo(note.memo);
      const enough = Number.isFinite(note.amountZat) && note.amountZat >= this.feeZat;
      if (!memo || !enough) {
        this.ignore(hash);
        continue;
      }
      const reservation = this.byNonce.get(memo.nonce);
      if (!reservation) {
        // A payment for a reservation that already expired: consumed (it can never be reused), and its session is told.
        const late = this.expired.get(memo.nonce);
        if (!late || late.keyHashPrefix !== memo.keyHashPrefix) {
          this.ignore(hash);
        } else if (note.confirmations >= this.minConfirmations) {
          this.expired.delete(memo.nonce);
          this.usedNotes.add(hash);
          this.persist();
          this.outbox.push({ kind: "status", sessionId: late.sessionId, reservationId: late.reservationId, nickname: late.nickname, status: "expired" });
        }
        continue;
      }
      if (memo.keyHashPrefix !== reservation.keyHash.slice(0, NAME_MEMO_KEY_PREFIX_LENGTH)) {
        this.ignore(hash);
        continue;
      }
      if (!reservation.seen) {
        reservation.seen = true;
        this.outbox.push({ kind: "status", sessionId: reservation.sessionId, reservationId: reservation.id, nickname: reservation.displayName, status: "seen" });
      }
      if (note.confirmations < this.minConfirmations) continue; // evaluated again on the next poll
      const now = this.now();
      const record: NameRecord = {
        nameKey: reservation.nameKey,
        displayName: reservation.displayName,
        keyHash: reservation.keyHash,
        publicKey: null,
        alg: null,
        avatar: null,
        createdAt: now,
        lastSeen: now,
      };
      this.usedNotes.add(hash);
      this.records.set(record.nameKey, record);
      this.drop(reservation);
      this.persist();
      this.outbox.push({ kind: "confirmed", sessionId: reservation.sessionId, reservationId: reservation.id, record });
    }
  }

  /** Expires reservations past their TTL (a seen one gets one more TTL to collect its confirmations). Queues `expired`. */
  expireDue(): void {
    const now = this.now();
    for (const reservation of [...this.reservations.values()]) {
      if (this.isDue(reservation)) this.retire(reservation);
    }
    for (const [nonce, entry] of this.expired) {
      if (now - entry.at > EXPIRED_MEMORY_MS || this.expired.size > EXPIRED_MEMORY_MAX) this.expired.delete(nonce);
    }
  }

  /** The next time something is due (a reservation expiring), or null with nothing pending. */
  nextExpiry(): number | null {
    let next: number | null = null;
    for (const reservation of this.reservations.values()) {
      const at = reservation.seen ? reservation.expiresAt + NAME_RESERVATION_TTL_MS : reservation.expiresAt;
      if (next === null || at < next) next = at;
    }
    return next;
  }

  /**
   * A fresh claim challenge for `sessionId` (replacing any earlier one): single use, NAME_CHALLENGE_TTL_MS. Issued
   * for any valid name, registered or not, so asking is not a registration oracle beyond what nickname_check says.
   */
  issueChallenge(sessionId: string, rawNickname: string): string | null {
    const nickname = sanitizeNickname(rawNickname);
    if (nickname === null) return null;
    const nonce = this.hex(16);
    this.challenges.set(sessionId, { nonce, nameKey: nicknameKey(nickname), expiresAt: this.now() + NAME_CHALLENGE_TTL_MS });
    return nonce;
  }

  /**
   * Verifies a claim proof against the session's outstanding challenge, which is consumed by ANY proof (good or
   * bad). Returns the record on success (its public key and algorithm are remembered at the first claim; later
   * claims must use the same key), null otherwise.
   */
  async verifyClaim(sessionId: string, proof: Pick<NameClaimProofMessage, "nickname" | "publicKey" | "signature" | "alg">): Promise<NameRecord | null> {
    const challenge = this.challenges.get(sessionId);
    this.challenges.delete(sessionId);
    if (!challenge || challenge.expiresAt <= this.now()) return null;
    const nickname = sanitizeNickname(proof.nickname);
    if (nickname === null || nicknameKey(nickname) !== challenge.nameKey) return null;
    const record = this.records.get(challenge.nameKey);
    if (!record) return null;
    if ((record.alg !== null && record.alg !== proof.alg) || (record.publicKey !== null && record.publicKey !== proof.publicKey)) return null;
    if ((await nameKeyHash(proof.alg, proof.publicKey)) !== record.keyHash) return null;
    if (!(await verifyNameSignature(proof.alg, proof.publicKey, nameClaimMessage(challenge.nonce, proof.nickname), proof.signature))) return null;
    if (this.records.get(record.nameKey) !== record) return null; // deleted while verifying
    record.publicKey = proof.publicKey;
    record.alg = proof.alg;
    record.lastSeen = this.now();
    this.persist();
    return record;
  }

  /** The owner is here with this look: remembers the avatar (and lastSeen) if it changed. */
  touch(nameKey: string, avatar: PlayerAvatar | null): void {
    const record = this.records.get(nameKey);
    if (!record) return;
    const same = avatar === null ? record.avatar === null : record.avatar !== null && record.avatar.model === avatar.model && record.avatar.color === avatar.color;
    if (same) return;
    record.avatar = avatar ? { ...avatar } : null;
    this.persist();
  }

  /**
   * ADR-019 § 4: stores a ban's end on every name owned by this key hash (`until`), or clears it
   * (null). Written to the store at once; nothing else about the ban (no reason, no moderator) is kept.
   */
  setBannedUntil(keyHash: string, until: number | null): void {
    let changed = false;
    for (const record of this.records.values()) {
      if (record.keyHash !== keyHash) continue;
      if (until === null) {
        if (record.bannedUntil === undefined) continue;
        delete record.bannedUntil;
      } else {
        if (record.bannedUntil === until) continue;
        record.bannedUntil = until;
      }
      changed = true;
    }
    if (changed) this.persist();
  }

  /**
   * The stored bans still running (one per key hash: the latest end, and a label naming the names it covers), for the
   * moderation state at start-up. The label fits MOD_NICKNAME_LABEL_MAX ("A, B +3 more"): a key may own many names, and
   * a longer label would make the web client drop every mod_log.
   */
  activeBans(): { readonly keyHash: string; readonly nickname: string; readonly until: number }[] {
    const now = this.now();
    const byKey = new Map<string, { keyHash: string; names: string[]; until: number }>();
    for (const record of this.records.values()) {
      if (record.bannedUntil === undefined || record.bannedUntil <= now) continue;
      const existing = byKey.get(record.keyHash);
      if (!existing) byKey.set(record.keyHash, { keyHash: record.keyHash, names: [record.displayName], until: record.bannedUntil });
      else byKey.set(record.keyHash, { ...existing, names: [...existing.names, record.displayName], until: Math.max(existing.until, record.bannedUntil) });
    }
    return [...byKey.values()].map((ban) => ({ keyHash: ban.keyHash, nickname: banLabel(ban.names), until: ban.until }));
  }

  /**
   * Drops every stored `bannedUntil` that has ended (a ban that ran out while the server was down — no
   * sweep ever sees it) and saves the store if anything changed. WorldServer calls it at start-up.
   */
  clearEndedBans(): boolean {
    const now = this.now();
    let changed = false;
    for (const record of this.records.values()) {
      if (record.bannedUntil === undefined || record.bannedUntil > now) continue;
      delete record.bannedUntil;
      changed = true;
    }
    if (changed) this.persist();
    return changed;
  }

  /** A session went away: its claim challenge goes with it. Its reservation stays — a payment may still be on its way. */
  forgetSession(sessionId: string): void {
    this.challenges.delete(sessionId);
  }

  private quoteOf(reservation: Reservation): NameQuoteMessage {
    return {
      type: "name_quote",
      reservationId: reservation.id,
      nickname: reservation.displayName,
      address: this.address,
      amountZat: this.feeZat,
      memo: reservation.memo,
      expiresAt: reservation.expiresAt,
    };
  }

  private isDue(reservation: Reservation): boolean {
    const at = reservation.seen ? reservation.expiresAt + NAME_RESERVATION_TTL_MS : reservation.expiresAt;
    return at <= this.now();
  }

  /**
   * Ends an unconfirmed reservation (expired, or replaced by a newer request for the same key or session): its
   * session is told `expired`, and its nonce is remembered so a payment that still arrives is consumed, never reused.
   */
  private retire(reservation: Reservation): void {
    this.drop(reservation);
    this.expired.set(reservation.nonce, {
      sessionId: reservation.sessionId,
      reservationId: reservation.id,
      nickname: reservation.displayName,
      keyHashPrefix: reservation.keyHash.slice(0, NAME_MEMO_KEY_PREFIX_LENGTH),
      at: this.now(),
    });
    this.outbox.push({ kind: "status", sessionId: reservation.sessionId, reservationId: reservation.id, nickname: reservation.displayName, status: "expired" });
  }

  private drop(reservation: Reservation): void {
    this.reservations.delete(reservation.id);
    if (this.byNonce.get(reservation.nonce) === reservation) this.byNonce.delete(reservation.nonce);
    if (this.byName.get(reservation.nameKey) === reservation) this.byName.delete(reservation.nameKey);
    if (this.byKey.get(reservation.keyHash) === reservation) this.byKey.delete(reservation.keyHash);
    if (this.bySession.get(reservation.sessionId) === reservation) this.bySession.delete(reservation.sessionId);
  }

  private ignore(hash: string): void {
    if (this.ignoredNotes.size >= IGNORED_NOTES_MAX) this.ignoredNotes.clear();
    this.ignoredNotes.add(hash);
  }

  private hex(size: number): string {
    return Buffer.from(this.random(size)).toString("hex");
  }

  /** Writes the store. A failed write keeps the in-memory state (the name stays owned until a restart) and is reported without names. */
  private persist(): void {
    try {
      this.store.save({ names: [...this.records.values()], usedNotes: [...this.usedNotes] });
    } catch (error) {
      console.error(`[names] could not save the name store (${(error as NodeJS.ErrnoException).code ?? "error"}) — registrations are kept in memory until a restart`);
    }
  }
}
