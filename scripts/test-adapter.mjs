// Runs grant-client.js's adapter against seeded localStorage in Node, then
// feeds the result through the server's own validator. Catches contract drift
// between what main.html stores and what /api/grant expects.
//   node scripts/test-adapter.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { parsePayload } from '../grant/payload.js';
import { selectSections } from '../grant/retrieval.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Yesterday and today, on main.html's 06:00 day boundary.
const now = new Date();
const day = (offset) => {
  const d = new Date(now);
  if (now.getHours() < 6) d.setDate(d.getDate() - 1);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const TODAY = day(0);
const YESTERDAY = day(-1);
const THREE_AGO = day(-3);

const seed = {
  [`goals:${THREE_AGO}`]: [
    { id: 'g-matthew', text: 'Onboard Matthew on the Klaviyo SOP', energy: 'mover' },
  ],
  [`goals:${YESTERDAY}`]: [
    { id: 'g-matthew', text: 'Onboard Matthew on the Klaviyo SOP', energy: 'mover', arrow: true, done: true, doneAt: Date.now() },
  ],
  [`goals:${TODAY}`]: [
    {
      id: 'g-matthew',
      text: 'Onboard Matthew on the Klaviyo SOP',
      energy: 'mover',
      category: 'CLIENT',
      arrow: true,
      breakpoint: {
        whereAmI: 'SOP doc half written',
        thinking: 'unsure how granular to go',
        nextStep: 'write the abandoned-cart section',
        context: 'Matthew waiting on it',
      },
    },
    { id: 'g-notion', text: 'Reorganise Notion workspace', energy: 'admin', category: 'INNER_WORK' },
    { id: 'g-invoice', text: 'Send invoices', energy: 'admin' },
  ],
  [`energy:${TODAY}`]: 'cooked',
  [`plan:${TODAY}`]: { locked: true, at: Date.now(), gate: null },
  [`daily:${TODAY}`]: { bedTime: '00:40', wakeTime: '06:10', meditation: '60' },
  'loops:open': [{ id: 'l1', text: 'Seba never got the flow timeline', createdAt: Date.now() }],
};

// ---- minimal browser surface ----
const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
const localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};

const sandbox = {
  localStorage,
  console,
  TextDecoder,
  fetch: async () => { throw new Error('network disabled in this test'); },
  document: {
    readyState: 'complete',
    // No #gmCardToday, so mount() bails out and we exercise the adapter alone.
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, addEventListener() {} }),
    addEventListener: () => {},
  },
};
sandbox.window = sandbox;
sandbox.CustomEvent = class { constructor(type) { this.type = type; } };
sandbox.window.dispatchEvent = () => {};

vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'grant-client.js'), 'utf8'), sandbox, { filename: 'grant-client.js' });

const Grant = sandbox.window.Grant;
if (!Grant) {
  console.error('FAIL: grant-client.js did not expose window.Grant');
  process.exit(1);
}

let failures = 0;
const check = (label, condition, detail) => {
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  (${detail})`}`);
};

console.log('midday payload from seeded state');
const raw = Grant.buildPayload('midday', 'jsem uplne cooked');

// The server must accept what the client builds. This is the contract check.
let parsed;
try {
  parsed = parsePayload(raw);
  console.log('  ok   server parsePayload accepted the payload');
} catch (error) {
  failures += 1;
  console.log(`  FAIL server rejected the payload: ${error.message}`);
  process.exit(1);
}

const matthew = parsed.tasks.find((t) => t.id === 'g-matthew');
const notion = parsed.tasks.find((t) => t.id === 'g-notion');

check('3 tasks read from today', parsed.tasks.length === 3, parsed.tasks.length);
check("energy tag mover -> MOVER", matthew.tag === 'MOVER', matthew.tag);
check('category passed through', matthew.category === 'CLIENT', matthew.category);
check('inner-work category kept', notion.category === 'INNER_WORK', notion.category);
check('missing category is null, not guessed', parsed.tasks.find((t) => t.id === 'g-invoice').category === null);
check('ageDays counted from first appearance', matthew.ageDays === 3, matthew.ageDays);
check('arrow resolved', parsed.arrow === 'g-matthew', parsed.arrow);
check('breakpoint note carried', matthew.breakpointNote?.nextStep === 'write the abandoned-cart section');
check('stated energy read', parsed.energy === 'cooked', parsed.energy);
check('sleep derived from bed/wake', parsed.tracker.sleepHours === 5.5, parsed.tracker.sleepHours);
check('meditation read from daily page', parsed.tracker.meditationMin === 60, parsed.tracker.meditationMin);
check('plan lock surfaced', parsed.tracker.planLocked === true);
check('open loop read', parsed.openLoops.length === 1);
check('energyCurve null, not fabricated', parsed.energyCurve === null);
check('streak counts landed arrows only', parsed.arrowStreak === 1, parsed.arrowStreak);

console.log('\nrouting on this payload');
const arrowTask = parsed.tasks.find((t) => t.id === parsed.arrow);
const sections = selectSections({ message: parsed.message, mode: parsed.mode, taskTag: arrowTask?.tag });
sections.forEach((s) => console.log(`  - ${s.id}`));
check('cooked day reaches energy doctrine', sections.some((s) => s.file === '02-energy-focus.md'));

console.log('\nnight_before reads tomorrow, not today');
const tomorrowPayload = parsePayload(Grant.buildPayload('night_before', 'plan tomorrow'));
check('tomorrow list is empty in this seed', tomorrowPayload.tasks.length === 0, tomorrowPayload.tasks.length);

console.log(`\n${failures ? `${failures} failing check(s)` : 'Adapter contract OK'}`);
process.exit(failures ? 1 : 0);
