// Runs grant-actions.js against a seeded fake localStorage and drives a
// tool batch, including a declined confirmation.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const store = new Map();
const localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};
const now = new Date();
const day = (o) => { const d = new Date(now); if (now.getHours() < 6) d.setDate(d.getDate()-1); d.setDate(d.getDate()+o);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const TODAY = day(0), TOMORROW = day(1);
store.set('goals:'+TODAY, JSON.stringify([
  { id: 't1', text: 'Onboard Matthew', energy: 'mover' },
  { id: 't2', text: 'Send invoices', energy: 'admin' },
]));

const events = [];
const sandbox = { localStorage, console, Promise, Date, Math, JSON,
  window: null, Event: class { constructor(t){this.type=t;} }, CustomEvent: class { constructor(t){this.type=t;} } };
sandbox.window = sandbox;
sandbox.window.dispatchEvent = (e) => events.push(e.type);
vm.createContext(sandbox);
vm.runInContext(readFileSync('grant-actions.js','utf8'), sandbox, { filename:'grant-actions.js' });

const A = sandbox.window.GrantActions;
let fails = 0;
const check = (label, cond, detail) => { if (!cond) fails++; console.log(`  ${cond?'ok  ':'FAIL'} ${label}${detail===undefined?'':`  (${detail})`}`); };
const goals = (k) => JSON.parse(localStorage.getItem('goals:'+k) || '[]');

// batch 1: add, tag, aim, urgent, loop, energy
const r1 = await A.runTools([
  { id:'u1', name:'add_task', input:{ title:'Draft Seba flow timeline', tag:'MOVER', category:'CLIENT' } },
  { id:'u2', name:'set_category', input:{ task_id:'t1', category:'CLIENT' } },
  { id:'u3', name:'aim_arrow', input:{ task_id:'t1' } },
  { id:'u4', name:'set_urgent', input:{ task_id:'t2', urgent:true } },
  { id:'u5', name:'add_loop', input:{ text:'Ping Honza about the deadline' } },
  { id:'u6', name:'set_day_energy', input:{ energy:'cooked' } },
], async () => true);

const list = goals(TODAY);
check('add_task created a task', list.length === 3, list.length);
check('new task is tagged mover', list[2].energy === 'mover', list[2].energy);
check('new task has category', list[2].category === 'CLIENT');
check('set_category applied', list[0].category === 'CLIENT');
check('aim_arrow set the arrow', list[0].arrow === true);
check('only one arrow', list.filter(g=>g.arrow).length === 1);
check('set_urgent applied', list[1].urgent === true);
check('loop captured', JSON.parse(localStorage.getItem('loops:open')).length === 1);
check('day energy stored', JSON.parse(localStorage.getItem('energy:'+TODAY)) === 'cooked');
check('6 tool_result blocks', r1.results.length === 6, r1.results.length);
check('none reported error', r1.results.every(r=>!r.is_error));
check('re-render was notified', events.includes('storage'));

// batch 2: confirmations. push accepted, delete declined.
const r2 = await A.runTools([
  { id:'u7', name:'push_task', input:{ task_id:'t2', day:'tomorrow' } },
  { id:'u8', name:'delete_task', input:{ task_id:'t1' } },
], async (q) => !/Delete/.test(q));

check('push moved it off today', goals(TODAY).find(g=>g.id==='t2') === undefined);
check('push landed on tomorrow', goals(TOMORROW).some(g=>g.id==='t2'));
check('declined delete kept the task', goals(TODAY).some(g=>g.id==='t1'));
const declined = JSON.parse(r2.results[1].content);
check('decline is reported back', declined.declined === true && r2.results[1].is_error === true);

// batch 3: unknown id must not throw
const r3 = await A.runTools([{ id:'u9', name:'set_tag', input:{ task_id:'nope', tag:'PREP' } }], async()=>true);
check('unknown id is an error, not a crash', r3.results[0].is_error === true);
check('nothing applied on failure', r3.applied.length === 0);

console.log(fails ? `\n${fails} failing check(s)` : '\nGrant actions OK');
process.exit(fails?1:0);
