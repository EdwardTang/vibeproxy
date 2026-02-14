# AGENTS

## Global AI Lint Compliance

This repo also follows the global doctrine in:

- `~/.cursor/.ai-lint/INDEX.md`

Required read/order before substantial changes:

1. `~/.cursor/.ai-lint/PHILOSOPHY.md`
2. `~/.cursor/.ai-lint/doctrine/languages/<language>.md`
3. `~/.cursor/.ai-lint/rejects/languages/<language>.md`
4. Override protocol when intentionally deviating

Rule precedence (highest first):

1. Rejects
2. Framework doctrine
3. Language doctrine
4. Core philosophy
5. Generic best practices

For this codebase, prioritize explicit async/error handling, no hidden side effects, no unbounded concurrency, and causal logging in Node/JS proxy paths.

## Rapid Iteration Loop

Use this loop for fast code -> build -> test cycles when working on Cursor model translation:

- `make smoke`
  - Runs `scripts/smoke-cursor-proxy.sh`
  - Calls `scripts/reset-runtime.sh` first to kill stale app/proxy processes and clear smoke temp state
  - Starts a fresh `cursor-proxy.js` on port `8319`
  - Verifies `GET /health` returns `OK`
  - Sends an OpenAI-style canary request to `POST /v1/chat/completions`

- `make rapid`
  - Runs `make app` then `make smoke`
  - Use this as the default local iteration command

## Canary Model

The smoke test defaults to the Cursor-exclusive canary model:

- `composer-1.5`

This validates the Cursor-specific route first before broader model checks.

## Override Canary Model (Optional)

You can override the canary per run:

```bash
CANARY_MODEL=cursor-small make smoke
```

## Notes

- The smoke check currently validates endpoint responsiveness and stream path health for quick feedback.
- If smoke fails, inspect `cursor-proxy.js` logs first, then rerun `make smoke` (which will reset runtime state first).
