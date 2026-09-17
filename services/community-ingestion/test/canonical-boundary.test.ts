import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
};

test('ingestion source cannot reference MatchBook canonical event or club collections', async () => {
  const violations: string[] = [];
  for (const path of await sourceFiles(sourceRoot)) {
    const text = await readFile(path, 'utf8');
    if (/EventsCollection|ClubsCollection|imports\/api\/(events|club)/.test(text)) violations.push(path);
  }
  assert.deepEqual(violations, []);
});
