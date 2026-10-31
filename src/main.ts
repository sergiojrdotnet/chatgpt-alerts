import { app } from './app.ts';
import { loadConfig } from './config.ts';
const config = loadConfig(), runtime = app(config);
await runtime.maintain();
await new Promise<void>(resolve => runtime.server.listen(config.PORT, config.HOST, resolve));
console.log(JSON.stringify({ level: 'info', message: 'ChatGPT Alerts listening', port: config.PORT, sources: config.sources.map(x => ({ id: x.id, integration: x.integration })) }));
let deliveryTask: Promise<void> | undefined;
let maintenanceTask: Promise<void> | undefined;
const delivery = setInterval(() => {
  if (!deliveryTask) deliveryTask = runtime.events.deliver(runtime.auth.authorized).catch(error => console.error(JSON.stringify({ level: 'error', message: 'Delivery worker failed', error: String(error) }))).finally(() => { deliveryTask = undefined; });
}, 1000);
const maintenance = setInterval(() => {
  if (!maintenanceTask) maintenanceTask = runtime.maintain().finally(() => { maintenanceTask = undefined; });
}, config.BACKUP_INTERVAL_MS);
async function shutdown() { clearInterval(delivery); clearInterval(maintenance); await runtime.close([deliveryTask, maintenanceTask].filter((x): x is Promise<void> => Boolean(x))); }
process.once('SIGTERM', () => { void shutdown(); }); process.once('SIGINT', () => { void shutdown(); });
