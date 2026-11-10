/**
 * Atomic file replacement shared by every document this bundle persists.
 *
 * The Harness home is shared with other processes, so a write must never leave
 * a half-written document behind. Each write goes to an exclusive `0600`
 * temporary sibling, is flushed and only then renamed over the target. Backups
 * use `COPYFILE_EXCL` so a snapshot taken within the same millisecond as an
 * earlier one is never replaced.
 *
 * @module @kuhufu/dsh-mcp-manager/host/atomic-file
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** Per-process temporary sequence, so concurrent writers never share a name. */
let sequence = 0;

/**
 * Replace one file atomically with a flushed temporary sibling.
 *
 * @param {string} file - target path.
 * @param {string} contents - new contents.
 * @param {{ mode?: number }} [options] - file mode for the temporary sibling.
 * @returns {Promise<void>} settles after the rename.
 */
export async function writeFileAtomic(file, contents, options = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${sequence += 1}-${randomUUID()}`;
  try {
    const handle = await open(temporary, 'wx', options.mode ?? 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Copy one file beside itself without ever replacing an existing backup.
 *
 * @param {string} source - file to snapshot.
 * @param {string} suffix - suffix after the source name, e.g. `bak-1699999999999`.
 * @returns {Promise<string>} the backup path that was created.
 */
export async function copyFileOnce(source, suffix) {
  for (let attempt = 1; ; attempt += 1) {
    const target = attempt === 1 ? `${source}.${suffix}` : `${source}.${suffix}-${attempt}`;
    try {
      await copyFile(source, target, constants.COPYFILE_EXCL);
      return target;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
}
