#!/usr/bin/env bash
# Generate signing keys for PICO-POE secure boot.
# Run once, keep private.pem SECRET.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KEY_DIR="$SCRIPT_DIR/../keys"
mkdir -p "$KEY_DIR"

if [ -f "$KEY_DIR/private.pem" ]; then
    echo "Keys already exist in $KEY_DIR — skipping generation."
    echo "Delete $KEY_DIR/private.pem to regenerate."
    exit 0
fi

echo "Generating secp256k1 ECDSA signing key..."
openssl ecparam -name secp256k1 -genkey -noout -out "$KEY_DIR/private.pem"

echo "Extracting public key..."
openssl ec -in "$KEY_DIR/private.pem" -pubout -out "$KEY_DIR/public.pem"

echo "Keys generated in $KEY_DIR"
echo "  private.pem — KEEP SECRET, used for signing firmware"
echo "  public.pem  — can be shared, used to verify signatures"
