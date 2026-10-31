import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, principal, subscription, alert, signingSecret } from './helpers.ts';
import { event } from '../src/model.ts';
import { Store } from '../src/store.ts';
import { Events } from '../src/events.ts';

test('Refresh preserves identity, replay progress and encrypted rotating credentials', async () => {
  const s = setup();
  try {
    const first = await s.events.subscribe(principal, subscription());
    s.store.ingest([event(alert())]); await s.events.deliver(() => true);
    const rotated = { ...subscription(), delivery: { ...subscription().delivery, secret: `whsec_${Buffer.alloc(32, 9).toString('base64')}` } };
    const refreshed = await s.events.subscribe(principal, rotated);
    assert.equal(first.id, refreshed.id); assert.equal(s.store.subscriptions().length, 1);
    const row = s.store.subscription(first.id)!; assert.equal(row.cursor, 1); assert.equal(row.credentials.previousSecret, signingSecret);
    const bytes = Buffer.concat([readFileSync(s.config.DATABASE_PATH), readFileSync(s.config.DATABASE_PATH + '-wal')]);
    assert.equal(bytes.includes(Buffer.from(signingSecret)), false); assert.equal(bytes.includes(Buffer.from(subscription().delivery.url)), false);
    s.store.close(); const restored = new Store(s.config.DATABASE_PATH, s.config.key);
    assert.equal(restored.subscription(first.id)?.credentials.secret, rotated.delivery.secret); restored.close();
  } finally { s.cleanup(); }
});
test('Filter by source, state and labels while preserving occurrence order metadata and deduplicating retries', async () => {
  const s = setup(); try {
    await s.events.subscribe(principal, subscription('production', { severity: 'warning' }));
    const item = event(alert()); s.store.ingest([event(alert('firing', 'staging')), event(alert('resolved')), item]); assert.equal(s.store.ingest([item]), 0);
    await s.events.deliver(() => true);
    const deliveries = s.payloads.filter(x => x.eventId); assert.equal(deliveries.length, 1); assert.equal(deliveries[0]?.eventId, item.eventId);
  } finally { s.close(); }
});
test('Replay cursors are bound to owner, callback and filters', async () => {
  const s = setup(); try {
    const first = await s.events.subscribe(principal, subscription());
    s.store.ingest([event(alert())]); await s.events.deliver(() => true);
    const cursor = s.payloads.find(x => x.eventId)!.cursor as string;
    await assert.rejects(s.events.subscribe({ ...principal, id: 'bob' }, { ...subscription(), cursor }), /cursor/);
    await assert.rejects(s.events.subscribe(principal, { ...subscription('staging'), cursor }), /cursor/);
    const replay = await s.events.subscribe(principal, { ...subscription(), cursor: first.cursor }); assert.equal(replay.truncated, false);
    await s.events.deliver(() => true); assert.equal(s.payloads.filter(x => x.eventId).length, 2);
  } finally { s.close(); }
});
test('A transient failure blocks following events, retries, and clears only after acknowledgement', async () => {
  let status = 503; const delivered: string[] = [];
  const s = setup(async (_id, _credentials, value) => { const data = value as { challenge?: string; eventId?: string }; if (data.challenge) return { status: 200, body: JSON.stringify(data) }; delivered.push(data.eventId!); return { status, body: '' }; });
  try {
    const sub = await s.events.subscribe(principal, subscription()); s.store.ingest([event(alert()), event(alert('firing', 'production', 'b'))]);
    await s.events.deliver(() => true); assert.equal(delivered.length, 1); assert.equal(s.store.subscription(sub.id)?.cursor, 0);
    status = 200; await s.events.deliver(() => true, Date.now() + 2000); assert.equal(delivered.length, 3); assert.equal(s.store.subscription(sub.id)?.cursor, 2); assert.equal(s.store.subscription(sub.id)?.attempts, 0);
  } finally { s.close(); }
});
for (const status of [400, 410, 413]) test(`HTTP ${status} stops automatic retry without discarding the event`, async () => {
  const s = setup(async (_id, _credentials, value) => { const data = value as { challenge?: string }; return data.challenge ? { status: 200, body: JSON.stringify(data) } : { status, body: '' }; });
  try { const sub = await s.events.subscribe(principal, subscription()); s.store.ingest([event(alert())]); await s.events.deliver(() => true); assert.equal(s.store.subscription(sub.id)?.state, status === 410 ? 'gone' : 'failed'); assert.equal(s.store.subscription(sub.id)?.cursor, 0); assert.equal(s.store.eventsAfter(0).length, 1); } finally { s.close(); }
});
test('Unsubscribe cannot be overwritten by an in-flight acknowledgement', async () => {
  let release: (() => void) | undefined, started: (() => void) | undefined;
  const ready = new Promise<void>(r => { started = r; });
  const s = setup(async (_id, _credentials, value) => { const data = value as { challenge?: string }; if (data.challenge) return { status: 200, body: JSON.stringify(data) }; started!(); await new Promise<void>(r => { release = r; }); return { status: 200, body: '' }; });
  try {
    const params = subscription(), sub = await s.events.subscribe(principal, params); s.store.ingest([event(alert())]); const pending = s.events.deliver(() => true); await ready;
    s.events.unsubscribe(principal, params); release!(); await pending;
    assert.equal(s.store.subscription(sub.id)?.state, 'unsubscribed'); assert.equal(s.store.subscription(sub.id)?.cursor, 0);
  } finally { s.close(); }
});
test('Concurrent worker invocations do not duplicate in-flight delivery', async () => {
  let release: (() => void) | undefined, started: (() => void) | undefined, calls = 0; const ready = new Promise<void>(r => { started = r; });
  const s = setup(async (_id, _credentials, value) => { const data = value as { challenge?: string }; if (data.challenge) return { status: 200, body: JSON.stringify(data) }; calls++; started!(); await new Promise<void>(r => { release = r; }); return { status: 200, body: '' }; });
  try { await s.events.subscribe(principal, subscription()); s.store.ingest([event(alert())]); const pending = s.events.deliver(() => true); await ready; await s.events.deliver(() => true); assert.equal(calls, 1); release!(); await pending; } finally { s.close(); }
});
test('Retention reports a truncated replay without treating deduplication sequence gaps as lost history', async () => {
  const s = setup(); try {
    const sub = await s.events.subscribe(principal, subscription()); const first = event(alert()); s.store.ingest([first], 100); s.store.ingest([first], 100); s.store.ingest([event(alert('firing', 'production', 'b'))], 200);
    s.store.acknowledge(sub.id, 1, 1); s.store.prune(150);
    const normal = await s.events.subscribe(principal, subscription()); assert.equal(normal.truncated, false);
    const replay = await s.events.subscribe(principal, { ...subscription(), cursor: sub.cursor }); assert.equal(replay.truncated, true);
    await s.events.deliver(() => true); assert.equal(s.payloads.filter(x => x.eventId).length, 1);
  } finally { s.close(); }
});
test('Expired and revoked subscriptions do not receive events', async () => {
  const s = setup(); try {
    const sub = await s.events.subscribe(principal, { ...subscription(), ttlMs: 1 }, Date.now() - 10); s.store.ingest([event(alert())]); await s.events.deliver(() => true); assert.equal(s.payloads.filter(x => x.eventId).length, 0);
    await s.events.subscribe(principal, subscription()); await s.events.deliver(() => false); assert.equal(s.store.subscription(sub.id)?.state, 'gone');
  } finally { s.close(); }
});
test('Reject invalid verification, unauthorized sources and unsupported replay age', async () => {
  const s = setup(async () => ({ status: 200, body: '{}' })); try {
    await assert.rejects(s.events.subscribe(principal, subscription()), /verification/);
    await assert.rejects(s.events.subscribe(principal, subscription('unknown')), /authorized/);
    await assert.rejects(s.events.subscribe(principal, { ...subscription(), maxAgeMs: 1 }), /maxAgeMs/);
  } finally { s.close(); }
});
test('Consistent backup restores events and encrypted subscriptions', async () => {
  const s = setup(); try {
    const sub = await s.events.subscribe(principal, subscription()); s.store.ingest([event(alert())]); const path = await s.store.backup(); const restored = new Store(path, s.config.key); const events = new Events(restored, s.config.sources);
    assert.equal(restored.eventsAfter(0).length, 1); assert.equal(events.status(principal).subscriptions[0]?.id, sub.id); restored.close();
    const wrong = new Store(path, Buffer.alloc(32, 3)); assert.throws(() => wrong.subscriptions()); wrong.close();
  } finally { s.close(); }
});
test('Refreshing during an in-flight delivery preserves replay instead of letting the old acknowledgement skip it', async () => {
  let release: (() => void) | undefined, started: (() => void) | undefined;
  const ready = new Promise<void>(r => { started = r; }); let hold = true, calls = 0;
  const s = setup(async (_id, _credentials, value) => { const data = value as { challenge?: string }; if (data.challenge) return { status: 200, body: JSON.stringify(data) }; calls++; if (hold) { started!(); await new Promise<void>(r => { release = r; }); } return { status: 200, body: '' }; });
  try {
    const sub = await s.events.subscribe(principal, subscription()); s.store.ingest([event(alert())]); const pending = s.events.deliver(() => true); await ready;
    await s.events.subscribe(principal, subscription()); hold = false; release!(); await pending; assert.equal(s.store.subscription(sub.id)?.cursor, 0);
    await s.events.deliver(() => true); assert.equal(calls, 2); assert.equal(s.store.subscription(sub.id)?.cursor, 1);
  } finally { s.close(); }
});
test('Exhausted transient retries stop and a verified host refresh resumes retained delivery', async () => {
  let status = 503; const s = setup(async (_id, _credentials, value) => { const data = value as { challenge?: string }; return data.challenge ? { status: 200, body: JSON.stringify(data) } : { status, body: '' }; });
  try {
    const sub = await s.events.subscribe(principal, subscription()); s.store.ingest([event(alert())]);
    for (let i = 0; i < 8; i++) await s.events.deliver(() => true, Date.now() + i * 301000);
    assert.equal(s.store.subscription(sub.id)?.state, 'failed'); assert.equal(s.store.subscription(sub.id)?.cursor, 0);
    status = 200; await s.events.subscribe(principal, subscription()); await s.events.deliver(() => true); assert.equal(s.store.subscription(sub.id)?.cursor, 1);
  } finally { s.close(); }
});
