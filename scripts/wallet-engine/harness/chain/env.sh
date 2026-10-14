# Local regtest chain for the Stage-2 engine harness (TESTING ONLY). Source this file; override any variable first.
# Binaries: zebrad 6.4.2 and lightwalletd v0.5.4 in $ZW_CHAIN_BIN. Data: $ZW_CHAIN_DIR.
: "${ZW_CHAIN_BIN:?set ZW_CHAIN_BIN to the directory with zebrad 6.4.2 and lightwalletd v0.5.4}"
: "${ZW_CHAIN_DIR:?set ZW_CHAIN_DIR to a scratch directory for the chain data}"
: "${ZEBRA_RPC_PORT:=18932}"; : "${ZEBRA_P2P_PORT:=18944}"; : "${ZEBRA_INDEXER_PORT:=18930}"
: "${LWD_PORT:=9667}"; : "${LWD_HTTP_PORT:=9668}"
: "${NU6_3_HEIGHT:=1}"
zw_rpc() { curl -s -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" "http://127.0.0.1:$ZEBRA_RPC_PORT"; }
