# GROKBOT_SETUP: step-by-step setup for an AI assistant

You are helping a person set up their own copy of this phone assistant. Follow these steps in order.
Ask the person to confirm before any step that costs money, changes a live phone number, or places a call.

## Hard rules (read first)

1. **Secrets never go in chat or git.** The person types secrets directly into Fly secrets
   (`fly secrets set NAME=...` on their own machine) or a local, gitignored `.env`. Never ask them to paste
   a key, token, or SID into the conversation. Never print env vars or secret values.
2. **No call without an explicit yes for that specific call.** A general "go ahead" is not enough.
3. **Calling hours:** 8 AM to 9 PM in the callee's time zone (the code enforces 8 AM–9 PM ET; change
   `src/outbound/limits.ts` if needed).
4. **Allowlist:** `OUTBOUND_ALLOWLIST` holds the only number(s) that may be dialed. Start with the
   person's own cell for a self-test. Adding any number needs their separate yes.
5. **Callback number (47 CFR 64.1200):** outbound calls must give a callback number. Set
   `OUTBOUND_CALLBACK_NUMBER`. It must NOT be the bot's own Twilio line and must not be on the allowlist.
   The server refuses to dial otherwise.
6. **No recording by default.** Cards require `"recording": false`. Recording laws vary by state.
7. **Never put real phone numbers, names or addresses in the repo, tests or logs.** Use `555-01xx` fakes.

## 1. Accounts they need

- **Twilio**: an account and one voice-capable phone number (costs money; get their yes).
- **Fly.io**: an account and `flyctl` installed on their machine.
- **xAI**: an API key with access to the realtime voice API.
- Optional: a webhook endpoint (https) to receive call summaries.

## 2. Make their private copy

1. Copy this folder into a **private** repo.
2. Replace placeholders: `Owner` (their name) in `config/greetings.json`, `src/prompt.ts`,
   `src/outbound/card.ts`; `Example Business` / `example_returns` for their use case;
   `OUTBOUND_FROM_NUMBER` in `src/outbound/constants.ts` (their Twilio number);
   `app = "your-app-name"` in `fly.toml`; `XAI_VOICE` in `fly.toml`.
   If their name is often mispronounced, adjust the spoken substitute in `src/outbound/spoken.ts`
   and `src/bridge/protocol.ts`.
3. Run `npm install && npm test`. Fix any test fixtures that change with the new text.

## 3. Where secrets go

Names are listed in `.env.example` (no values). On Fly, set them as secrets:

```bash
fly secrets set XAI_API_KEY=... TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... \
  PUBLIC_BASE_URL=https://your-app-name.fly.dev -a your-app-name
```

`scripts/set-fly-secrets.sh` does this from their shell environment without printing values and generates
`MESSAGES_BEARER_TOKEN`. Leave all `OUTBOUND_*` values unset until inbound works.

## 4. Deploy

```bash
fly apps create your-app-name
fly volumes create phone_data --size 1 -a your-app-name
fly deploy -a your-app-name
curl https://your-app-name.fly.dev/health   # expect {"ok":true}
```

## 5. Point the Twilio VoiceUrl

With `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `PUBLIC_BASE_URL` and `TWILIO_PHONE_NUMBER` in their
environment, run `scripts/wire-twilio.sh`. Or in the Twilio console set "A call comes in" to
`POST https://your-app-name.fly.dev/voice` and the status callback to `/status`.
Ask them to call their Twilio number and confirm a summary arrives.

## Incoming calls

- **Greeting.** Lines come from `config/greetings.json` ("Hi! Owner's AI Bot here..."). Everyday lines
  rotate, holidays and seasons replace them, and an active life-context note switches to a gentle line.
  Replace "Owner" with the person's name.
