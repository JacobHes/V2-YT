# GRANT — RETRIEVAL STRATEGY (how Grant reads the knowledge base without skimming)

The problem this solves: dumping all three knowledge files into every API call is expensive and, worse, makes the model skim. Load the right slice for the task instead.

## The two-tier load
**Tier 1, always loaded (small, every call):**
- `GRANT_SYSTEM_PROMPT.md` (the doctrine spine + flow + rules)
- `GRANT_CONTEXT.md` (Jacob's context)
- Today's app data (tasks, energy state, tracker numbers, locked plan) injected as a structured block

That alone runs the daily flow. The three big extractions are NOT loaded by default.

**Tier 2, retrieved on demand (the big files):**
Load the relevant extraction section only when the task calls for depth. Route by intent. **Jacob writes in English AND Czech (often voice-transcribed), so routing must be bilingual.** Two-layer routing: (1) the `mode` field in the payload is the primary router and is language-independent, use it first; (2) keyword matching on the message is the secondary layer and must include both languages:

| User intent / trigger (EN + CZ examples) | Load from |
|---|---|
| plan day, aim arrow, sort tasks, night-before, morning / naplánovat den, plán, šíp, roztřídit tasky, priprava na zítra, ráno, co mám dělat | `01-work-system.md` |
| energy check, cooked/full, timing, focus scattered, meditation, rest, sleep / energie, jsem cooked, vyřízenej, nemám energii, nesoustředím se, fokus, meditace, odpočinek, spánek, spát | `02-energy-focus.md` |
| stalling, can't start, perfectionism, task won't ship, carryover, fell off, bored, indecision, what to do / nemůžu začít, prokrastinuju, odkládám, nejde mi to, zaseklej, nevím co dělat, nuda, perfekcionismus, zase jsem to nedodělal | `03-execution-recovery.md` |

Keyword lists live in one config file so they can be extended when a real message misses. Normalize diacritics before matching (zasekly matches zaseklej/zaseklý). When no keywords match and mode is `adhoc`, load nothing extra and let Tier 1 handle it; if Grant then determines depth is needed, the endpoint supports a second-pass fetch.

## How to implement retrieval (pick one, in order of effort)
1. **Section-tagged chunks (recommended v1).** Pre-split each extraction into its H2 sections at build time into a JSON map `{sectionId: text}`. Keyword-match the user message + task type to section ids, inject only those sections (cap ~2-3) into the call. Cheap, deterministic, no vector DB.
2. **Embeddings retrieval (v2 if v1 misses).** Embed each H2 section, store vectors, retrieve top-k per query. Only build this if keyword routing proves too blunt.

## Anti-skim rules baked into every call
- Never inject a whole extraction file raw. Inject targeted sections.
- Number the rules in the injected context and instruct Grant to state which rule he is applying when he makes a call.
- Give Grant a checklist to run (the daily flow steps), not a vibe to absorb. Structure defeats skimming.
- If the injected context does not contain what's needed, Grant says so and asks, rather than inventing.

## Cost note
Tier-1-only calls are cheap. Tier-2 loads a few sections, not whole files. Use Sonnet for real coaching conversations; a cheaper/faster model is fine for pure sorting if you later want to trim.
