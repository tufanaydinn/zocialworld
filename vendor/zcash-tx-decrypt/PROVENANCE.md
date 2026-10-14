# vendor/zcash-tx-decrypt — provenance

The game server's decryption helper (ADR-018 § 5 name fee, § 6 transfer fee), **0.2 (Stage 2)**.
Node.js, CommonJS, synchronous, no network access, no logging. The server loads it with
`createRequire` (`apps/server/src/zcash/txDecrypt.ts`); no npm dependency is added.

| | |
|---|---|
| Package name | `zw-tx-decrypt` 0.2.0 (`package.json`) |
| Source | Zocial World's own Rust crate `zw-tx-decrypt`: `scripts/wallet-engine/zw-tx-decrypt/`, built by `scripts/wallet-engine/build-engine.sh helper` |
| Built from | the Stage-2 wallet engine's exact `Cargo.lock` (the build checks every one of its ~200 packages against the engine's version, source and checksum): librustzcash `0a2c6d1ae6274e6af2291e312f7b7459516882f2`, orchard `3bd2b736d1273226595773265313fc3f3428af16` — the same code the wallet encrypts with |
| Decrypts with | `zcash_client_backend::decrypt_transaction` (Sapling, Orchard and **Ironwood** outputs; v4/v5/v6 transactions) |
| Addresses | `registryKeysFromSeed` / `addressesFromUfvk` return exactly the engine's `get_addresses()`: the full UA (Orchard-family + Sapling + p2pkh), the shielded UA (Orchard-family + Sapling), the Stage-1 UA (Sapling + p2pkh), `zs1`, `t1` |
| Licence | MIT OR Apache-2.0 (as the crates it builds on); bundled crates: `THIRD-PARTY-NOTICES.md`, generated with `node scripts/wallet-engine/third-party-notices.mjs <work dir>/zw-tx-decrypt zw-tx-decrypt` on the build's copy of the crate (the engine's `Cargo.lock`); not listed in `SHA256SUMS` |
| Built | 2026-10-14 with `wasm-pack build --target nodejs --release` (through `build-engine.sh helper`), with `--remap-path-prefix` for the build directory, the Cargo home and the Rust toolchain directory, so no machine path is compiled in |
| buildInfo() | `zw-tx-decrypt 0.2.0 (Stage 2 wallet engine); librustzcash 0a2c6d1a…; orchard 3bd2b736…; NU6.3 branch 37a5165b` |

## What changed from 0.1 (and why the server changed with it)

- `unifiedAddress` is now the **full** unified address (it was the Sapling + transparent address, now
  `unifiedSaplingTransparentAddress`); `unifiedShieldedAddress` and `unifiedSaplingTransparentAddress`
  are new.
- A fee or name-fee output paid by a Stage-2 wallet to a UA with an Orchard-family receiver decrypts
  as `pool: "ironwood"`. The game server counts `"ironwood"` as well as `"sapling"`
  notes (`apps/server/src/zcash/shieldedPayments.ts`) and accepts every one of its key's addresses at
  start-up (`txDecrypt.ts checkAddressAgainstKey`). The two changes and this helper ship together.

## Integrity

`SHA256SUMS` lists every file (`sha256sum -c SHA256SUMS` here):

```
zw_tx_decrypt_bg.wasm  1,974,581 bytes
sha256 4ff4b6c095c7e6397ae3a3c48ea5d22615f623f5046e14a765806647b9590804
```

Same source and lock file as the previous 0.2.0 build (`582c578a…`, 1,974,679 bytes); this build only
changes the compiled build-info string and maps the Rust toolchain directory out of the panic locations.
The JavaScript glue and the TypeScript types are unchanged. Confirm it with
`EXPECT_HELPER_WASM_SHA256=4ff4b6c095c7e6397ae3a3c48ea5d22615f623f5046e14a765806647b9590804 scripts/wallet-engine/build-engine.sh helper <dir>`.

## Tests

`ZW_TX_DECRYPT_PKG=$PWD/zw_tx_decrypt.js node --test test/decrypt.test.mjs` — 15 tests on real
transactions from local NU6.3 regtest chains (regtest test keys only): `test/fixtures/regtest-ironwood-txs.json`
(Stage-2 engine, v6: Ironwood fee and name-fee outputs, a Sapling fee output, an Orchard-only `u1`,
`zs1`, Sapling → Ironwood, shielding, `t1` and TEX withdrawals) and `test/fixtures/regtest-txs.json`
(Stage-1 engine, v5, Sapling only). The game server's tests (`apps/server/src/zcash/feeVerifier.test.ts`,
`walletServices.test.ts`, `identity/nameLightwalletd.test.ts`) decrypt both fixtures through this package.

## API

```js
decryptTransaction(rawTxHex, height, network, ufvk)  // -> [{ pool, outputIndex, valueZat, memoText, memoHex, incoming, transferType }]
registryKeysFromSeed(seedPhrase, network, account)   // operator setup, offline (scripts/tools/registry-keys.mjs)
addressesFromUfvk(ufvk, network)                     // the server checks its configured address against its key
describeAddress(address)                             // { network, kind, receivers, hasSapling, hasOrchard, hasTransparent }
inspectTransaction(rawTxHex, height, network)        // version, branch, bundle sizes (Ironwood actions included)
buildInfo()
```

`network` is `"main" | "test" | "regtest"`. Errors carry `e.code`. `README.md` has the address table.
