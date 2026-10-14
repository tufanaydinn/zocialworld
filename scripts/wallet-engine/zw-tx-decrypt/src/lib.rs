// Zocial World — zw-tx-decrypt (ADR-018 § 5 and § 6). MIT OR Apache-2.0.
//
// A small WebAssembly helper for the game server (Node.js). It trial-decrypts a raw transaction
// with the project's viewing key, so the server can check the mainnet name fee (§ 5) and the
// player-to-player transfer fee (§ 6) without zcashd and without a wallet database:
//
//   decryptTransaction(rawTxHex, height, network, ufvk)  -> [{ pool, outputIndex, valueZat,
//                                                             memoText, memoHex, incoming, transferType }]
//   registryKeysFromSeed(seedPhrase, network, account)   -> { ufvk, unifiedAddress (full: Orchard-family
//                                                             + Sapling + transparent), unifiedShieldedAddress
//                                                             (Orchard-family + Sapling), unifiedSaplingTransparent-
//                                                             Address (the Stage-1 address), saplingAddress,
//                                                             transparentAddress, diversifierIndex }
//   addressesFromUfvk(ufvk, network)                     -> the same addresses, without the seed
//   inspectTransaction(rawTxHex, height, network)        -> { txid, version, consensusBranchId, ... }
//
// Stage 2 (ADR-018 § 3, "Ironwood"): it is built from EXACTLY the librustzcash / orchard revisions
// of the Stage-2 wallet engine (WebZjs + patches 0001-0005: Cargo.toml [patch.crates-io] + the
// engine's Cargo.lock), and decrypts with `zcash_client_backend::decrypt_transaction`, so v4, v5
// and v6 (NU6.3) transactions parse at any height and Sapling, Orchard and Ironwood outputs are all
// tried. Since the Stage-2 wallet pays a unified address with an Orchard-family receiver as an
// IRONWOOD output, a fee or name-fee output to the project's full or shielded unified address is
// reported with `pool: "ironwood"` (value and memo as for Sapling); one to its zs1 or Stage-1
// (Sapling + transparent) address with `pool: "sapling"`.
//
// Nothing here logs, stores or returns key material other than what the caller asks for; the
// seed phrase given to `registryKeysFromSeed` is only used to derive keys and is dropped.

use std::collections::HashMap;

use serde::Serialize;
use wasm_bindgen::prelude::*;
use zcash_client_backend::{decrypt_transaction, TransferType};
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedFullViewingKey, UnifiedSpendingKey};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{self, BlockHeight, BranchId, NetworkType, NetworkUpgrade, Parameters};
use zcash_protocol::memo::{Memo, MemoBytes};

// ---------------------------------------------------------------------------------------------
// Networks

/// `main`, `test`, or `regtest` (a local chain with every upgrade through NU6.3 active from
/// height 1, like the zebrad regtest used to verify the Sapling beta).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Net {
    Main,
    Test,
    Regtest,
}

impl Net {
    pub fn parse(s: &str) -> Result<Net, String> {
        match s.trim() {
            "main" | "mainnet" => Ok(Net::Main),
            "test" | "testnet" => Ok(Net::Test),
            "regtest" => Ok(Net::Regtest),
            other => Err(format!(
                "invalid_network: {:?} is not one of main | test | regtest",
                other
            )),
        }
    }
}

impl Parameters for Net {
    fn network_type(&self) -> NetworkType {
        match self {
            Net::Main => NetworkType::Main,
            Net::Test => NetworkType::Test,
            Net::Regtest => NetworkType::Regtest,
        }
    }

