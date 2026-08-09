// Assemble the exact request Grant would receive, without sending it.
// Verifies prompt layout, cache breakpoint placement and history windowing.
//   node scripts/dry-run.mjs            summary of all five flows
//   node scripts/dry-run.mjs cz_stall   full prompt text for one case
import { selectSections } from '../grant/retrieval.js';
import { buildSystem, buildMessages } from '../grant/assemble.js';
import { parsePayload, windowHistory, HISTORY_WINDOW } from '../grant/payload.js';

const CASES = {
  en_night_before: {
    mode: 'night_before',
    now: '2026-08-09T22:10:00+02:00',
    energy: 'medium',
    message: 'help me plan tomorrow',
    tasks: [
      { id: 't1', title: 'Complex welcome flow revisions', tag: 'MOVER', category: 'CLIENT', ageDays: 2, status: 'open' },
      { id: 't2', title: 'Onboard Matthew on the Klaviyo SOP', tag: 'MOVER', category: 'CLIENT', ageDays: 9, status: 'open' },
      { id: 't3', title: 'Honza cookbook abandoned-cart copy', tag: 'MOVER', category: 'CLIENT', ageDays: 1, status: 'open' },
      { id: 't4', title: 'Stage assets for Nikol campaign', tag: 'PREP', category: 'CLIENT', ageDays: 0, status: 'open' },
      { id: 't5', title: 'Send invoices', tag: 'ADMIN', category: 'CLIENT', ageDays: 4, status: 'open' },
      { id: 't6', title: 'Reorganise Notion workspace', tag: 'ADMIN', category: 'INNER_WORK', ageDays: 11, status: 'open' },
      { id: 't7', title: 'Ascension Secrets module 3', tag: 'PREP', category: 'INNER_WORK', ageDays: 3, status: 'open' },
      { id: 't8', title: 'Build a better task tracker view', tag: 'MOVER', category: 'INNER_WORK', ageDays: 6, status: 'open' },
    ],
    arrow: null,
    arrowStreak: 3,
    tracker: { sleepHours: 6.5, bedtime: '00:40', wakeTime: '07:10', meditationMin: 60 },
    openLoops: [{ text: 'Seba never got the flow timeline', closed: false }],
    history: [],
  },

  cz_morning: {
    mode: 'morning',
    now: '2026-08-10T08:40:00+02:00',
    energy: null,
    message: 'nestíhám, co mám dneska dělat',
    tasks: [
      { id: 't2', title: 'Onboard Matthew on the Klaviyo SOP', tag: 'MOVER', category: 'CLIENT', ageDays: 10, status: 'open' },
      { id: 't5', title: 'Send invoices', tag: 'ADMIN', category: 'CLIENT', ageDays: 5, status: 'open' },
    ],
    arrow: null,
    arrowStreak: 0,
    tracker: { sleepHours: 5.5, bedtime: '01:10', wakeTime: '06:55' },
    openLoops: [],
    history: [],
  },

  cooked_day: {
    mode: 'midday',
    now: '2026-08-10T13:20:00+02:00',
    energy: 'cooked',
    message: 'jsem uplne cooked',
    tasks: [
      { id: 't2', title: 'Onboard Matthew on the Klaviyo SOP', tag: 'MOVER', category: 'CLIENT', ageDays: 10, isArrow: true, status: 'open' },
      { id: 't4', title: 'Stage assets for Nikol campaign', tag: 'PREP', category: 'CLIENT', ageDays: 1, status: 'open' },
    ],
    arrow: 't2',
    arrowStreak: 0,
    tracker: { sleepHours: 4.5, bedtime: '01:40', wakeTime: '06:10', meditationMin: 60 },
    energyCurve: [
      { hour: 8, level: 'medium' }, { hour: 10, level: 'full' }, { hour: 13, level: 'medium' },
      { hour: 15, level: 'cooked' }, { hour: 19, level: 'medium' },
    ],
    openLoops: [],
    history: [],
  },

  cz_stall: {
    mode: 'adhoc',
    now: '2026-08-10T15:05:00+02:00',
    energy: 'medium',
    message: 'nemůžu začít, odkládám to celej den',
    tasks: [
      {
        id: 't2',
        title: 'Onboard Matthew on the Klaviyo SOP',
        tag: 'MOVER',
        category: 'CLIENT',
        ageDays: 6,
        isArrow: true,
        status: 'open',
        breakpointNote: {
          whereAmI: 'SOP doc half written, flow section empty',
          thinking: 'unsure how granular the steps should be',
          nextStep: 'write the abandoned-cart section end to end',
          context: 'Klaviyo tab open, Matthew waiting on it',
        },
      },
    ],
    arrow: 't2',
    arrowStreak: 0,
    tracker: { sleepHours: 6, bedtime: '00:20', wakeTime: '06:20' },
    openLoops: [],
    history: [],
  },

  debrief: {
    mode: 'debrief',
    now: '2026-08-10T23:50:00+02:00',
    energy: 'cooked',
    message: 'sip jsem nevystrelil',
    tasks: [
      { id: 't2', title: 'Onboard Matthew on the Klaviyo SOP', tag: 'MOVER', category: 'CLIENT', ageDays: 6, isArrow: true, status: 'UNFIRED' },
      { id: 't6', title: 'Reorganise Notion workspace', tag: 'ADMIN', category: 'INNER_WORK', ageDays: 12, status: 'done' },
    ],
    arrow: 't2',
    arrowStreak: 0,
    tracker: { sleepHours: 6, bedtime: '00:20', wakeTime: '06:20', meditationMin: 60 },
    openLoops: [{ text: 'Seba never got the flow timeline', closed: false }],
    history: [],
  },
};

