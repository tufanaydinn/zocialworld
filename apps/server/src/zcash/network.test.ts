import { test } from "node:test";
import assert from "node:assert/strict";
import { MAINNET_LIGHTWALLETD_URL, TESTNET_LIGHTWALLETD_URL, loadZcashServerConfig, parseFeeUsd, publicZcashInfo } from "./network.js";

/** ADR-018: ZCASH_NETWORK, the bridge's default upstream, the payment cap and the refusals on main. */

test("defaults: the test chain, testnet.zec.rocks, no payment cap", () => {
  const result = loadZcashServerConfig({});
  assert.ok(result.ok);
  assert.deepEqual(result.config, { network: "test", lightwalletdUrl: TESTNET_LIGHTWALLETD_URL, lightwalletdUrls: [TESTNET_LIGHTWALLETD_URL], paymentCapZat: null, paymentFeeUsd: null, nameFeeUsd: null, nu7ActivationHeight: null });
});

test("main: zec.rocks by default and the 0.01 ZEC cap; an explicit URL, `off` and another cap are honoured", () => {
  const main = loadZcashServerConfig({ ZCASH_NETWORK: "main" });
  assert.ok(main.ok);
  assert.deepEqual(main.config, { network: "main", lightwalletdUrl: MAINNET_LIGHTWALLETD_URL, lightwalletdUrls: [MAINNET_LIGHTWALLETD_URL], paymentCapZat: 1_000_000, paymentFeeUsd: null, nameFeeUsd: null, nu7ActivationHeight: null });
  const custom = loadZcashServerConfig({ ZCASH_NETWORK: "MAIN", LIGHTWALLETD_URL: "https://eu.zec.rocks:443", PAYMENT_CAP_ZEC: "0.005" });
  assert.ok(custom.ok);
  assert.equal(custom.config.lightwalletdUrl, "https://eu.zec.rocks:443");
  assert.equal(custom.config.paymentCapZat, 500_000);
  const uncapped = loadZcashServerConfig({ ZCASH_NETWORK: "main", PAYMENT_CAP_ZEC: "off", LIGHTWALLETD_URL: "off" });
  assert.ok(uncapped.ok);
  assert.equal(uncapped.config.paymentCapZat, null, "the operator can lift the cap");
  assert.equal(uncapped.config.lightwalletdUrl, null);
  assert.deepEqual(uncapped.config.lightwalletdUrls, []);
});

test("LIGHTWALLETD_URL takes an ordered, comma-separated list (primary first); bad, duplicate or too many entries fail closed", () => {
  const list = loadZcashServerConfig({ ZCASH_NETWORK: "main", LIGHTWALLETD_URL: " https://zec.rocks:443 , https://eu.zec.rocks:443,https://na.zec.rocks:443 " });
  assert.ok(list.ok);
  assert.equal(list.config.lightwalletdUrl, "https://zec.rocks:443");
  assert.deepEqual(list.config.lightwalletdUrls, ["https://zec.rocks:443", "https://eu.zec.rocks:443", "https://na.zec.rocks:443"]);
  for (const bad of ["https://zec.rocks:443,ftp://x", "https://a:443,https://a:443", ",", "https://a,https://b,https://c,https://d,https://e,https://f"]) {
    const result = loadZcashServerConfig({ LIGHTWALLETD_URL: bad });
    assert.equal(result.ok, false, bad);
  }
});

test("PAYMENT_FEE_USD / NAME_FEE_USD are optional approximate labels; bad values fail closed", () => {
  const labelled = loadZcashServerConfig({ ZCASH_NETWORK: "main", PAYMENT_FEE_USD: "1", NAME_FEE_USD: "1.25" });
  assert.ok(labelled.ok);
  assert.equal(labelled.config.paymentFeeUsd, 1);
  assert.equal(labelled.config.nameFeeUsd, 1.25);
  assert.equal(parseFeeUsd(undefined), null);
  assert.equal(parseFeeUsd(" "), null);
  for (const bad of ["0", "-1", "1.234", "abc", "1001", "$1", "1e2"]) assert.equal(parseFeeUsd(bad), "invalid", bad);
  assert.equal(loadZcashServerConfig({ PAYMENT_FEE_USD: "about one" }).ok, false);
  assert.equal(loadZcashServerConfig({ NAME_FEE_USD: "0" }).ok, false);
});

