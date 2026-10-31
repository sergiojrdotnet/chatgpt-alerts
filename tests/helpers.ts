import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { Events } from '../src/events.ts';
import type { Callback } from '../src/callback.ts';
import type { Alert } from '../src/model.ts';
export const signingSecret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
export const principal = { id: 'alice', expiresAt: Date.now() + 86400000 };
export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-alerts-'));
  const sources = [{ id: 'production', name: 'Production', integration: 'grafana', secret: randomBytes(32).toString('hex') }, { id: 'staging', name: 'Staging', integration: 'grafana', secret: randomBytes(32).toString('hex') }];
  const path = join(directory, 'sources.json'); writeFileSync(path, JSON.stringify({ sources }));
  const env = { HOST: '127.0.0.1', PORT: '0', SOURCES_FILE: path, STORAGE_KEY: randomBytes(32).toString('base64'), DATABASE_PATH: join(directory, 'alerts.sqlite'), DEV_TOKEN: randomBytes(32).toString('hex') };
  return { directory, env, config: loadConfig(env), cleanup() { rmSync(directory, { recursive: true, force: true }); } };
}
export function setup(post?: Callback) {
  const f = fixture(), store = new Store(f.config.DATABASE_PATH, f.config.key), payloads: Record<string, unknown>[] = [];
  const callback: Callback = post ?? (async (_id, _credentials, value) => { const data = value as Record<string, unknown>; payloads.push(data); return { status: 200, body: JSON.stringify({ challenge: data.challenge }) }; });
  const events = new Events(store, f.config.sources, callback);
  return { ...f, store, events, payloads, close() { store.close(); f.cleanup(); } };
}
export function subscription(source = 'production', labels = {}) { return { name: 'alert.firing' as const, arguments: { source, labels }, delivery: { mode: 'webhook' as const, url: 'https://callbacks.example.com/events', secret: signingSecret } }; }
export function alert(status: 'firing' | 'resolved' = 'firing', source = 'production', fingerprint = 'a'): Alert {
  return { integration: 'grafana', source, fingerprint, status, name: 'Memory high', labels: { severity: 'warning' }, annotations: { summary: 'Memory usage threshold' }, startsAt: '2026-10-31T10:00:00Z', ...(status === 'resolved' ? { endsAt: '2026-10-31T10:01:00Z' } : {}), links: {} };
}
export function notification(status = 'firing') { return { receiver: 'alerts', orgId: 1, status, groupKey: 'group', truncatedAlerts: 0, alerts: [{ fingerprint: 'a', status, labels: { alertname: 'Memory high', severity: 'warning' }, annotations: { summary: 'Memory usage threshold' }, startsAt: '2026-10-31T10:00:00Z', endsAt: status === 'resolved' ? '2026-10-31T10:01:00Z' : '0001-01-01T00:00:00Z' }] }; }
export function signed(body: Buffer, secret: string, now = Date.now()) { const timestamp = Math.floor(now / 1000).toString(); return { 'content-type': 'application/json', 'x-grafana-alerting-timestamp': timestamp, 'x-grafana-alerting-signature': createHmac('sha256', secret).update(`${timestamp}:`).update(body).digest('hex') }; }
