//! Test tooling (native): prints addresses the Sapling-beta tests need but no wallet export makes,
//! derived from a seed given in the ZW_TEST_SEED environment variable (never printed):
//! an Orchard-only unified address, an Orchard + Sapling UA, and a TEX address, per network.
//! Usage: ZW_TEST_SEED="<24 words>" cargo run --release --example test_addresses
use zcash_address::{ToAddress, ZcashAddress};
use zcash_keys::address::UnifiedAddress;
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};
use zcash_protocol::consensus::Parameters;
use zw_tx_decrypt::Net;

fn main() {
    let seed_phrase = std::env::var("ZW_TEST_SEED").expect("set ZW_TEST_SEED");
    let mnemonic = <bip0039::Mnemonic<bip0039::English>>::from_phrase(seed_phrase.trim())
        .expect("valid mnemonic");
    let seed = mnemonic.to_seed("");
    let mut out = Vec::new();
    for (name, net) in [("main", Net::Main), ("test", Net::Test), ("regtest", Net::Regtest)] {
        let usk = UnifiedSpendingKey::from_seed(&net, &seed[..], zip32::AccountId::ZERO).unwrap();
        let ufvk = usk.to_unified_full_viewing_key();
        let (ua, _) = ufvk
            .default_address(UnifiedAddressRequest::AllAvailableKeys)
            .unwrap();
        let orchard_only =
            UnifiedAddress::from_receivers(ua.orchard().copied(), None, None).unwrap();
        let orchard_sapling =
            UnifiedAddress::from_receivers(ua.orchard().copied(), ua.sapling().copied(), None)
                .unwrap();
        let orchard_transparent =
            UnifiedAddress::from_receivers(ua.orchard().copied(), None, ua.transparent().copied())
                .unwrap();
        let tex = match ua.transparent().unwrap() {
            zcash_transparent::address::TransparentAddress::PublicKeyHash(h) => {
                ZcashAddress::from_tex(net.network_type(), *h).encode()
            }
            _ => unreachable!(),
        };
        out.push(format!(
            "\"{}\": {{\"orchardOnlyUa\": \"{}\", \"orchardSaplingUa\": \"{}\", \"orchardTransparentUa\": \"{}\", \"tex\": \"{}\"}}",
            name,
            orchard_only.encode(&net),
            orchard_sapling.encode(&net),
            orchard_transparent.encode(&net),
            tex
        ));
    }
    println!("{{{}}}", out.join(", "));
}