    fn activation_height(&self, nu: NetworkUpgrade) -> Option<BlockHeight> {
        match self {
            Net::Main => consensus::Network::MainNetwork.activation_height(nu),
            Net::Test => consensus::Network::TestNetwork.activation_height(nu),
            // Every upgrade this librustzcash knows (Overwinter … NU6.3) at height 1.
            Net::Regtest => {
                let _ = nu;
                Some(BlockHeight::from_u32(1))
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Core logic (plain Rust, unit-testable natively)

/// One decrypted output.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DecryptedOutputInfo {
    /// "sapling" | "orchard" | "ironwood"
    pub pool: &'static str,
    /// Index of the output in the Sapling bundle's outputs, or of the action in the Orchard /
    /// Ironwood bundle.
    pub output_index: usize,
    /// Note value in zatoshis.
    pub value_zat: u64,
    /// The memo as text when it is a ZIP 302 text memo, else null.
    pub memo_text: Option<String>,
    /// The memo bytes as hex, with the trailing zero padding removed ("f6" = empty memo).
    pub memo_hex: String,
    /// true when the output was received on one of the key's EXTERNAL addresses (a payment to
    /// the key's owner). Only incoming outputs count as a fee payment.
    pub incoming: bool,
    /// "incoming" | "internal" (change to the same key) | "outgoing" (recovered with the key's
    /// outgoing viewing key: the key's owner paid it).
    pub transfer_type: &'static str,
}

fn err<T>(code: &str, detail: impl std::fmt::Display) -> Result<T, String> {
    Err(format!("{}: {}", code, detail))
}

pub fn parse_tx(raw_tx_hex: &str, height: u32, net: Net) -> Result<Transaction, String> {
    let bytes = match hex::decode(raw_tx_hex.trim()) {
        Ok(b) => b,
        Err(e) => return err("invalid_hex", e),
    };
    if height == 0 {
        return err(
            "invalid_height",
            "pass the height the transaction was mined at (or chain tip + 1 for an unmined one)",
        );
    }
    // The branch id is only used for v4 (and older) transactions; v5/v6 carry their own.
    let branch = BranchId::for_height(&net, BlockHeight::from_u32(height));
    let tx = match Transaction::read(&bytes[..], branch) {
        Ok(tx) => tx,
        Err(e) => return err("invalid_transaction", e),
    };
    // Reject trailing garbage: a re-serialization must give back exactly the input.
    let mut again = Vec::with_capacity(bytes.len());
    if tx.write(&mut again).is_err() || again != bytes {
        return err("invalid_transaction", "the hex is not exactly one transaction");
    }
    Ok(tx)
}

pub fn parse_ufvk(ufvk: &str, net: Net) -> Result<UnifiedFullViewingKey, String> {
    match UnifiedFullViewingKey::decode(&net, ufvk.trim()) {
        Ok(k) => Ok(k),
        Err(e) => err("invalid_ufvk", e),
    }
}

fn memo_fields(memo: &MemoBytes) -> (Option<String>, String) {
    let raw = memo.as_array();
    let end = raw.iter().rposition(|b| *b != 0).map(|i| i + 1).unwrap_or(0);
    let memo_hex = hex::encode(&raw[..end]);
    let text = match Memo::try_from(memo.clone()) {
        Ok(Memo::Text(t)) => Some(String::from(t)),
        _ => None,
    };
    (text, memo_hex)
}

fn transfer(t: TransferType) -> (&'static str, bool) {
    match t {
        TransferType::Incoming => ("incoming", true),
        TransferType::AccountInternal | TransferType::WalletInternal => ("internal", false),
        TransferType::Outgoing => ("outgoing", false),
    }
}

pub fn decrypt(
    raw_tx_hex: &str,
    height: u32,
    net: Net,
    ufvk: &str,
) -> Result<Vec<DecryptedOutputInfo>, String> {
    let tx = parse_tx(raw_tx_hex, height, net)?;
    let ufvk = parse_ufvk(ufvk, net)?;
    let mut keys = HashMap::new();
    keys.insert(0u32, ufvk);
    let d = decrypt_transaction(&net, Some(BlockHeight::from_u32(height)), None, &tx, &keys);
    let mut out = Vec::new();
    for o in d.sapling_outputs() {
        let (memo_text, memo_hex) = memo_fields(o.memo());
        let (transfer_type, incoming) = transfer(o.transfer_type());
        out.push(DecryptedOutputInfo {
            pool: "sapling",
            output_index: o.index(),
            value_zat: o.note().value().inner(),
            memo_text,
            memo_hex,
            incoming,
            transfer_type,
        });
    }
    for (pool, outputs) in [("orchard", d.orchard_outputs()), ("ironwood", d.ironwood_outputs())] {
        for o in outputs {
            let (memo_text, memo_hex) = memo_fields(o.memo());
            let (transfer_type, incoming) = transfer(o.transfer_type());
            out.push(DecryptedOutputInfo {
                pool,
                output_index: o.index(),
                value_zat: o.note().0.value().inner(),
                memo_text,
                memo_hex,
                incoming,
                transfer_type,
            });
        }
    }
    Ok(out)
}

/// The receive addresses of a key, exactly as the Stage-2 wallet engine's `get_addresses()` gives
/// them for an account (ADR-018 § 1, Stage 2 amendment): the key's default diversifier index
/// (ZIP 316: the first index with a valid Sapling receiver) and five encodings of its receivers.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyAddresses {
    /// The FULL unified address: every receiver of the key, i.e. Orchard-family (a Stage-2 wallet
    /// pays it as an Ironwood output) + Sapling + transparent (P2PKH). The engine's `unified`.
    pub unified_address: String,
    /// The key's shielded receivers only: Orchard-family + Sapling, no transparent receiver. The
    /// engine's `unifiedShielded`.
    pub unified_shielded_address: String,
    /// Sapling + transparent, no Orchard-family receiver: the Stage-1 main address (a payment to it
    /// is a Sapling output). The engine's `unifiedSaplingTransparent`.
    pub unified_sapling_transparent_address: String,
    /// The Sapling receiver alone (zs1… on mainnet).
    pub sapling_address: String,
    /// The transparent receiver alone (t1… on mainnet), when the key has a transparent component.
    pub transparent_address: Option<String>,
    /// The diversifier index of every receiver above (decimal string).
    pub diversifier_index: String,
}

pub fn addresses(ufvk: &UnifiedFullViewingKey, net: Net) -> Result<KeyAddresses, String> {
    use zcash_address::{ToAddress, ZcashAddress};
    use zcash_keys::address::UnifiedAddress;
    use zcash_keys::encoding::AddressCodec;
    let (ua, idx) = match ufvk.default_address(UnifiedAddressRequest::AllAvailableKeys) {
        Ok(v) => v,
        Err(e) => return err("address_generation_failed", format!("{:?}", e)),
    };
    let sapling = match ua.sapling() {
        Some(pa) => *pa,
        None => return err("invalid_ufvk", "the viewing key has no Sapling component"),
    };
    let orchard = ua.orchard().copied();
    let transparent = ua.transparent().copied();
    let build = |o, t| match UnifiedAddress::from_receivers(o, Some(sapling), t) {
        Some(u) => Ok(u.encode(&net)),
        None => err("address_generation_failed", "no receivers"),
    };
    Ok(KeyAddresses {
        unified_address: build(orchard, transparent)?,
        unified_shielded_address: build(orchard, None)?,
        unified_sapling_transparent_address: build(None, transparent)?,
        sapling_address: ZcashAddress::from_sapling(net.network_type(), sapling.to_bytes())
            .encode(),
        transparent_address: transparent.map(|t| t.encode(&net)),
        diversifier_index: u128::from(idx).to_string(),
    })
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegistryKeys {
    /// The unified full viewing key to configure on the game server (it can see incoming
    /// payments, never spend).
    pub ufvk: String,
    #[serde(flatten)]
    pub addresses: KeyAddresses,
}

pub fn registry_keys(seed_phrase: &str, net: Net, account: u32) -> Result<RegistryKeys, String> {
    use bip0039::{English, Mnemonic};
    let normalized = seed_phrase.split_whitespace().collect::<Vec<_>>().join(" ");
    let mnemonic = match <Mnemonic<English>>::from_phrase(normalized.to_lowercase()) {
        Ok(m) => m,
        // Never echo the phrase back.
        Err(_) => return err("invalid_seed_phrase", "not a valid BIP-39 English mnemonic"),
    };
    let seed = mnemonic.to_seed("");
    let account = match zip32::AccountId::try_from(account) {
        Ok(a) => a,
        Err(_) => return err("invalid_account", "account index must be < 2^31"),
    };
    let usk = match UnifiedSpendingKey::from_seed(&net, &seed[..], account) {
        Ok(k) => k,
        Err(e) => return err("key_derivation_failed", format!("{:?}", e)),
    };
    let ufvk = usk.to_unified_full_viewing_key();
    let addresses = addresses(&ufvk, net)?;
    Ok(RegistryKeys {
        ufvk: ufvk.encode(&net),
        addresses,
    })
}

/// The shape of a transaction (for audits and tests).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TxShape {
    pub txid: String,
    /// "V4" | "V5" | "V6" …
    pub version: String,
    /// Consensus branch id the transaction commits to (lower-case hex).
    pub consensus_branch_id: String,
    pub transparent_inputs: usize,
    pub transparent_outputs: usize,
    pub sapling_spends: usize,
    pub sapling_outputs: usize,
    pub orchard_actions: usize,
    pub ironwood_actions: usize,
    pub has_orchard_bundle: bool,
    pub has_ironwood_bundle: bool,
    pub has_sprout_bundle: bool,
    pub expiry_height: u32,
}

pub fn inspect(raw_tx_hex: &str, height: u32, net: Net) -> Result<TxShape, String> {
    let tx = parse_tx(raw_tx_hex, height, net)?;
    let (t_in, t_out) = tx
        .transparent_bundle()
        .map(|b| (b.vin.len(), b.vout.len()))
        .unwrap_or((0, 0));
    let (s_sp, s_out) = tx
        .sapling_bundle()
        .map(|b| (b.shielded_spends().len(), b.shielded_outputs().len()))
        .unwrap_or((0, 0));
    Ok(TxShape {
        txid: tx.txid().to_string(),
        version: format!("{:?}", tx.version()),
        consensus_branch_id: format!("{:08x}", u32::from(tx.consensus_branch_id())),
        transparent_inputs: t_in,
        transparent_outputs: t_out,
        sapling_spends: s_sp,
        sapling_outputs: s_out,
        orchard_actions: tx.orchard_bundle().map(|b| b.actions().len()).unwrap_or(0),
        ironwood_actions: tx.ironwood_bundle().map(|b| b.actions().len()).unwrap_or(0),
        has_orchard_bundle: tx.orchard_bundle().is_some(),
        has_ironwood_bundle: tx.ironwood_bundle().is_some(),
        has_sprout_bundle: tx.sprout_bundle().is_some(),
        expiry_height: u32::from(tx.expiry_height()),
    })
}

/// What an encoded address is, without trusting it: network, kind and (for a unified address)
/// the receivers it carries. Used to prove a wallet's UA has no Orchard receiver and to validate
/// a configured fee/registry address (it must have a Sapling receiver).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AddressInfo {
    /// "main" | "test" | "regtest"
    pub network: &'static str,
    /// "sprout" | "sapling" | "unified" | "transparent-p2pkh" | "transparent-p2sh" | "tex"
    pub kind: &'static str,
    /// For a unified address, its receivers in encoding order: "orchard", "sapling",
    /// "p2pkh", "p2sh" or "unknown:<typecode>"; for other kinds the kind itself.
    pub receivers: Vec<String>,
    pub has_sapling: bool,
    pub has_orchard: bool,
    pub has_transparent: bool,
}

struct Described(AddressInfo);

fn net_name(net: NetworkType) -> &'static str {
    match net {
        NetworkType::Main => "main",
        NetworkType::Test => "test",
        NetworkType::Regtest => "regtest",
    }
}

