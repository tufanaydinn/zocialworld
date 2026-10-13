import type { RpcFn } from "../zcash/faucet.js";
import type { NameRegistryConfig, NameRegistryMode } from "./nameConfig.js";
import { NameRegistry, noteKeyForViewingKey, type NameUpdate } from "./nameRegistry.js";
import { DevNameScanner, LightwalletdNameScanner, ZcashdNameScanner, type NameScanner, type PaymentReader } from "./nameScanner.js";
import { FileNameStore, MemoryNameStore } from "./nameStore.js";

/**
 * The name registry as WorldServer sees it (ADR-016; ADR-018 § 5): the mode, the registry (null without one) and
 * the scanner poll loop. The loop runs only while a reservation is pending: it expires due reservations, asks the
 * scanner for notes, feeds them to the registry and hands the resulting updates to WorldServer. One scan at a time;
 * every timer is unref'd. Scan failures are logged at most once a minute, with addresses removed.
 */

/** What the client may know about this server's names (GET /zcash/info → `names`). Never the address. */
export interface NameRegistryInfo {
  /** `off`: no registry (names on the honour system); `fee`: fee-confirmed names; `disabled`: holders keep Guest-style names. */
  readonly mode: "off" | "fee" | "disabled";
  readonly feeZat: number;
}

export interface NameServiceOptions {
  readonly mode: NameRegistryMode;
  readonly registry?: NameRegistry | null;
  readonly scanner?: NameScanner | null;
  readonly feeZat?: number;
}

const SCAN_ERROR_LOG_INTERVAL_MS = 60_000;

export class NameService {
  readonly mode: NameRegistryMode;
  readonly registry: NameRegistry | null;
  private readonly scanner: NameScanner | null;
  private readonly feeZat: number;
  private listener: (updates: NameUpdate[]) => void = () => undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scanning = false;
  private disposed = false;
  private lastScanErrorLog = -Infinity;

  constructor(options: NameServiceOptions) {
    this.mode = options.mode;
    this.registry = options.registry ?? null;
    this.scanner = options.scanner ?? null;
    this.feeZat = options.feeZat ?? this.registry?.feeZat ?? 0;
  }

  /** No registry: ADR-015's honour mode (the default). */
  static off(): NameService {
    return new NameService({ mode: "off" });
  }

  /** Reservations, payments and claims are live (dev, zcashd or lightwalletd). The stage/voice gate (server-verified identity) keys off this. */
  get enabled(): boolean {
    return this.registry !== null;
  }

  /** set_nickname is honoured for holders (no registry at all). */
  get honourMode(): boolean {
    return this.mode === "off";
  }

  info(): NameRegistryInfo {
    return { mode: this.enabled ? "fee" : this.mode === "disabled" ? "disabled" : "off", feeZat: this.enabled ? this.feeZat : 0 };
  }

  /**
   * ADR-018 § 5 (`name_payment_sent`): the session that holds `reservationId` reports the txid of its payment. Only the
   * lightwalletd backend uses it (the others see payments on their own); anything else is ignored. The scan follows
   * on the next poll.
   */
  paymentSent(sessionId: string, reservationId: string, txid: string): void {
    if (!this.registry || !(this.scanner instanceof LightwalletdNameScanner)) return;
    if (this.registry.reservationSession(reservationId) !== sessionId) return;
    if (this.scanner.report(reservationId, txid)) this.kick();
  }

  /** WorldServer: where updates go. */
  setListener(listener: (updates: NameUpdate[]) => void): void {
    this.listener = listener;
  }

  /** Delivers whatever direct registry calls queued, and keeps the poll loop going while anything is pending. */
  flush(): void {
    if (!this.registry) return;
    this.scanner?.prune?.(this.registry.pendingViews()); // a replaced reservation's txids go now
    const updates = this.registry.takeUpdates();
    if (updates.length > 0) this.listener(updates);
    this.kick();
  }

  /** Arms the poll loop if a reservation is pending and no poll is scheduled. */
  kick(): void {
    if (!this.registry || !this.scanner || this.disposed || this.timer || this.scanning || !this.registry.hasPending()) return;
    this.timer = setTimeout(() => void this.tick(), this.scanner.pollMs);
    this.timer.unref?.();
  }

