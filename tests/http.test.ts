import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { app } from '../src/app.ts';
import { fixture, notification, signed, signingSecret } from './helpers.ts';

async function running() {
  const f = fixture();
  const runtime = app(f.config, async (_id, _credentials, data) => ({ status: 200, body: JSON.stringify(data) }));
  await new Promise<void>(r => runtime.server.listen(0, '127.0.0.1', r));
  const address = runtime.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  async function rpc(method: string, params: Record<string, unknown> = {}, version = '2026-07-28') {
    const modern = version === '2026-07-28';
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${f.config.DEV_TOKEN}`, 'MCP-Protocol-Version': version };
    if (modern) { headers['Mcp-Method'] = method; if (method === 'tools/call') headers['Mcp-Name'] = String(params.name); }
    const meta = modern ? { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientInfo': { name: 'acceptance', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } : undefined;
    const response = await fetch(base + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, ...(meta ? { _meta: meta } : {}) } }) });
    const raw = await response.text();
    const data = response.headers.get('content-type')?.includes('text/event-stream') ? raw.split('\n').find(x => x.startsWith('data: '))!.slice(6) : raw;
    return { status: response.status, body: JSON.parse(data) };
  }
  return { ...f, runtime, base, rpc, async close() { await runtime.close(); f.cleanup(); } };
}
test('Official SDK serves modern discovery, tools and the Events extension', async () => {
  const r = await running(); try {
    const discover = await r.rpc('server/discover'); assert.equal(discover.status, 200); assert.deepEqual(discover.body.result.capabilities.events, {}); assert.equal(discover.body.result.cacheScope, 'private');
    const tools = await r.rpc('tools/list'); assert.deepEqual(tools.body.result.tools.map((x: { name: string }) => x.name).sort(), ['get_alert', 'list_alerts', 'list_sources', 'subscription_status']);
    const catalog = await r.rpc('events/list'); assert.deepEqual(catalog.body.result.events.map((x: { name: string }) => x.name), ['alert.firing', 'alert.resolved']);
    const subscribe = await r.rpc('events/subscribe', { name: 'alert.firing', arguments: { source: 'production' }, delivery: { mode: 'webhook', url: 'https://callbacks.example.com/events', secret: signingSecret } });
    assert.ok(subscribe.body.result.id); assert.equal(r.runtime.store.subscriptions()[0]?.filters.source, 'production');
    const status = await r.rpc('tools/call', { name: 'subscription_status', arguments: {} }); assert.equal(status.body.result.structuredContent.subscriptions.length, 1);
    const stop = await r.rpc('events/unsubscribe', { name: 'alert.firing', arguments: { source: 'production' }, delivery: { mode: 'webhook', url: 'https://callbacks.example.com/events' } }); assert.equal(stop.body.error, undefined);
  } finally { await r.close(); }
});
for (const version of ['2025-03-26', '2025-06-18', '2025-11-25']) test(`SDK supports ${version} initialization and Events`, async () => {
  const r = await running(); try {
    const initialize = await r.rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'legacy', version: '1' } }, version);
    assert.equal(initialize.body.result.protocolVersion, version); assert.deepEqual(initialize.body.result.capabilities.events, {});
    const tools = await r.rpc('tools/list', {}, version); assert.equal(tools.body.result.tools.length, 4);
    const events = await r.rpc('events/list', {}, version); assert.equal(events.body.result.events.length, 2);
  } finally { await r.close(); }
});
test('Real SDK client discovers and invokes tools', async () => {
  const r = await running(), client = new Client({ name: 'sdk-acceptance', version: '1' });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(r.base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${r.config.DEV_TOKEN}` } } });
    await client.connect(transport); const tools = await client.listTools(); assert.equal(tools.tools.length, 4);
    const sources = await client.callTool({ name: 'list_sources', arguments: {} }); assert.deepEqual((sources.structuredContent as { sources: { id: string }[] }).sources.map(x => x.id), ['production', 'staging']);
  } finally { await client.close(); await r.close(); }
});
test('Signed Grafana intake normalizes alerts, rejects forgery and truncation, and deduplicates', async () => {
  const r = await running(); try {
    const payload = Buffer.from(JSON.stringify(notification())); const url = r.base + '/webhooks/grafana/production';
    const headers = signed(payload, r.config.sources[0]!.secret);
    let response = await fetch(url, { method: 'POST', headers, body: payload }); assert.equal(response.status, 202); assert.deepEqual(await response.json(), { received: 1, accepted: 1 });
    response = await fetch(url, { method: 'POST', headers, body: payload }); assert.equal((await response.json()).accepted, 0);
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 401);
    const truncated = Buffer.from(JSON.stringify({ ...notification(), truncatedAlerts: 1 })); assert.equal((await fetch(url, { method: 'POST', headers: signed(truncated, r.config.sources[0]!.secret), body: truncated })).status, 422);
    assert.equal(r.runtime.store.eventsAfter(0).length, 1); assert.equal(r.runtime.store.eventsAfter(0)[0]?.name, 'alert.firing'); assert.equal(r.runtime.store.eventsAfter(0)[0]?.data.endsAt, undefined);
  } finally { await r.close(); }
});
test('Authentication, origins, methods, content types, body limits and source routes fail closed', async () => {
  const r = await running(); try {
    assert.equal((await fetch(r.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(r.base + '/mcp', { method: 'POST', headers: { Origin: 'https://malicious.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(r.base + '/mcp')).status, 405);
    assert.equal((await fetch(r.base + '/webhooks/unknown/production', { method: 'POST' })).status, 404);
    assert.equal((await fetch(r.base + '/webhooks/grafana/production', { method: 'POST', body: '{}' })).status, 415);
    assert.equal((await fetch(r.base + '/webhooks/grafana/production', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'a'.repeat(1024 * 1024 + 1) })).status, 413);
  } finally { await r.close(); }
});
