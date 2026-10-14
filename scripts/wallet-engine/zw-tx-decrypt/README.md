# zw-tx-decrypt 0.2 (Stage 2)

Zocial World game-server helper (ADR-018 § 5 name fee, § 6 transfer fee). Node.js, CommonJS,
synchronous, no network access, no logging.

```js
const h = require("./zw_tx_decrypt.js");
h.decryptTransaction(rawTxHex, height, "main", registryUfvk);
// -> [{ pool: "sapling" | "orchard" | "ironwood", outputIndex, valueZat, memoText, memoHex, incoming, transferType }]
h.registryKeysFromSeed(seedPhrase, "main", 0);   // operator's one-time setup, offline
// -> { ufvk, unifiedAddress, unifiedShieldedAddress, unifiedSaplingTransparentAddress,
//      saplingAddress, transparentAddress, diversifierIndex }
h.addressesFromUfvk(ufvk, "main");              // the same addresses, without the seed
h.describeAddress("u1…");                        // { network, kind, receivers, hasSapling, hasOrchard, hasTransparent }
h.inspectTransaction(rawTxHex, height, "main");  // { version, consensusBranchId, … ironwoodActions … }
h.buildInfo();
```

Addresses (exactly the Stage-2 engine's `get_addresses()` for the same account; one diversifier
index, ZIP 316):

| Field | Receivers | Engine field | A Stage-2 wallet pays it as |
|---|---|---|---|
| `unifiedAddress` | Orchard-family + Sapling + transparent (P2PKH) | `unified` | an **Ironwood** output |
| `unifiedShieldedAddress` | Orchard-family + Sapling | `unifiedShielded` | an **Ironwood** output |
| `unifiedSaplingTransparentAddress` | Sapling + transparent (the Stage-1 address) | `unifiedSaplingTransparent` | a Sapling output |
| `saplingAddress` | Sapling (`zs1…`) | `sapling` | a Sapling output |
| `transparentAddress` | P2PKH (`t1…`) | `transparent` | (withdrawals only) |

**Changed in 0.2:** `unifiedAddress` is now the FULL unified address (it was the Sapling +
transparent address, which is now `unifiedSaplingTransparentAddress`); `unifiedShieldedAddress`
and `unifiedSaplingTransparentAddress` are new. A fee or name-fee output paid by the Stage-2 wallet
to `unifiedAddress` / `unifiedShieldedAddress` decrypts as `pool: "ironwood"` (same `valueZat`,
`memoText`, `incoming: true`), so the server's fee checks must accept `pool === "ironwood"` as well
as `"sapling"`, and its address check must accept every address above.

Built from exactly the librustzcash (`0a2c6d1a…`) and orchard (`3bd2b736…`) revisions of the
Stage-2 wallet engine, using the engine's `Cargo.lock`; decrypts with
`zcash_client_backend::decrypt_transaction` (Sapling, Orchard and Ironwood outputs; v4/v5/v6
transactions). Errors are `Error`s with a `code` (`invalid_hex`, `invalid_height`,
`invalid_transaction`, `invalid_network`, `invalid_ufvk`, `invalid_seed_phrase`,
`invalid_account`, `invalid_address`).

Tests: `node --test test/decrypt.test.mjs` — real transactions from local NU6.3 regtest chains,
regtest keys only: `test/fixtures/regtest-ironwood-txs.json` (Stage-2 engine: v6, Ironwood fee and
name-fee outputs, Sapling fee output, Orchard-only u1, zs1, Sapling → Ironwood, shielding, t1 and
TEX withdrawals) and `test/fixtures/regtest-txs.json` (Stage-1 engine: v5, Sapling only).