  /** One poll (exposed for tests): expire, scan, apply, deliver, re-arm. */
  async tick(): Promise<void> {
    this.timer = null;
    const registry = this.registry;
    const scanner = this.scanner;
    if (!registry || !scanner || this.scanning || this.disposed) return;
    this.scanning = true;
    try {
      registry.expireDue();
      if (registry.hasPending()) registry.processNotes(await scanner.scan(registry.pendingViews()));
    } catch (error) {
      const now = Date.now();
      if (now - this.lastScanErrorLog >= SCAN_ERROR_LOG_INTERVAL_MS) {
        this.lastScanErrorLog = now;
        const reason = (error instanceof Error ? error.message : String(error)).replace(/\b[uz][0-9a-z]{20,}\b/gi, "<address>");
        console.warn(`[names] registry scan failed (retrying while reservations are pending): ${reason}`);
      }
    } finally {
      this.scanning = false;
      // A confirmed or expired reservation's reported txids go now, even when nothing else is
      // pending (no further scan would prune them).
      scanner.prune?.(registry.pendingViews());
    }
    if (this.disposed) return;
    const updates = registry.takeUpdates();
    if (updates.length > 0) this.listener(updates);
    this.kick();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Builds the service for a loaded config. The zcashd backend needs the faucet's RPC client; the lightwalletd backend
 * a reader of reported transactions (the server's lightwalletd connection + the registry's viewing key).
 */
export function createNameService(
  config: NameRegistryConfig,
  deps: { readonly rpc: RpcFn | null; readonly now?: () => number; readonly paymentReader?: PaymentReader | null },
): NameService {
  const now = deps.now ?? Date.now;
  if (config.mode === "off" || config.mode === "disabled" || config.address === null) return new NameService({ mode: config.mode === "disabled" ? "disabled" : "off" });
  if (config.mode === "lightwalletd") {
    if (!deps.paymentReader) return new NameService({ mode: "disabled" });
    // Mainnet txids are public, so consumed notes are stored as keyed (v2) hashes, the key derived from the
    // viewing key (never in names.json).
    const noteKey = config.ufvk ? noteKeyForViewingKey(config.ufvk) : null;
    const registry = new NameRegistry({ now, store: new FileNameStore(config.file ?? "./data/names.json"), address: config.address, feeZat: config.feeZat, minConfirmations: config.minConfirmations ?? 1, noteKey });
    return new NameService({ mode: "lightwalletd", registry, scanner: new LightwalletdNameScanner(deps.paymentReader) });
  }
  if (config.mode === "zcashd") {
    if (!deps.rpc) return new NameService({ mode: "disabled" });
    const registry = new NameRegistry({ now, store: new FileNameStore(config.file ?? "./data/names.json"), address: config.address, feeZat: config.feeZat, minConfirmations: 0 });
    return new NameService({ mode: "zcashd", registry, scanner: new ZcashdNameScanner(deps.rpc, config.address) });
  }
  // dev: one confirmation, which the fake scanner reports after the full delay (seen after half of it).
  const store = config.file ? new FileNameStore(config.file) : new MemoryNameStore();
  const registry = new NameRegistry({ now, store, address: config.address, feeZat: config.feeZat, minConfirmations: 1 });
  return new NameService({ mode: "dev", registry, scanner: new DevNameScanner(now, config.devConfirmMs) });
}

/** The store's description for the startup log (path or "memory"), never the address. */
export function describeNameService(service: NameService, config: NameRegistryConfig): string {
  switch (service.mode) {
    case "off":
      return "off (ADR-015 honour mode: holders choose names freely; nothing stored)";
    case "disabled":
      return `DISABLED — ${config.problem ?? "zcashd RPC unavailable"}: holders keep Guest-style names until this is fixed`;
    case "dev":
      return `dev — NOT FOR PRODUCTION: names confirm after ${config.devConfirmMs} ms without payment; fee ${config.feeZat / 1e8} ZEC; store ${config.file ?? "memory (forgotten on restart)"}`;
    case "zcashd":
      return `zcashd — fee ${config.feeZat / 1e8} ZEC, scanning every 5 s while reservations are pending; store ${config.file}`;
    case "lightwalletd":
      return `lightwalletd — fee ${config.feeZat / 1e8} ZEC; reported payments are fetched and decrypted with the registry's viewing key, ${config.minConfirmations ?? 1} confirmation(s); store ${config.file}`;
  }
}
