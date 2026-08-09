# Grant, build notes

What exists, how to run it, and what is deliberately not done yet.

## Files

| File | What it is |
|---|---|
| `api/grant.js` | The endpoint. Anthropic call, prompt caching, SSE streaming, history windowing. |
| `grant/assemble.js` | System prompt assembly and cache breakpoint layout. |
| `grant/retrieval.js` | Tier 2 routing. Bilingual keyword table, mode router, section ranking. |
| `grant/payload.js` | The app-to-Grant data contract. Validation and rendering. |
| `grant/grant-data.js` | Generated. Do not edit. |
| `grant-client.js` | Browser side: adapter, SSE client, panel. Loaded by `main.html`. |
| `scripts/build-knowledge.mjs` | Splits the knowledge files into H2 sections. |

## Setup

```sh
npm install
npm run build:knowledge     # re-run after editing anything in grant-build/
```

Set on the server (Vercel project settings, never in the client):

| Var | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | Server side only. |
| `GRANT_MODEL` | `claude-sonnet-5` | Swap to `claude-opus-5` for debrief or stall conversations if Sonnet proves thin. One line, no routing logic. |
| `GRANT_SUMMARY_MODEL` | `claude-haiku-4-5` | Only folds old conversation turns. |
| `GRANT_EFFORT` | `medium` | `low` through `max`. Raise if answers feel shallow, lower if replies are slow. |
| `GRANT_MAX_TOKENS` | `12000` | Caps thinking plus reply together. |

## Checks

```sh
npm run test:retrieval      # the six routing cases from the build prompt
npm run dry-run             # prompt layout and cache breakpoints, all five flows
npm run dry-run cz_stall    # full assembled prompt for one case
node scripts/test-adapter.mjs   # main.html storage -> payload -> server validation
```

All four pass. They make no API calls.

## Prompt caching

Render order is load-bearing. Anthropic caches on a prefix match, so one byte
changing early invalidates everything after it:

1. system prompt + Jacob's context, ~2400 tokens, **never changes** [breakpoint]
2. retrieved Tier 2 sections, ~1700 to 3000 tokens [breakpoint]
3. mode brief + today's app data, ~200 to 350 tokens, changes every call

Nothing cacheable may ever be added below block 3. To confirm caching is live,
watch `cache_read` in the function logs: if it stays at 0 across calls in one
session, something above the last breakpoint is changing per request.

## Not done, and why

- **No live API test.** No key was available in this environment, so every check
  above is offline. The first real call is unverified. Watch the function log
  line `[grant] usage ...` on it.
- **`energyCurve` is always null.** `energy:<date>` stores one value per day, not
  an hourly series, so there is no curve to build. Grant is told this and will
  ask rather than guess at a peak window. Timing the arrow to a real peak needs
  hourly energy logging first.
- **`category` has no UI.** The adapter reads `g.category` and sends `null` when
  it is absent. The jump-ship rule needs it to tell inner-work from client
  delivery, so it stays weak until tasks can be tagged. `Grant.setCategory(date,
  id, 'CLIENT' | 'INNER_WORK')` writes it; a control in the task row is the
  missing piece.
- **`breakpointNote` has no capture UI.** `Grant.setBreakpoint(date, id, note)`
  writes it and Grant reads it back on resume, but nothing prompts for it yet
  when a MOVER is stopped mid-stream.
- **Streaming on Vercel is unverified.** The headers and `maxDuration` are set
  for it. If replies arrive all at once instead of token by token, that is the
  platform buffering, not the client.