impl zcash_address::TryFromAddress for Described {
    type Error = ();
    fn try_from_sprout(
        net: NetworkType,
        _data: [u8; 64],
    ) -> Result<Self, zcash_address::ConversionError<()>> {
        Ok(Described(AddressInfo { network: net_name(net), kind: "sprout", receivers: vec!["sprout".into()], has_sapling: false, has_orchard: false, has_transparent: false }))
    }
    fn try_from_sapling(
        net: NetworkType,
        _data: [u8; 43],
    ) -> Result<Self, zcash_address::ConversionError<()>> {
        Ok(Described(AddressInfo { network: net_name(net), kind: "sapling", receivers: vec!["sapling".into()], has_sapling: true, has_orchard: false, has_transparent: false }))
    }
    fn try_from_unified(
        net: NetworkType,
        ua: zcash_address::unified::Address,
    ) -> Result<Self, zcash_address::ConversionError<()>> {
        use zcash_address::unified::{Container, Receiver};
        let receivers: Vec<String> = ua
            .items_as_parsed()
            .iter()
            .map(|r| match r {
                Receiver::Orchard(_) => "orchard".to_string(),
                Receiver::Sapling(_) => "sapling".to_string(),
                Receiver::P2pkh(_) => "p2pkh".to_string(),
                Receiver::P2sh(_) => "p2sh".to_string(),
                Receiver::Unknown { typecode, .. } => format!("unknown:{}", typecode),
            })
            .collect();
        let has = |k: &str| receivers.iter().any(|r| r == k);
        Ok(Described(AddressInfo {
            network: net_name(net),
            kind: "unified",
            has_sapling: has("sapling"),
            has_orchard: has("orchard"),
            has_transparent: has("p2pkh") || has("p2sh"),
            receivers,
        }))
    }
    fn try_from_transparent_p2pkh(
        net: NetworkType,
        _data: [u8; 20],
    ) -> Result<Self, zcash_address::ConversionError<()>> {
        Ok(Described(AddressInfo { network: net_name(net), kind: "transparent-p2pkh", receivers: vec!["p2pkh".into()], has_sapling: false, has_orchard: false, has_transparent: true }))
    }
    fn try_from_transparent_p2sh(
        net: NetworkType,
        _data: [u8; 20],
    ) -> Result<Self, zcash_address::ConversionError<()>> {
        Ok(Described(AddressInfo { network: net_name(net), kind: "transparent-p2sh", receivers: vec!["p2sh".into()], has_sapling: false, has_orchard: false, has_transparent: true }))
    }
    fn try_from_tex(
        net: NetworkType,
        _data: [u8; 20],
    ) -> Result<Self, zcash_address::ConversionError<()>> {
        Ok(Described(AddressInfo { network: net_name(net), kind: "tex", receivers: vec!["tex".into()], has_sapling: false, has_orchard: false, has_transparent: false }))
    }
}

