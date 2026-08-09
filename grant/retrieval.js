// =============================================================
// Tier 2 retrieval for Grant.
//
// Tier 1 (system prompt + Jacob's context + today's app data) is always loaded
// by the caller. This module answers one question: which knowledge sections, if
// any, should be injected on top for THIS message?
//
// Two-layer routing, per RETRIEVAL_STRATEGY.md:
//   1. `mode` is the primary router and is language-independent.
//   2. Keyword matching on the message is the secondary layer, bilingual
//      (EN + CZ), matched against diacritic-stripped text so "zaseklej",
//      "zaseklý" and "zasekly" all hit.
//
// Whole files are never injected. We pick sections, capped at MAX_SECTIONS.
//
// Swapping in embeddings later means reimplementing selectSections() alone;
// every caller goes through it and gets back the same {id, file, heading, text}
// shape, so nothing downstream changes.
// =============================================================
import { SECTIONS } from './grant-data.js';

export const MAX_SECTIONS = 3;

const WORK = '01-work-system.md';
const ENERGY = '02-energy-focus.md';
const EXEC = '03-execution-recovery.md';

// Which file each mode leans on when the message itself gives us nothing.
const MODE_ROUTES = {
  night_before: [WORK],
  morning: [WORK],
  midday: [ENERGY],
  debrief: [EXEC, WORK],
  adhoc: [],
};

// Mode is the primary router, so it has to outweigh incidental keyword hits: a
// debrief that happens to contain the word "sip" is still a debrief. A STRONG
// signal (worth 5+) still overrides it, which is the point — "nemuzu zacit"
// during a night-before session must reach the execution doctrine.
const MODE_WEIGHTS = [4, 2, 1];

// Within a file, mode also biases which sections come back first. Substring
// match against the section id, so renaming a heading degrades to "no bias"
// rather than to a crash.
const MODE_SECTION_HINTS = {
  night_before: ['it-s-all-won-the-night-before', 'shoot-one-big-arrow-daily', '3-work-prep'],
  morning: ['shoot-one-big-arrow-daily', '4-the-daily-deadline-decision', '1-the-core-system'],
  midday: ['4-energy-from-action', '3-energy-drains', '5-focus-is-subtraction'],
  debrief: ['decision-rules', 'part-five-rest-recovery', '6-shoot-one-big-arrow-daily'],
  adhoc: [],
};

