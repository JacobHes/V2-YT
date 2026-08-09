// ============================================================
// POST /api/grant
//
// Grant's runtime. Assembles the system prompt, retrieves the doctrine
// sections this call actually needs, and streams the reply back as SSE.
//
// Prompt assembly and caching layout live in ../grant/assemble.js.
// The API key lives in ANTHROPIC_API_KEY on the server and never reaches the
// browser.
//
// Env:
//   ANTHROPIC_API_KEY     required
//   GRANT_MODEL           default claude-sonnet-5
//   GRANT_SUMMARY_MODEL   default claude-haiku-4-5 (history folding only)
//   GRANT_EFFORT          low | medium | high | xhigh | max, default medium
//   GRANT_MAX_TOKENS      default 12000
// ============================================================
import Anthropic from '@anthropic-ai/sdk';

import { selectSections } from '../grant/retrieval.js';
import { buildSystem, buildMessages } from '../grant/assemble.js';
import { parsePayload, windowHistory, PayloadError, HISTORY_WINDOW } from '../grant/payload.js';

// Vercel defaults Node functions to 10s. A coaching reply with adaptive
// thinking runs longer than that, and the stream would be cut mid-sentence.
// 60 is the Hobby ceiling; Pro allows up to 300.
export const maxDuration = 60;

const MODEL = process.env.GRANT_MODEL || 'claude-sonnet-5';
const SUMMARY_MODEL = process.env.GRANT_SUMMARY_MODEL || 'claude-haiku-4-5';
const EFFORT = process.env.GRANT_EFFORT || 'medium';
const MAX_TOKENS = Number(process.env.GRANT_MAX_TOKENS) || 12000;

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/**
 * Fold turns that fell out of the window into a short summary block.
 * Grant has no memory between calls, so this is how anything older survives.
 */
async function foldHistory(overflow) {
  if (!overflow.length) return null;

  const transcript = overflow
    .map((turn) => `${turn.role === 'user' ? 'Jacob' : 'Grant'}: ${turn.content}`)
    .join('\n');

  try {
    const response = await getClient().messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 400,
      system:
        'Compress this coaching conversation into 3 to 5 short lines: decisions made, what the arrow is, commitments, anything still open. Facts only. No advice, no em-dashes.',
      messages: [{ role: 'user', content: transcript }],
    });
    return (
      response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim() || null
    );
  } catch (error) {
    // A failed fold must not fail the turn. Losing older context degrades the
    // answer; refusing to answer at all is worse.
    console.error('[grant] history fold failed:', error?.message || error);
    return null;
  }
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server' });
  }

  let payload;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    payload = parsePayload(body);
  } catch (error) {
    const message = error instanceof PayloadError ? error.message : 'Invalid JSON body';
    return res.status(400).json({ error: message });
  }

  const { kept, overflow } = windowHistory(payload.history, HISTORY_WINDOW);

  // Route on the newest user message, falling back to the payload's own
  // `message` field when the caller sends one outside the history array.
  const lastUser = [...kept].reverse().find((turn) => turn.role === 'user');
  const routingMessage = payload.message || lastUser?.content || '';
  const arrowTask = payload.tasks.find((task) => task.id === payload.arrow);

  const sections = selectSections({
    message: routingMessage,
    mode: payload.mode,
    taskTag: arrowTask?.tag || null,
  });
  const sectionIds = sections.map((section) => section.id);

  // Retrieval check: which sections were injected, per call.
  console.log(
    `[grant] mode=${payload.mode} energy=${payload.energy || 'null'} model=${MODEL} sections=${
      sectionIds.join(', ') || '(none, Tier 1 only)'
    }`
  );

  const foldedSummary = await foldHistory(overflow);
  const system = buildSystem({ payload, sections, foldedSummary });
  const messages = buildMessages({ kept, message: payload.message });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  sse(res, 'meta', { mode: payload.mode, model: MODEL, sectionIds });

  try {
    const stream = getClient().messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORT },
      system,
      messages,
    });

    stream.on('text', (delta) => sse(res, 'delta', { text: delta }));

    const final = await stream.finalMessage();

    // cache_read staying at 0 across calls means something above the last
    // breakpoint is changing per request.
    console.log(
      `[grant] usage in=${final.usage.input_tokens} cache_write=${final.usage.cache_creation_input_tokens} cache_read=${final.usage.cache_read_input_tokens} out=${final.usage.output_tokens} stop=${final.stop_reason}`
    );

    sse(res, 'done', {
      stopReason: final.stop_reason,
      sectionIds,
      usage: {
        input: final.usage.input_tokens,
        output: final.usage.output_tokens,
        cacheRead: final.usage.cache_read_input_tokens,
        cacheWrite: final.usage.cache_creation_input_tokens,
      },
    });
  } catch (error) {
    console.error('[grant] stream failed:', error);
    // Headers are already out, so the error has to travel as an SSE event.
    sse(res, 'error', { message: error?.message || 'Grant call failed' });
  } finally {
    res.end();
  }
}
