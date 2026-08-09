// =============================================================
// The data contract between the tracker app and Grant.
//
// Grant reads this block. He never guesses at it, and he never re-asks for
// anything it already contains. Validation lives here rather than in the route
// so the shape has exactly one definition.
// =============================================================

export const MODES = ['night_before', 'morning', 'midday', 'debrief', 'adhoc'];
export const ENERGY_STATES = ['full', 'medium', 'cooked'];
export const TAGS = ['MOVER', 'PREP', 'ADMIN'];
export const CATEGORIES = ['CLIENT', 'INNER_WORK'];

/** Turns per conversation kept verbatim before older ones get folded. */
export const HISTORY_WINDOW = 12;

export class PayloadError extends Error {}

function pick(value, allowed, field) {
  if (value === null || value === undefined) return null;
  if (!allowed.includes(value)) {
    throw new PayloadError(`${field} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Validate and normalise the request body. Throws PayloadError on bad input. */
export function parsePayload(body) {
  if (!body || typeof body !== 'object') {
    throw new PayloadError('Body must be a JSON object');
  }

  const mode = pick(body.mode, MODES, 'mode') || 'adhoc';
  const tasks = Array.isArray(body.tasks) ? body.tasks : [];

  return {
    mode,
    now: typeof body.now === 'string' ? body.now : null,
    energy: pick(body.energy, ENERGY_STATES, 'energy'),
    tasks: tasks.map((task, index) => ({
      id: task?.id ?? `task-${index}`,
      title: String(task?.title ?? '').trim(),
      tag: pick(task?.tag, TAGS, 'tasks[].tag'),
      category: pick(task?.category, CATEGORIES, 'tasks[].category'),
      ageDays: Number.isFinite(task?.ageDays) ? task.ageDays : null,
      isArrow: Boolean(task?.isArrow),
      status: task?.status ?? null,
      breakpointNote: task?.breakpointNote ?? null,
    })),
    arrow: body.arrow ?? null,
    arrowStreak: Number.isFinite(body.arrowStreak) ? body.arrowStreak : 0,
    tracker: body.tracker && typeof body.tracker === 'object' ? body.tracker : {},
    energyCurve: Array.isArray(body.energyCurve) ? body.energyCurve : null,
    openLoops: Array.isArray(body.openLoops) ? body.openLoops : [],
    history: Array.isArray(body.history) ? body.history : [],
    message: typeof body.message === 'string' ? body.message : '',
  };
}

function formatBreakpointNote(note) {
  if (!note) return null;
  const parts = [
    note.whereAmI && `where I am: ${note.whereAmI}`,
    note.thinking && `thinking: ${note.thinking}`,
    note.nextStep && `next step: ${note.nextStep}`,
    note.context && `context: ${note.context}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' | ') : null;
}

function formatTask(task) {
  const bits = [task.tag, task.category].filter(Boolean).join('/');
  const age = task.ageDays === null ? '' : `, ${task.ageDays}d old`;
  const status = task.status ? `, ${task.status}` : '';
  const arrow = task.isArrow ? ' [ARROW]' : '';
  const head = `- [${task.id}] ${task.title} (${bits || 'untagged'}${age}${status})${arrow}`;
  const note = formatBreakpointNote(task.breakpointNote);
  // The breakpoint note is the clarity-tax killer. Reading it back on resume is
  // the whole point of having captured it, so it goes right under its task.
  return note ? `${head}\n    breakpoint note: ${note}` : head;
}

function formatTracker(tracker) {
  const entries = Object.entries(tracker).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return 'No tracker numbers logged.';
  return entries.map(([key, value]) => `- ${key}: ${value}`).join('\n');
}

function formatEnergyCurve(curve) {
  if (!curve || !curve.length) {
    return 'Not enough logs yet. Do not guess his peak window; ask or use the stated state.';
  }
  const line = curve
    .slice()
    .sort((a, b) => a.hour - b.hour)
    .map((point) => `${String(point.hour).padStart(2, '0')}:00 ${point.level}`)
    .join('  ');
  return `Rolling personal averages: ${line}`;
}

/**
 * Render the payload as the structured block injected after Tier 1.
 * Kept last in the system array because it changes every call and would
 * otherwise invalidate the cached prefix above it.
 */
export function renderAppData(payload) {
  const arrowTask = payload.tasks.find((t) => t.id === payload.arrow);

  const lines = [
    "# TODAY'S APP DATA (authoritative. Read it, do not guess or re-ask.)",
    '',
    `Mode: ${payload.mode}`,
    `Now: ${payload.now || 'unknown'}`,
    `Stated energy: ${payload.energy || 'not stated'}`,
    '',
    '## Tasks',
    payload.tasks.length ? payload.tasks.map(formatTask).join('\n') : 'No tasks in the app.',
    '',
    '## Arrow',
    payload.arrow
      ? `Aimed at: ${arrowTask ? arrowTask.title : payload.arrow} (id ${payload.arrow})`
      : 'No arrow aimed.',
    `Arrow streak: ${payload.arrowStreak} consecutive days LANDED.`,
    '',
    '## Tracker',
    formatTracker(payload.tracker),
    '',
    '## Energy curve',
    formatEnergyCurve(payload.energyCurve),
    '',
    '## Open loops',
    payload.openLoops.length
      ? payload.openLoops
          .map((loop) => `- [${loop.closed ? 'closed' : 'OPEN'}] ${loop.text}`)
          .join('\n')
      : 'None recorded.',
  ];

  return lines.join('\n');
}

/**
 * Trim conversation history to the last HISTORY_WINDOW turns.
 * Returns the kept turns plus the older ones, which the caller folds into a
 * summary. Grant has no memory between calls; the app owns this state.
 */
export function windowHistory(history, windowSize = HISTORY_WINDOW) {
  const clean = history
    .filter((turn) => turn && (turn.role === 'user' || turn.role === 'assistant'))
    .map((turn) => ({ role: turn.role, content: String(turn.content ?? '') }))
    .filter((turn) => turn.content.trim().length > 0);

  if (clean.length <= windowSize) return { kept: clean, overflow: [] };

  let cut = clean.length - windowSize;
  // The API requires the first message to be a user turn, so never open the
  // window on an assistant reply.
  while (cut < clean.length && clean[cut].role !== 'user') cut += 1;

  return { kept: clean.slice(cut), overflow: clean.slice(0, cut) };
}
