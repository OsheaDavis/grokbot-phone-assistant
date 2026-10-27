# INDEX: phone-assistant-public

Generic public version of the phone assistant, scrubbed of personal info. Made 2026-10-27 from the private repo main 472777f (git-tracked files only, no history). Not pushed anywhere.

- README.md: plain-language overview and how we built it
- GROKBOT_SETUP.md: step-by-step setup for another person's Grok Bot, with safety rules
- .env.example: env var names only, no values
- fly.toml, Dockerfile, docker-entrypoint.sh: Fly.io hosting (app name is `your-app-name`)
- config/: greetings and caller lists (placeholder known-contacts example, empty allow/block lists)
- examples/call-cards/: one generic sample context card plus a fake numbers example
- scripts/: set Fly secrets and wire the Twilio VoiceUrl (read values from env, never print them)
- src/: server, inbound bridge to xAI realtime voice, guardrails, outbound card/approval/dial
- tests/: 561 node tests, all fixtures use fake 555-01xx numbers and placeholder names
