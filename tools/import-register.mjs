/**
 * Kauaʻi register -> the cold-start seed file.
 *
 * This is only for a database that does not exist yet. Once there is one, use
 * sync-register.mjs instead: it upserts on the publisher's stable id, so it can
 * be re-run against a live install without duplicating anything or detaching
 * the memberships and swipes that point at existing records.
 *
 * Both read the same transform, so the seed and the sync can never disagree.
 *
 * Lives in tools/ at the repo root, deliberately OUTSIDE app/: Meteor bundles
 * and executes every file under app/ except public/, private/ and tests/, so a
 * build script parked there runs as server code at boot and takes the server
 * down with it.
 *
 * Run from the repo root:
 *   node tools/import-register.mjs <register.json> app/private/seed-kauai.json
 */
import fs from 'fs';
import { transform } from './lib/transform.mjs';

const [, , REGISTER, OUT] = process.argv;
if (!REGISTER || !OUT) {
  console.error('usage: node tools/import-register.mjs <register.json> <out.json>');
  process.exit(1);
}

const reg = JSON.parse(fs.readFileSync(REGISTER, 'utf8'));
const { clubs, events } = transform(reg);

fs.writeFileSync(OUT, `${JSON.stringify({
  generatedFrom: REGISTER.split('/').pop(),
  datasetName: reg.dataset_name,
  scope: reg.geographic_scope,
  verifiedOn: reg.last_public_web_verification_date,
  clubs,
  events,
}, null, 2)}\n`);

const has = (rows, key) => rows.filter(r => r[key] !== undefined).length;
console.log(`clubs   ${clubs.length}`);
console.log(`events  ${events.length}`);
console.log('\nfield coverage (a missing key means the card draws no row):');
for (const k of ['description', 'endDate', 'cost', 'audience', 'registrationNote', 'phone', 'hostName']) {
  console.log(`  events.${k.padEnd(17)} ${String(has(events, k)).padStart(3)}/${events.length}`);
}
