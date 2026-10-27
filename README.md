# Phone assistant (generic public version)

A small Node.js server that answers a phone number with an AI voice, takes a message, and sends you a
summary. It can also place tightly limited outbound calls, but only after a human approves each one.

Everything personal has been replaced with placeholders: the owner is "Owner", the business is
"Example Business", the callee is "Example Partner", and every phone number is a fictional
`555-01xx` style number. Replace them with your own values in your own private copy.

## The basic setup

- **Twilio number.** You buy a phone number on Twilio. Its "A call comes in" webhook (VoiceUrl) points at
  `https://<your-app-name>.fly.dev/voice`. Twilio signs every request; the server rejects bad signatures.
- **Fly.io hosting.** The server runs as one always-on Fly machine (`fly.toml`) with a small volume
  mounted at `/data` for call logs, cards and admin files. Secrets live in Fly secrets, never in git.
- **The Grok voice side.** For each call, Twilio streams audio (G.711 u-law) over a websocket to
  `/media-stream`. The server bridges it to the xAI realtime voice API
  (`wss://api.x.ai/v1/realtime`, key in `XAI_API_KEY`). The voice is set by `XAI_VOICE`.

## Part 1: Incoming calls

1. Twilio POSTs `/voice`. Signature checked; blocklisted, withheld, or spammy callers get a short goodbye.
2. Everyone else is connected to `/media-stream`, which opens the xAI realtime session.
3. The bot speaks a greeting from `config/greetings.json` ("Hi! Owner's AI Bot here...").
4. It takes a message: name, callback number, reason, any questions, and an urgent flag.
5. It never gives out personal details (address, schedule, family, work, money). A guardrail checks
   every model answer and replaces anything that leaks with a fixed refusal.
6. After the call, a JSON log is saved and a summary is POSTed to your webhook.

## Part 2: Outgoing calls (approval card plus fail-closed checks)

Outbound is off unless `OUTBOUND_ENABLED` is set. Each call needs:

- a **context card** (see `examples/call-cards/example-returns-v1.json`): who is called, why, the goal,
  every line the bot may say, what it may give (only the callback number) and take, and when to hang up;
- an **approval** that names the card id and its sha256 hash, re-checked at approval, at dial and on
  every turn;
- the callee number on `OUTBOUND_ALLOWLIST` (one E.164 number; missing or malformed = no calls);
- a valid `OUTBOUND_CALLBACK_NUMBER` that is not the bot's own line and not on the allowlist
  (47 CFR 64.1200 requires a callback number);
- calling hours (8 AM to 9 PM ET), max 3 turns, max 90 seconds, recording off, silent hang-up on voicemail.

On the call, every spoken line is fixed text from the card. The model only labels the reply
(YES, NO, UNCLEAR, OFFTOPIC, DECLINE). Anything off the card means a polite refusal and hang-up.
Anything unset or invalid returns 400/403 and nothing is dialed.

## Part 3: How a phone bot on Grok Bot runs this day to day

A Grok Bot "phone bot" operates the server for the owner. It keeps a LEAD file and context files
(`business/` and `personal/`), reads the card before every call, gets the owner's explicit yes for each
call, logs lessons as proposals only, receives summaries through a Grok Bot routine webhook, and keeps
every secret in env vars. Full steps are in `GROKBOT_SETUP.md`.

## Call summaries to a webhook

Set `SUMMARY_WEBHOOK_URL` (https only). Optional `SUMMARY_WEBHOOK_SECRET` adds an HMAC-SHA256
`X-Summary-Signature`; optional `SUMMARY_WEBHOOK_AUTH` adds an `Authorization` header. Delivery refuses
private/loopback addresses, does not follow redirects, retries 3 times, and redacts card/bank digits.
`GET /messages` (bearer `MESSAGES_BEARER_TOKEN`) lists stored messages.

## Run locally

```bash
npm install
npm test        # 561 tests
npm run build
npm start       # GET /health -> {"ok":true}
```

## How we built it

We built it in small reviewed steps with AI coding agents: a plan first, then inbound only (greeting,
message taking, summaries), then many rounds of red-team tests against prompt injection, personal-info
leaks and money scams, then outbound in two stages. Stage 1 added the allowlist and approval gate.
Stage 2 added context cards with hash checks, fixed spoken lines and a label-only model. Every change
went through a branch, a test run and a second agent's cross-review before merge, and no call was ever
placed without the owner's explicit yes.

See `GROKBOT_SETUP.md` for a step-by-step setup guide written for an AI assistant.

## License and contributing

MIT licensed, see [LICENSE](LICENSE). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).
