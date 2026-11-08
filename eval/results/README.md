# Eval results

Each file is one eval run: a `summary` plus `results`, which holds every generated email with its checks and token usage. Produce a run with `npm run eval -- --label <name>`, and compare runs side by side with `npm run compare -- <name> <name> ...`.

All runs use the scenarios in `eval/scenarios.json` and the recorded lookup responses in `test/fixtures/helper-responses.json`, so the model is the only variable.
