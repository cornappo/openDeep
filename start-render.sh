#!/bin/sh
set -eu

wallet_zip=/etc/secrets/oracle-wallet.zip
wallet_dir=/tmp/oracle-wallet

if [ ! -f "$wallet_zip" ]; then
    echo "Secret File mancante: $wallet_zip" >&2
    exit 1
fi

rm -rf "$wallet_dir"
mkdir -p "$wallet_dir"
unzip -q -o "$wallet_zip" -d "$wallet_dir"
export TNS_ADMIN="$wallet_dir"

exec npm start