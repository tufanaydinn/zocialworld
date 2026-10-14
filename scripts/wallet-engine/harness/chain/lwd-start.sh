#!/bin/bash
# lightwalletd v0.5.4 in front of this chain's zebrad: gRPC 127.0.0.1:$LWD_PORT (plaintext). Fresh cache each start.
set -euo pipefail
. "$(dirname "$0")/env.sh"
D=$ZW_CHAIN_DIR
if [ -f $D/lwd.pid ] && kill -0 "$(cat $D/lwd.pid)" 2>/dev/null; then kill "$(cat $D/lwd.pid)"; sleep 1; fi
rm -rf $D/lwd-data; mkdir -p $D/lwd-data
printf 'rpcuser=x\nrpcpassword=x\nrpcbind=127.0.0.1\nrpcport=%s\n' "$ZEBRA_RPC_PORT" > $D/lwd.conf
cd $D
nohup $ZW_CHAIN_BIN/lightwalletd --no-tls-very-insecure --grpc-bind-addr 127.0.0.1:$LWD_PORT --http-bind-addr 127.0.0.1:$LWD_HTTP_PORT --zcash-conf-path $D/lwd.conf --data-dir $D/lwd-data --log-file $D/lwd.log > $D/lwd.out 2>&1 < /dev/null &
echo $! > $D/lwd.pid
echo "lightwalletd pid $(cat $D/lwd.pid) on 127.0.0.1:$LWD_PORT"
