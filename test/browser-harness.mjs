import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createMcpManager } from '../host/manager.js';
import { createFetchRoutes } from '../host/routes.js';
await mkdir(path.join(import.meta.dirname, '../.qa'), { recursive: true });
process.env.DSH_HOME = await mkdtemp(path.join(import.meta.dirname, '../.qa/browser-home-'));
const home = process.env.DSH_HOME;
const tools = new Map();
const manager = createMcpManager({ ctx: { tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); }, schemas() { return [...tools.values()]; } } } });
await manager.boot();
const routes = createFetchRoutes(manager);
const server = createServer(async (req, res) => {
  if (req.url === '/__qa/corrupt' && req.method === 'POST') {
    await writeFile(path.join(home, 'storages/mcp-manager.json'), '{broken');
    res.end('ok'); return;
  }
  const route = routes.find(route => route.path === req.url);
  if (route) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const response = await route.fetch(new Request('http://localhost' + req.url, { method: 'POST', body: raw }));
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
  }
  const files = { '/': 'browser.html', '/react.js': '../.qa/react.js', '/react-dom.js': '../.qa/react-dom.js', '/client.js': '../client.js' };
  if (!files[req.url]) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', req.url === '/' ? 'text/html' : 'text/javascript');
  res.end(await readFile(new URL(files[req.url], import.meta.url)));
});
server.listen(4199, '127.0.0.1');
process.on('SIGTERM', async () => { await manager.dispose(); server.closeAllConnections(); server.close(); await rm(home, { recursive: true, force: true }); });
