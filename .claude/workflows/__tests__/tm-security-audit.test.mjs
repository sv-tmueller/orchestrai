/**
 * Lock test for the vendored Cloudflare security-audit skill (issue #450).
 *
 * .claude/skills/tm-security-audit/ is a copy of skills/security-audit/ from
 * cloudflare/security-audit-skill at a pinned commit. These things are held
 * here:
 *
 * 1. The folder holds exactly the 20 upstream files and nothing else.
 * 2. Each file matches upstream byte for byte, by git blob SHA-1. SKILL.md is
 *    the one exception: its three orchestrai changes are undone first, and
 *    the result must match upstream.
 * 3. Upstream's own two test files run as part of this run, so their roughly
 *    65 tests show up by name in `npm test`.
 * 4. The orchestrai part of SKILL.md is pinned by its own tests: the header
 *    block by a SHA-256 digest, the header's model table row by row, and the
 *    frontmatter (user-typed only, no model key).
 * 5. File modes: the two validators are executable, the other 18 files are not.
 *    A blob hash does not cover the mode.
 *
 * The digests below are what `gh api
 * 'repos/cloudflare/security-audit-skill/git/trees/<commit>?recursive=1'`
 * prints, so a reviewer can re-derive them with one command.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PINNED_COMMIT = 'c1c8a8c1471069fb0e188eeaff69b8e8db6564a8';

const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(here, '..', '..', 'skills', 'tm-security-audit');

// Upstream's tests register with node:test at require time, so they run in
// this file's process. A missing file throws and fails the run.
const require = createRequire(import.meta.url);
require(join(skillDir, 'validate-findings.test.cjs'));
require(join(skillDir, 'validate-coverage-ledger.test.cjs'));

const UPSTREAM_BLOB_SHA1 = {
  'AI-AND-LLM.md': '02ba9039eca4cec811fefc77bce0d7349b379aae',
  'ATTACK-CLASSES.md': '18a2beb4dbb554fb52b0a0293b8bd9108207f8fa',
  'CLIENT-SIDE.md': '8ba673e9e7e3d02f5518aa0219bcbeec7957531b',
  'CLOUD-AND-DEPLOYMENT.md': '5569f76c7740744aa3f60aaa89eaefe275f2e6c9',
  'DATA-ISOLATION-AND-LIFECYCLE.md': '0cba1fa463b62c9b0caba710a201e29c1eecd0ec',
  'DESKTOP-MOBILE-AND-LOCAL-IPC.md': 'd6230098651bff6348d3868c11f566bfb1306e7f',
  'HUNTING.md': '377d4dcfbe88a049379448cd7892717185401597',
  'MEMORY-SAFETY-AND-BINARY.md': '86ff4920752661fc4a31a35ca4f962ace5dd5f48',
  'PROTOCOLS-RPC-AND-MESSAGING.md': 'b04ab88f852224838fdc9683d9fcccd858b0778a',
  'RECONNAISSANCE.md': '1a170a93ab76b93dc5ac268a5b690beb423a8aa9',
  'RESOURCE-EXHAUSTION-AND-AVAILABILITY.md': '6cbbd1e2cfa482068c8279c2f7da9db43d3f54b8',
  'SKILL.md': '92178dad304d3f63e37582a297026a7874e12c62',
  'SUPPLY-CHAIN-AND-RELEASE.md': 'bf96aed0803bc07471483ab129dea86759c3e305',
  'VALIDATION-AND-REPORTING.md': '5e200d7387e665e53e0e4190fa4a5814c334c507',
  'WEB-PROTOCOL-AND-AUTH.md': '1a099fa575cf52a61e9a627f91b61015120fa517',
  'report-schema.json': '55815a3687a45fff63d8ebf20068611bd6ad6d9a',
  'validate-coverage-ledger.cjs': '0ef58657bef18b26a92321df6c8e3d31bc8e6659',
  'validate-coverage-ledger.test.cjs': 'b1444f57e1b021a61175733b8c356171861c8701',
  'validate-findings.cjs': '2843feceddb7e30bf10d6e4f7bbe6640e4c57799',
  'validate-findings.test.cjs': '8d245b226bbe2fdf28b46b3203b99c2824039d2d',
};

const BEGIN_MARKER = '<!-- orchestrai header: begin -->\n';
const END_MARKER = '<!-- orchestrai header: end -->\n\n';

// git blob id: sha1("blob <byte length>\0" + bytes)
function blobSha1(bytes) {
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

function replaceOnce(text, from, to) {
  assert.equal(occurrences(text, from), 1, `expected exactly one ${JSON.stringify(from)}`);
  return text.replace(from, () => to);
}

// Undo the three orchestrai changes to SKILL.md, so what is left is upstream.
function upstreamSkillText(text) {
  assert(
    text.startsWith('---\nname: tm-security-audit\n'),
    'SKILL.md must start with the tm-security-audit name line',
  );
  let out = replaceOnce(text, '---\nname: tm-security-audit\n', '---\nname: security-audit\n');
  out = replaceOnce(out, '\ndisable-model-invocation: true\n---\n', '\n---\n');

  assert.equal(occurrences(out, BEGIN_MARKER), 1, 'expected one header begin marker');
  assert.equal(occurrences(out, END_MARKER), 1, 'expected one header end marker');
  const start = out.indexOf(BEGIN_MARKER);
  const end = out.indexOf(END_MARKER) + END_MARKER.length;
  assert(start < end, 'header begin marker must come before the end marker');
  const header = out.slice(start, end);
  assert(header.includes(PINNED_COMMIT), 'header must name the pinned upstream commit');
  return out.slice(0, start) + out.slice(end);
}

// The header block: begin marker line through end marker line, both included,
// each line ending in "\n".
function headerBlock(text) {
  const lines = text.split('\n');
  const begin = lines.indexOf('<!-- orchestrai header: begin -->');
  const end = lines.indexOf('<!-- orchestrai header: end -->');
  assert.equal(lines.lastIndexOf('<!-- orchestrai header: begin -->'), begin, 'one begin marker line');
  assert.equal(lines.lastIndexOf('<!-- orchestrai header: end -->'), end, 'one end marker line');
  assert(begin >= 0 && end > begin, 'begin marker line must come before the end marker line');
  return `${lines.slice(begin, end + 1).join('\n')}\n`;
}

// The lines between the opening and closing `---` of the frontmatter.
function frontmatterLines(text) {
  assert(text.startsWith('---\n'), 'SKILL.md must start with frontmatter');
  const close = text.indexOf('\n---\n', 4);
  assert(close > 0, 'frontmatter must close with ---');
  return text.slice(4, close).split('\n');
}

function fail(message) {
  throw new Error(`header table: ${message}`);
}

// Read the model table in the header: header row, separator row, then data
// rows. Returns { role, model, effort } per data row and throws on a table
// with no data rows or on a row it cannot read.
function readHeaderTable(header) {
  const tableLines = header.split('\n').filter((l) => l.startsWith('|'));
  const cellsOf = (line) => line.split('|').slice(1, -1).map((c) => c.trim());
  if (tableLines.length < 3) fail('needs a header row, a separator row and at least one data row');
  const columns = cellsOf(tableLines[0]);
  const modelAt = columns.findIndex((c) => /^`?model`?\b/i.test(c));
  const effortAt = columns.findIndex((c) => /^effort$/i.test(c));
  if (modelAt < 0 || effortAt < 0) fail('needs a model column and an effort column');
  if (!/^\|[\s|:-]+\|$/.test(tableLines[1])) fail('second row must be the separator');

  return tableLines.slice(2).map((line) => {
    const cells = cellsOf(line);
    if (cells.length !== columns.length) fail(`row has ${cells.length} cells, expected ${columns.length}: ${line}`);
    const models = cells[modelAt].match(/\b(sonnet|opus)\b/gi) ?? [];
    if (models.length !== 1) fail(`model cell must name exactly one of sonnet and opus: ${line}`);
    const effort = cells[effortAt].replaceAll('`', '');
    if (effort !== 'high' && effort !== 'xhigh') fail(`effort cell must be high or xhigh: ${line}`);
    return { role: cells[0], model: models[0].toLowerCase(), effort };
  });
}

test('tm-security-audit: folder holds exactly the 20 upstream files', () => {
  assert.deepEqual(readdirSync(skillDir).sort(), Object.keys(UPSTREAM_BLOB_SHA1).sort());
});

for (const [name, sha] of Object.entries(UPSTREAM_BLOB_SHA1)) {
  if (name === 'SKILL.md') continue;
  test(`tm-security-audit: ${name} is byte-identical to upstream`, () => {
    assert.equal(blobSha1(readFileSync(join(skillDir, name))), sha);
  });
}

test('tm-security-audit: SKILL.md is upstream plus the three orchestrai changes', () => {
  const text = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  const upstream = upstreamSkillText(text);
  assert.equal(blobSha1(Buffer.from(upstream, 'utf8')), UPSTREAM_BLOB_SHA1['SKILL.md']);
});

// The orchestrai header is the one part of SKILL.md that is ours, so the
// byte-identity tests above do not cover it. These tests pin it.

// SHA-256 of the header block: the begin marker line through the end marker
// line, both included, each line ending in "\n". Reproduce it with
//   sed -n '/orchestrai header: begin/,/orchestrai header: end/p' SKILL.md | sha256sum
// An edit to the header needs this digest updated on purpose, in the same
// commit, after a person has read the edit.
const HEADER_SHA256 = 'd4b62b2b2e004191f1eda729d411210f204dc3a8ebbe263418af5c4b4681baa0';

const skillText = () => readFileSync(join(skillDir, 'SKILL.md'), 'utf8');

test('tm-security-audit: SKILL.md header block matches its recorded digest', () => {
  const digest = createHash('sha256').update(headerBlock(skillText())).digest('hex');
  assert.equal(digest, HEADER_SHA256);
});

// Where the header sits: the begin marker line right after the frontmatter's
// closing `---` line and one blank line, the end marker line followed by one
// blank line and upstream's first heading. The byte-identity rebuild cuts the
// header out by its markers, so it would not notice a header moved elsewhere.
test('tm-security-audit: header sits between the frontmatter and upstream\'s first heading', () => {
  const lines = skillText().split('\n');
  const close = lines.indexOf('---', 1);
  assert(close > 0, 'frontmatter must close with ---');
  const begin = lines.indexOf('<!-- orchestrai header: begin -->');
  const end = lines.indexOf('<!-- orchestrai header: end -->');
  assert.equal(lines[close + 1], '', 'one blank line between the closing --- and the begin marker');
  assert.equal(begin, close + 2, 'begin marker line must follow the closing --- and one blank line');
  assert.equal(lines[end + 1], '', 'one blank line after the end marker');
  assert.equal(lines[end + 2], '# Security Audit', 'upstream first heading must follow the header');
});

// Role, model and effort the header must assign. The role is the first cell of
// the header's table. Reconnaissance agents and hunters do the work, so they
// run on the cheaper model. Critics and verifiers judge, so they run on opus.
const EXPECTED_ROWS = [
  { role: /^Reconnaissance agents$/, model: 'sonnet', effort: 'high' },
  { role: /^Hunters$/, model: 'sonnet', effort: 'high' },
  { role: /^Coverage critics\b/, model: 'opus', effort: 'xhigh' },
  { role: /^Candidate verifiers$/, model: 'opus', effort: 'xhigh' },
  { role: /^Record verifiers\b/, model: 'opus', effort: 'xhigh' },
];

test('tm-security-audit: header table gives each role its model and effort', () => {
  const rows = readHeaderTable(headerBlock(skillText()));
  assert.equal(rows.length, EXPECTED_ROWS.length, 'every table row must be one of the expected roles');
  for (const want of EXPECTED_ROWS) {
    const hits = rows.filter((r) => want.role.test(r.role));
    assert.equal(hits.length, 1, `expected exactly one row for ${want.role}`);
    assert.equal(hits[0].model, want.model, `${hits[0].role}: model`);
    assert.equal(hits[0].effort, want.effort, `${hits[0].role}: effort`);
  }
});

const TABLE_HEAD = '| Upstream role | Agent type | Defined in | `model` (tier) | Effort |\n|---|---|---|---|---|\n';
const BAD_TABLES = {
  'no data rows': TABLE_HEAD,
  'no table': 'plain text\n',
  'a row with a missing cell': `${TABLE_HEAD}| Hunters | \`general\` | HUNTING.md | \`sonnet\` |\n`,
  'a model cell that names both models': `${TABLE_HEAD}| Hunters | \`general\` | HUNTING.md | \`sonnet\` or \`opus\` | \`high\` |\n`,
  'a model cell outside sonnet and opus': `${TABLE_HEAD}| Hunters | \`general\` | HUNTING.md | \`fable\` | \`high\` |\n`,
  'an effort cell of max': `${TABLE_HEAD}| Hunters | \`general\` | HUNTING.md | \`sonnet\` | \`max\` |\n`,
};
for (const [label, table] of Object.entries(BAD_TABLES)) {
  test(`tm-security-audit: header table reader rejects ${label}`, () => {
    // The message check keeps a broken reader (for example a ReferenceError)
    // from passing as a rejection.
    assert.throws(() => readHeaderTable(table), /^Error: header table: /);
  });
}

test('tm-security-audit: SKILL.md frontmatter is user-typed only', () => {
  const lines = frontmatterLines(skillText());
  assert(lines.includes('disable-model-invocation: true'), 'frontmatter needs disable-model-invocation: true');
});

test('tm-security-audit: SKILL.md frontmatter has no model key', () => {
  const lines = frontmatterLines(skillText());
  assert.deepEqual(
    lines.filter((l) => /^model\s*:/.test(l)),
    [],
    'a model: key would pin the skill to a model; the header table assigns models per role',
  );
});

const VALIDATORS = ['validate-findings.cjs', 'validate-coverage-ledger.cjs'];

test('tm-security-audit: the two validators have an executable bit', () => {
  for (const name of VALIDATORS) {
    assert.notEqual(statSync(join(skillDir, name)).mode & 0o111, 0, `${name} must be executable`);
  }
});

test('tm-security-audit: the other 18 files have no executable bit', () => {
  const others = Object.keys(UPSTREAM_BLOB_SHA1).filter((n) => !VALIDATORS.includes(n));
  assert.equal(others.length, 18);
  for (const name of others) {
    assert.equal(statSync(join(skillDir, name)).mode & 0o111, 0, `${name} must not be executable`);
  }
});
