// Wrapper around `node --test` that fails when the glob matches nothing.
// `node --test <glob>` on its own exits 0 with "# tests 0" for a
// non-matching pattern, so a green run is not proof anything ran.
import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const pattern = '.claude/workflows/__tests__/*.test.mjs';

const files = globSync(pattern);
if (files.length === 0) {
  console.error(`no test files found matching ${pattern}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--test', pattern, ...process.argv.slice(2)],
  { stdio: 'inherit' }
);
process.exit(result.status ?? 1);
