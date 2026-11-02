/**
 * Repair a profile patch that declares one row twice.
 *
 * A patch can hold a `disabled` override *before* a later `insert` of the same
 * id — another tool appending the insert after an override exists. DeepSeek
 * Harness's Plugin Manager then rewrites that earlier override in place, the
 * later insert keeps winning, and the row cannot be enabled or disabled from
 * the profile layer at all (it reports `overridden`).
 *
 * The repair keeps the declaration that actually carries the configuration (the
 * insert, or any block with more than `id`/`disabled`) and rewrites the
 * enablement at the end of the sequence, where the last declaration wins:
 *
 * - disabling appends `- id: <id>` / `disabled: true`;
 * - enabling only drops the stale overrides, because the insert is enabled.
 *
 * It touches nothing else, refuses anything it does not fully understand, and
 * leaves a timestamped backup beside the patch before writing.
 *
 * @module @kuhufu/dsh-mcp-manager/host/profile-patch
 */

import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';

/** A top-level sequence entry starts at column zero with "- ". */
const ENTRY_START = /^-(?:\s|$)/;
/** A top-level `id` key inside an entry, with an optional quote style. */
const ID_KEY = /^ {2}id:\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))\s*(?:#.*)?$/;
/** The `- id: ...` form that starts an entry. */
const ID_IN_START = /^-\s+id:\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))\s*(?:#.*)?$/;
/** A row nested inside an `insert:` entry. */
const NESTED_ID_KEY = /^ {4}- id:\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))\s*(?:#.*)?$/;
/** An `insert` key, either as the entry's first line or nested in it (a comment may follow). */
const INSERT_KEY = /^(?:-\s+|\s+)insert:\s*(?:#.*)?$/;

/**
 * Split a patch document into its top-level sequence entries.
 *
 * @param {string} text - patch file text.
 * @returns {{ text: string, id?: string, insert: boolean, keys: string[] }[]} entries, in order.
 */
function splitEntries(text) {
  const lines = text.split('\n');
  const entries = [];
  let current = null;
  for (const line of lines) {
    if (ENTRY_START.test(line)) {
      if (current !== null) entries.push(current);
      current = { lines: [line], id: undefined, ids: [], insert: false, keys: [] };
      if (INSERT_KEY.test(line)) current.insert = true;
      const startId = ID_IN_START.exec(line);
      if (startId !== null) {
        current.id = startId[1] ?? startId[2] ?? startId[3];
        current.ids.push(current.id);
        current.keys.push('id');
      }
      continue;
    }
    if (current === null) continue;
    current.lines.push(line);
    if (INSERT_KEY.test(line)) current.insert = true;
    const nested = NESTED_ID_KEY.exec(line);
    if (nested !== null && current.insert) {
      current.ids.push(nested[1] ?? nested[2] ?? nested[3]);
      continue;
    }
    const id = ID_KEY.exec(line);
    if (id !== null) {
      current.id = id[1] ?? id[2] ?? id[3];
      current.keys.push('id');
      continue;
    }
    const key = /^ {2}([A-Za-z][A-Za-z0-9_-]*):/.exec(line);
    if (key !== null && key[1] !== 'insert') current.keys.push(key[1]);
  }
  if (current !== null) entries.push(current);
  return entries;
}

/** Whether one entry only states an id and its enabled state. */
function isBareOverride(entry) {
  return entry.insert === false
    && entry.id !== undefined
    && entry.keys.every((key) => key === 'id' || key === 'disabled');
}

/**
 * Map a Loader entry id to its patch row id.
 *
 * Included rows are addressed as `include:<patchId>` in the Loader while the
 * profile patch declares them under `<patchId>` alone, so a repair called with a
 * Loader id has to strip the scope prefix first.
 *
 * @param {string} entryId - Loader entry id, e.g. `include:magpie-mcp-github`.
 * @returns {string} the id the profile patch uses.
 */
export function patchIdOf(entryId) {
  const prefix = 'include:';
  return entryId.startsWith(prefix) ? entryId.slice(prefix.length) : entryId;
}

/**
 * Rewrite one row's enablement at the end of the profile patch.
 *
 * @param {string} patchPath - absolute path of the profile's `cordis.patch.yml`.
 * @param {string} entryId - Loader row id, e.g. `magpie-mcp-GitHub`.
 * @param {boolean} enabled - requested state.
 * @returns {Promise<{ repaired: boolean, backup?: string, reason?: string }>} whether the file changed.
 */
export async function repairDuplicateRow(patchPath, entryId, enabled) {
  let text;
  try {
    text = await readFile(patchPath, 'utf8');
  } catch (error) {
    return { repaired: false, reason: error?.code === 'ENOENT' ? 'no patch file' : String(error?.message ?? error) };
  }

  const entries = splitEntries(text);
  const matches = entries.filter((entry) => entry.ids.includes(entryId));
  if (matches.length < 2) return { repaired: false, reason: 'the row is not declared twice' };
  const stale = matches.filter(isBareOverride);
  if (stale.length === 0) return { repaired: false, reason: 'no stale override row to remove' };
  const insertDisabled = matches.some(
    (entry) => entry.insert && entry.lines.some((line) => /^\s+disabled:\s*true\b/.test(line)),
  );
  if (enabled && insertDisabled) return { repaired: false, reason: 'the insert itself is disabled' };

  const kept = entries.filter((entry) => !stale.includes(entry));
  const body = kept
    .map((entry) => entry.lines.join('\n').replace(/\n+$/, ''))
    .filter((block) => block.trim() !== '')
    .join('\n');
  const appended = enabled ? '' : `- id: ${JSON.stringify(entryId)}\n  disabled: true\n`;
  const next = `${body}${body.endsWith('\n') || body === '' ? '' : '\n'}${appended}`;

  if (next === text) return { repaired: false, reason: 'nothing to change' };

  const backup = `${patchPath}.bak-${new Date().toISOString().replace(/[^0-9]/g, '')}`;
  await copyFile(patchPath, backup);
  const temporary = `${patchPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, next, { mode: 0o600 });
  await rename(temporary, patchPath);
  return { repaired: true, backup };
}
