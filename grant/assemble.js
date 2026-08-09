// =============================================================
// System prompt assembly.
//
// Split out from the route so the exact request Grant would receive can be
// inspected without spending an API call.
//
// Render order is load-bearing for prompt caching. Anthropic caches on a prefix
// match, so a single byte changing early invalidates everything after it:
//   1. system prompt + Jacob's context   never changes   [cache breakpoint]
//   2. retrieved Tier 2 sections         changes per topic [cache breakpoint]
//   3. mode brief + today's app data     changes per call  (no breakpoint)
// =============================================================
import { SYSTEM_PROMPT, CONTEXT } from './grant-data.js';
import { renderSections } from './retrieval.js';
import { renderAppData } from './payload.js';

// The mode says which step of the daily flow we are standing in. The doctrine
// itself lives in the system prompt; this does not restate it.
export const MODE_BRIEFS = {
  night_before:
    'NIGHT-BEFORE MODE. Run the full flow: dump, close open loops, sort by ENERGY, force exactly ONE arrow, then the 3-question gate. One arrow, never two.',
  morning:
    'MORNING FALLBACK. No plan was locked last night. Run the compressed version: aim one arrow and fire. No guilt, no lecture about not planning.',
  midday:
    'MIDDAY CHECK-IN. Route on his real energy state. Full tank fires the arrow, genuinely cooked routes to a prep day, "cannot start" on a normal tank gets the 5-minute test.',
  debrief:
    'END-OF-DAY DEBRIEF. Arrow landed, partial or unfired. Where the energy actually went. One fix. Then flow into aiming tomorrow. Honest, not moralising.',
  adhoc: 'AD HOC. Answer what he asked, in the system.',
};

export const OUTPUT_RULES = [
  '# OUTPUT RULES',
  '1. No em-dashes. No emojis unless Jacob used one first.',
  '2. Short. No step-by-step unless he asks for it.',
  '3. Match his language: he writes English and Czech, sometimes voice-transcribed. Reply in whichever he used.',
  '4. Read the app data block before answering. Never re-ask for something it already contains.',
  '5. When a call comes from a retrieved RULE BLOCK, name the block.',
  '6. If the retrieved context does not cover what is needed, say so and ask. Do not invent doctrine.',
].join('\n');

export function buildSystem({ payload, sections, foldedSummary = null }) {
  const blocks = [];

  // Block 1: the cache anchor. Must stay byte-identical across calls.
  blocks.push({
    type: 'text',
    text: `${SYSTEM_PROMPT}\n\n---\n\n${CONTEXT}\n\n---\n\n${OUTPUT_RULES}`,
    cache_control: { type: 'ephemeral' },
  });

  // Block 2: stable across a run of calls that retrieve the same sections.
  const rendered = renderSections(sections);
  if (rendered) {
    blocks.push({ type: 'text', text: rendered, cache_control: { type: 'ephemeral' } });
  }

  // Block 3: volatile. Nothing cacheable may sit below this.
  const tail = [
    `# MODE\n${MODE_BRIEFS[payload.mode] || MODE_BRIEFS.adhoc}`,
    '',
    renderAppData(payload),
  ];
  if (foldedSummary) {
    tail.push('', '# EARLIER IN THIS CONVERSATION (summary)', foldedSummary);
  }
  blocks.push({ type: 'text', text: tail.join('\n') });

  return blocks;
}

/**
 * Assemble the `messages` array. The API requires it to open on a user turn and
 * to be non-empty, both of which a windowed history can violate on its own.
 */
export function buildMessages({ kept, message }) {
  const messages = kept.length ? [...kept] : [];
  const lastUser = [...kept].reverse().find((turn) => turn.role === 'user');

  if (message && lastUser?.content !== message) {
    messages.push({ role: 'user', content: message });
  }
  if (!messages.length) {
    messages.push({ role: 'user', content: message || 'Start.' });
  }
  return messages;
}
