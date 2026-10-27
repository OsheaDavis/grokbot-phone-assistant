#!/bin/sh
# Ensure the Fly volume at /data is writable, then drop root.
set -eu
data_dir="${DATA_DIR:-/data}"
mkdir -p "$data_dir"
if [ "$(id -u)" = "0" ]; then
  chown app:app "$data_dir"
  exec su-exec app node dist/index.js
fi
exec node dist/index.js