test("/zcash/info carries a fiat label only next to a fee that is charged — never an address", () => {
  const config = loadZcashServerConfig({ ZCASH_NETWORK: "main", PAYMENT_FEE_USD: "1", NAME_FEE_USD: "1" });
  assert.ok(config.ok);
  assert.deepEqual(publicZcashInfo(config.config, { mode: "fee", feeZat: 75_000 }, 75_000), {
    names: { mode: "fee", feeZat: 75_000, feeUsd: 1 },
    network: "main",
    payments: { feeZat: 75_000, capZat: 1_000_000, feeUsd: 1 },
  });
  assert.deepEqual(publicZcashInfo(config.config, { mode: "disabled", feeZat: 0 }, 0), {
    names: { mode: "disabled", feeZat: 0, feeUsd: null },
    network: "main",
    payments: { feeZat: 0, capZat: 1_000_000, feeUsd: null },
  });
  const unlabelled = loadZcashServerConfig({ ZCASH_NETWORK: "main" });
  assert.ok(unlabelled.ok);
  const info = publicZcashInfo(unlabelled.config, { mode: "fee", feeZat: 75_000 }, 75_000) as { payments: { feeUsd: unknown }; names: { feeUsd: unknown } };
  assert.equal(info.payments.feeUsd, null, "no operator label: the client shows the ZEC amount only");
  assert.equal(info.names.feeUsd, null);
});

test("main refuses to start with test-chain-only settings: the faucet and the zcashd/dev registries", () => {
  const faucet = loadZcashServerConfig({ ZCASH_NETWORK: "main", ZCASHD_RPC_URL: "http://zcashd:18232" });
  assert.equal(faucet.ok, false);
  assert.match(!faucet.ok ? faucet.error : "", /faucet/);
  for (const registry of ["zcashd", "dev", "DEV"]) {
    const result = loadZcashServerConfig({ ZCASH_NETWORK: "main", NAME_REGISTRY: registry });
    assert.equal(result.ok, false, registry);
    assert.match(!result.ok ? result.error : "", /lightwalletd/);
  }
  assert.ok(loadZcashServerConfig({ ZCASH_NETWORK: "main", NAME_REGISTRY: "lightwalletd" }).ok);
  assert.ok(loadZcashServerConfig({ ZCASH_NETWORK: "test", NAME_REGISTRY: "dev", ZCASHD_RPC_URL: "http://zcashd:18232" }).ok, "the test chain keeps them");
});

test("bad values fail closed", () => {
  assert.equal(loadZcashServerConfig({ ZCASH_NETWORK: "mainnet" }).ok, false);
  assert.equal(loadZcashServerConfig({ ZCASH_NETWORK: "main", PAYMENT_CAP_ZEC: "lots" }).ok, false);
  assert.equal(loadZcashServerConfig({ ZCASH_NETWORK: "main", PAYMENT_CAP_ZEC: "0" }).ok, false);
  assert.equal(loadZcashServerConfig({ LIGHTWALLETD_URL: "ftp://example.org" }).ok, false);
});

test("NU7_ACTIVATION_HEIGHT is an optional block height; anything else fails closed", () => {
  const set = loadZcashServerConfig({ ZCASH_NETWORK: "main", NU7_ACTIVATION_HEIGHT: "3600000" });
  assert.ok(set.ok);
  assert.equal(set.config.nu7ActivationHeight, 3_600_000);
  for (const bad of ["0", "-5", "soon", "1.5"]) assert.equal(loadZcashServerConfig({ NU7_ACTIVATION_HEIGHT: bad }).ok, false, bad);
});
