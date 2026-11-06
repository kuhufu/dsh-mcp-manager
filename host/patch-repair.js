/**
 * Repair cross-layer duplicate patch declarations.
 *
 * A plugin entry declared by the home patch (`insert`) and overridden by the
 * profile patch (`- id: X / disabled: ...`) can never be disabled: the home
 * layer applies later, so the override written by Plugin Manager sits before
 * the insert that creates the row. The manager itself cannot rewrite layers, so
 * this module moves the inserting entry into the profile layer, where overrides
 * and the insert share one ordered list.
 *
 * Only flow-style `insert` arrays are handled; anything unexpected is reported
 * as a problem and the files are left untouched.
 *
 * @module @kuhufu/dsh-mcp-manager/host/patch-repair
 */

import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** @typedef {{ id: string, text: string }} FlowEntry */

/**
 * Find the `insert:` array in a patch document and return its balanced span.
 * @param {string} text - patch file contents.
 * @returns {{ start: number, end: number, entries: FlowEntry[] } | undefined} span and entries.
 */
export function findFlowInsert(text) {
  const marker = /(^|[\s[{,])insert\s*:/m.exec(text);
  if (marker === null) return undefined;
  const open = text.indexOf('[', marker.index + marker[0].length);
  if (open < 0) return undefined;
  const close = matchBracket(text, open, '[', ']');
  if (close < 0) return undefined;
  const body = text.slice(open + 1, close);
  /** @type {FlowEntry[]} */
  const entries = [];
  let index = 0;
  while (index < body.length) {
    const start = body.indexOf('{', index);
    if (start < 0) break;
    const end = matchBracket(body, start, '{', '}');
    if (end < 0) return undefined;
    const entryText = body.slice(start, end + 1);
    const id = /\bid\s*:\s*"?([A-Za-z0-9._:-]+)"?/.exec(entryText);
    if (id === null) return undefined;
    entries.push({ id: id[1], text: entryText });
    index = end + 1;
  }
  return { start: open, end: close, entries };
}

/**
 * Index of the bracket closing the one at `open`, string-aware.
 * @param {string} text - haystack.
 * @param {number} open - index of the opening bracket.
 * @param {string} left - opening character.
 * @param {string} right - closing character.
 * @returns {number} closing index or -1.
 */
function matchBracket(text, open, left, right) {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== '') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === left) depth += 1;
    else if (ch === right) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Entry ids declared by a block-style patch document.
 * @param {string} text - patch file contents.
 * @returns {Set<string>} ids declared outside `insert` blocks.
 */
export function declaredIds(text) {
  const ids = new Set();
  for (const match of text.matchAll(/^\s*-\s+id\s*:\s*["']?([A-Za-z0-9._:-]+)["']?\s*$/gm)) ids.add(match[1]);
  return ids;
}

/**
 * Last standalone `disabled` value the profile declares for one id.
 * @param {string} text - profile patch contents.
 * @param {string} id - entry id.
 * @returns {boolean | undefined} the last declared value.
 */
function lastDisabledOverride(text, id) {
  const pattern = new RegExp(`^\\s*-\\s+id\\s*:\\s*["']?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$\\n\\s+disabled\\s*:\\s*(true|false)\\s*$`, 'gm');
  let last;
  for (const match of text.matchAll(pattern)) last = match[1] === 'true';
  return last;
}

/**
 * Remove the standalone `id` + `disabled` block a profile declares for one id.
 * @param {string} text - profile patch contents.
 * @param {string} id - entry id.
 * @returns {string} contents without that block.
 */
function stripDisabledOverride(text, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*-\\s+id\\s*:\\s*["']?${escaped}["']?\\s*\\n\\s+disabled\\s*:\\s*(?:true|false)\\s*\\n?`, 'gm');
  return text.replace(pattern, '');
}

/**
 * Repair one profile: move home-inserted entries that the profile also declares
 * into the profile patch, so overrides and inserts share one ordered layer.
 * @param {{ homePatch: string, profilePatch: string, stamp?: string }} options - file paths.
 * @returns {Promise<{ moved: string[], problems: string[], backups: string[] }>} repair report.
 */
export async function repairPatchLayers({ homePatch, profilePatch, stamp = String(Date.now()) }) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const backups = [];
  const homeText = await readFile(homePatch, 'utf8').catch(() => undefined);
  if (homeText === undefined) return { moved: [], problems: [`cannot read ${homePatch}`], backups };
  const profileText = await readFile(profilePatch, 'utf8').catch(() => undefined);
  if (profileText === undefined) return { moved: [], problems: [`cannot read ${profilePatch}`], backups };

  const insert = findFlowInsert(homeText);
  if (insert === undefined || insert.entries.length === 0) return { moved: [], problems: [], backups };

  const profileIds = declaredIds(profileText);
  const moving = insert.entries.filter((entry) => profileIds.has(entry.id));
  if (moving.length === 0) return { moved: [], problems: [], backups };

  const keep = insert.entries.filter((entry) => !profileIds.has(entry.id));
  const replacement = keep.length === 0 ? '[]' : `[ ${keep.map((entry) => entry.text).join(', ')} ]`;
  const nextHome = homeText.slice(0, insert.start) + replacement + homeText.slice(insert.end + 1);
  // The moved insert now sits in the same ordered list as the overrides, so it
  // must come first and the last override must be re-emitted after it: a later
  // declaration wins, and the user's enabled/disabled choice must survive.
  const trailing = moving
    .map((entry) => {
      const override = lastDisabledOverride(profileText, entry.id);
      return override === undefined ? '' : `- id: ${entry.id}\n  disabled: ${override}\n`;
    })
    .join('');
  const appended = moving
    .map((entry) => `- insert:\n    # moved from the home patch: overrides must share its layer\n    - ${entry.text}\n`)
    .join('') + trailing;
  // Drop the old override blocks: the trailing copy replaces them, so each moved
  // id keeps exactly one declaration and one override, in that order.
  let stripped = profileText;
  for (const entry of moving) stripped = stripDisabledOverride(stripped, entry.id);
  const nextProfile = `${stripped.trimEnd()}\n${appended}`;

  backups.push(await backup(homePatch, stamp), await backup(profilePatch, stamp));
  await writeAtomic(homePatch, nextHome);
  await writeAtomic(profilePatch, nextProfile);
  return { moved: moving.map((entry) => entry.id), problems, backups };
}

/**
 * Copy one file next to itself before rewriting it.
 * @param {string} file - path to snapshot.
 * @param {string} stamp - suffix for the copy.
 * @returns {Promise<string>} backup path.
 */
async function backup(file, stamp) {
  const target = `${file}.bak-${stamp}`;
  await copyFile(file, target).catch(() => {});
  return target;
}

/**
 * Replace one file atomically with mode 0600.
 * @param {string} file - target path.
 * @param {string} contents - new contents.
 * @returns {Promise<void>} settles after the rename.
 */
async function writeAtomic(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
