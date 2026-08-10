// =============================================================
// The tools Grant can use to act on the tracker.
//
// Definitions live here so the server and the browser cannot drift: the server
// sends this list to the model, the browser executes what comes back.
//
// Every tool takes a task by its `id`, which the payload already carries, so
// Grant never addresses a task by position or by guessing at its text.
//
// `confirm: true` marks a tool the browser must ask about before running.
// Adding, tagging and aiming are cheap to undo; moving a task to another day
// or deleting it is not, and one misread sentence should not cost work.
// =============================================================

export const TOOLS = [
  {
    name: 'add_task',
    description:
      'Add a task to a day. Use this when Jacob describes work that is not yet on the list. Returns the new task id.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The task as it should read on the list. Concrete and specific.' },
        tag: { type: 'string', enum: ['MOVER', 'PREP', 'ADMIN'], description: 'Energy tag. Omit if genuinely unclear.' },
        category: { type: 'string', enum: ['CLIENT', 'INNER_WORK'], description: 'Client delivery or inner work.' },
        day: { type: 'string', enum: ['today', 'tomorrow'], description: 'Defaults to today.' },
        urgent: { type: 'boolean', description: 'Only when Jacob says it is urgent.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'set_tag',
    description: 'Set or clear the energy tag on an existing task.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        tag: { type: 'string', enum: ['MOVER', 'PREP', 'ADMIN', 'NONE'] },
      },
      required: ['task_id', 'tag'],
    },
  },
  {
    name: 'set_category',
    description:
      'Mark a task as client delivery or inner work. This is what lets you see inner work crowding out client delivery.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        category: { type: 'string', enum: ['CLIENT', 'INNER_WORK'] },
      },
      required: ['task_id', 'category'],
    },
  },
  {
    name: 'aim_arrow',
    description:
      'Aim the arrow at one task. There is only ever one arrow per day, so this clears any previous one.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'set_urgent',
    description: 'Flag a task urgent, or clear the flag.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        urgent: { type: 'boolean' },
      },
      required: ['task_id', 'urgent'],
    },
  },
  {
    name: 'complete_task',
    description: 'Tick a task off, or untick it.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        done: { type: 'boolean' },
      },
      required: ['task_id', 'done'],
    },
  },
  {
    name: 'set_day_energy',
    description: "Record Jacob's energy state for today when he states it.",
    input_schema: {
      type: 'object',
      properties: { energy: { type: 'string', enum: ['full', 'medium', 'cooked', 'none'] } },
      required: ['energy'],
    },
  },
  {
    name: 'add_loop',
    description: 'Capture an open loop so it stops taking up head space.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'capture_breakpoint',
    description:
      'Store a breakpoint note on a task being stopped mid-stream, so re-entry is cheap. Ask for the parts you do not have rather than inventing them.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        whereAmI: { type: 'string' },
        thinking: { type: 'string' },
        nextStep: { type: 'string' },
        context: { type: 'string' },
      },
      required: ['task_id', 'nextStep'],
    },
  },
  {
    name: 'add_step',
    description:
      'Add a step to a task\'s breakdown. Use this on the arrow when it is really several actions that batch together.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['task_id', 'text'],
    },
  },
  {
    name: 'complete_step',
    description: 'Tick a step of a task\'s breakdown off by its text, or untick it.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        text: { type: 'string', description: 'The step text, matched case-insensitively.' },
        done: { type: 'boolean' },
      },
      required: ['task_id', 'text', 'done'],
    },
  },
  {
    name: 'push_task',
    description: 'Move a task to another day.',
    confirm: true,
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        day: { type: 'string', enum: ['today', 'tomorrow'] },
      },
      required: ['task_id', 'day'],
    },
  },
  {
    name: 'delete_task',
    description: 'Remove a task entirely. Prefer completing or pushing it.',
    confirm: true,
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
];

/** The shape the Messages API wants: no `confirm`, that is ours. */
export const API_TOOLS = TOOLS.map(function (t) {
  return { name: t.name, description: t.description, input_schema: t.input_schema };
});

export const CONFIRM_TOOLS = TOOLS.filter(function (t) { return t.confirm; })
  .map(function (t) { return t.name; });

export const TOOL_RULES = [
  '# ACTING ON THE TRACKER',
  'You can change the tracker yourself with the tools you have. Use them.',
  '1. When Jacob describes work, add it. Do not tell him to add it.',
  '2. Tag what you add. An untagged task cannot be sorted by energy.',
  '3. Set category on anything you touch: CLIENT or INNER_WORK.',
  '4. Aim exactly one arrow. Aiming a new one drops the old one.',
  '5. Act first, then say in one line what you changed. Do not narrate each call.',
  '6. Moving and deleting ask Jacob first. If he declines, drop it and move on.',
  '7. Never invent a breakpoint note. Ask for what you do not have.',
].join('\n');