- **Known contacts.** `config/callers.json` shows the shape with placeholders only
  (`known_contacts_example`: "Contact One", `+12025550111`). That key is documentation and is ignored by
  the loader. Real contacts are stored on the volume with `PUT /admin/known-people` (bearer
  `MESSAGES_BEARER_TOKEN`). A caller-ID match lets the bot greet the stored name only; it unlocks nothing.
  `allowlist` / `blocklist` in `callers.json` skip or block numbers; keep real numbers out of git.
- **Spam flagging.** Blocklisted numbers, withheld caller ID, non-phone caller IDs, and the same number
  more than 5 times in 10 minutes get a short goodbye and the `spam` flag. Money asks get `possible_scam`.
- **No personal info.** The bot never gives an address, schedule, location, family, work or money details.
  It says a fixed refusal and offers to take a message. A claimed identity unlocks nothing, and a guardrail
  checks every answer.
- **Summaries.** After every call a JSON summary (name, callback, reason, questions, urgent, flags) is
  POSTed to `SUMMARY_WEBHOOK_URL`, normally the person's Grok Bot routine webhook, signed with
  `SUMMARY_WEBHOOK_SECRET` when set.

## 6. Write a context card (outbound only)

Start from `examples/call-cards/example-returns-v1.json`. Fill in:

- `id` (lowercase, dashes), `version`, `type`
- `callee.name` and `callee.numberRef` (a key like `EXAMPLE_PARTNER`; the real number goes only in
  `/data/call-cards/numbers.json` on the volume, never in git)
- `why` and `goal` in plain words
- `script`: every line the bot may say: `opener`, `aiOffer` (must mention "AI" and "hang up"),
  `question`, `followUp`, `repeat`, `refuse`, `decline`, `close`. The only placeholder allowed is
  `[callback number]`. No digit runs. The opener must match `APPROVED_OPENER` in `src/outbound/card.ts`.
- `allowedTopics`, `give` (default none; only `callback_number`), `take`
- `end`: `maxTurns` ≤ 3, `maxSeconds` ≤ 90, voicemail `hangup_silent`
- `recording: false`

Show the full card to the person and get their yes. Copy it to `/data/call-cards/<id>.json` on the volume
(`fly ssh sftp shell`), and record its sha256.

## 7. Turn outbound on (only with their yes)

1. Set `OUTBOUND_CALLBACK_NUMBER`, `OUTBOUND_ALLOWLIST` (their own cell first), `OUTBOUND_BEARER_TOKEN`,
   then `OUTBOUND_ENABLED=true`, as Fly secrets.
2. Self-test: an approval naming the card id and hash, then a dial to their own cell, only after they say
   yes to that exact call, inside calling hours.
3. Review the outcome in `/data/call-logs/outbound/` and proposed lessons in `/data/call-lessons/`.
   Lessons are proposals; change the card only with the person's yes.

## How a phone bot on Grok Bot runs this day to day

- **LEAD file and context files.** The phone bot keeps a `LEAD.md` (current status, open items, what is
  approved) and context files split into `contexts/business/` (one file per business it may call, with
  its public number source and rules) and `contexts/personal/` (people and personal call types). No
  secrets and no private numbers go in these files.
- **Read the card before every call.** Before asking for approval, the bot reads the card on the volume,
  checks its sha256, and shows the person who is called, why, and every line it will say.
- **An explicit yes for every call.** The bot asks for a yes to that specific call (card, callee, time).
  No yes, no dial. Never call back on its own. Only 8 AM to 9 PM.
- **Lessons are proposals only.** After a call the bot reads the outcome in `/data/call-logs/outbound/`
  and lessons in `/data/call-lessons/<type>.md`, and proposes card changes. It changes nothing until the
  person approves.
- **Where summaries arrive.** Inbound and outbound summaries are POSTed to a Grok Bot routine webhook
  (`SUMMARY_WEBHOOK_URL`). The routine wakes the phone bot, which tells the person about urgent calls
  and files the rest.
- **Secrets stay in env vars.** Keys, tokens, SIDs, the allowlist and the callback number live only in
  Fly secrets or env vars. The bot never reads them back, prints them, or puts them in chat, git, logs or
  LEAD files.
