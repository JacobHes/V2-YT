// =============================================================
// Build step for Grant's knowledge base.
//
//   node scripts/build-knowledge.mjs
//
// Reads the four authored markdown files in grant-build/ and emits a single
// generated ES module, grant/grant-data.js, containing:
//   SYSTEM_PROMPT  — GRANT_SYSTEM_PROMPT.md verbatim
//   CONTEXT        — GRANT_CONTEXT.md verbatim
//   SECTIONS       — { [sectionId]: { id, file, heading, text } }
//
// Emitting a JS module instead of JSON keeps the serverless function free of
// filesystem reads, which are the usual way a Vercel bundle loses its data
// files. RETRIEVAL_STRATEGY.md is a spec for us, not runtime context, so it is
// deliberately not embedded.
// =============================================================
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'grant-build');
const OUT = join(ROOT, 'grant', 'grant-data.js');

const KNOWLEDGE_FILES = [
  '01-work-system.md',
  '02-energy-focus.md',
  '03-execution-recovery.md',
];

function slugify(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Split a markdown file on its H2 headings. Anything above the first H2 (the
// title and any preamble) becomes a section of its own so nothing is dropped.
function splitSections(fileName, markdown) {
  const lines = markdown.split('\n');
  const sections = [];
  let heading = 'Preamble';
  let buffer = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (!text) return;
    const base = fileName.replace(/\.md$/, '');
    sections.push({
      id: `${base}#${slugify(heading)}`,
      file: fileName,
      heading,
      text: `## ${heading}\n\n${text}`,
    });
  };

  for (const line of lines) {
    const match = /^##\s+(.*\S)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[1];
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

const systemPrompt = readFileSync(join(SRC, 'GRANT_SYSTEM_PROMPT.md'), 'utf8').trim();
const context = readFileSync(join(SRC, 'GRANT_CONTEXT.md'), 'utf8').trim();

const sections = {};
for (const fileName of KNOWLEDGE_FILES) {
  const markdown = readFileSync(join(SRC, 'knowledge', fileName), 'utf8');
  for (const section of splitSections(fileName, markdown)) {
    if (sections[section.id]) {
      throw new Error(`Duplicate section id: ${section.id}`);
    }
    sections[section.id] = section;
  }
}

const banner =
  '// GENERATED FILE — do not edit.\n' +
  '// Run `npm run build:knowledge` after changing anything in grant-build/.\n';

const body =
  `export const SYSTEM_PROMPT = ${JSON.stringify(systemPrompt)};\n\n` +
  `export const CONTEXT = ${JSON.stringify(context)};\n\n` +
  `export const SECTIONS = ${JSON.stringify(sections, null, 2)};\n`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, banner + '\n' + body, 'utf8');

const ids = Object.keys(sections);
console.log(`Wrote ${OUT}`);
console.log(`  system prompt: ${systemPrompt.length} chars`);
console.log(`  context:       ${context.length} chars`);
console.log(`  sections:      ${ids.length}`);
for (const id of ids) {
  console.log(`    ${id} (${sections[id].text.length} chars)`);
}
