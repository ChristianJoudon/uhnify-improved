import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateRegistry, type SourceRegistry } from './contracts.js';

export const DEFAULT_REGISTRY_PATH = resolve(
  fileURLToPath(new URL('../../../app/private/community-sources.v1.json', import.meta.url)),
);

export async function loadSourceRegistry(path = DEFAULT_REGISTRY_PATH): Promise<SourceRegistry> {
  const text = await readFile(path, 'utf8');
  return validateRegistry(JSON.parse(text) as unknown);
}
