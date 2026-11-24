/**
 * Lock test for the vendored Cloudflare security-audit skill (issue #450).
 *
 * .claude/skills/tm-security-audit/ is a copy of skills/security-audit/ from
 * cloudflare/security-audit-skill at a pinned commit. Three things are held
 * here:
 *
 * 1. The folder holds exactly the 20 upstream files and nothing else.
 * 2. Each file matches upstream byte for byte, by git blob SHA-1. SKILL.md is
 *    the one exception: its three orchestrai changes are undone first, and
 *    the result must match upstream.
 * 3. Upstream's own two test files run as part of this run, so their roughly
 *    65 tests show up by name in `npm test`.
 *
 * The digests below are what `gh api
 * 'repos/cloudflare/security-audit-skill/git/trees/<commit>?recursive=1'`
 * prints, so a reviewer can re-derive them with one command.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
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