function assemble(raw) {
  const payload = parsePayload(raw);
  const { kept, overflow } = windowHistory(payload.history, HISTORY_WINDOW);
  const arrowTask = payload.tasks.find((t) => t.id === payload.arrow);
  const sections = selectSections({
    message: payload.message,
    mode: payload.mode,
    taskTag: arrowTask?.tag || null,
  });
  const system = buildSystem({ payload, sections, foldedSummary: null });
  const messages = buildMessages({ kept, message: payload.message });
  return { payload, sections, system, messages, overflow };
}

const only = process.argv[2];

if (only) {
  if (!CASES[only]) {
    console.error(`Unknown case: ${only}. Options: ${Object.keys(CASES).join(', ')}`);
    process.exit(1);
  }
  const { system, messages } = assemble(CASES[only]);
  system.forEach((block, index) => {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`SYSTEM BLOCK ${index + 1}  cache_control=${block.cache_control ? 'ephemeral' : 'none'}`);
    console.log('='.repeat(70));
    console.log(block.text);
  });
  console.log(`\n${'='.repeat(70)}\nMESSAGES\n${'='.repeat(70)}`);
  console.log(JSON.stringify(messages, null, 2));
  process.exit(0);
}

// ~3.5 chars per token is a rough guide, enough to check we clear the 1024-token
// minimum cacheable prefix. Real counts come from usage on a live call.
const est = (chars) => Math.round(chars / 3.5);
let anchorChars = null;
let failures = 0;

for (const [name, raw] of Object.entries(CASES)) {
  const { system, messages, sections } = assemble(raw);

  // The cache anchor must be byte-identical across every call, or nothing
  // downstream of it ever gets a cache hit.
  if (anchorChars === null) anchorChars = system[0].text.length;
  else if (system[0].text.length !== anchorChars) {
    console.log(`  !! block 1 differs across cases, cache will never hit`);
    failures += 1;
  }

  // Cacheable blocks must all precede the volatile tail.
  const lastCached = system.map((b) => Boolean(b.cache_control)).lastIndexOf(true);
  if (lastCached === system.length - 1) {
    console.log(`  !! ${name}: volatile block carries a cache breakpoint`);
    failures += 1;
  }

  console.log(`${name}`);
  console.log(`  system blocks: ${system.length}   messages: ${messages.length}`);
  system.forEach((block, index) => {
    console.log(
      `    block ${index + 1}: ${String(block.text.length).padStart(6)} chars  ~${String(est(block.text.length)).padStart(5)} tok  cache=${block.cache_control ? 'yes' : 'no '}`
    );
  });
  console.log(`  sections: ${sections.map((s) => s.id).join(', ') || '(none)'}`);
  console.log();
}

console.log(`Cache anchor: ${anchorChars} chars, ~${est(anchorChars)} tokens (needs >1024 to cache).`);
console.log(failures ? `${failures} problem(s)` : 'Prompt layout OK');
process.exit(failures ? 1 : 0);
