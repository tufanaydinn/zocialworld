import { test } from "node:test";
import assert from "node:assert/strict";
import { FAUCET_MISSING_COPY, PUBLIC_TESTNET_FAUCETS, REGTEST_FAUCET_COPY, addressChain, faucetErrorMessage, faucetPlan, walletChain } from "./testChain.ts";

// The wallet's faucets follow its chain — the game's own regtest chain never sees public testnet faucets.

test("the build's chain: 'test' is the project's own regtest chain, 'main' is mainnet", () => {
  assert.equal(walletChain("test"), "regtest");
  assert.equal(walletChain("main"), "mainnet");
});

test("address prefixes tell the chain apart (regtest before testnet)", () => {
  assert.equal(addressChain("uregtest1qqqqsomethinglong"), "regtest");
  assert.equal(addressChain("zregtestsapling1abc"), "regtest");
  assert.equal(addressChain("utest1abc"), "testnet");
  assert.equal(addressChain("ztestsapling1abc"), "testnet");
  assert.equal(addressChain("u1abc"), "mainnet");
  assert.equal(addressChain("zs1abc"), "mainnet");
  assert.equal(addressChain("t1abc"), "mainnet");
  assert.equal(addressChain("bc1abc"), "unknown");
});

test("regtest: only this server's faucet, never the public faucets or their guide; a test-chain address label", () => {
  const ready = faucetPlan("regtest", { available: true });
  assert.equal(ready.show, true);
  assert.equal(ready.server, "ready");
  assert.deepEqual(ready.publicFaucets, []);
  assert.equal(ready.guide, false);
  assert.ok(ready.intro.startsWith(REGTEST_FAUCET_COPY));
  assert.match(ready.addressLabel, /test-chain/);
  assert.equal(faucetPlan("regtest", { available: false }).server, "missing");
  assert.deepEqual(faucetPlan("regtest", { available: false }).publicFaucets, [], "no public fallback when the server has no faucet");
  assert.equal(faucetPlan("regtest", null).server, "checking");
});

test("public testnet (a future build): the public faucets and the guide; mainnet: no faucet at all", () => {
  const testnet = faucetPlan("testnet", { available: false });
  assert.deepEqual(testnet.publicFaucets, PUBLIC_TESTNET_FAUCETS);
  assert.equal(testnet.guide, true);
  const mainnet = faucetPlan("mainnet", { available: true });
  assert.equal(mainnet.show, false);
  assert.deepEqual(mainnet.publicFaucets, []);
  assert.equal(mainnet.guide, false);
  assert.doesNotMatch(`${mainnet.heading} ${mainnet.intro}`, /faucet|test/i);
});

test("faucet errors are precise: no_session, cooldown, busy, send_failed, disabled, bad_address, unreachable", () => {
  assert.match(faucetErrorMessage("no_session", 403), /session/);
  assert.match(faucetErrorMessage("cooldown", 429), /10 minutes/);
  assert.match(faucetErrorMessage("busy", 429), /busy/);
  assert.match(faucetErrorMessage("send_failed", 502), /couldn't send/);
  assert.equal(faucetErrorMessage("faucet_disabled", 503), FAUCET_MISSING_COPY);
  assert.match(faucetErrorMessage("bad_address", 400), /test chain/);
  assert.match(faucetErrorMessage(null, 0), /couldn't be reached/);
  assert.match(faucetErrorMessage(null, 504), /HTTP 504/);
});