pub fn describe_address(address: &str) -> Result<AddressInfo, String> {
    let parsed = match zcash_address::ZcashAddress::try_from_encoded(address.trim()) {
        Ok(a) => a,
        Err(e) => return err("invalid_address", e),
    };
    match parsed.convert::<Described>() {
        Ok(d) => Ok(d.0),
        Err(e) => err("invalid_address", format!("{:?}", e)),
    }
}

// ---------------------------------------------------------------------------------------------
// JavaScript bindings (wasm-pack --target nodejs)

fn js_error(message: String) -> JsValue {
    let e = js_sys::Error::new(&message);
    if let Some((code, _)) = message.split_once(": ") {
        if !code.is_empty() && code.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
            let _ = js_sys::Reflect::set(&e, &JsValue::from_str("code"), &JsValue::from_str(code));
        }
    }
    e.into()
}

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsValue> {
    v.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| js_error(format!("internal_error: {}", e)))
}

fn net_arg(network: &str) -> Result<Net, JsValue> {
    Net::parse(network).map_err(js_error)
}

#[wasm_bindgen(typescript_custom_section)]
const TS: &'static str = r#"
export type ZwNetwork = "main" | "test" | "regtest";
export interface ZwDecryptedOutput {
  pool: "sapling" | "orchard" | "ironwood";
  outputIndex: number;
  valueZat: number;
  memoText: string | null;
  memoHex: string;
  /** true only for a payment received on the key's external address. */
  incoming: boolean;
  transferType: "incoming" | "internal" | "outgoing";
}
export interface ZwKeyAddresses {
  /** Full unified address: Orchard-family + Sapling + transparent receivers (the Stage-2 engine's `unified`). */
  unifiedAddress: string;
  /** Orchard-family + Sapling receivers, no transparent one (the engine's `unifiedShielded`). */
  unifiedShieldedAddress: string;
  /** Sapling + transparent receivers, no Orchard-family one: the Stage-1 main address (the engine's `unifiedSaplingTransparent`). */
  unifiedSaplingTransparentAddress: string;
  /** The Sapling receiver alone (zs1…). */
  saplingAddress: string;
  /** The transparent receiver alone (t1… / tm…). */
  transparentAddress: string | null;
  diversifierIndex: string;
}
export interface ZwRegistryKeys extends ZwKeyAddresses { ufvk: string; }
export interface ZwAddressInfo {
  network: ZwNetwork;
  kind: "sprout" | "sapling" | "unified" | "transparent-p2pkh" | "transparent-p2sh" | "tex";
  receivers: string[];
  hasSapling: boolean; hasOrchard: boolean; hasTransparent: boolean;
}
export interface ZwTxShape {
  txid: string; version: string; consensusBranchId: string;
  transparentInputs: number; transparentOutputs: number;
  saplingSpends: number; saplingOutputs: number;
  orchardActions: number; ironwoodActions: number;
  hasOrchardBundle: boolean; hasIronwoodBundle: boolean; hasSproutBundle: boolean;
  expiryHeight: number;
}
"#;

