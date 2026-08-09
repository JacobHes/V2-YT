// Routing check for the six cases in the build prompt.
// Pure retrieval — makes no API calls.
//   node scripts/test-retrieval.mjs
import { selectSections } from '../grant/retrieval.js';

const CASES = [
  {
    name: 'EN night-before: "help me plan tomorrow", 8 mixed tasks',
    input: { message: 'help me plan tomorrow', mode: 'night_before' },
    expectFile: '01-work-system.md',
  },
  {
    name: 'CZ morning: "nestiham, co mam dneska delat", no locked plan',
    input: { message: 'nestíhám, co mám dneska dělat', mode: 'morning' },
    expectFile: '01-work-system.md',
  },
  {
    name: 'Cooked day: energy=cooked, MOVER arrow',
    input: { message: 'jsem uplne cooked', mode: 'midday', taskTag: 'MOVER' },
    expectFile: '02-energy-focus.md',
  },
  {
    name: 'CZ stall: "nemuzu zacit, odkladam to celej den", ageDays=6',
    input: { message: 'nemůžu začít, odkládám to celej den', mode: 'adhoc', taskTag: 'MOVER' },
    expectFile: '03-execution-recovery.md',
  },
  {
    name: 'Debrief: arrow UNFIRED, bedtime past midnight',
    input: { message: 'sip jsem nevystrelil, slo jsem spat po pulnoci', mode: 'debrief' },
    expectFile: '03-execution-recovery.md',
  },
  {
    name: 'Adhoc with no signal: Tier 1 only',
    input: { message: 'ok', mode: 'adhoc' },
    expectFile: null,
  },
];

let failures = 0;

for (const testCase of CASES) {
  const sections = selectSections(testCase.input);
  const files = [...new Set(sections.map((s) => s.file))];
  const ok = testCase.expectFile === null ? sections.length === 0 : files[0] === testCase.expectFile;

  if (!ok) failures += 1;

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${testCase.name}`);
  console.log(`      expected primary: ${testCase.expectFile ?? '(no sections)'}`);
  console.log(`      got:              ${files.join(', ') || '(no sections)'}`);
  for (const section of sections) console.log(`        - ${section.id}`);
  console.log();
}

console.log(failures ? `${failures} failing case(s)` : 'All routing cases pass');
process.exit(failures ? 1 : 0);
