#!/usr/bin/env bash
# Zocial World — byte-identical check of two independent builds (ADR-018 § 7).
#
#   verify-reproducible.sh <OUT_A> <OUT_B>                          compare two finished outputs
#   verify-reproducible.sh --build <WORK_A> <WORK_B> [main|all]     run build-engine.sh in both work
#                                                                   directories one after the other, then compare
#
# Every file of webzjs-wallet-main/, webzjs-wallet-regtest/ and zw-tx-decrypt/ (whichever exist in both) and
# BUILD-INFO.txt must be identical. The second build of --build is run with EXPECT_*_WASM_SHA256 set to the first
# build's hashes, so build-engine.sh itself also fails on a difference. Exit status 0 = byte-identical.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
sha() { sha256sum "$1" | cut -d' ' -f1; }

if [ "${1:-}" = "--build" ]; then
  WA=$(mkdir -p "$2" && cd "$2" && pwd); WB=$(mkdir -p "$3" && cd "$3" && pwd); WHAT=${4:-all}
  [ "$WA" != "$WB" ] || { echo "the two work directories must differ" >&2; exit 2; }
  "$HERE/build-engine.sh" "$WHAT" "$WA"
  env_b=()
  [ -f "$WA/out/webzjs-wallet-main/webzjs_wallet_bg.wasm" ] && env_b+=("EXPECT_MAIN_WASM_SHA256=$(sha "$WA/out/webzjs-wallet-main/webzjs_wallet_bg.wasm")")
  [ -f "$WA/out/webzjs-wallet-regtest/webzjs_wallet_bg.wasm" ] && env_b+=("EXPECT_REGTEST_WASM_SHA256=$(sha "$WA/out/webzjs-wallet-regtest/webzjs_wallet_bg.wasm")")
  [ -f "$WA/out/zw-tx-decrypt/zw_tx_decrypt_bg.wasm" ] && env_b+=("EXPECT_HELPER_WASM_SHA256=$(sha "$WA/out/zw-tx-decrypt/zw_tx_decrypt_bg.wasm")")
  env "${env_b[@]}" "$HERE/build-engine.sh" "$WHAT" "$WB"
  set -- "$WA/out" "$WB/out"
fi

A=$1; B=$2
status=0
compared=0
for pkg in webzjs-wallet-main webzjs-wallet-regtest zw-tx-decrypt; do
  if [ -d "$A/$pkg" ] && [ -d "$B/$pkg" ]; then
    compared=$((compared + 1))
    if diff -r "$A/$pkg" "$B/$pkg" >/dev/null; then
      n=$(find "$A/$pkg" -type f | wc -l)
      wasm=$(find "$A/$pkg" -maxdepth 1 -name '*_bg.wasm' | head -1)
      echo "IDENTICAL  $pkg: $n files; $(basename "$wasm") $(stat -c %s "$wasm") bytes sha256 $(sha "$wasm")"
    else
      echo "DIFFERENT  $pkg:"; diff -r "$A/$pkg" "$B/$pkg" | head -20 || true
      status=1
    fi
  elif [ -d "$A/$pkg" ] || [ -d "$B/$pkg" ]; then
    echo "MISSING    $pkg exists in only one of the outputs"; status=1
  fi
done
if [ -f "$A/BUILD-INFO.txt" ] && [ -f "$B/BUILD-INFO.txt" ]; then
  if cmp -s "$A/BUILD-INFO.txt" "$B/BUILD-INFO.txt"; then echo "IDENTICAL  BUILD-INFO.txt"; else echo "DIFFERENT  BUILD-INFO.txt"; diff "$A/BUILD-INFO.txt" "$B/BUILD-INFO.txt" | head -20 || true; status=1; fi
fi
[ "$compared" -gt 0 ] || { echo "nothing to compare" >&2; exit 2; }
[ "$status" = 0 ] && echo "byte-identical: $A == $B" || echo "NOT reproducible: $A != $B"
exit "$status"