/// Trial-decrypts every Sapling, Orchard and Ironwood output of a raw transaction with a unified
/// full viewing key. `height` is the block height the transaction was mined at (or the chain tip
/// + 1 for an unmined one). Returns the outputs the key can see (empty when none).
/// Throws an Error whose `code` is `invalid_hex`, `invalid_height`, `invalid_transaction`,
/// `invalid_network` or `invalid_ufvk`.
#[wasm_bindgen(js_name = decryptTransaction, unchecked_return_type = "ZwDecryptedOutput[]")]
pub fn decrypt_transaction_js(
    raw_tx_hex: &str,
    height: u32,
    #[wasm_bindgen(unchecked_param_type = "ZwNetwork")] network: &str,
    ufvk: &str,
) -> Result<JsValue, JsValue> {
    let net = net_arg(network)?;
    let outputs = decrypt(raw_tx_hex, height, net, ufvk).map_err(js_error)?;
    to_js(&outputs)
}

/// One-time operator setup: derives the project's registry keys from its seed phrase.
/// Returns `{ ufvk, unifiedAddress (Orchard-family + Sapling + transparent), unifiedShieldedAddress
/// (Orchard-family + Sapling), unifiedSaplingTransparentAddress (Sapling + transparent: the Stage-1
/// address), saplingAddress, transparentAddress, diversifierIndex }`. The seed is never logged or
/// returned.
/// Throws with `code` `invalid_seed_phrase`, `invalid_network` or `invalid_account`.
#[wasm_bindgen(js_name = registryKeysFromSeed, unchecked_return_type = "ZwRegistryKeys")]
pub fn registry_keys_from_seed_js(
    seed_phrase: &str,
    #[wasm_bindgen(unchecked_param_type = "ZwNetwork")] network: &str,
    account: u32,
) -> Result<JsValue, JsValue> {
    let net = net_arg(network)?;
    let keys = registry_keys(seed_phrase, net, account).map_err(js_error)?;
    to_js(&keys)
}

