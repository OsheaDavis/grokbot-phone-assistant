# Contributing

Thanks for helping.

## Issues and pull requests

- **Issue:** open one on GitHub describing the problem or idea. Do not paste phone numbers, keys or call logs.
- **Pull request:** fork the repo, make a branch, commit your change with tests, and open a PR against `main`.
  Every PR is reviewed before merge.

## Run the tests

```bash
npm install
npm test
```

All tests must pass.

## Never commit

- real phone numbers (use fictional `555-01xx` numbers)
- real names or addresses
- API keys, tokens, Twilio SIDs, or `.env` files
- call recordings, transcripts or logs

## Safety rules stay

Any change to call behavior must keep:

- the outbound allowlist (fail closed when missing or malformed)
- the owner's explicit yes for each outbound call
- the context card, checked by hash, as the only source of spoken lines
- a callback number that is not the bot's own line
