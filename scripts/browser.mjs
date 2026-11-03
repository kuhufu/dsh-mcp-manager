/** Run the optional browser suite with its isolated development environment. */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const python = process.env.MCP_QA_PYTHON ?? (process.platform === 'win32' ? '.qa/venv/Scripts/python.exe' : '.qa/venv/bin/python');
if (!existsSync(python) || !existsSync('.qa/react.js') || !existsSync('.qa/react-dom.js')) {
  console.error('Browser test environment is missing. Follow test/BROWSER.md, then run npm run test:browser.');
  process.exit(1);
}
const result = spawnSync(python, ['test/browser.smoke.py'], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
