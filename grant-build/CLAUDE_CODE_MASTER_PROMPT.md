# PASTE THIS INTO CLAUDE CODE

You are building "Grant," an API-powered productivity coach inside my existing tracker web app (React front end, the dashboard with Main / Fitness / Health / Water / Finance / Caffeine / Nova / Daily Tracker tiles). Grant replaces/powers the "Nova" tile. He runs a specific productivity system and must perform at a high level with full context, never skimming his knowledge base.

I am providing 7 files in this folder. Read ALL of them fully before writing any code.

## Files provided
- `GRANT_SYSTEM_PROMPT.md` — Grant's runtime doctrine and rules. This is the base system prompt.
- `GRANT_CONTEXT.md` — everything Grant knows about me. Loaded every call, after the system prompt.
- `RETRIEVAL_STRATEGY.md` — how Grant reads the knowledge base without skimming. Implement this exactly.
- `knowledge/01-work-system.md` — full doctrine: planning, arrow, night-before.
- `knowledge/02-energy-focus.md` — full doctrine: energy, focus, rest.
- `knowledge/03-execution-recovery.md` — full doctrine: execution, perfectionism, stalling, recovery.

## What to build

### 1. Backend API route for Grant
- A server-side endpoint (e.g. `/api/grant`) that calls the Anthropic Messages API. Model: `claude-sonnet-4-6` as the default, set via a config/env var (`GRANT_MODEL`), not hardcoded. Grant's work is applying a fixed doctrine to structured data, which Sonnet handles excellently at a fraction of frontier cost. Do NOT build model-routing logic in v1; the config var makes later experiments (e.g. Opus for debrief/stall conversations) a one-line change. Keep the API key server-side in an env var, NEVER in the client.
- System prompt assembly per call: `GRANT_SYSTEM_PROMPT.md` + `GRANT_CONTEXT.md` + a structured block of today's app data (tasks, energy state, tracker numbers, locked plan) + any retrieved knowledge sections.
- **Prompt caching:** mark the static prefix (system prompt + context, and knowledge sections when repeated) with `cache_control` breakpoints so repeated calls hit the cache. Large latency and cost win, implement from v1.
- **Streaming:** stream responses to the UI so Grant feels instant.
- Conversation history: pass history each call, but **window it**: keep the last ~12 turns verbatim; when a conversation exceeds that, have the server fold older turns into a 3-5 line summary block prepended to history. Grant has no memory between calls; the app owns state.

### 2. The retrieval layer (from RETRIEVAL_STRATEGY.md)
- At build time, split each of the 3 knowledge files into its H2 (`##`) sections into a JSON map `{sectionId: text, file, heading}`.
- Implement Tier 1 / Tier 2 loading: Tier 1 (system prompt + context + app data) always; Tier 2 (targeted knowledge sections) retrieved by keyword-matching the user message and current task type to section ids, capped at ~3 sections per call.
- Start with keyword routing (the table in RETRIEVAL_STRATEGY.md). Structure it so embeddings can be swapped in later without rewriting callers.

### 3. Data contract between app and Grant
Define a typed payload the app sends Grant each call:
```
{
  mode: "night_before" | "morning" | "midday" | "debrief" | "adhoc",
  now: ISO timestamp,
  energy: "full" | "medium" | "cooked" | null,
  tasks: [{ id, title, tag: "MOVER"|"PREP"|"ADMIN", category: "CLIENT"|"INNER_WORK", ageDays, isArrow, status,
            breakpointNote: { whereAmI, thinking, nextStep, context } | null }],
  arrow: taskId | null,
  arrowStreak: number,            // consecutive days the arrow LANDED
  tracker: { sleepHours, bedtime, wakeTime, meditationMin, ... },
  energyCurve: [{ hour, level }] | null,   // rolling personal averages once enough logs exist
  openLoops: [{ text, closed }],
  history: [ {role, content} ]    // windowed per the backend rule, not unbounded
}
```
Field notes: `breakpointNote` is the clarity-tax killer from the execution doctrine, captured when a task is paused so re-entry is cheap; Grant should prompt for it when a MOVER is being stopped mid-stream, and read it back when the task resumes. `energyCurve` lets Grant time the arrow to the real peak window instead of guessing. `arrowStreak` is what the streak UI runs on (arrow LANDED, not task count).
```
```
Grant reads this, never guesses at it.

### 4. Wire Grant into the app flows
Grant is the engine behind these app features (build the UI hooks that call `/api/grant`):
- Night-before wizard: dump, sort, aim one arrow, 3-question gate. Grant assists each step.
- Morning fallback: compressed version when no plan is locked.
- Energy check-in routing: full/medium/cooked changes what Grant surfaces.
- Stall helper: a "I'm stuck" button that sends current task + state, Grant applies the execution doctrine (vague? too big? fiddling? 48h MVP?).
- EOD debrief: arrow landed/partial/unfired, where energy went, one fix, then flows into aiming tomorrow.

### 5. Enforce the anti-skim + style rules
- Inject numbered rules; instruct Grant to name the rule he applies.
- Never inject a whole knowledge file raw, only targeted sections.
- Output style is enforced in the system prompt (no em-dashes, no emojis, direct, concise, English/Czech). Do not override it.

## Build order
1. Backend `/api/grant` route + Anthropic call + system prompt assembly (hardcode a stub knowledge section first, prove the call works). Include prompt caching and streaming from the start.
2. Knowledge splitter + JSON section map + bilingual keyword retrieval.
3. Data contract + wire real app data into the payload.
4. UI hooks for the 5 flows.
5. Test against these cases before calling it done:
   - EN night-before: "help me plan tomorrow" with 8 mixed tasks → Grant runs dump/sort/aim, forces exactly one arrow, runs the 3-question gate.
   - CZ morning: "nestíhám, co mám dneska dělat" with no locked plan → morning fallback, compressed, no guilt copy, one arrow.
   - Cooked day: energy="cooked" + a MOVER arrow → Grant routes to prep day, offers the 5-minute test, does not push the mover.
   - CZ stall: "nemůžu začít, odkládám to celej den" on a task with ageDays=6 → loads execution-recovery, applies vague/too-big/fiddling diagnosis, proposes the 48h MVP version.
   - Debrief: arrow=UNFIRED, bedtime past midnight → honest debrief, seed-cause question, flows into aiming tomorrow, no moralizing.
   - Retrieval check: each of the five above must show the correct knowledge sections were injected (log section ids per call).

## Constraints
- API key server-side only.
- Do not add diet/calorie/supplement advice features.
- Keep Grant's voice and rules exactly as written in the system prompt.
- Ship a working v1 of the backend call before building all the UI. 48-hour-rule the build itself: minimum viable Grant that can hold a planning conversation, then iterate.

Confirm you have read all 7 files, then start with build step 1.
