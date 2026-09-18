import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test, { mock } from 'node:test';
import { SourceDefinitionSchema } from '../src/contracts.js';
import { replaySite } from '../src/source-tools.js';

/**
 * Every folder under test/sites is a real site, as it was on the day it was
 * captured: the register entry that reads it, the pages it served, and what
 * was read from them. Replayed with the clock set to that day. A parser
 * change that breaks a site fails here by the site's name; a new site is a
 * new folder and no new code (`dry-run entry.json --save-fixture=test/sites/<slug>`).
 */
const root = fileURLToPath(new URL('./sites', import.meta.url));
const sites = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : [];

for (const site of sites) {
  test(`site: ${site} still reads the way it did when captured`, async () => {
    const read = (name: string) => JSON.parse(readFileSync(resolve(root, site, name), 'utf8')) as unknown;
    const source = SourceDefinitionSchema.parse(read('entry.json'));
    const { pages } = read('pages.json') as { pages: Array<{ url: string; mediaType: string; text: string }> };
    const expected = read('expected.json') as { now: string; items: unknown[] };
    assert.ok(expected.items.length > 0, 'a captured site with nothing in it proves nothing');
    mock.timers.enable({ apis: ['Date'], now: Date.parse(expected.now) });
    try {
      assert.deepEqual(JSON.parse(JSON.stringify(await replaySite(source, pages))), expected.items);
    } finally {
      mock.timers.reset();
    }
  });
}
