import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
const id = `chatgpt-alerts-smoke-${Date.now()}`, directory = mkdtempSync(join(tmpdir(), id));
const secret = randomBytes(32).toString('hex'), key = randomBytes(32).toString('base64'), container = `${id}-server-1`;
const operator = join(directory, 'operator.env');
function docker(...args) { const r = spawnSync('docker', args, { encoding: 'utf8' }); if (r.status) throw new Error(r.stderr || r.stdout); return r.stdout.trim(); }
function http(path, options = {}) {
  const program = `const r=await fetch('http://127.0.0.1:3000'+${JSON.stringify(path)},${JSON.stringify(options)});console.log(JSON.stringify({status:r.status,body:await r.text()}))`;
  return JSON.parse(docker('exec', container, 'node', '--input-type=module', '-e', program));
}
async function ready() { for (let i = 0; i < 100; i++) { try { if (http('/readyz').status === 200) return; } catch {} await new Promise(r => setTimeout(r, 200)); } throw new Error('Container never became ready'); }

try {
  docker('build', '-t', 'chatgpt-alerts:smoke', '.');
  writeFileSync(join(directory, 'sources.json'), JSON.stringify({ sources: [{ id: 'production', name: 'Production', integration: 'grafana', secret }] }), { mode: 0o644 });
  writeFileSync(join(directory, 'server.env'), `PUBLIC_URL=https://alerts.example.com\nCF_ACCESS_TEAM_DOMAIN=team.cloudflareaccess.com\nCF_ACCESS_AUD=${'a'.repeat(64)}\nCF_ACCESS_ALLOWED_EMAILS=operator@example.com\nSTORAGE_KEY=${key}\n`, { mode: 0o600 });
  writeFileSync(operator, `IMAGE_DIGEST=chatgpt-alerts:smoke\nSERVER_ENV_FILE=${join(directory, 'server.env')}\nSOURCES_FILE=${join(directory, 'sources.json')}\nALERTS_NETWORK=${id}\nMCP_PORT=0\n`, { mode: 0o600 });
  docker('network', 'create', '--internal', id);
  docker('compose', '--project-name', id, '--env-file', operator, '-f', 'deploy/compose.yaml', 'up', '-d', '--wait', '--wait-timeout', '40');
  const inspect = JSON.parse(docker('inspect', container))[0]; assert.equal(inspect.Config.User, 'node'); assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  await ready();
  assert.equal(http('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': 'forged' }, body: '{}' }).status, 401);
  const data = JSON.stringify({ receiver: 'alerts', orgId: 1, groupKey: 'test', status: 'firing', alerts: [{ fingerprint: 'container', status: 'firing', labels: { alertname: 'Container validation', test: 'true' }, annotations: {}, startsAt: new Date().toISOString(), endsAt: '0001-01-01T00:00:00Z' }] });
  const timestamp = Math.floor(Date.now() / 1000).toString(), signature = createHmac('sha256', secret).update(`${timestamp}:${data}`).digest('hex');
  const headers = { 'Content-Type': 'application/json', 'X-Grafana-Alerting-Timestamp': timestamp, 'X-Grafana-Alerting-Signature': signature };
  const first = http('/webhooks/grafana/production', { method: 'POST', headers, body: data }); assert.equal(first.status, 202); assert.equal(JSON.parse(first.body).accepted, 1);
  assert.equal(JSON.parse(http('/webhooks/grafana/production', { method: 'POST', headers, body: data }).body).accepted, 0);
  docker('restart', container); await ready();
  const count = docker('exec', container, 'node', '--input-type=module', '-e', "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync('/data/alerts.sqlite',{readOnly:true});console.log(d.prepare('SELECT count(*) AS n FROM events').get().n);d.close()"); assert.equal(count, '1');
  const integrity = docker('exec', container, 'node', '--input-type=module', '-e', "import{readdirSync}from'node:fs';import{DatabaseSync}from'node:sqlite';const f=readdirSync('/data/backups').sort().at(-1);const d=new DatabaseSync('/data/backups/'+f,{readOnly:true});console.log(d.prepare('PRAGMA quick_check').get().quick_check);d.close()"); assert.equal(integrity, 'ok');
  console.log('Container smoke passed: nonroot, read-only, isolated network, forged authentication rejection, signed ingestion, deduplication, restart persistence and verified backup.');
} catch (error) { try { console.error(docker('logs', '--tail', '30', container)); } catch {} throw error; }
finally { try { docker('compose', '--project-name', id, '--env-file', operator, '-f', 'deploy/compose.yaml', 'down', '--volumes'); } catch {} try { docker('network', 'rm', id); } catch {} rmSync(directory, { recursive: true, force: true }); }
