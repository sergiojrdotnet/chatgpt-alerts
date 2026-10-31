import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { integrations } from './integrations/index.ts';

export const sourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), name: z.string().min(1).max(200),
  integration: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), secret: z.string().min(32).refine(x => !x.startsWith('change-me'), 'Replace the example secret')
}).strict();
export type Source = z.infer<typeof sourceSchema>;
export const sourceFileSchema = z.object({ sources: z.array(sourceSchema).min(1).max(100) }).strict();
const environment = z.object({
  HOST: z.string().default('127.0.0.1'), PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_PATH: z.string().default('.data/alerts.sqlite'), SOURCES_FILE: z.string(),
  STORAGE_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  BACKUP_INTERVAL_MS: z.coerce.number().int().min(60000).default(3600000),
  PUBLIC_URL: z.url().optional(), DEV_TOKEN: z.string().min(32).optional(),
  CF_ACCESS_TEAM_DOMAIN: z.string().regex(/^[a-z0-9-]+\.cloudflareaccess\.com$/).optional(),
  CF_ACCESS_AUD: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  CF_ACCESS_ALLOWED_EMAILS: z.string().optional()
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const cfg = environment.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));
  const { sources } = sourceFileSchema.parse(JSON.parse(readFileSync(cfg.SOURCES_FILE, 'utf8')));
  if (sources.some(x => !integrations.has(x.integration))) throw new Error('Unsupported integration');
  if (new Set(sources.map(x => x.id)).size !== sources.length) throw new Error('Source IDs must be unique');
  const emails = new Set((cfg.CF_ACCESS_ALLOWED_EMAILS ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  if (cfg.DEV_TOKEN) {
    if (cfg.HOST !== '127.0.0.1' || env.NODE_ENV === 'production') throw new Error('Development authentication requires loopback and a non-production environment');
    if (cfg.CF_ACCESS_AUD || cfg.CF_ACCESS_TEAM_DOMAIN || emails.size) throw new Error('Do not mix development and Cloudflare authentication');
  } else {
    if (!cfg.PUBLIC_URL || new URL(cfg.PUBLIC_URL).protocol !== 'https:' || new URL(cfg.PUBLIC_URL).origin !== cfg.PUBLIC_URL) throw new Error('PUBLIC_URL must be an HTTPS origin without a path');
    if (!cfg.CF_ACCESS_TEAM_DOMAIN || !cfg.CF_ACCESS_AUD || !emails.size) throw new Error('Cloudflare Access domain, audience and allowed emails are required');
    for (const email of emails) z.email().parse(email);
  }
  return { ...cfg, sources, emails, key: Buffer.from(cfg.STORAGE_KEY, 'base64') };
}
export type Config = ReturnType<typeof loadConfig>;
