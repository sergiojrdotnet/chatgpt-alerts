import { DatabaseSync, backup } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Credentials } from './callback.ts';
import { canonical, digest, signCursor, readCursor } from './model.ts';
import type { AlertEvent, EventName, Filters, StoredEvent } from './model.ts';

export type Subscription = {
  id: string; owner: string; name: EventName; filters: Filters; credentials: Credentials;
  expiresAt: number; cursor: number; revision: number; attempts: number; nextAttempt: number;
  state: 'active' | 'failed' | 'gone' | 'unsubscribed'; lastError: string | null;
};
type Row = Record<string, string | number | null>;
export class Store {
  private db: DatabaseSync;
  private key: Buffer;
  private path: string;
  constructor(path: string, key: Buffer) {
    if (key.length !== 32) throw new Error('Storage key must contain 32 bytes');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.path = path; this.key = key; this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, occurred_at TEXT NOT NULL, data TEXT NOT NULL, received_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_received ON events(received_at);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, filters TEXT NOT NULL, credentials TEXT NOT NULL, expires_at INTEGER NOT NULL, cursor INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'active', last_error TEXT);
      CREATE INDEX IF NOT EXISTS subscription_owner ON subscriptions(owner);`);
    if (path !== ':memory:') chmodSync(path, 0o600);
  }
  close() { this.db.close(); }
  ready() { this.db.prepare('SELECT 1').get(); }
  private seal(id: string, value: Credentials) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  private open(id: string, value: string): Credentials {
    const bytes = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
  }
  ingest(events: AlertEvent[], now = Date.now()) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO events(id,name,occurred_at,data,received_at) VALUES(?,?,?,?,?)'); let accepted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try { for (const item of events) accepted += Number(insert.run(item.eventId, item.name, item.timestamp, JSON.stringify(item.data), now).changes); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return accepted;
  }
  highWater() { return Number(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get()?.seq ?? 0); }
  prunedThrough() { return Number(this.db.prepare("SELECT value FROM metadata WHERE key='pruned-through'").get()?.value ?? 0); }
  eventsAfter(sequence: number, limit = 100, sources?: string[]) {
    const rows = sources
      ? this.db.prepare(`SELECT * FROM events WHERE seq>? AND json_extract(data,'$.source') IN (${sources.map(() => '?').join(',')}) ORDER BY seq LIMIT ?`).all(sequence, ...sources, limit)
      : this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(sequence, limit);
    return rows.map(x => this.toEvent(x as Row));
  }
  private toEvent(row: Row): StoredEvent { return { seq: Number(row.seq), eventId: String(row.id), name: row.name as EventName, timestamp: String(row.occurred_at), data: JSON.parse(String(row.data)) }; }
  event(id: string) { const row = this.db.prepare('SELECT * FROM events WHERE id=?').get(id); return row ? this.toEvent(row as Row) : undefined; }
  identity(owner: string, name: EventName, filters: Filters, url: string) { return `sub_${digest([owner, name, filters, url])}`; }
  cursor(scope: string, sequence: number) { return signCursor(this.key, scope, sequence); }
  parseCursor(scope: string, cursor: string) { return readCursor(this.key, scope, cursor); }
  subscriptions(owner?: string): Subscription[] {
    const rows = owner ? this.db.prepare('SELECT * FROM subscriptions WHERE owner=?').all(owner) : this.db.prepare('SELECT * FROM subscriptions').all();
    return rows.map(x => this.toSubscription(x as Row));
  }
  subscription(id: string) { const row = this.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id); return row ? this.toSubscription(row as Row) : undefined; }
  private toSubscription(row: Row): Subscription {
    return { id: String(row.id), owner: String(row.owner), name: row.name as EventName, filters: JSON.parse(String(row.filters)), credentials: this.open(String(row.id), String(row.credentials)), expiresAt: Number(row.expires_at), cursor: Number(row.cursor), revision: Number(row.revision), attempts: Number(row.attempts), nextAttempt: Number(row.next_attempt), state: row.state as Subscription['state'], lastError: row.last_error === null ? null : String(row.last_error) };
  }
  save(input: Pick<Subscription, 'id' | 'owner' | 'name' | 'filters' | 'credentials' | 'expiresAt' | 'cursor'>, now: number) {
    const previous = this.subscription(input.id); let credentials = input.credentials;
    if (previous && previous.credentials.secret !== credentials.secret) credentials = { ...credentials, previousSecret: previous.credentials.secret, rotateUntil: now + 60000 };
    else if (previous?.credentials.previousSecret && (previous.credentials.rotateUntil ?? 0) > now) credentials = { ...credentials, previousSecret: previous.credentials.previousSecret, rotateUntil: previous.credentials.rotateUntil };
    this.db.prepare(`INSERT INTO subscriptions(id,owner,name,filters,credentials,expires_at,cursor) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET credentials=excluded.credentials,expires_at=excluded.expires_at,cursor=excluded.cursor,revision=revision+1,attempts=0,next_attempt=0,state='active',last_error=NULL`).run(input.id, input.owner, input.name, canonical(input.filters), this.seal(input.id, credentials), input.expiresAt, input.cursor);
  }
  acknowledge(id: string, revision: number, sequence: number) {
    this.db.prepare("UPDATE subscriptions SET cursor=?,attempts=0,next_attempt=0,last_error=NULL WHERE id=? AND revision=? AND state='active' AND cursor<?").run(sequence, id, revision, sequence);
  }
  failure(id: string, revision: number, state: Subscription['state'], attempts: number, nextAttempt: number, error: string) {
    this.db.prepare('UPDATE subscriptions SET state=?,attempts=?,next_attempt=?,last_error=? WHERE id=? AND revision=?').run(state, attempts, nextAttempt, error, id, revision);
  }
  unsubscribe(id: string) { this.db.prepare("UPDATE subscriptions SET state='unsubscribed',revision=revision+1 WHERE id=?").run(id); }
  prune(before: number) {
    const boundary = Number(this.db.prepare('SELECT MIN(seq) AS seq FROM events WHERE received_at>=?').get(before)?.seq ?? this.highWater() + 1);
    const last = Number(this.db.prepare('SELECT MAX(seq) AS seq FROM events WHERE seq<?').get(boundary)?.seq ?? 0);
    if (!last) return 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const removed = Number(this.db.prepare('DELETE FROM events WHERE seq<=?').run(last).changes);
      this.db.prepare("INSERT INTO metadata(key,value) VALUES('pruned-through',?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)").run(last);
      this.db.exec('COMMIT'); return removed;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async backup() {
    const directory = join(dirname(this.path), 'backups'); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `alerts-${Date.now()}-${randomBytes(3).toString('hex')}.sqlite`);
    await backup(this.db, target); chmodSync(target, 0o600);
    const check = new DatabaseSync(target, { readOnly: true });
    try { if (check.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('Backup integrity check failed'); } finally { check.close(); }
    for (const file of readdirSync(directory).filter(x => /^alerts-\d+-[a-f0-9]+\.sqlite$/.test(x)).sort().slice(0, -7)) unlinkSync(join(directory, file));
    return target;
  }
}
