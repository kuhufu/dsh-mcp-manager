/**
 * Checks for `repairDuplicateRow`: a profile patch that declares one row twice
 * (a bare `disabled` override before a later `insert`) cannot be toggled by the
 * Plugin Manager, so the plugin rewrites the enablement at the end of the
 * sequence itself.
 *
 * @module @kuhufu/dsh-mcp-manager/test/patch-repair
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { patchIdOf, repairDuplicateRow } from '../host/profile-patch.js';

const home = await mkdtemp(path.join(tmpdir(), 'dshmcp-patch-'));
const patchPath = path.join(home, 'cordis.patch.yml');

/** The broken shape: the override is written before the insert it should control. */
const broken = `# profile patch
- id: ui-theme
  config:
    preference: system
- id: magpie-mcp-GitHub
  disabled: true
- insert:
    - id: magpie-mcp-GitHub
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: "GitHub"
        transport: "stdio"
        command: "node"
- id: unrelated
  config:
    keep: me
`;

await writeFile(patchPath, broken);
const disabled = await repairDuplicateRow(patchPath, 'magpie-mcp-GitHub', false);
assert.equal(disabled.repaired, true);
assert.equal(typeof disabled.backup, 'string');
assert.ok((await readdir(home)).some((name) => name.startsWith('cordis.patch.yml.bak-')), 'a backup is written');

let text = await readFile(patchPath, 'utf8');
assert.ok(text.startsWith('# profile patch\n'), 'header comments survive a repair');
const githubBlocks = text.split(/^-(?=\s)/m).filter((block) => block.includes('magpie-mcp-GitHub'));
assert.equal(githubBlocks.filter((block) => !block.includes('insert:')).length, 1, 'one override remains');
assert.match(text, /- id: "magpie-mcp-GitHub"\n {2}disabled: true\n$/, 'the final declaration disables the row at the end');
assert.ok(text.includes('name: "@deepseek-ai/dsh-mcp-client"'), 'the insert with the configuration survives');
assert.match(text, /- id: ui-theme\n {2}config:\n {4}preference: system/, 'unrelated rows keep their body');
assert.ok(text.trimEnd().endsWith('disabled: true'), 'the decisive row is last');
assert.ok(text.endsWith('\n'));

// Enabling drops the stale override and leaves the insert in force.
const enabled = await repairDuplicateRow(patchPath, 'magpie-mcp-GitHub', true);
assert.equal(enabled.repaired, true);
text = await readFile(patchPath, 'utf8');
assert.equal(text.includes('disabled'), false, 'no disabled override is left behind');
assert.ok(text.includes('serverName: "GitHub"'), 'the insert is still there');
assert.match(text, /- id: unrelated\n {2}config:\n {4}keep: me/, 'later unrelated rows are preserved');

// A single declaration is left untouched.
const single = `- insert:\n    - id: solo\n      name: x\n`;
await writeFile(patchPath, single);
assert.equal((await repairDuplicateRow(patchPath, 'solo', false)).repaired, false);
assert.equal(await readFile(patchPath, 'utf8'), single);

// Two inserts without a bare override are a shape this helper refuses.
const doubleInserts = `- insert:\n    - id: twice\n      name: a\n- insert:\n    - id: twice\n      name: b\n`;
await writeFile(patchPath, doubleInserts);
const refused = await repairDuplicateRow(patchPath, 'twice', false);
assert.equal(refused.repaired, false);
assert.equal(refused.reason, 'no stale override row to remove');
assert.equal(await readFile(patchPath, 'utf8'), doubleInserts);

// Loader ids carry the `include:` scope that the patch itself does not.
assert.equal(patchIdOf('include:magpie-mcp-github'), 'magpie-mcp-github');
assert.equal(patchIdOf('magpie-mcp-github'), 'magpie-mcp-github');
await writeFile(patchPath, broken);
const scoped = await repairDuplicateRow(patchPath, patchIdOf('include:magpie-mcp-GitHub'), false);
assert.equal(scoped.repaired, true, 'a Loader entry id is mapped before the repair');
assert.match(await readFile(patchPath, 'utf8'), /- id: "magpie-mcp-GitHub"\n {2}disabled: true\n$/);

// The magpie-style `- insert: # comment` header is still an insert.
const commented = `- id: magpie-mcp-github\n  disabled: true\n- insert: # magpie\n    - id: magpie-mcp-github\n      name: x\n      config:\n        serverName: "github"\n`;
await writeFile(patchPath, commented);
const commentedRepair = await repairDuplicateRow(patchPath, 'magpie-mcp-github', false);
assert.equal(commentedRepair.repaired, true, 'an insert header with a trailing comment is recognised');
assert.match(await readFile(patchPath, 'utf8'), /- id: "magpie-mcp-github"\n {2}disabled: true\n$/);

// A missing file is a refusal, not a crash.
assert.equal((await repairDuplicateRow(path.join(home, 'absent.yml'), 'x', true)).repaired, false);

// Two bare overrides with no insert, enabled: keep the file a valid empty array.
const onlyOverrides = `# header\n- id: only\n  disabled: true\n- id: only\n  disabled: false\n`;
await writeFile(patchPath, onlyOverrides);
const emptied = await repairDuplicateRow(patchPath, 'only', true);
assert.equal(emptied.repaired, true);
const emptiedText = await readFile(patchPath, 'utf8');
assert.ok(emptiedText.startsWith('# header\n'), 'the header is kept when the last entry is removed');
assert.match(emptiedText, /^\[\]$/m, 'the result is still a top-level array');

await rm(home, { recursive: true, force: true });
console.log('patch repair smoke: 27 checks passed, 0 failed');