// Index, quote and resource sections are lookup aids, not doctrine. They should
// surface only when the message actually points at them, never as the thing we
// fall back to when nothing matches.
const LOW_PRIORITY = /(^|#)(preamble|story-anecdote-index|resources-mentioned|key-quotes|signature-formulations|source-contradiction)/;

// Keyword table. Extend this first when a real message routes wrong; it is the
// intended tuning surface and needs no other code change.
export const KEYWORDS = {
  [WORK]: [
    // EN
    'plan', 'planning', 'plan my day', 'aim', 'arrow', 'sort', 'sort tasks',
    'night before', 'tomorrow', 'morning', 'what should i do', 'prioritise',
    'prioritize', 'priority', 'schedule', 'prep', 'environment', 'lock',
    // CZ (diacritics stripped at match time)
    'naplanovat', 'naplanuj', 'planovat', 'plan dne', 'sip', 'sipy',
    'roztridit', 'tasky', 'ukoly', 'priprava', 'zitra', 'rano', 'dneska',
    'co mam delat', 'priorita', 'priority', 'rozvrh',
  ],
  [ENERGY]: [
    // EN
    'energy', 'energie', 'cooked', 'exhausted', 'tired', 'drained', 'wiped',
    'burnout', 'burnt out', 'focus', 'focused', 'scattered', 'distracted',
    'concentrate', 'meditation', 'meditate', 'rest', 'sleep', 'slept',
    'nap', 'recovery', 'peak', 'timing', 'trough',
    // CZ
    'nemam energii', 'vycerpany', 'vyrizeny', 'unaveny', 'unavenej',
    'nesoustredim', 'soustredeni', 'fokus', 'rozhozeny', 'meditace',
    'meditovat', 'odpocinek', 'odpocivat', 'spanek', 'spat', 'vyspany',
    'regenerace', 'vykon',
  ],
  [EXEC]: [
    // EN
    'stuck', 'stalling', 'stalled', 'cant start', "can't start", 'procrastinat',
    'putting it off', 'avoiding', 'perfectionism', 'perfect', 'overthinking',
    'fiddling', 'busywork', 'carryover', 'fell off', 'gave up', 'bored',
    'boring', 'indecision', 'undecided', 'ship', 'shipping', 'mvp', 'unfinished',
    // CZ
    'nemuzu zacit', 'nezacnu', 'prokrastinuju', 'prokrastinace', 'odkladam',
    'odkladani', 'nejde mi to', 'zaseklej', 'zaseknuty', 'zasekly', 'zaseknuta',
    'nevim co delat', 'nuda', 'nudi', 'perfekcionismus', 'dokonaly',
    'nedodelal', 'nedodelany', 'vzdal jsem', 'vyhybam se',
  ],
};

// A message can carry an explicit signal that outranks fuzzy keyword hits.
// These push a file to the front of the ranking rather than merely adding to it.
const STRONG_SIGNALS = {
  [EXEC]: [
    'nemuzu zacit', 'cant start', "can't start", 'prokrastinuju', 'odkladam',
    'stuck', 'zaseklej', 'zasekly', 'perfekcionismus', 'perfectionism',
  ],
  [ENERGY]: ['cooked', 'nemam energii', 'vycerpany', 'burnout', 'burnt out'],
};

export function normalize(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function countHits(haystack, needles) {
  let hits = 0;
  for (const needle of needles) {
    if (haystack.includes(normalize(needle))) hits += 1;
  }
  return hits;
}

// Rank files by keyword hits, with mode as the tiebreaker and the fallback.
function rankFiles({ message, mode, taskTag }) {
  const text = normalize(message);
  const scores = new Map();

  for (const [file, words] of Object.entries(KEYWORDS)) {
    let score = countHits(text, words);
    if (score && (STRONG_SIGNALS[file] || []).some((w) => text.includes(normalize(w)))) {
      score += 5;
    }
    if (score) scores.set(file, score);
  }

  (MODE_ROUTES[mode] || []).forEach((file, index) => {
    scores.set(file, (scores.get(file) || 0) + (MODE_WEIGHTS[index] ?? 0));
  });

  // A MOVER that is being stopped or restarted is an execution question.
  if (taskTag === 'MOVER') {
    scores.set(EXEC, (scores.get(EXEC) || 0) + 0.5);
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([file]) => file);
}

// Within a chosen file, rank its sections by how well they match the message.
// Headings count for more than body text: a hit in "Focus Is Subtraction" is a
// stronger signal than the same word buried in an anecdote.
function rankSectionsInFile(file, message, mode) {
  const text = normalize(message);
  const words = text.split(/[^a-z0-9']+/).filter((w) => w.length > 3);
  const hints = MODE_SECTION_HINTS[mode] || [];

  return Object.values(SECTIONS)
    .filter((section) => section.file === file)
    .map((section) => {
      const heading = normalize(section.heading);
      const body = normalize(section.text);
      let score = 0;
      for (const word of words) {
        if (heading.includes(word)) score += 3;
        else if (body.includes(word)) score += 1;
      }

      // Mode bias, strongest for the first hint.
      const hintIndex = hints.findIndex((hint) => section.id.includes(hint));
      if (hintIndex !== -1) score += 3 - hintIndex * 0.5;

      // Keeps index and quote sections out of the no-match fallback.
      if (LOW_PRIORITY.test(section.id)) score -= 2;

      return { section, score };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Pick the Tier 2 sections for one call.
 *
 * @param {object} input
 * @param {string} [input.message]  the user's latest message
 * @param {string} [input.mode]     night_before | morning | midday | debrief | adhoc
 * @param {string} [input.taskTag]  MOVER | PREP | ADMIN, when a task is in play
 * @param {number} [input.max]      section cap, defaults to MAX_SECTIONS
 * @returns {Array<{id, file, heading, text}>}
 */
export function selectSections({ message = '', mode = 'adhoc', taskTag = null, max = MAX_SECTIONS } = {}) {
  const files = rankFiles({ message, mode, taskTag });

  // adhoc with nothing to go on: load nothing extra and let Tier 1 handle it.
  // Grant can ask for depth on a second pass.
  if (!files.length) return [];

  const picked = [];
  const seen = new Set();

  // Take the best-matching section from each ranked file first, so a query that
  // straddles two topics gets both rather than three slices of one.
  for (const file of files) {
    if (picked.length >= max) break;
    const ranked = rankSectionsInFile(file, message, mode);
    const best = ranked[0];
    if (best && !seen.has(best.section.id)) {
      seen.add(best.section.id);
      picked.push(best.section);
    }
  }

  // Then backfill from the top-ranked file until we hit the cap.
  for (const file of files) {
    if (picked.length >= max) break;
    for (const { section } of rankSectionsInFile(file, message, mode)) {
      if (picked.length >= max) break;
      if (seen.has(section.id)) continue;
      seen.add(section.id);
      picked.push(section);
    }
  }

  return picked.slice(0, max);
}

/**
 * Render the chosen sections as the numbered-rules block the anti-skim rules
 * call for. Numbering is what lets Grant name the rule he is applying.
 */
export function renderSections(sections) {
  if (!sections.length) return '';

  const blocks = sections.map((section, index) => {
    const number = index + 1;
    return [
      `### RULE BLOCK ${number}: ${section.heading}`,
      `Source: ${section.file}  |  id: ${section.id}`,
      '',
      section.text,
    ].join('\n');
  });

  return [
    '# RETRIEVED DOCTRINE (Tier 2)',
    '',
    'These are targeted sections of your knowledge base, not the whole file.',
    'Read them fully. Do not skim.',
    'When you make a call that comes from one of these blocks, name it, e.g.',
    '"RULE BLOCK 2".',
    'If what you need is not in these blocks, say so and ask, rather than',
    'inventing it.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