/// The fee/registry addresses that belong to a viewing key (what `registryKeysFromSeed` returns,
/// without the seed and the key): `{ unifiedAddress, unifiedShieldedAddress,
/// unifiedSaplingTransparentAddress, saplingAddress, transparentAddress, diversifierIndex }`.
#[wasm_bindgen(js_name = addressesFromUfvk, unchecked_return_type = "ZwKeyAddresses")]
pub fn addresses_from_ufvk_js(
    ufvk: &str,
    #[wasm_bindgen(unchecked_param_type = "ZwNetwork")] network: &str,
) -> Result<JsValue, JsValue> {
    let net = net_arg(network)?;
    let key = parse_ufvk(ufvk, net).map_err(js_error)?;
    to_js(&addresses(&key, net).map_err(js_error)?)
}

/// The shape of a raw transaction: version, consensus branch, bundle sizes.
#[wasm_bindgen(js_name = inspectTransaction, unchecked_return_type = "ZwTxShape")]
pub fn inspect_transaction_js(
    raw_tx_hex: &str,
    height: u32,
    #[wasm_bindgen(unchecked_param_type = "ZwNetwork")] network: &str,
) -> Result<JsValue, JsValue> {
    let net = net_arg(network)?;
    to_js(&inspect(raw_tx_hex, height, net).map_err(js_error)?)
}

/// Describes an encoded Zcash address: `{ network, kind, receivers, hasSapling, hasOrchard,
/// hasTransparent }`. Throws with `code` `invalid_address`.
#[wasm_bindgen(js_name = describeAddress, unchecked_return_type = "ZwAddressInfo")]
pub fn describe_address_js(address: &str) -> Result<JsValue, JsValue> {
    to_js(&describe_address(address).map_err(js_error)?)
}

