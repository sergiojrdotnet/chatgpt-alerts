import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const eventNames = ['alert.firing', 'alert.resolved'] as const;
export const eventName = z.enum(eventNames);
export const labels = z.record(z.string().max(200), z.string().max(8000));
export const filters = z.object({ source: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), labels: labels.default({}) }).strict();
export const alertSchema = z.object({
  integration: z.string(), source: z.string(), fingerprint: z.string().min(1).max(200),
  status: z.enum(['firing', 'resolved']), name: z.string().min(1).max(8000), severity: z.string().max(8000).optional(),
  labels, annotations: labels, startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  links: z.record(z.string(), z.string().max(4000))
});
export type Alert = z.infer<typeof alertSchema>;
export type Filters = z.infer<typeof filters>;
export type EventName = typeof eventNames[number];
export type AlertEvent = { eventId: string; name: EventName; timestamp: string; data: Alert };
export type StoredEvent = AlertEvent & { seq: number };
export type Principal = { id: string; expiresAt: number };

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function equal(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export function event(data: Alert): AlertEvent {
  alertSchema.parse(data);
  const result = { eventId: `evt_${digest(data)}`, name: `alert.${data.status}` as EventName, timestamp: data.status === 'resolved' ? data.endsAt! : data.startsAt, data };
  if (!result.timestamp || Buffer.byteLength(JSON.stringify(result)) > 240 * 1024) throw new Error('Invalid alert timestamp or event too large');
  return result;
}
export function matches(item: AlertEvent, name: EventName, input: Filters) {
  return item.name === name && item.data.source === input.source && Object.entries(input.labels).every(([k, v]) => item.data.labels[k] === v);
}
export function signCursor(key: Buffer, scope: string, sequence: number) {
  const value = Buffer.from(JSON.stringify([scope, sequence])).toString('base64url');
  return `${value}.${createHmac('sha256', key).update(value).digest('base64url')}`;
}
export function readCursor(key: Buffer, scope: string, cursor: string) {
  const [value, signature, extra] = cursor.split('.');
  if (!value || !signature || extra || !equal(signature, createHmac('sha256', key).update(value).digest('base64url'))) throw new Error('Invalid replay cursor');
  const [owner, sequence] = JSON.parse(Buffer.from(value, 'base64url').toString());
  if (owner !== scope || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid replay cursor');
  return sequence as number;
}
