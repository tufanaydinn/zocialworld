#!/bin/bash
# zebrad 6.4.2 on a regtest chain with every upgrade through NU6.3 active at height NU6_3_HEIGHT (default 1).
# Usage: zebrad-start.sh <miner_address>   (stops a running zebrad of this chain by its recorded PID first)
set -euo pipefail
. "$(dirname "$0")/env.sh"
D=$ZW_CHAIN_DIR; MINER="$1"
if [ -f $D/zebrad.pid ] && kill -0 "$(cat $D/zebrad.pid)" 2>/dev/null; then
  kill "$(cat $D/zebrad.pid)"; for i in $(seq 1 40); do kill -0 "$(cat $D/zebrad.pid)" 2>/dev/null || break; sleep 0.5; done
fi
mkdir -p $D/state
cat > $D/zebrad.toml <<TOML
[network]
network = "Regtest"
listen_addr = "127.0.0.1:$ZEBRA_P2P_PORT"
initial_testnet_peers = []
initial_mainnet_peers = []
cache_dir = false

[network.testnet_parameters.activation_heights]
BeforeOverwinter = 1
Overwinter = 1
Sapling = 1
Blossom = 1
Heartwood = 1
Canopy = 1
NU5 = 1
NU6 = 1
"NU6.1" = 1
"NU6.2" = 1
"NU6.3" = $NU6_3_HEIGHT

[mining]
miner_address = "$MINER"

[rpc]
listen_addr = "127.0.0.1:$ZEBRA_RPC_PORT"
enable_cookie_auth = false
indexer_listen_addr = "127.0.0.1:$ZEBRA_INDEXER_PORT"

[state]
cache_dir = "$D/state"

[tracing]
filter = "warn,zebrad=info"
TOML
cd $D
nohup nice -n 10 $ZW_CHAIN_BIN/zebrad -c $D/zebrad.toml start >> $D/zebrad.log 2>&1 < /dev/null &
echo $! > $D/zebrad.pid
for i in $(seq 1 60); do
  if zw_rpc getblockcount | grep -q result; then echo "zebrad up (pid $(cat $D/zebrad.pid)), miner $MINER"; exit 0; fi
  sleep 1
done
echo "zebrad did not come up"; tail -20 $D/zebrad.log; exit 1
