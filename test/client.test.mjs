import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { CONNECTION_OPTIONS } from '../host/store.js';
const source = (await readFile(new URL('../client.js', import.meta.url), 'utf8')).replace(
  'return { NS, inject, apply };',
  'return { NS, inject, apply, useManagerData, McpManagerSection, validateDraft, draftOf, parsePairs, directTranslator, ServerDialog, CONNECTION_OPTIONS, McpSessionPanel, openSessionPanel, closeSessionPanel, parseConfigText, previewEntries, previewTransport, previewTarget, importWarningText, ImportJsonDialog };',
);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));
function fixture() {
  let current, exported;
  const requests = [], mounts = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useState(initial) {
      const owner = current, index = owner.cursor++;
      if (!(index in owner.hooks)) owner.hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [owner.hooks[index], (value) => { owner.hooks[index] = typeof value === 'function' ? value(owner.hooks[index]) : value; }];
    },
    useRef(initial) { const [value] = this.useState(() => ({ current: initial })); return value; },
    useReducer(reducer, initial) { const [value, set] = this.useState(initial); return [value, (action) => set((previous) => reducer(previous, action))]; },
    useMemo(fn, deps) {
      const owner = current, index = owner.cursor++, old = owner.hooks[index];
      if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) owner.hooks[index] = { value: fn(), deps };
      return owner.hooks[index].value;
    },
    useCallback(fn, deps) { return this.useMemo(() => fn, deps); },
    memo(component) { return component; },
    useEffect(fn, deps) {
      const owner = current, index = owner.cursor++, old = owner.hooks[index];
      if (!old || !deps || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        owner.effects.push(() => { old?.cleanup?.(); owner.hooks[index] = { deps, cleanup: fn() }; });
      }
    },
    useId() { return this.useMemo(() => `uid-${current.id}-${current.cursor}`, []); },
  };
  vm.runInNewContext(source, {
    window: { addEventListener() {}, removeEventListener() {}, __ModuleLoader__: { load(module) { exported = module.factory(() => React); } } },
    navigator: { language: 'zh-CN' }, AbortController, AbortSignal, URL,
    setInterval() { return 1; }, clearInterval() {},
    fetch(route, options) { return new Promise((resolve, reject) => requests.push({ route, options, reject, reply(payload) { resolve({ json: async () => payload }); } })); },
  });
  function mount(component, props) {
    const owner = { id: mounts.length, hooks: [], effects: [], cursor: 0 };
    const handle = {
      render(nextProps = props) {
        props = nextProps;
        current = owner; owner.cursor = 0;
        const value = component(props); current = undefined;
        for (const effect of owner.effects.splice(0)) effect();
        return value;
      },
      unmount() { for (const hook of owner.hooks) hook?.cleanup?.(); },
    };
    mounts.push(handle); handle.render(); return handle;
  }
  const t = exported.directTranslator();
  return { api: exported, requests, mount, t, cleanup() { for (const handle of mounts) handle.unmount(); } };
}
const payload = (railEntry) => ({ ok: true, servers: [], external: [], ui: { railEntry }, storage: { readOnly: false, hasBackup: false } });

test('late polling cannot undo a preference mutation and both surfaces receive it', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const first = f.mount(f.api.useManagerData, f.t), second = f.mount(f.api.useManagerData, f.t);
  assert.equal(f.requests.length, 2);
  const mutation = first.render().actions.setRailEntry(false);
  await flush(); f.requests[2].reply(payload(false)); await mutation; await flush();
  f.requests[0].reply(payload(true)); f.requests[1].reply(payload(true)); await flush();
  assert.equal(first.render().railEntry, false); assert.equal(second.render().railEntry, false);
});

test('writes from different surfaces are serialized and publish in commit order', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const first = f.mount(f.api.useManagerData, f.t), second = f.mount(f.api.useManagerData, f.t);
  f.requests[0].reply(payload(true)); f.requests[1].reply(payload(true)); await flush();
  const a = first.render().actions.setRailEntry(false);
  const b = second.render().actions.setRailEntry(true);
  await flush(); assert.equal(f.requests.length, 3);
  f.requests[2].reply(payload(false)); await a; await flush();
  assert.equal(f.requests.length, 4); assert.equal(second.render().railEntry, false);
  f.requests[3].reply(payload(true)); await b; await flush();
  assert.equal(first.render().railEntry, true); assert.equal(second.render().railEntry, true);
});

