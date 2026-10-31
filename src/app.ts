import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { authentication } from './auth.ts';
import type { Config } from './config.ts';
import type { Callback } from './callback.ts';
import { event } from './model.ts';
import { integrations } from './integrations/index.ts';
import { Store } from './store.ts';
import { Events } from './events.ts';
import { mcp } from './mcp.ts';

function json(res: ServerResponse, status: number, body: unknown) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Request body too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export function app(config: Config, callback?: Callback) {
  const store = new Store(config.DATABASE_PATH, config.key); store.subscriptions();
  const auth = authentication(config), events = new Events(store, config.sources, callback), handler = mcp(store, events, config);
  const nodeHandler = toNodeHandler({ fetch: async request => {
    const principal = await auth.authenticate(Object.fromEntries(request.headers));
    if (!principal) return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    return handler.fetch(request, { authInfo: { token: '', clientId: principal.id, scopes: ['alerts:read'], expiresAt: principal.expiresAt / 1000 } });
  } }, { maxRequestBodySize: 1024 * 1024 });
  let maintenanceError: string | undefined;
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === '/healthz' && req.method === 'GET') return json(res, 200, { status: 'ok' });
      if (path === '/readyz' && req.method === 'GET') { store.ready(); return json(res, maintenanceError ? 503 : 200, { status: maintenanceError ? 'degraded' : 'ready' }); }
      if (path === '/mcp') {
        if (req.headers.origin && req.headers.origin !== config.PUBLIC_URL) return json(res, 403, { error: 'Origin not allowed' });
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error: 'Only POST is supported' }); }
        return await nodeHandler(req, res);
      }
      const route = /^\/webhooks\/([a-z0-9_-]+)\/([a-z0-9_-]+)$/.exec(path);
      const source = route && config.sources.find(x => x.id === route[2] && x.integration === route[1]);
      if (!source) return json(res, 404, { error: 'Not found' });
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error: 'Only POST is supported' }); }
      if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return json(res, 415, { error: 'Expected application/json' });
      const data = await body(req);
      let alerts;
      try { alerts = integrations.get(source.integration)!.receive(source, data, req.headers).map(event); }
      catch (error) { const signature = error instanceof Error && error.message === 'Invalid webhook signature or timestamp'; return json(res, signature ? 401 : 422, { error: signature ? 'Invalid webhook signature or timestamp' : 'Invalid integration payload' }); }
      return json(res, 202, { received: alerts.length, accepted: store.ingest(alerts) });
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof Error && error.message === 'Request body too large' ? 413 : 500, { error: 'Request failed' });
      console.error(JSON.stringify({ level: 'error', message: 'HTTP request failed', error: error instanceof Error ? error.message : 'Unknown failure' }));
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  async function maintain() {
    try { store.prune(Date.now() - config.RETENTION_DAYS * 86400000); const path = await store.backup(); maintenanceError = undefined; console.log(JSON.stringify({ level: 'info', message: 'Backup verified', path })); }
    catch (error) { maintenanceError = 'Backup failed'; console.error(JSON.stringify({ level: 'error', message: maintenanceError, error: String(error) })); }
  }
  return { server, store, events, maintain, auth, async close(pending: Promise<unknown>[] = []) { const stopped = new Promise<void>(resolve => { if (server.listening) server.close(() => resolve()); else resolve(); }); await Promise.allSettled([stopped, ...pending]); await handler.close(); store.close(); } };
}
