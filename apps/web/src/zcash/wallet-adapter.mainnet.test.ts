import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";

/**
 * ADR-018 § 1, § 4, § 6: the adapter's mainnet rules with a stubbed mainnet engine (the Stage 2 API: five addresses,
 * per-pool balances, TEX withdrawals) —
 *  - a new wallet is unusable (no address, no send) until its backup check passes;
 *  - the per-transaction cap is enforced IN THE ADAPTER: on a payment's recipient amount (the project fee comes on
 *    top), a withdrawal and the name fee; shielding is exempt;
 *  - one engine call carries the recipient output and the project-fee output; a withdrawal is marked as such;
 *  - balances: shielded (Ironwood + Sapling + legacy Orchard) is what payments can spend; transparent waits to be shielded.
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

type Output = { to: string; amountZat: string; memo?: string; withdrawal?: boolean };

function stubEngine() {
  const calls: { kind: string; outputs?: Output[] }[] = [];
  const wallet = {
    accountId: 0,
    createdWithBirthday: 3_510_000,
    address: async () => "u1stubunifiedaddress",
    transparentAddress: async () => "t1stubtransparent",
    exportDb: async () => new Uint8Array([1]),
    sync: async () => undefined,
    balances: async () => ({ totalZec: 0.005, pendingZec: 0, transparentZec: 0.02, shieldableZec: 0.02, chainTipHeight: 3_510_438, fullyScannedHeight: 3_510_438, raw: null }),
    sendWithMemo: async (to: string, amount: bigint, memo: string) => (calls.push({ kind: "sendWithMemo", outputs: [{ to, amountZat: amount.toString(), memo }] }), "aa".repeat(32)),
    send: async () => "bb".repeat(32),
    shield: async () => true,
    tip: async () => 3_510_438,
    getTransactionHistory: async () => ({ transactions: [] }),
    mainnetEngine: {
      addresses: async () => ({ unified: "u1stubfull", unifiedShielded: "u1stubshielded", unifiedSaplingTransparent: "u1stubstage1", sapling: "zs1stub", transparent: "t1stub" }),
      sendingStatus: async () => ({ allowed: true, expectedBranch: "37a5165b", chainBranch: "37a5165b", code: null, reason: null, pendingUpgrade: null }),
      previewSend: async (outputs: Output[]) => (calls.push({ kind: "previewSend", outputs }), { txids: [], feeZat: 15_000, amountZat: 0, outputs: [] }),
      send: async (outputs: Output[]) => (calls.push({ kind: "send", outputs }), { txids: ["cc".repeat(32)], feeZat: 15_000, amountZat: 0, outputs: [] }),
      previewShield: async () => ({ txid: "", utxos: 1, transparentInZat: 2_000_000, feeZat: 15_000, shieldedZat: 1_985_000 }),
      shield: async () => (calls.push({ kind: "shield" }), { txid: "dd".repeat(32), utxos: 1, transparentInZat: 2_000_000, feeZat: 15_000, shieldedZat: 1_985_000 }),
    },
  };
  return { wallet, calls };
}

describe("mainnet adapter (stubbed mainnet engine, Stage 2 API)", () => {
  let calls: { kind: string; outputs?: Output[] }[] = [];

  beforeEach(async () => {
    localStorage.clear();
    const walletMod = await import("./core/wallet");
    const stub = stubEngine();
    calls = stub.calls;
    walletMod.__testSeam.walletFactory = async () => stub.wallet as any;
    const adapterMod = await import("./ZcashWalletAdapter");
    adapterMod.__walletPolicyTestSeam.network = "main";
    adapterMod.__walletPolicyTestSeam.capSetting = undefined;
    await adapterMod.ZcashWalletAdapter.clearAllData();
  });

  afterEach(async () => {
    const walletMod = await import("./core/wallet");
    walletMod.__testSeam.walletFactory = null;
    const adapterMod = await import("./ZcashWalletAdapter");
    adapterMod.__walletPolicyTestSeam.network = null;
    adapterMod.__walletPolicyTestSeam.capSetting = undefined;
    await adapterMod.ZcashWalletAdapter.clearAllData();
  });

  it("a new mainnet wallet gives no address and sends nothing until the backup check passes", async () => {
    const { ZcashWalletAdapter, getWalletState } = await import("./ZcashWalletAdapter");
    const words = await ZcashWalletAdapter.createWallet("a passphrase of length");
    assert.equal(words.length, 24);
    assert.equal(getWalletState().backupPending, true);
    await assert.rejects(ZcashWalletAdapter.getReceiveAddress(), /backup_pending/);
    await assert.rejects(ZcashWalletAdapter.getAddresses(), /backup_pending/);
    await assert.rejects(ZcashWalletAdapter.sendRequest({ purpose: "withdrawal", to: "t1x", amountZat: 1000n }), /backup_pending/);
    await assert.rejects(ZcashWalletAdapter.sendShielded("u1" + "q".repeat(60), "0.001", ""), /backup_pending/);
    assert.equal(calls.length, 0, "the engine was never asked");
    ZcashWalletAdapter.confirmBackup();
    assert.equal(getWalletState().backupPending, false);
    assert.deepEqual(await ZcashWalletAdapter.getAddresses(), { unified: "u1stubfull", unifiedShielded: "u1stubshielded", unifiedSaplingTransparent: "u1stubstage1", sapling: "zs1stub", transparent: "t1stub" });
  });

  it("a restored wallet needs no backup check", async () => {
    const { ZcashWalletAdapter, getWalletState } = await import("./ZcashWalletAdapter");
    const { realGenerateMnemonic } = await import("./core/keys");
    await ZcashWalletAdapter.importSeed(realGenerateMnemonic(), "a passphrase of length", 3_494_959);
    assert.equal(getWalletState().backupPending, false);
    assert.equal(typeof (await ZcashWalletAdapter.getReceiveAddress()), "string");
  });

  it("the cap applies to the recipient amount (not the project fee), withdrawals and the name fee — shielding is exempt", async () => {
    const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter");
    await ZcashWalletAdapter.createWallet("a passphrase of length");
    ZcashWalletAdapter.confirmBackup();
    const fee = { address: "zs1projectfee", amountZat: 75_000n, memo: "zw-fee:v1:" + "ab".repeat(16) };
    // Exactly the cap plus the fee on top: allowed — ONE engine call with both outputs.
    const preview = await ZcashWalletAdapter.previewSend({ purpose: "payment", to: "u1recipient", amountZat: 1_000_000n, memo: "hi", projectFee: fee });
    assert.deepEqual(preview, { networkFeeZat: 15_000, amountZat: 1_000_000n, projectFeeZat: 75_000n, recipientPool: null, recipientAddress: null, recipientTex: false });
    assert.deepEqual(calls.at(-1)!.outputs, [
      { to: "u1recipient", amountZat: "1000000", memo: "hi" },
      { to: "zs1projectfee", amountZat: "75000", memo: fee.memo },
    ]);
    const txid = await ZcashWalletAdapter.sendRequest({ purpose: "payment", to: "u1recipient", amountZat: 1_000_000n, projectFee: fee });
    assert.equal(txid, "cc".repeat(32));
    assert.equal(calls.filter((c) => c.kind === "send").length, 1);
    // Above the cap: refused before the engine is asked.
    const before = calls.length;
    await assert.rejects(ZcashWalletAdapter.previewSend({ purpose: "payment", to: "u1recipient", amountZat: 1_000_001n, projectFee: fee }), /over_cap/);
    await assert.rejects(ZcashWalletAdapter.sendRequest({ purpose: "withdrawal", to: "t1mine", amountZat: 2_000_000n }), /over_cap/);
    await assert.rejects(ZcashWalletAdapter.sendRequest({ purpose: "name_fee", to: "u1registry", amountZat: 1_500_000n, memo: "zw-name:v1:x" }), /over_cap/);
    await assert.rejects(ZcashWalletAdapter.sendShielded("u1" + "q".repeat(60), "0.02", "memo"), /over_cap/);
    assert.equal(calls.length, before, "nothing reached the engine");
    // Shielding moves 0.02 ZEC of the player's own funds: exempt.
    const shielded = await ZcashWalletAdapter.shieldTransparent();
    assert.equal(shielded.shieldedZat, 1_985_000);
    assert.equal(calls.at(-1)!.kind, "shield");
  });

  it("a withdrawal is marked as one (the engine allows a transparent recipient only then); a fee belongs to payments only", async () => {
    const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter");
    await ZcashWalletAdapter.createWallet("a passphrase of length");
    ZcashWalletAdapter.confirmBackup();
    await ZcashWalletAdapter.sendRequest({ purpose: "withdrawal", to: " t1mine ", amountZat: 500_000n });
    assert.deepEqual(calls.at(-1)!.outputs, [{ to: "t1mine", amountZat: "500000", withdrawal: true }]);
    await assert.rejects(ZcashWalletAdapter.sendRequest({ purpose: "withdrawal", to: "t1mine", amountZat: 500_000n, projectFee: { address: "zs1x", amountZat: 1n, memo: "m" } }), /invalid_outputs/);
    await assert.rejects(ZcashWalletAdapter.sendRequest({ purpose: "payment", to: "u1x", amountZat: 0n }), /invalid_amount/);
  });

  it("`off` lifts the cap (the operator's switch); the test chain never had one", async () => {
    const adapterMod = await import("./ZcashWalletAdapter");
    adapterMod.__walletPolicyTestSeam.capSetting = "off";
    assert.equal(adapterMod.transactionCapZat(), null);
    adapterMod.__walletPolicyTestSeam.capSetting = "0.005";
    assert.equal(adapterMod.transactionCapZat(), 500_000n);
    adapterMod.__walletPolicyTestSeam.network = "test";
    assert.equal(adapterMod.transactionCapZat(), null);
  });

  it("a player payment is sealed to the SHIELDED-ONLY unified address (never the full u1 with the exchange receiver)", async () => {
    const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter");
    await ZcashWalletAdapter.createWallet("a passphrase of length");
    await assert.rejects(ZcashWalletAdapter.getPaymentAddress(), /backup_pending/);
    ZcashWalletAdapter.confirmBackup();
    assert.equal(await ZcashWalletAdapter.getPaymentAddress(), "u1stubshielded");
    assert.notEqual(await ZcashWalletAdapter.getPaymentAddress(), (await ZcashWalletAdapter.getAddresses()).unified);
  });

  it("the preview reports the pool and receiver the engine resolved", async () => {
    const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter");
    const walletMod = await import("./core/wallet");
    const stub = stubEngine();
    stub.wallet.mainnetEngine.previewSend = async () => ({ txids: [], feeZat: 10_000, amountZat: 0, outputs: [{ to: "t1resolved", pool: "transparent", amountZat: 5000, hasMemo: false }] }) as never;
    walletMod.__testSeam.walletFactory = async () => stub.wallet as any;
    await ZcashWalletAdapter.createWallet("a passphrase of length");
    ZcashWalletAdapter.confirmBackup();
    const preview = await ZcashWalletAdapter.previewSend({ purpose: "withdrawal", to: "t1typed", amountZat: 5000n });
    assert.equal(preview.recipientPool, "transparent");
    assert.equal(preview.recipientAddress, "t1resolved");
  });

  it("the send stays busy until the wallet DB is saved — also after a lost broadcast answer", async () => {
    const { ZcashWalletAdapter, getWalletState } = await import("./ZcashWalletAdapter");
    const walletMod = await import("./core/wallet");
    const stub = stubEngine();
    const busyWhileSaving: (string | null)[] = [];
    stub.wallet.exportDb = async () => (busyWhileSaving.push(getWalletState().txidInProgress), new Uint8Array([1]));
    let failure: Error | null = null;
    stub.wallet.mainnetEngine.send = async (outputs: Output[]) => {
      calls.push({ kind: "send", outputs });
      if (failure) throw failure;
      return { txids: ["cc".repeat(32)], feeZat: 15_000, amountZat: 0, outputs: [] };
    };
    walletMod.__testSeam.walletFactory = async () => stub.wallet as any;
    await ZcashWalletAdapter.createWallet("a passphrase of length");
    ZcashWalletAdapter.confirmBackup();
    busyWhileSaving.length = 0;
    await ZcashWalletAdapter.sendRequest({ purpose: "withdrawal", to: "t1mine", amountZat: 1000n });
    assert.deepEqual(busyWhileSaving, ["pending"], "saved while still busy: the update prompt cannot reload in between");
    assert.equal(getWalletState().txidInProgress, null);
    // The engine lost the network's answer — the stored transaction reserves notes, so the DB is saved too.
    failure = Object.assign(new Error(`broadcast_uncertain: [txid=${"ef".repeat(32)}] lost`), { code: "broadcast_uncertain", txid: "ef".repeat(32) });
    busyWhileSaving.length = 0;
    await assert.rejects(ZcashWalletAdapter.sendRequest({ purpose: "withdrawal", to: "t1mine", amountZat: 1000n }), (e: unknown) => (e as { txid?: string }).txid === "ef".repeat(32));
    assert.deepEqual(busyWhileSaving, ["pending"]);
    assert.equal(getWalletState().txidInProgress, null);
    // A failure before anything was built saves nothing.
    failure = Object.assign(new Error("insufficient_funds: no"), { code: "insufficient_funds" });
    busyWhileSaving.length = 0;
    await assert.rejects(ZcashWalletAdapter.sendRequest({ purpose: "withdrawal", to: "t1mine", amountZat: 1000n }), /insufficient_funds/);
    assert.deepEqual(busyWhileSaving, []);
  });

  it("balances: shielded (every pool) is spendable, transparent waits to be shielded", async () => {
    const { ZcashWalletAdapter } = await import("./ZcashWalletAdapter");
    await ZcashWalletAdapter.createWallet("a passphrase of length");
    ZcashWalletAdapter.confirmBackup();
    await ZcashWalletAdapter.sync();
    assert.deepEqual(ZcashWalletAdapter.getBalance(), { totalZec: 0.005, pendingZec: 0, transparentZec: 0.02, shieldableZec: 0.02 });
  });
});
