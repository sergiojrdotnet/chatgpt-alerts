import type { Source } from '../config.ts';
import type { Alert } from '../model.ts';
import { grafana } from './grafana.ts';

export interface Integration {
  id: string;
  receive(source: Source, body: Buffer, headers: Record<string, string | string[] | undefined>, now?: number): Alert[];
}
export const integrations: ReadonlyMap<string, Integration> = new Map([[grafana.id, grafana]]);
