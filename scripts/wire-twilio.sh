#!/usr/bin/env bash
# Point your Twilio number (TWILIO_PHONE_NUMBER) at this app's inbound Voice webhook.
# Uses TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and PUBLIC_BASE_URL from the environment.
# Does not print those values. Does not place a call.
set -euo pipefail

if [[ -z "${TWILIO_ACCOUNT_SID:-}" || -z "${TWILIO_AUTH_TOKEN:-}" || -z "${PUBLIC_BASE_URL:-}" ]]; then
  echo "Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or PUBLIC_BASE_URL" >&2
  exit 1
fi

case "${TWILIO_ACCOUNT_SID}${TWILIO_AUTH_TOKEN}" in
  *$'\n'*|*'#'*)
    echo "Twilio credentials contain a newline; refusing to continue" >&2
    exit 1
    ;;
esac

PHONE="${TWILIO_PHONE_NUMBER:?Set TWILIO_PHONE_NUMBER to your Twilio number in E.164}"
VOICE_URL="${PUBLIC_BASE_URL%/}/voice"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
chmod 700 "$tmpdir"

encoded_phone="$(node --input-type=commonjs -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$PHONE")"
list_url="https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json?PhoneNumber=${encoded_phone}"

umask 077
cat > "$tmpdir/list.cfg" <<EOF
silent
show-error
fail
user = "${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}"
url = "${list_url}"
output = "${tmpdir}/list.json"
EOF
chmod 600 "$tmpdir/list.cfg"

if ! curl --config "$tmpdir/list.cfg" 2>"$tmpdir/err"; then
  echo "Twilio number lookup failed" >&2
  exit 1
fi

if ! pn_sid="$(node --input-type=commonjs -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const rows = Array.isArray(data.incoming_phone_numbers) ? data.incoming_phone_numbers : [];
const row = rows.find((item) => item && item.phone_number === process.argv[2]);
if (!row || typeof row.sid !== "string" || row.sid.indexOf("PN") !== 0) process.exit(2);
process.stdout.write(row.sid);
' "$tmpdir/list.json" "$PHONE")"; then
  echo "Phone number $PHONE was not found on this Twilio account" >&2
  exit 1
fi

post_url="https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers/${pn_sid}.json"
cat > "$tmpdir/update.cfg" <<EOF
silent
show-error
fail
request = "POST"
user = "${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}"
url = "${post_url}"
output = "${tmpdir}/update.json"
EOF
chmod 600 "$tmpdir/update.cfg"

if ! curl --config "$tmpdir/update.cfg" \
  --data-urlencode "VoiceUrl=${VOICE_URL}" \
  --data-urlencode "VoiceMethod=POST" \
  2>"$tmpdir/err"; then
  echo "Twilio VoiceUrl update failed" >&2
  exit 1
fi

if ! configured="$(node --input-type=commonjs -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof data.voice_url !== "string" || data.voice_url.length === 0) process.exit(2);
process.stdout.write(data.voice_url);
' "$tmpdir/update.json")"; then
  echo "Twilio update response did not include a VoiceUrl" >&2
  exit 1
fi

echo "Configured VoiceUrl: ${configured}"
