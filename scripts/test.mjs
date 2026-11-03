import { spawnSync } from 'node:child_process';
const suites = ['mcp', 'external', 'takeover-race', 'patch-repair'];
for (const suite of suites) {
  const result = spawnSync(process.execPath, [`test/${suite}.smoke.mjs`], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const result = spawnSync(process.execPath, ['--test', 'test/regression.test.mjs', 'test/client.test.mjs'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
