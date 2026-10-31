import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { writeFileSync } from 'node:fs';
import { fixture, notification, signed } from './helpers.ts';
import { loadConfig } from '../src/config.ts';
import { authentication } from '../src/auth.ts';
import { grafana } from '../src/integrations/grafana.ts';
import { callbackUrl, publicAddress } from '../src/callback.ts';

test('Reject private, mapped, link-local and special-use callback addresses', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '100.64.0.1', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1', '0.0.0.0', '224.0.0.1']) assert.equal(publicAddress(address), false, address);
  for (const url of ['http://callbacks.example.com', 'https://user:password@example.com', 'https://example.com/#x', 'https://127.0.0.1', 'https://[::1]']) assert.throws(() => callbackUrl(url), /Callback/, url);
  assert.equal(publicAddress('1.1.1.1'), true); assert.equal(callbackUrl('https://callbacks.example.com/events').hostname, 'callbacks.example.com');
});
test('Grafana signatures bind the timestamp and exact body; mixed batches use each alert state', () => {
  const f = fixture(); try {
    const value = notification(); value.alerts.push(notification('resolved').alerts[0]!); const body = Buffer.from(JSON.stringify(value)); const headers = signed(body, f.config.sources[0]!.secret);
    const alerts = grafana.receive(f.config.sources[0]!, body, headers); assert.deepEqual(alerts.map(x => x.status), ['firing', 'resolved']);
    assert.throws(() => grafana.receive(f.config.sources[0]!, Buffer.from('{}'), headers));
    assert.throws(() => grafana.receive(f.config.sources[0]!, body, headers, Date.now() + 301000));
  } finally { f.cleanup(); }
});
test('Configuration rejects duplicate sources, unknown integrations, placeholders and insecure production development mode', () => {
  const f = fixture(); try {
    assert.throws(() => loadConfig({ ...f.env, HOST: '0.0.0.0' }), /loopback/);
    assert.throws(() => loadConfig({ ...f.env, NODE_ENV: 'production' }), /loopback/);
    writeFileSync(f.env.SOURCES_FILE, JSON.stringify({ sources: [f.config.sources[0], f.config.sources[0]] })); assert.throws(() => loadConfig(f.env), /unique/);
    writeFileSync(f.env.SOURCES_FILE, JSON.stringify({ sources: [{ ...f.config.sources[0], integration: 'unknown' }] })); assert.throws(() => loadConfig(f.env), /Unsupported/);
    writeFileSync(f.env.SOURCES_FILE, JSON.stringify({ sources: [{ ...f.config.sources[0], secret: 'change-me' + 'x'.repeat(32) }] })); assert.throws(() => loadConfig(f.env), /example/);
  } finally { f.cleanup(); }
});
test('Cloudflare verifies signature, issuer, audience, identity, expiry and app token type', async () => {
  const f = fixture(); try {
    const config = { ...f.config, DEV_TOKEN: undefined, PUBLIC_URL: 'https://alerts.example.com', CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'a'.repeat(64), emails: new Set(['operator@example.com']) };
    const { publicKey, privateKey } = await generateKeyPair('RS256'); const { privateKey: other } = await generateKeyPair('RS256');
    const auth = authentication(config, async () => publicKey);
    async function token(overrides: Record<string, unknown> = {}, key = privateKey) { return new SignJWT({ email: 'operator@example.com', type: 'app', ...overrides }).setProtectedHeader({ alg: 'RS256' }).setSubject('operator').setIssuer('https://team.cloudflareaccess.com').setAudience(config.CF_ACCESS_AUD).setIssuedAt().setExpirationTime('1h').sign(key); }
    const valid = await token(); const identity = await auth.authenticate({ 'cf-access-jwt-assertion': valid }); assert.ok(identity); assert.ok(auth.authorized(identity.id));
    assert.equal(await auth.authenticate({ authorization: `Bearer ${valid}` }), undefined);
    for (const invalid of [await token({ email: 'other@example.com' }), await token({ type: 'service' }), await token({}, other)]) assert.equal(await auth.authenticate({ 'cf-access-jwt-assertion': invalid }), undefined);
    const wrongAudience = await new SignJWT({ email: 'operator@example.com', type: 'app' }).setProtectedHeader({ alg: 'RS256' }).setSubject('operator').setIssuer('https://team.cloudflareaccess.com').setAudience('wrong').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    assert.equal(await auth.authenticate({ 'cf-access-jwt-assertion': wrongAudience }), undefined);
  } finally { f.cleanup(); }
});
test('Callback DNS rejects mixed public/private answers and selects a validated pinned address', async () => {
  const { resolveCallback } = await import('../src/callback.ts');
  const mixed = (async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]) as unknown as typeof import('node:dns/promises').lookup;
  await assert.rejects(resolveCallback(new URL('https://callbacks.example.com/events'), mixed), /nonpublic/);
  const publicOnly = (async () => [{ address: '1.1.1.1', family: 4 }]) as unknown as typeof import('node:dns/promises').lookup;
  assert.deepEqual(await resolveCallback(new URL('https://callbacks.example.com/events'), publicOnly), { address: '1.1.1.1', family: 4 });
});
