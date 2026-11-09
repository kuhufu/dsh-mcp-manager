/**
 * Deployment-wide "inject by default" preference for foreign `dsh-mcp-client`
 * entries. Their configuration belongs to the profile patch, so this document
 * only records the deviations: an entry is injected unless it is listed `false`.
 *
 * Stored at `<DSH_HOME>/storages/mcp-manager-external.json`.
 *
 * @module @kuhufu/dsh-mcp-manager/host/external-defaults
 */

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { isRecord, resolveDshHome } from './store.js';

/** Persisted document version. */
export const EXTERNAL_DEFAULTS_VERSION = 1;

/** Relative path of the document below `DSH_HOME`. */
export const EXTERNAL_DEFAULTS_RELATIVE_PATH = path.join('storages', 'mcp-manager-external.json');

/**
 * Create the external-entry default store.
 * @param {{ file?: string, logger?: object }} [options] - overrides for tests.
 * @returns {object} store handle.
 */
export function createExternalDefaults(options = {}) {
  const file = options.file ?? path.join(resolveDshHome(), EXTERNAL_DEFAULTS_RELATIVE_PATH);
  const logger = options.logger;
  /** @type {Record<string, boolean>} */
  let entries = {};
  let loaded = false;
  let loading;
  let writeChain = Promise.resolve();

  const warn = (message) => {
    if (typeof logger?.warn === 'function') logger.warn(`mcp-manager: ${message}`);
  };

  async function readDocument() {
    try {
      const document = JSON.parse(await readFile(file, 'utf8'));
      if (isRecord(document) && document.version !== undefined && document.version !== EXTERNAL_DEFAULTS_VERSION) {
        warn(`ignoring ${file}: unsupported document version ${String(document.version)}`);
        return;
      }
      if (isRecord(document) && isRecord(document.entries)) {
        for (const [entryId, autoInject] of Object.entries(document.entries)) {
          if (entryId !== '' && typeof autoInject === 'boolean') entries[entryId] = autoInject;
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`ignoring ${file}: ${error?.message ?? String(error)}`);
    }
  }

  function load() {
    if (loaded) return Promise.resolve();
    loading ??= readDocument().then(() => { loaded = true; });
    return loading;
  }

  async function writeSnapshot(candidate) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ version: EXTERNAL_DEFAULTS_VERSION, entries: candidate }, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw new Error(`could not persist external defaults: ${error?.message ?? String(error)}`);
    }
  }

  return {
    file,
    load,
    /** @param {string} entryId - Loader entry id. @returns {boolean} whether it is injected by default. */
    autoInjectOf: (entryId) => entries[entryId] !== false,
    /**
     * @param {string} entryId - Loader entry id.
     * @param {boolean} autoInject - requested default.
     * @returns {Promise<void>} settles after the write.
     */
    set(entryId, autoInject) {
      const run = writeChain.then(async () => {
        await load();
        const candidate = { ...entries };
        if (autoInject === true) delete candidate[entryId];
        else candidate[entryId] = false;
        await writeSnapshot(candidate);
        entries = candidate;
      });
      writeChain = run.then(() => undefined, () => undefined);
      return run;
    },
    flush: () => writeChain,
  };
}
