#!/usr/bin/env bash
# Set Fly secrets from the current environment. Never prints secret values.
# Generates MESSAGES_BEARER_TOKEN with openssl when it is unset.
# Writes a generated bearer to .messages-bearer (mode 600). That file is gitignored.
set -euo pipefail

if command -v flyctl >/dev/null 2>&1; then
  FLY=(flyctl)
elif command -v fly >/dev/null 2>&1; then
  FLY=(fly)
else
  echo "flyctl is not installed" >&2
  exit 1
fi

required=(XAI_API_KEY TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN PUBLIC_BASE_URL)
missing=0
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env: ${name}" >&2
    missing=1
  fi
done
if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

generated=0
if [[ -z "${MESSAGES_BEARER_TOKEN:-}" ]]; then
  MESSAGES_BEARER_TOKEN="$(openssl rand -hex 32)"
  generated=1
fi

names=(
  XAI_API_KEY
  XAI_VOICE
  XAI_PRONUNCIATION_REPLACE
  TWILIO_ACCOUNT_SID
  TWILIO_AUTH_TOKEN
  PUBLIC_BASE_URL
  SUMMARY_WEBHOOK_URL
  SUMMARY_WEBHOOK_SECRET
  SUMMARY_WEBHOOK_AUTH
  MESSAGES_BEARER_TOKEN
  DATA_DIR
)

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
chmod 700 "$tmpdir"
umask 077
: > "$tmpdir/secrets.env"

echo "Setting Fly secrets for these names:"
for name in "${names[@]}"; do
  value="${!name:-}"
  if [[ -z "$value" ]]; then
    continue
  fi
  if [[ "$value" == *$'\n'* ]]; then
    echo "Env ${name} contains a newline; refusing to import" >&2
    exit 1
  fi
  printf '%s=%s\n' "$name" "$value" >> "$tmpdir/secrets.env"
  echo "  ${name}"
done

if [[ "$generated" -eq 1 ]]; then
  printf '%s\n' "$MESSAGES_BEARER_TOKEN" > .messages-bearer
  chmod 600 .messages-bearer
  echo "Generated MESSAGES_BEARER_TOKEN. Value written to .messages-bearer (mode 600), not printed." >&2
fi

set +e
"${FLY[@]}" secrets import < "$tmpdir/secrets.env" >"$tmpdir/out" 2>&1
status=$?
set -e
if [[ "$status" -ne 0 ]]; then
  echo "fly secrets import failed" >&2
  node --input-type=commonjs -e '
const fs = require("fs");
let text = fs.readFileSync(process.argv[1], "utf8");
for (const [key, value] of Object.entries(process.env)) {
  if (!value || value.length < 8) continue;
  if (!/KEY|TOKEN|SECRET|SID|BEARER|URL|AUTH/.test(key)) continue;
  text = text.split(value).join("[REDACTED]");
}
process.stderr.write(text);
' "$tmpdir/out" >&2
  exit 1
fi

echo "Fly secrets updated."