test('unmount aborts reads and manual refresh replaces an in-flight poll', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const page = f.mount(f.api.useManagerData, f.t);
  void page.render().requestList(true);
  assert.equal(f.requests[0].options.signal.aborted, true);
  page.unmount(); assert.equal(f.requests[1].options.signal.aborted, true);
});

test('failed requests release the read gate so refresh can retry', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const page = f.mount(f.api.useManagerData, f.t);
  f.requests[0].reject(new Error('offline')); await flush();
  assert.ok(page.render().loadError);
  void page.render().requestList(true); f.requests[1].reply(payload(true)); await flush();
  assert.equal(page.render().loadError, null);
});

test('form round trip preserves whitespace, connection settings and disabled tools', () => {
  const f = fixture();
  const server = { name: 'test', transport: 'stdio', command: 'node', env: { VALUE: '  padded  ' }, requestTimeoutMs: 120000, retryCount: 2, disabledTools: ['echo'] };
  const draft = f.api.draftOf(server), validated = f.api.validateDraft(draft, [], f.t);
  assert.equal(validated.input.env.VALUE, '  padded  ');
  assert.equal(validated.input.requestTimeoutMs, 120000); assert.equal(validated.input.retryCount, 2);
  assert.deepEqual(plain(validated.input.disabledTools), ['echo']);
  assert.ok(f.api.validateDraft({ ...draft, retryCount: '11' }, [], f.t).errors.retryCount);
});

test('page exposes import/export, search, status and storage recovery controls', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const page = f.mount(f.api.McpManagerSection, { t: f.t });
  f.requests[0].reply(payload(true)); await flush();
  const nodes = [];
  function visit(node) { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) return node.forEach(visit); nodes.push(node); node.children?.forEach(visit); }
  visit(page.render());
  assert.ok(nodes.some((node) => node.type === 'input' && node.props.type === 'search'));
  assert.ok(nodes.some((node) => node.type?.name === 'ConfigTransfer'));
  assert.ok(nodes.some((node) => node.type?.name === 'StorageRecovery'));
  const importer = nodes.find((node) => node.type === 'button' && node.props['aria-label'] === f.t('importMcpTitle'));
  assert.notEqual(importer, undefined);
  importer.props.onClick();
  assert.ok(elements(page.render()).some((node) => node.type?.name === 'ImportJsonDialog'));
});

test('direct MCP JSON paste tolerates JSONC comments and trailing commas', () => {
  const f = fixture();
  const document = f.api.parseConfigText(`{
    // Claude Desktop / Cursor style
    "mcpServers": {
      "example-server": { "command": "npx", "args": ["-y", "pkg"], /* inline */ },
      "remote": { "type": "http", "url": "https://example.com/mcp?query=a//b", },
    },
  }`);
  assert.equal(document.mcpServers['example-server'].command, 'npx');
  assert.equal(document.mcpServers.remote.url, 'https://example.com/mcp?query=a//b');
  assert.equal(f.api.parseConfigText('\uFEFF{"mcpServers":{}}').mcpServers !== undefined, true);
  assert.equal(f.api.parseConfigText('{ broken'), undefined);
  assert.equal(f.api.parseConfigText('   '), undefined);
});

test('the import preview reads every supported document shape', () => {
  const f = fixture();
  const names = (document) => plain(f.api.previewEntries(document)).map((entry) => entry.name);
  assert.deepEqual(names({ mcpServers: { a: { command: 'node' }, b: { url: 'https://example.com/mcp' } } }), ['a', 'b']);
  assert.deepEqual(names({ inputs: [{ id: 'token' }], servers: { vs: { type: 'stdio', command: 'node' } } }), ['vs']);
  assert.deepEqual(names([{ name: 'arr', transport: 'stdio', command: 'node' }]), ['arr']);
  assert.deepEqual(names({ bare: { command: 'node' } }), ['bare']);
  assert.deepEqual(names({ name: 'solo', command: 'node' }), ['solo']);
  assert.deepEqual(names({ inputs: [], foo: 'bar' }), []);
  assert.equal(f.api.previewTransport({ type: 'sse', url: 'https://example.com/sse' }), 'sse');
  assert.equal(f.api.previewTransport({ command: 'node' }), 'stdio');
  assert.equal(f.api.previewTransport({ url: 'https://example.com/mcp' }), 'http');
  assert.equal(f.api.previewTransport({ type: 'stdio' }), 'invalid');
  assert.equal(f.api.previewTarget({ command: 'node', args: ['server.mjs'] }), 'node server.mjs');
  assert.equal(f.api.previewTarget({ url: 'https://example.com/mcp' }), 'https://example.com/mcp');
});

