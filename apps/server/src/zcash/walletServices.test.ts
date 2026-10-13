import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWalletServices } from "./walletServices.js";
import type { ChainSource } from "./lightwalletdClient.js";

/**
 * ADR-018: the server's startup rules in one place — main refuses test-chain-only settings, a
 * fee/registry address must belong to its viewing key, and missing pieces turn the registry "disabled" and the fee off
 * (with a reason for the log, never an address or a key).
 */

const FIXTURE = JSON.parse(readFileSync(new URL("../../../../vendor/zcash-tx-decrypt/test/fixtures/regtest-txs.json", import.meta.url), "utf8")) as {
  ufvks: Record<string, string>;
  addresses: Record<string, { unified: string; sapling: string; transparent: string }>;
};
const offlineChain = (): ChainSource => ({ tipHeight: async () => 1, getTransaction: async () => null });
const deps = { rpc: null, chain: offlineChain };

test("main refuses the faucet and the zcashd/dev registries before anything starts", () => {
  const faucet = createWalletServices({ ZCASH_NETWORK: "main", ZCASHD_RPC_URL: "http://zcashd:18232" }, deps);
  assert.ok(!faucet.ok && /faucet/.test(faucet.error));
  const dev = createWalletServices({ ZCASH_NETWORK: "main", NAME_REGISTRY: "dev" }, deps);
  assert.ok(!dev.ok && /NAME_REGISTRY=dev/.test(dev.error));
  const zcashd = createWalletServices({ ZCASH_NETWORK: "main", NAME_REGISTRY: "zcashd" }, deps);
  assert.ok(!zcashd.ok);
});

test("main with nothing configured: names off, no transfer fee (with the reason), the 0.01 cap, zec.rocks", () => {
  const result = createWalletServices({ ZCASH_NETWORK: "main" }, deps);
  assert.ok(result.ok);
  if (!result.ok) return;
  const { services } = result;
  assert.equal(services.zcash.network, "main");
  assert.equal(services.zcash.paymentCapZat, 1_000_000);
  assert.equal(services.zcash.lightwalletdUrl, "https://zec.rocks:443");
  assert.equal(services.names.mode, "off");
  assert.equal(services.fees, null);
  assert.match(services.feeProblem ?? "", /PAYMENT_FEE_ADDRESS/);
  services.names.dispose();
});

test("a registry address that is not its viewing key's refuses to start (the error names the variables only)", () => {
  const result = createWalletServices(
    { NAME_REGISTRY: "lightwalletd", NAME_REGISTRY_ADDRESS: FIXTURE.addresses.B!.unified, NAME_REGISTRY_UFVK: FIXTURE.ufvks.PROJECT!, NAME_REGISTRY_FILE: "/tmp/never-written-names.json" },
    deps,
  );
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.match(result.error, /NAME_REGISTRY_ADDRESS \/ NAME_REGISTRY_UFVK: the address does not belong to the viewing key/);
  assert.equal(result.error.includes(FIXTURE.addresses.B!.unified), false);
  assert.equal(result.error.includes(FIXTURE.ufvks.PROJECT!), false);
});

test("test chain: the lightwalletd registry and a configured transfer fee share the registry's key", () => {
  const result = createWalletServices(
    {
      NAME_REGISTRY: "lightwalletd",
      NAME_REGISTRY_ADDRESS: FIXTURE.addresses.PROJECT!.unified,
      NAME_REGISTRY_UFVK: FIXTURE.ufvks.PROJECT!,
      NAME_REGISTRY_FILE: `/tmp/zw-walletservices-${process.pid}-names.json`,
      PAYMENT_FEE_ZEC: "0.00075",
    },
    deps,
  );
  assert.ok(result.ok, result.ok ? "" : result.error);
  if (!result.ok) return;
  assert.equal(result.services.names.mode, "lightwalletd");
  assert.equal(result.services.fees?.feeZat, 75_000);
  assert.equal(result.services.feeProblem, null);
  result.services.names.dispose();
  result.services.fees?.dispose();
});

test("on mainnet a registry/fee address without an Orchard-family receiver starts with a warning; the full UA does not", async () => {
  const { loadTxDecryptHelper } = await import("./txDecrypt.js");
  // A throwaway BIP 39 test vector (no funds): the mainnet keys the registry tool would print for it.
  const keys = loadTxDecryptHelper().registryKeysFromSeed(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
    "main",
    0,
  );
  const env = (address: string): Record<string, string> => ({
    ZCASH_NETWORK: "main",
    NAME_REGISTRY: "lightwalletd",
    NAME_REGISTRY_ADDRESS: address,
    NAME_REGISTRY_UFVK: keys.ufvk,
    NAME_REGISTRY_MAINNET_ACK: "accepted",
    NAME_REGISTRY_FILE: `/tmp/zw-walletservices-${process.pid}-main-names.json`,
    PAYMENT_FEE_MAINNET_ACK: "accepted",
  });
  for (const [label, address, warned] of [
    ["the Stage-1 UA (Sapling + transparent)", keys.unifiedSaplingTransparentAddress, true],
    ["the zs1", keys.saplingAddress, true],
    ["the full UA", keys.unifiedAddress, false],
    ["the shielded UA", keys.unifiedShieldedAddress, false],
  ] as const) {
    const result = createWalletServices(env(address), deps);
    assert.ok(result.ok, `${label}: ${result.ok ? "" : result.error}`);
    if (!result.ok) continue;
    const { warnings } = result.services;
    if (warned) {
      assert.equal(warnings.length, 2, `${label}: the registry and the fee address (which defaults to it)`);
      assert.match(warnings[0]!, /^NAME_REGISTRY_ADDRESS has no Orchard-family receiver/);
      assert.match(warnings[1]!, /^PAYMENT_FEE_ADDRESS/);
      assert.match(warnings[0]!, /public on the chain/);
      assert.equal(warnings.some((w) => w.includes(address) || w.includes(keys.ufvk)), false, "never the address or the key");
    } else {
      assert.deepEqual(warnings, [], label);
    }
    result.services.names.dispose();
    result.services.fees?.dispose();
  }
});

test("a fee address on another network than the server refuses to start", () => {
  const result = createWalletServices(
    { ZCASH_NETWORK: "main", PAYMENT_FEE_ADDRESS: FIXTURE.addresses.PROJECT!.unified, PAYMENT_FEE_UFVK: FIXTURE.ufvks.PROJECT!, PAYMENT_FEE_MAINNET_ACK: "accepted" },
    deps,
  );
  assert.ok(!result.ok && /network \(main\)/.test(result.error));
});
