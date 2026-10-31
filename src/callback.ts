import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { Webhook } from 'standardwebhooks';

export type Credentials = { url: string; secret: string; previousSecret?: string; rotateUntil?: number };
export type CallbackResult = { status: number; body: string };
export type Callback = (id: string, credentials: Credentials, payload: unknown) => Promise<CallbackResult>;
export function publicAddress(address: string) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function callbackUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Callback requires HTTPS without credentials or a fragment');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && !publicAddress(host)) throw new Error('Callback address must be public');
  return url;
}
export async function resolveCallback(url: URL, resolve = lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await Promise.race([
    resolve(host, { all: true }),
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Callback DNS timeout')), 5000); timer.unref(); })
  ]);
  if (!addresses.length || addresses.some(x => !publicAddress(x.address))) throw new Error('Callback DNS contains a nonpublic address');
  return addresses.find(x => x.family === 4) ?? addresses[0]!;
}
export const postCallback: Callback = async (subscriptionId, credentials, payload) => {
  const url = callbackUrl(credentials.url);
  const address = await resolveCallback(url);
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 256 * 1024) return { status: 413, body: '' };
  const id = payload && typeof payload === 'object' && 'eventId' in payload ? String(payload.eventId) : `verify_${randomUUID()}`;
  const now = new Date();
  const signatures = [new Webhook(credentials.secret).sign(id, now, body)];
  if (credentials.previousSecret && (credentials.rotateUntil ?? 0) > now.getTime()) signatures.push(new Webhook(credentials.previousSecret).sign(id, now, body));
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST', agent: false, family: address.family,
      lookup: (_hostname, _options, done) => done(null, address.address, address.family),
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'webhook-id': id,
        'webhook-timestamp': Math.floor(now.getTime() / 1000).toString(), 'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': subscriptionId }
    }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 16384) res.destroy(new Error('Callback response too large')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString() }));
    });
    const timer = setTimeout(() => req.destroy(new Error('Callback HTTPS timeout')), 10000); timer.unref();
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end(body);
  });
};