test('the direct import dialog posts the parsed document and reports the summary', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  let received;
  const onImport = async (document, enable) => {
    received = { document, enable };
    return {
      imported: 1,
      enabled: 1,
      warnings: [{ kind: 'renamed', from: 'My Server', to: 'My-Server' }],
    };
  };
  const dialog = f.mount(f.api.ImportJsonDialog, { t: f.t, readOnly: false, onClose() {}, onImport });
  const textarea = () => elements(dialog.render()).find((node) => node.type === 'textarea');
  textarea().props.onChange({ target: { value: '{"mcpServers":{"My Server":{"command":"node"}}}' } });
  dialog.render();
  assert.equal(textarea().props.value, '{"mcpServers":{"My Server":{"command":"node"}}}');
  const form = elements(dialog.render()).find((node) => node.type === 'form');
  await form.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(plain(received.document), { mcpServers: { 'My Server': { command: 'node' } } });
  assert.equal(received.enable, true);
  const nodes = elements(dialog.render());
  assert.ok(nodes.some((node) => node.children?.[0] === f.t('importMcpDone', { count: 1, enabled: 1 })));
  assert.ok(nodes.some((node) => node.type === 'li' && node.children?.[0] === f.t('importRenamed', { from: 'My Server', to: 'My-Server' })));
  assert.equal(f.api.importWarningText({ kind: 'skipped', name: 'sse', reason: 'sse-unsupported' }, f.t),
    f.t('importSkipped', { name: 'sse', reason: f.t('importReasonSse') }));
});

test('a late read from one surface cannot replace a newer snapshot from another', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const first = f.mount(f.api.useManagerData, f.t), second = f.mount(f.api.useManagerData, f.t);
  f.requests[1].reply(payload(false)); await flush();
  f.requests[0].reply(payload(true)); await flush();
  assert.equal(first.render().railEntry, false); assert.equal(second.render().railEntry, false);
});

function elements(tree) {
  const result = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    result.push(node); node.children?.forEach(visit);
  }
  visit(tree); return result;
}

test('saving dialogs retain Escape, close and cancel, and report detached failures', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  let rejectSave, closed = 0, detached;
  const props = { t: f.t, mode: 'edit', server: { name: 'test', transport: 'stdio', command: 'node' }, servers: [],
    onSave: () => new Promise((_resolve, reject) => { rejectSave = reject; }),
    onClose: () => { closed++; }, onDetachedError: (error) => { detached = error; } };
  const dialog = f.mount(f.api.ServerDialog, props);
  const saving = elements(dialog.render()).find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} });
  const nodes = elements(dialog.render());
  const close = nodes.find((node) => node.props['aria-label'] === f.t('closeDialog'));
  assert.notEqual(close.props.disabled, true); close.props.onClick();
  const cancel = nodes.find((node) => node.type === 'button' && node.children.includes(f.t('cancel')));
  assert.notEqual(cancel.props.disabled, true); cancel.props.onClick();
  nodes.find((node) => node.props.role === 'dialog').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(closed, 3);
  dialog.unmount(); rejectSave(new Error('save failed')); await saving;
  assert.equal(detached.message, 'save failed');
});

test('completion of a dismissed save cannot close a newly opened editor', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const page = f.mount(f.api.McpManagerSection, { t: f.t });
  const data = { ...payload(true), servers: [{ id: 'one', name: 'one', command: 'node', transport: 'stdio', enabled: false }] };
  f.requests[0].reply(data); await flush();
  const edit = () => elements(page.render()).find((node) => node.type?.name === 'ServerRow').props.onEdit();
  const editor = () => elements(page.render()).find((node) => node.type?.name === 'ServerDialog');
  edit(); const first = editor(); const saving = first.props.onSave({ name: 'one', transport: 'stdio', command: 'node' });
  first.props.onClose(); edit(); const second = editor();
  assert.notEqual(first.props.key, second.props.key);
  await flush(); f.requests[1].reply(data); await saving; await flush();
  assert.equal(editor().props.key, second.props.key);
});

test('matching external rows suppress no-results text and preference remains last', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const page = f.mount(f.api.McpManagerSection, { t: f.t });
  f.requests[0].reply({ ...payload(true), servers: [{ name: 'managed', enabled: false }], external: [{ entryId: 'foreign', serverName: 'foreign', enabled: true }] }); await flush();
  elements(page.render()).find((node) => node.props.type === 'search').props.onChange({ target: { value: 'foreign' } });
  const nodes = elements(page.render());
  assert.ok(nodes.some((node) => node.type?.name === 'ExternalList'));
  assert.equal(nodes.some((node) => node.children.includes(f.t('noMatches'))), false);
  const transfers = nodes.filter((node) => node.type?.name === 'ConfigTransfer');
  assert.equal(transfers.length, 1);
  assert.ok(nodes.indexOf(transfers[0]) < nodes.findIndex((node) => node.type?.name === 'RailPreferenceRow'));
});

