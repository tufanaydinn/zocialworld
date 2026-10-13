# vendor/zcash-tx-decrypt — provenance

The game server's decryption helper (ADR-018 § 5 name fee, § 6 transfer fee), **0.2 (Stage 2)**.
Node.js, CommonJS, synchronous, no network access, no logging. The server loads it with
`createRequire` (`apps/server/src/zcash/txDecrypt.ts`); no npm dependency is added.

| | |
|---|---|
| Package name | `zw-tx-decrypt` 0.2.0 (`package.json`) |
| Source | Zocial World's own Rust crate `zw-tx-decrypt`; its sources and the wallet engine build scripts are published separately later |
| Built from | the Stage-2 wallet engine's exact `Cargo.lock` (the build checks every one of its ~200 packages against the engine's version, source and checksum): librustzcash `0a2c6d1ae6274e6af2291e312f7b7459516882f2`, orchard `3bd2b736d1273226595773265313fc3f3428af16` — the same code the wallet encrypts with |
| Decrypts with | `zcash_client_backend::decrypt_transaction` (Sapling, Orchard and **Ironwood** outputs; v4/v5/v6 transactions) |
| Addresses | `registryKeysFromSeed` / `addressesFromUfvk` return exactly the engine's `get_addresses()`: the full UA (Orchard-family + Sapling + p2pkh), the shielded UA (Orchard-family + Sapling), the Stage-1 UA (Sapling + p2pkh), `zs1`, `t1` |
| Licence | MIT OR Apache-2.0 (as the crates it builds on) |
| Built | 2026-10-09 with `wasm-pack build --target nodejs --release`, in two independent directories, byte-identical |
| buildInfo() | `zw-tx-decrypt 0.2.0 (Stage 2, …); librustzcash 0a2c6d1a…; orchard 3bd2b736…; NU6.3 branch 37a5165b` |

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
zw_tx_decrypt_bg.wasm  1,974,679 bytes
sha256 582c578ab3a70777f22f5b8d92df431b3b94835fe38b71b7f569a3225fcb923e
```

(0.1 was 1,973,087 bytes, sha256 `59a1a94f…`.)

Rebuilt twice from the engine's sources and lockfile, byte-identical to this package.

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
