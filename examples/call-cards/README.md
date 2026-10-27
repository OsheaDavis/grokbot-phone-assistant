# Context card examples

Real cards live on the Fly volume at `$DATA_DIR/call-cards/<id>.json`; real numbers live only in
`$DATA_DIR/call-cards/numbers.json` (never in git). These files are examples with a fake 555 number.
Every outbound approval must name a card id and its sha256 hash (`cardHash` = sha256 of the card's
canonical JSON). The hash is re-checked at approval, at dial, and on every call turn.

`example-returns-v1.json` is the one generic sample card. `numbers.example.json` maps its `numberRef` to a fake number.
