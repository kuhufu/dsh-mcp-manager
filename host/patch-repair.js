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
 * Both patch styles are handled: a flow-style `insert: [ ... ]` array and a
 * block-style `- insert:` item. A patch file is only rewritten when the result
 * still begins with a top-level YAML array; otherwise the files are left
 * untouched and the problem is reported. That check matters because a patch
 * without a top-level array makes the whole Harness fail at startup.
 *
 * @module @kuhufu/dsh-mcp-manager/host/patch-repair
 */

import { readFile } from 'node:fs/promises';

import { copyFileOnce, writeFileAtomic } from './atomic-file.js';

/** @typedef {{ id: string, text: string, start?: number, end?: number }} PatchEntry */

/**
 * Find the first flow-style `insert:` array and return its balanced span.
 * @param {string} text - patch file contents.
 * @returns {{ start: number, end: number, entries: PatchEntry[] } | undefined} span and entries.
 */
function findFlowInsert(text) {
  const marker = /(^|[\s[{,])insert\s*:/m.exec(text);
  if (marker === null) return undefined;
  const open = text.indexOf('[', marker.index + marker[0].length);
  if (open < 0) return undefined;
  const close = matchBracket(text, open, '[', ']');
  if (close < 0) return undefined;
  const body = text.slice(open + 1, close);
  const entries = flowEntries(body);
  if (entries === undefined) return undefined;
  return { start: open, end: close, entries };
}

/**
 * Extract the entries of a flow-style `insert` body.
 * @param {string} body - text between the insert array brackets.
 * @returns {PatchEntry[] | undefined} entries, or undefined for an unsupported shape.
 */
function flowEntries(body) {
  /** @type {PatchEntry[]} */
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
  return entries;
}

/**
 * Find a block-level item written as `- insert: [...]`.
 * @param {string} text - patch file contents.
 * @returns {{ start: number, end: number, entries: PatchEntry[] } | undefined} span and entries.
 */
function findInlineFlowInsert(text) {
  const marker = /^-\s+insert\s*:\s*\[/m.exec(text);
  if (marker === null) return undefined;
  const open = text.indexOf('[', marker.index);
  const close = matchBracket(text, open, '[', ']');
  if (close < 0) return undefined;
  const entries = flowEntries(text.slice(open + 1, close));
  if (entries === undefined) return undefined;
  return { start: open, end: close, entries };
}

/**
 * Find the first block-style top-level `- insert:` item and its entries.
 *
 * Only the item itself is parsed: the entries are the `- id:` sequence items
 * below it, and the item ends at the next top-level sequence item. Nested
 * sequences (arguments, config lists) are left alone.
 *
 * @param {string} text - patch file contents.
 * @returns {{ start: number, end: number, entries: PatchEntry[], block: true } | undefined} item span and entries.
 */
function findBlockInsert(text) {
  const lines = lineSpans(text);
  const index = lines.findIndex((line) => /^-\s+insert\s*:\s*(?:#.*)?$/.test(line.text));
  if (index < 0) return undefined;
  const start = lines[index].start;
  let end = text.length;
  for (let next = index + 1; next < lines.length; next += 1) {
    if (/^-\s/.test(lines[next].text)) {
      end = lines[next].start;
      break;
    }
  }
  /** @type {PatchEntry[]} */
  const entries = [];
  let indent;
  for (let line = index + 1; line < lines.length && lines[line].start < end; line += 1) {
    const match = /^(\s+)-\s+id\s*:\s*["']?([A-Za-z0-9._:-]+)["']?\s*(?:#.*)?$/.exec(lines[line].text);
    if (match === null) continue;
    const width = match[1].length;
    if (indent === undefined) indent = width;
    if (width !== indent) continue;
    let entryEnd = end;
    for (let next = line + 1; next < lines.length && lines[next].start < end; next += 1) {
      if (lines[next].text.startsWith(`${' '.repeat(width)}- `)) {
        entryEnd = lines[next].start;
        break;
      }
    }
    entries.push({
      id: match[2],
      text: text.slice(lines[line].start, entryEnd).trimEnd(),
      start: lines[line].start,
      end: entryEnd,
    });
  }
  return entries.length === 0 ? undefined : { start, end, entries, block: true };
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
function declaredIds(text) {
  const ids = new Set();
  for (const match of text.matchAll(/^\s*-\s+id\s*:\s*["']?([A-Za-z0-9._:-]+)["']?\s*$/gm)) ids.add(match[1]);
  return ids;
}

/**
 * Entry ids declared by insert items in a profile patch, in either style.
 * @param {string} text - profile patch contents.
 * @returns {Set<string>} ids already inserted by the profile.
 */
function profileInsertIds(text) {
  const ids = new Set();
  const lines = lineSpans(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^-\s+insert\s*:/.test(line.text)) continue;
    if (/^-\s+insert\s*:\s*\[/.test(line.text)) {
      const open = text.indexOf('[', line.start);
      const close = matchBracket(text, open, '[', ']');
      if (close < 0) continue;
      const entries = flowEntries(text.slice(open + 1, close));
      if (entries !== undefined) for (const entry of entries) ids.add(entry.id);
      continue;
    }
    for (let next = index + 1; next < lines.length && !/^-\s/.test(lines[next].text); next += 1) {
      const match = /^\s+-\s+id\s*:\s*["']?([A-Za-z0-9._:-]+)["']?\s*(?:#.*)?$/.exec(lines[next].text);
      if (match !== null) ids.add(match[1]);
    }
  }
  return ids;
}

/**
 * Whether one patch still looks like a top-level array with indented insert
 * bodies. Catches the corruption a text splice can cause even when the first
 * line still starts with `-`.
 * @param {string} text - patch contents.
 * @returns {boolean} true when the shape is safe to write.
 */
function validPatchText(text) {
  if (patchShape(text) === 'invalid') return false;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^-\s+insert\s*:\s*(?:#.*)?$/.test(lines[index])) continue;
    let next = index + 1;
    while (next < lines.length) {
      const trimmed = lines[next].trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        next += 1;
        continue;
      }
      break;
    }
    if (next < lines.length && !/^\s/.test(lines[next]) && !/^-\s/.test(lines[next])) return false;
  }
  return true;
}

/**
 * Last standalone `disabled` value the profile declares for one id.
 * @param {string} text - profile patch contents.
 * @param {string} id - entry id.
 * @returns {boolean | undefined} the last declared value.
 */
function lastDisabledOverride(text, id) {
  const pattern = new RegExp(`^-\\s+id\\s*:\\s*["']?${escapeRegExp(id)}["']?\\s*$\\n\\s+disabled\\s*:\\s*(true|false)\\s*$`, 'gm');
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
  const pattern = new RegExp(`^-\\s+id\\s*:\\s*["']?${escapeRegExp(id)}["']?\\s*\\n\\s+disabled\\s*:\\s*(?:true|false)\\s*\\n?`, 'gm');
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
  const backups = [];
  const homeText = await readFile(homePatch, 'utf8').catch(() => undefined);
  if (homeText === undefined) return { moved: [], problems: [`cannot read ${homePatch}`], backups };
  const profileText = await readFile(profilePatch, 'utf8').catch(() => undefined);
  if (profileText === undefined) return { moved: [], problems: [`cannot read ${profilePatch}`], backups };

  const homeShape = patchShape(homeText);
  if (homeShape === 'invalid') {
    return { moved: [], problems: [`${homePatch} is not a top-level YAML array`], backups };
  }
  const profileShape = patchShape(profileText);
  if (profileShape === 'invalid') {
    return { moved: [], problems: [`${profilePatch} is not a top-level YAML array`], backups };
  }

  const insert = homeShape === 'block'
    ? findBlockInsert(homeText) ?? findInlineFlowInsert(homeText)
    : findFlowInsert(homeText);
  if (insert === undefined || insert.entries.length === 0) return { moved: [], problems, backups };

  const profileIds = declaredIds(profileText);
  const moving = insert.entries.filter((entry) => profileIds.has(entry.id));
  if (moving.length === 0) return { moved: [], problems, backups };
  const alreadyInserted = profileInsertIds(profileText);
  const conflicting = moving.filter((entry) => alreadyInserted.has(entry.id));
  if (conflicting.length > 0) {
    return {
      moved: [],
      problems: [`${profilePatch} already inserts ${conflicting.map((entry) => entry.id).join(', ')}; refusing to duplicate the declaration`],
      backups,
    };
  }
  const movingIds = new Set(moving.map((entry) => entry.id));

  const nextHome = insert.block === true
    ? removeBlockEntries(homeText, insert, movingIds)
    : removeFlowEntries(homeText, insert, movingIds);
  if (!validPatchText(nextHome)) {
    return { moved: [], problems: [`${homePatch} would no longer be a top-level YAML array`], backups };
  }

  const nextProfile = appendToProfile(profileText, moving);
  if (nextProfile === undefined) {
    return { moved: [], problems: [`${profilePatch} is not a block-style patch; refusing to append`], backups };
  }
  if (!validPatchText(nextProfile)) {
    return { moved: [], problems: [`${profilePatch} would no longer be a top-level YAML array`], backups };
  }

  backups.push(await copyFileOnce(homePatch, `bak-${stamp}`), await copyFileOnce(profilePatch, `bak-${stamp}`));
  // Write the profile first: if the home write then fails, the entry exists in
  // both layers (a duplicate, repaired on the next run) instead of being lost.
  await writeFileAtomic(profilePatch, nextProfile);
  await writeFileAtomic(homePatch, nextHome);
  return { moved: moving.map((entry) => entry.id), problems, backups };
}

/**
 * Drop the moved entries from a flow-style insert array.
 * @param {string} text - home patch contents.
 * @param {{ start: number, end: number, entries: PatchEntry[] }} insert - flow span.
 * @param {Set<string>} movingIds - ids leaving this file.
 * @returns {string} new home patch contents.
 */
function removeFlowEntries(text, insert, movingIds) {
  const keep = insert.entries.filter((entry) => !movingIds.has(entry.id));
  const replacement = keep.length === 0 ? '[]' : `[ ${keep.map((entry) => entry.text).join(', ')} ]`;
  return text.slice(0, insert.start) + replacement + text.slice(insert.end + 1);
}

/**
 * Drop the moved entries from a block-style insert item, keeping the file a
 * top-level array when that item was the last declaration.
 * @param {string} text - home patch contents.
 * @param {{ start: number, end: number, entries: PatchEntry[] }} insert - block span.
 * @param {Set<string>} movingIds - ids leaving this file.
 * @returns {string} new home patch contents.
 */
function removeBlockEntries(text, insert, movingIds) {
  const allMove = insert.entries.every((entry) => movingIds.has(entry.id));
  if (allMove) {
    const remaining = text.slice(0, insert.start) + text.slice(insert.end);
    return patchShape(remaining) === 'invalid' ? `${remaining.trimEnd()}\n[]\n` : remaining;
  }
  let next = text;
  for (const entry of [...insert.entries].reverse()) {
    if (!movingIds.has(entry.id)) continue;
    next = next.slice(0, entry.start) + next.slice(entry.end);
  }
  return next;
}

/**
 * Append the moved entries to the profile patch, after removing their stale
 * standalone override blocks. The trailing override keeps the user's choice.
 * @param {string} profileText - current profile patch contents.
 * @param {PatchEntry[]} moving - entries to move.
 * @returns {string | undefined} new contents, or undefined for an unsupported shape.
 */
function appendToProfile(profileText, moving) {
  let stripped = profileText;
  for (const entry of moving) stripped = stripDisabledOverride(stripped, entry.id);
  let base = stripped.trimEnd();
  const shape = patchShape(base);
  if (shape === 'flow') {
    if (!isEmptyArray(base)) return undefined; // appending a block item to a flow array is invalid
    // Keep any comment header that precedes the empty array.
    const lines = base.split('\n');
    const at = lines.findIndex((line) => /^\[\s*\]$/.test(line.trim()));
    base = at < 0 ? '' : lines.slice(0, at).join('\n').replace(/\n+$/, '');
  } else if (shape === 'invalid' && base.trim() !== '') {
    return undefined;
  }
  const appended = moving
    .map((entry) => {
      const override = lastDisabledOverride(profileText, entry.id);
      const trailing = override === undefined ? '' : `- id: ${entry.id}\n  disabled: ${override}\n`;
      return `${insertSnippet(entry)}\n${trailing}`;
    })
    .join('');
  return base === '' ? appended : `${base}\n${appended}`;
}

/**
 * Render one moved entry as a profile-level insert item.
 * @param {PatchEntry} entry - entry from the home patch.
 * @returns {string} YAML block.
 */
function insertSnippet(entry) {
  const raw = entry.text.trimEnd();
  if (!raw.trimStart().startsWith('-')) {
    return `- insert:\n    # moved from the home patch: overrides must share its layer\n    - ${raw.trim()}\n`;
  }
  // Re-anchor the entry at the four-space indent of a nested insert sequence.
  const leading = raw.length - raw.trimStart().length;
  const shift = 4 - leading;
  const lines = raw.split('\n').map((line, index) => {
    if (index === 0) return `${' '.repeat(4)}${line.trimStart()}`;
    if (shift >= 0) return `${' '.repeat(shift)}${line}`;
    let next = line;
    for (let remove = -shift; remove > 0 && next.startsWith(' '); remove -= 1) next = next.slice(1);
    return next;
  });
  return `- insert:\n    # moved from the home patch: overrides must share its layer\n${lines.join('\n')}\n`;
}

/**
 * Whether a patch's first meaningful line starts a top-level array.
 * @param {string} text - patch file contents.
 * @returns {'flow' | 'block' | 'invalid'} shape.
 */
function patchShape(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line === '---') continue;
    if (line.startsWith('[')) return 'flow';
    if (line.startsWith('-')) return 'block';
    return 'invalid';
  }
  return 'invalid';
}

/**
 * Whether the only meaningful content is an empty flow array (`[]`).
 * @param {string} text - patch file contents.
 * @returns {boolean} true for comments plus `[]`.
 */
function isEmptyArray(text) {
  const lines = text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#') && trimmed !== '---';
  });
  return lines.length === 1 && /^\[\s*\]$/.test(lines[0].trim());
}

/**
 * Split text into lines with their absolute offsets.
 * @param {string} text - haystack.
 * @returns {{ start: number, end: number, text: string }[]} line records without the newline.
 */
function lineSpans(text) {
  const lines = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    lines.push({ start, end, text: text.slice(start, end).replace(/\r$/, '') });
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
}

/**
 * Escape one literal for use inside a RegExp.
 * @param {string} value - literal text.
 * @returns {string} escaped text.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