test('browser connection ranges and defaults stay aligned with the Host', () => {
  const f = fixture();
  assert.deepEqual(plain(f.api.CONNECTION_OPTIONS), CONNECTION_OPTIONS);
});

const sessionPayload = (sessionId, visible) => ({
  ok: true, sessionId, overrides: {},
  servers: [{ id: 'managed', name: 'managed', enabled: true, visible, status: 'ready' }],
  external: [{ entryId: 'foreign', serverName: 'foreign', enabled: true, visible }],
});
function panelControl(panel, t, kind) {
  const nodes = elements(panel.render());
  if (kind === 'reset') return nodes.find((node) => node.type === 'button' && node.children.includes(t('sessionReset')));
  const label = t(kind === 'managed' ? 'sessionToggle' : 'sessionHideExternal', { name: kind === 'managed' ? 'managed' : 'foreign' });
  return nodes.find((node) => node.type?.name === 'SwitchButton' && node.props.label === label);
}
for (const kind of ['managed', 'external', 'reset']) {
  for (const outcome of ['success', 'failure']) {
    test(`${kind} ${outcome} from an old session cannot replace state, error or busy status`, async (t) => {
      const f = fixture(); t.after(f.cleanup);
      f.api.openSessionPanel('a');
      const panel = f.mount(f.api.McpSessionPanel, { t: f.t });
      f.requests[0].reply(sessionPayload('a', true)); await flush();
      const control = panelControl(panel, f.t, kind);
      (control.props.onChange ?? control.props.onClick)();
      const old = f.requests[1];
      if (kind === 'reset') assert.deepEqual(JSON.parse(old.options.body), { sessionId: 'a', reset: true });
      f.api.openSessionPanel('b'); panel.render();
      f.requests[2].reply(sessionPayload('b', false)); await flush();
      assert.equal(panelControl(panel, f.t, 'managed').props.checked, false);
      panelControl(panel, f.t, 'managed').props.onChange();
      assert.deepEqual(JSON.parse(f.requests[3].options.body), { sessionId: 'b', serverId: 'managed', enabled: true });
      if (outcome === 'success') old.reply(sessionPayload('a', true));
      else old.reject(new Error('old session failed'));
      await flush();
      const current = panelControl(panel, f.t, 'managed');
      assert.equal(current.props.checked, false, 'B keeps its own visibility');
      assert.equal(current.props.busy, true, 'A cannot clear B’s pending mutation');
      assert.equal(elements(panel.render()).some((node) => node.props.role === 'alert'), false);
      f.requests[3].reply(sessionPayload('b', true)); await flush();
      assert.equal(panelControl(panel, f.t, 'managed').props.checked, true);
      panelControl(panel, f.t, 'managed').props.onChange();
      assert.deepEqual(JSON.parse(f.requests[4].options.body), { sessionId: 'b', serverId: 'managed', enabled: false });
      f.requests[4].reply(sessionPayload('b', false)); await flush();
    });
  }
}

test('closing and reopening the same session invalidates prior mutations and reads', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  f.api.openSessionPanel('a');
  const panel = f.mount(f.api.McpSessionPanel, { t: f.t, sessionId: 'a' });
  f.requests[0].reply(sessionPayload('a', true)); await flush();
  panelControl(panel, f.t, 'external').props.onChange();
  // Closing and reopening are separate interactions: the close must land as a
  // render before the reopen, or React sees one unchanged `active` value.
  f.api.closeSessionPanel(); panel.render();
  f.api.openSessionPanel('a'); panel.render();
  f.requests[2].reply(sessionPayload('a', false)); await flush();
  f.requests[1].reply(sessionPayload('a', true)); await flush();
  assert.equal(panelControl(panel, f.t, 'external').props.checked, false);

  f.api.closeSessionPanel(); panel.render();
  f.api.openSessionPanel('a'); panel.render();
  f.api.openSessionPanel('b'); panel.render({ t: f.t, sessionId: 'b' });
  f.requests[4].reply(sessionPayload('b', false)); await flush();
  f.requests[3].reply(sessionPayload('a', true)); await flush();
  assert.equal(panelControl(panel, f.t, 'managed').props.checked, false);
});
