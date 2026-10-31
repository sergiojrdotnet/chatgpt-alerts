import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
const id = `chatgpt-alerts-smoke-${Date.now()}`, directory = mkdtempSync(join(tmpdir(), id));
const secret = randomBytes(32).toString('hex'), key = randomBytes(32).toString('base64');
function docker(...args) { const r = spawnSync('docker', args, { encoding: 'utf8' }); if (r.status) throw new Error(r.stderr || r.stdout); return r.stdout.trim(); }
function http(path, options = {}) {
  const program = `const r=await fetch('http://127.0.0.1:3000'+${JSON.stringify(path)},${JSON.stringify(options)});console.log(JSON.stringify({status:r.status,body:await r.text()}))`;
  return JSON.parse(docker('exec', id, 'node', '--input-type=module', '-e', program));
}
async function ready() { for (let i = 0; i < 100; i++) { try { if (http('/readyz').status === 200) return; } catch {} await new Promise(r => setTimeout(r, 200)); } throw new Error('Container never became ready'); }

try {
  docker('build', '-t', 'chatgpt-alerts:smoke', '.');
  writeFileSync(join(directory, 'sources.json'), JSON.stringify({ sources: [{ id: 'production', name: 'Production', integration: 'grafana', secret }] }), { mode: 0o644 });
  docker('volume', 'create', id);
  docker('run', '-d', '--name', id, '--network', 'none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--memory=256m', '--pids-limit=64', '--tmpfs=/tmp:rw,size=16m', '-v', `${id}:/data`, '-v', `${join(directory, 'sources.json')}:/run/config/sources.json:ro`, '-e', 'PUBLIC_URL=https://alerts.example.com', '-e', 'CF_ACCESS_TEAM_DOMAIN=team.cloudflareaccess.com', '-e', `CF_ACCESS_AUD=${'a'.repeat(64)}`, '-e', 'CF_ACCESS_ALLOWED_EMAILS=operator@example.com', '-e', `STORAGE_KEY=${key}`, 'chatgpt-alerts:smoke');
  const inspect = JSON.parse(docker('inspect', id))[0]; assert.equal(inspect.Config.User, 'node'); assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  await ready();
  assert.equal(http('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': 'forged' }, body: '{}' }).status, 401);
  const data = JSON.stringify({ receiver: 'alerts', orgId: 1, groupKey: 'test', status: 'firing', alerts: [{ fingerprint: 'container', status: 'firing', labels: { alertname: 'Container validation', test: 'true' }, annotations: {}, startsAt: new Date().toISOString(), endsAt: '0001-01-01T00:00:00Z' }] });
  const timestamp = Math.floor(Date.now() / 1000).toString(), signature = createHmac('sha256', secret).update(`${timestamp}:${data}`).digest('hex');
  const headers = { 'Content-Type': 'application/json', 'X-Grafana-Alerting-Timestamp': timestamp, 'X-Grafana-Alerting-Signature': signature };
  const first = http('/webhooks/grafana/production', { method: 'POST', headers, body: data }); assert.equal(first.status, 202); assert.equal(JSON.parse(first.body).accepted, 1);
  assert.equal(JSON.parse(http('/webhooks/grafana/production', { method: 'POST', headers, body: data }).body).accepted, 0);
  docker('restart', id); await ready();
  const count = docker('exec', id, 'node', '--input-type=module', '-e', "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync('/data/alerts.sqlite',{readOnly:true});console.log(d.prepare('SELECT count(*) AS n FROM events').get().n);d.close()"); assert.equal(count, '1');
  const integrity = docker('exec', id, 'node', '--input-type=module', '-e', "import{readdirSync}from'node:fs';import{DatabaseSync}from'node:sqlite';const f=readdirSync('/data/backups').sort().at(-1);const d=new DatabaseSync('/data/backups/'+f,{readOnly:true});console.log(d.prepare('PRAGMA quick_check').get().quick_check);d.close()"); assert.equal(integrity, 'ok');
  console.log('Container smoke passed: nonroot, read-only, isolated network, forged authentication rejection, signed ingestion, deduplication, restart persistence and verified backup.');
} catch (error) { try { console.error(docker('logs', '--tail', '30', id)); } catch {} throw error; }
finally { try { docker('rm', '-f', id); } catch {} try { docker('volume', 'rm', id); } catch {} rmSync(directory, { recursive: true, force: true }); }
