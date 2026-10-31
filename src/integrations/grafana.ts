import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { labels, equal } from '../model.ts';
import type { Integration } from './index.ts';
const timestamp = z.iso.datetime({ offset: true });
const notification = z.object({
  receiver: z.string(), status: z.enum(['firing', 'resolved']), orgId: z.number().int().nonnegative(), groupKey: z.string(),
  truncatedAlerts: z.number().int().nonnegative().optional(),
  alerts: z.array(z.object({
    status: z.enum(['firing', 'resolved']), fingerprint: z.string().min(1).max(200), labels, annotations: labels,
    startsAt: timestamp, endsAt: timestamp,
    generatorURL: z.string().max(4000).optional(), dashboardURL: z.string().max(4000).optional(),
    panelURL: z.string().max(4000).optional(), silenceURL: z.string().max(4000).optional()
  })).min(1).max(500)
});
export const grafana: Integration = {
  id: 'grafana',
  receive(source, body, headers, now = Date.now()) {
    const signedAt = String(headers['x-grafana-alerting-timestamp'] ?? '');
    const signature = String(headers['x-grafana-alerting-signature'] ?? '');
    const expected = createHmac('sha256', source.secret).update(`${signedAt}:`).update(body).digest('hex');
    if (!/^\d+$/.test(signedAt) || Math.abs(now / 1000 - Number(signedAt)) > 300 || !/^[a-fA-F0-9]{64}$/.test(signature) || !equal(signature.toLowerCase(), expected)) throw new Error('Invalid webhook signature or timestamp');
    const input = notification.parse(JSON.parse(body.toString()));
    if (input.truncatedAlerts) throw new Error('Truncated notification; set Grafana Max Alerts to 0');
    return input.alerts.map(item => {
      const endsAt = item.endsAt.startsWith('0001-') ? undefined : item.endsAt;
      if (item.status === 'resolved' && !endsAt) throw new Error('Resolved alert requires an end timestamp');
      return {
        integration: 'grafana', source: source.id, fingerprint: item.fingerprint, status: item.status,
        name: item.labels.alertname || item.fingerprint, ...(item.labels.severity ? { severity: item.labels.severity } : {}), labels: item.labels, annotations: item.annotations,
        startsAt: item.startsAt, ...(endsAt ? { endsAt } : {}),
        links: Object.fromEntries(Object.entries({ generator: item.generatorURL, dashboard: item.dashboardURL, panel: item.panelURL, silence: item.silenceURL }).filter((x): x is [string, string] => Boolean(x[1])))
      };
    });
  }
};