/// The librustzcash / orchard revisions this helper was built from (must match the wallet's).
#[wasm_bindgen(js_name = buildInfo)]
pub fn build_info() -> String {
    "zw-tx-decrypt 0.2.0 (Stage 2 wallet engine); librustzcash 0a2c6d1ae6274e6af2291e312f7b7459516882f2; orchard 3bd2b736d1273226595773265313fc3f3428af16; NU6.3 branch 37a5165b".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // A throwaway test mnemonic (BIP-39 test vector style); it holds no funds on any network.
    const SEED: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

    #[test]
    fn keys_on_every_network() {
        for (net, ua_prefix, zs_prefix, t_prefix) in [
            (Net::Main, "u1", "zs1", "t1"),
            (Net::Test, "utest1", "ztestsapling1", "tm"),
            (Net::Regtest, "uregtest1", "zregtestsapling1", "tm"),
        ] {
            let k = registry_keys(SEED, net, 0).unwrap();
            assert!(k.addresses.unified_address.starts_with(ua_prefix));
            assert!(k.addresses.sapling_address.starts_with(zs_prefix));
            assert!(k.addresses.transparent_address.as_ref().unwrap().starts_with(t_prefix));
            // Full UA: Orchard-family + Sapling + transparent; shielded UA: Orchard-family +
            // Sapling; the Stage-1 UA: Sapling + transparent, no Orchard. One diversifier index.
            let decode = |a: &str| match zcash_keys::address::Address::decode(&net, a).unwrap() {
                zcash_keys::address::Address::Unified(ua) => ua,
                _ => panic!("not a UA"),
            };
            let full = decode(&k.addresses.unified_address);
            let shielded = decode(&k.addresses.unified_shielded_address);
            let stage1 = decode(&k.addresses.unified_sapling_transparent_address);
            assert!(full.orchard().is_some() && full.sapling().is_some() && full.transparent().is_some());
            assert!(shielded.orchard().is_some() && shielded.sapling().is_some() && shielded.transparent().is_none());
            assert!(stage1.orchard().is_none() && stage1.sapling().is_some() && stage1.transparent().is_some());
            assert_eq!(full.orchard(), shielded.orchard());
            assert_eq!(full.sapling(), stage1.sapling());
            assert_eq!(full.transparent(), stage1.transparent());
            assert!(k.addresses.unified_address.starts_with(ua_prefix));
            assert!(k.addresses.unified_shielded_address.starts_with(ua_prefix));
            assert!(k.addresses.unified_sapling_transparent_address.starts_with(ua_prefix));
            for a in [&k.addresses.unified_address, &k.addresses.unified_shielded_address, &k.addresses.unified_sapling_transparent_address] {
                let info = describe_address(a).unwrap();
                assert_eq!(info.kind, "unified");
            }
            let sorted = |a: &str| { let mut r = describe_address(a).unwrap().receivers; r.sort(); r };
            assert_eq!(sorted(&k.addresses.unified_address), vec!["orchard", "p2pkh", "sapling"]);
            assert_eq!(sorted(&k.addresses.unified_shielded_address), vec!["orchard", "sapling"]);
            assert_eq!(sorted(&k.addresses.unified_sapling_transparent_address), vec!["p2pkh", "sapling"]);
            // The UFVK round-trips and gives the same addresses.
            let again = addresses(&parse_ufvk(&k.ufvk, net).unwrap(), net).unwrap();
            assert_eq!(again, k.addresses);
        }
        assert!(registry_keys("not a seed", Net::Main, 0)
            .unwrap_err()
            .starts_with("invalid_seed_phrase:"));
    }

    #[test]
    fn bad_inputs() {
        assert!(decrypt("zz", 1, Net::Main, "x").unwrap_err().starts_with("invalid_hex:"));
        assert!(decrypt("00", 0, Net::Main, "x").unwrap_err().starts_with("invalid_height:"));
        assert!(decrypt("0400008085202f89", 3_500_000, Net::Main, "x")
            .unwrap_err()
            .starts_with("invalid_transaction:"));
        assert!(Net::parse("mainnet2").unwrap_err().starts_with("invalid_network:"));
    }
}
