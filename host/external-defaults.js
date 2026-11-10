/**
 * Deployment-wide "inject by default" preference for foreign `dsh-mcp-client`
 * entries. Their configuration belongs to the profile patch, so this document
 * only records the deviations: an entry is injected unless it is listed `false`.
 *
 * Stored at `<DSH_HOME>/storages/mcp-manager-external.json`.
 *
 * @module @kuhufu/dsh-mcp-manager/host/external-defaults
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeFileAtomic } from './atomic-file.js';
import { ManagerError, isRecord, resolveDshHome } from './store.js';

/** Persisted document version. */
const EXTERNAL_DEFAULTS_VERSION = 1;

/** Relative path of the document below `DSH_HOME`. */
const EXTERNAL_DEFAULTS_RELATIVE_PATH = path.join('storages', 'mcp-manager-external.json');

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
  /** Exact bytes this store last read or wrote; see `writeSnapshot`. */
  let baseline = '';
  let baselineKnown = false;

  const warn = (message) => {
    if (typeof logger?.warn === 'function') logger.warn(`mcp-manager: ${message}`);
  };

  async function readDocument() {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`ignoring ${file}: ${error?.message ?? String(error)}`);
      baseline = '';
      baselineKnown = error?.code === 'ENOENT';
      return {};
    }
    let document;
    try {
      document = JSON.parse(raw);
    } catch (error) {
      warn(`ignoring ${file}: ${error?.message ?? String(error)}`);
      baselineKnown = false;
      return {};
    }
    if (isRecord(document) && document.version !== undefined && document.version !== EXTERNAL_DEFAULTS_VERSION) {
      warn(`ignoring ${file}: unsupported document version ${String(document.version)}`);
      baselineKnown = false;
      return {};
    }
    /** @type {Record<string, boolean>} */
    const next = {};
    if (isRecord(document) && isRecord(document.entries)) {
      for (const [entryId, autoInject] of Object.entries(document.entries)) {
        if (entryId !== '' && typeof autoInject === 'boolean') next[entryId] = autoInject;
      }
    }
    baseline = raw;
    baselineKnown = true;
    return next;
  }

  function load() {
    if (loaded) return Promise.resolve();
    loading ??= readDocument().then((document) => {
      entries = document;
      loaded = true;
    });
    return loading;
  }

  async function writeSnapshot(candidate) {
    if (baselineKnown) {
      let current;
      try { current = await readFile(file, 'utf8'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if ((current ?? '') !== baseline) {
        // Another process replaced the document; follow it and let the caller retry.
        entries = await readDocument();
        throw new ManagerError('conflict', `${file} was changed by another process; the default-injection flags were reloaded, retry the change`);
      }
    }
    const payload = `${JSON.stringify({ version: EXTERNAL_DEFAULTS_VERSION, entries: candidate }, null, 2)}\n`;
    try {
      await writeFileAtomic(file, payload);
    } catch (error) {
      throw new Error(`could not persist external defaults: ${error?.message ?? String(error)}`);
    }
    baseline = payload;
    baselineKnown = true;
  }

  return {
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
