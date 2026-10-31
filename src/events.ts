import { randomBytes } from 'node:crypto';
import { ProtocolError } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { callbackUrl, postCallback } from './callback.ts';
import type { Callback } from './callback.ts';
import { filters, eventName, equal, matches } from './model.ts';
import type { Principal } from './model.ts';
import type { Source } from './config.ts';
import { Store } from './store.ts';

const secret = z.string().regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/).refine(x => {
  const bytes = Buffer.from(x.slice(6), 'base64'); return bytes.length >= 24 && bytes.length <= 64 && bytes.toString('base64') === x.slice(6);
});
export const deliverySchema = z.object({ mode: z.literal('webhook'), url: z.string().max(4000), secret });
export const subscribeSchema = z.object({ name: eventName, arguments: filters, delivery: deliverySchema, cursor: z.string().max(2000).nullable().optional(), ttlMs: z.number().int().positive().nullable().optional(), maxAgeMs: z.number().int().nonnegative().optional() });
export const unsubscribeSchema = z.object({ name: eventName, arguments: filters, delivery: deliverySchema.omit({ secret: true }) });
export class Events {
  private store: Store;
  private sources: Source[];
  private post: Callback;
  private working = false;
  constructor(store: Store, sources: Source[], post: Callback = postCallback) { this.store = store; this.sources = sources; this.post = post; }
  private requireSource(id: string) { if (!this.sources.some(x => x.id === id)) throw new ProtocolError(-32024, 'Source is not authorized'); }
  async subscribe(principal: Principal, params: z.infer<typeof subscribeSchema>, now = Date.now()) {
    this.requireSource(params.arguments.source);
    if (params.maxAgeMs !== undefined) throw new ProtocolError(-32026, 'Use the replay cursor; maxAgeMs is not supported');
    let url: string;
    try { url = callbackUrl(params.delivery.url).toString(); } catch { throw new ProtocolError(-32602, 'Invalid callback URL'); }
    const id = this.store.identity(principal.id, params.name, params.arguments, url);
    const highWater = this.store.highWater();
    let requested: number | undefined;
    try { requested = params.cursor ? this.store.parseCursor(id, params.cursor) : undefined; }
    catch { throw new ProtocolError(-32602, 'Invalid replay cursor'); }
    if (requested !== undefined && requested > highWater) throw new ProtocolError(-32602, 'Replay cursor is ahead of retained history');
    const expiresAt = Math.min(now + Math.min(params.ttlMs ?? 3600000, 3600000), principal.expiresAt);
    if (expiresAt <= now) throw new ProtocolError(-32024, 'Authorization expired');
    const challenge = randomBytes(32).toString('base64url');
    const credentials = { url, secret: params.delivery.secret };
    try {
      const result = await this.post(id, credentials, { type: 'verification', challenge });
      if (result.status < 200 || result.status >= 300 || !equal(String(JSON.parse(result.body).challenge), challenge)) throw new Error('Invalid verification response');
    } catch { throw new ProtocolError(-32015, 'Callback verification failed', { reason: 'challenge_failed' }); }
    const latest = this.store.subscription(id);
    const start = latest && latest.state !== 'unsubscribed' ? Math.min(latest.cursor, requested ?? latest.cursor) : requested ?? highWater;
    const pruned = this.store.prunedThrough(); const truncated = start < pruned; const cursor = Math.max(start, pruned);
    this.store.save({ id, owner: principal.id, name: params.name, filters: params.arguments, credentials, expiresAt, cursor }, now);
    return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: this.store.cursor(id, cursor), truncated };
  }
  unsubscribe(principal: Principal, params: z.infer<typeof unsubscribeSchema>) {
    this.requireSource(params.arguments.source);
    const url = callbackUrl(params.delivery.url).toString();
    this.store.unsubscribe(this.store.identity(principal.id, params.name, params.arguments, url)); return {};
  }
  status(principal: Principal) {
    return { subscriptions: this.store.subscriptions(principal.id).map(x => ({ id: x.id, name: x.name, filters: x.filters, state: x.state, expired: x.expiresAt <= Date.now(), refreshBefore: new Date(x.expiresAt).toISOString(), lastAcknowledgedSequence: x.cursor, attempts: x.attempts, lastError: x.lastError })) };
  }
  async deliver(authorized: (owner: string) => boolean, now = Date.now()) {
    if (this.working) return; this.working = true;
    try {
      for (const snapshot of this.store.subscriptions()) {
        if (snapshot.state !== 'active' || snapshot.expiresAt <= now || snapshot.nextAttempt > now) continue;
        if (!authorized(snapshot.owner) || !this.sources.some(x => x.id === snapshot.filters.source)) {
          this.store.failure(snapshot.id, snapshot.revision, 'gone', snapshot.attempts, 0, 'Authorization revoked'); continue;
        }
        for (const item of this.store.eventsAfter(snapshot.cursor)) {
          const current = this.store.subscription(snapshot.id)!;
          if (current.state !== 'active' || current.revision !== snapshot.revision || current.expiresAt <= Date.now() || !authorized(current.owner)) break;
          if (item.seq <= current.cursor) continue;
          if (!matches(item, current.name, current.filters)) { this.store.acknowledge(current.id, current.revision, item.seq); continue; }
          let status = 503;
          try { status = (await this.post(current.id, current.credentials, { eventId: item.eventId, name: item.name, timestamp: item.timestamp, data: item.data, cursor: this.store.cursor(current.id, item.seq) })).status; } catch { /* Network failures follow the same bounded retry policy as HTTP 503. */ }
          if (status >= 200 && status < 300) { this.store.acknowledge(current.id, current.revision, item.seq); continue; }
          const attempts = current.attempts + 1, transient = [408, 429].includes(status) || status >= 500;
          const state = status === 410 ? 'gone' : transient && attempts < 8 ? 'active' : 'failed';
          this.store.failure(current.id, current.revision, state, attempts, now + Math.min(300000, 1000 * 2 ** (attempts - 1)), `Callback HTTP ${status}`); break;
        }
      }
    } finally { this.working = false; }
  }
}
