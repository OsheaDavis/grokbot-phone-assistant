import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Banned in every source file, including the outbound dialer. */
const FORBIDDEN = [
  /\/Calls(?:\.json)?\b/,
  /Messages\.json/,
  /googleapis/,
  /<Dial[\s>/]/,
  /<Record[\s>/]/,
  /twilio\.rest/,
  /new Twilio/,
  /from\(["']twilio["']\)/,
  /api\.twilio\.com/,
];

/** Twilio call-create may appear only in the dialer. */
const DIALER_ONLY = [/calls\.create/, /client\.calls/, /call-create/];
const DIALER_REL = "src/outbound/dialer.ts";
/** The one REST client file may name the Twilio host and the Calls resource, nothing else. */
const CLIENT_REL = "src/outbound/twilio-client.ts";
const CLIENT_ALLOWED = new Set([/\/Calls(?:\.json)?\b/.source, /api\.twilio\.com/.source]);

test("application source places no call except the outbound dialer, and does not record", () => {
  const files = listTs(path.join(root, "src"));
  let dialers = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file).split(path.sep).join("/");
    for (const pattern of FORBIDDEN) {
      if (rel === CLIENT_REL && CLIENT_ALLOWED.has(pattern.source)) continue;
      assert.doesNotMatch(text, pattern, `${rel} ${pattern.source}`);
    }
    if (rel !== CLIENT_REL) {
      // Only src/index.ts may build the client; only the dialer may invoke it.
      if (rel !== "src/index.ts") assert.doesNotMatch(text, /twilio-client/, rel);
      assert.doesNotMatch(text, /createTwilioRestClient/, rel);
    }
    assert.doesNotMatch(text, /createWriteStream/, rel);
    assert.doesNotMatch(text, /\.wav/, rel);
    if (rel === DIALER_REL) {
      dialers += 1;
      assert.match(text, /calls\.create/);
      assert.match(text, /call-create/);
    } else {
      for (const pattern of DIALER_ONLY) {
        assert.doesNotMatch(text, pattern, `${rel} ${pattern.source}`);
      }
    }
  }
  assert.equal(dialers, 1);
});

test("the REST client file hits only the Calls resource, never records, and never invokes call-create itself", () => {
  const text = fs.readFileSync(path.join(root, CLIENT_REL), "utf8");
  const hosts = text.match(/https:\/\/[^\s"'`]+/g) ?? [];
  assert.deepEqual(hosts, ["https://api.twilio.com/2010-04-01/Accounts"]);
  assert.equal((text.match(/Calls\.json/g) ?? []).length, 1);
  assert.match(text, /form\.set\("Record", "false"\)/);
  assert.doesNotMatch(text, /IncomingPhoneNumbers|Messages|Recordings|Conferences/);
  for (const pattern of DIALER_ONLY) assert.doesNotMatch(text, pattern);
  const index = fs.readFileSync(path.join(root, "src/index.ts"), "utf8");
  assert.match(index, /outboundClientFor\(/);
});

test("operator scripts only configure the inbound number and do not print secrets", () => {
  const wire = fs.readFileSync(path.join(root, "scripts/wire-twilio.sh"), "utf8");
  const secrets = fs.readFileSync(path.join(root, "scripts/set-fly-secrets.sh"), "utf8");
  assert.match(wire, /IncomingPhoneNumbers/);
  assert.doesNotMatch(wire, /\/Calls/);
  assert.doesNotMatch(wire, /Messages\.json/);
  assert.doesNotMatch(wire, /set -x/);
  assert.doesNotMatch(wire, /echo\b[^\n]*\$\{?(TWILIO_AUTH_TOKEN|TWILIO_ACCOUNT_SID|XAI_API_KEY)/);
  assert.doesNotMatch(secrets, /set -x/);
  assert.doesNotMatch(secrets, /echo\b[^\n]*\$\{?(TWILIO_AUTH_TOKEN|XAI_API_KEY|SUMMARY_WEBHOOK_SECRET|SUMMARY_WEBHOOK_AUTH|MESSAGES_BEARER_TOKEN)/);
});

test(".env.example lists names only", () => {
  const text = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    assert.match(line, /^[A-Z0-9_]+=$/);
  }
  assert.match(text, /^XAI_API_KEY=$/m);
  assert.match(text, /^TWILIO_AUTH_TOKEN=$/m);
  assert.match(text, /^MESSAGES_BEARER_TOKEN=$/m);
  assert.match(text, /^SUMMARY_WEBHOOK_SECRET=$/m);
  assert.match(text, /^SUMMARY_WEBHOOK_AUTH=$/m);
});
