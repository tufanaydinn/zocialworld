#!/bin/bash
# Resets the engine regtest chain (TESTING ONLY): fresh zebrad state and lightwalletd cache, then mines
# (a miner-address change needs ~15 s for zebrad to persist its non-finalized blocks first):
#   heights 1-2    to C's t-address,
#   heights 3-5    to A's t-address           (transparent coinbase: A shields it to Ironwood),
#   heights 6-7    to B's full unified address (v6 coinbases with one Ironwood action each),
#   heights 8-108  to C's t-address           (coinbase maturity for A's outputs).
# Usage: reset.sh <A t-address> <B unified address> <C t-address>
set -euo pipefail
H=$(dirname "$0"); . "$H/env.sh"
A="$1"; B="$2"; CT="$3"
gen() { for i in $(seq 1 60); do if zw_rpc generate "[$1]" | grep -q '"result":\["'; then return 0; fi; sleep 1; done; echo "generate failed" >&2; exit 1; }
"$H/stop.sh" || true
sleep 1
rm -rf $ZW_CHAIN_DIR/state $ZW_CHAIN_DIR/lwd-data; mkdir -p $ZW_CHAIN_DIR/state
"$H/zebrad-start.sh" "$CT"; gen 2; sleep 15
"$H/zebrad-start.sh" "$A"; gen 3; sleep 15
"$H/zebrad-start.sh" "$B"; gen 2; sleep 15
"$H/zebrad-start.sh" "$CT"; for i in 1 2 3 4 5; do gen 20; done; gen 1
echo "height $(zw_rpc getblockcount)"
"$H/lwd-start.sh"
sleep 8; tail -2 $ZW_CHAIN_DIR/lwd.log
