#!/bin/bash
# Stops this chain's lightwalletd and zebrad by their recorded PIDs.
. "$(dirname "$0")/env.sh"
for p in lwd zebrad; do
  if [ -f $ZW_CHAIN_DIR/$p.pid ] && kill -0 "$(cat $ZW_CHAIN_DIR/$p.pid)" 2>/dev/null; then kill "$(cat $ZW_CHAIN_DIR/$p.pid)"; echo "stopped $p $(cat $ZW_CHAIN_DIR/$p.pid)"; fi
done
