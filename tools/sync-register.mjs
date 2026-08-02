/**
 * Sync a public register into MatchBook's database.
 *
 * Re-runnable by design. Every record is upserted on the publisher's own stable
 * id, so a refresh updates documents in place rather than inserting duplicates —
 * which means an event keeps its _id and every membership, swipe and saved
 * reference that points at it survives the refresh. That is the whole reason
 * this exists instead of a reseed: reseeding only ever works on an empty
 * database, and an empty database is one nobody has used yet.
 *
 * Records that have since disappeared from the register are pruned, but only
 * ones this dataset put there — anything a person created in the app has no
 * importedFrom and is never touched.
 *
 * There is no size ceiling here. This talks to Mongo directly, so it is bounded
 * by the database rather than by a bundle.
 *
 * A database seeded before this existed has records with no sourceId. They are
 * adopted on the first run by matching the publisher's natural key — a club's
 * name, an event's name and start time — so an existing install migrates in
 * place instead of gaining 307 duplicates beside the originals.
 *
 *   node tools/sync-register.mjs <register.json> [--dry-run] [--prune]
 *
 * MONGO_URL defaults to Meteor's dev database (mongodb://127.0.0.1:3001/meteor).
 * Point it at anything else to sync a deployed environment.
 */
import crypto from 'crypto';
import fs from 'fs';
import { MongoClient } from 'mongodb';
import { transform } from './lib/transform.mjs';

/**
 * Meteor's own _id shape: 17 characters from its unmistakable-character
 * alphabet. The driver would otherwise mint a native ObjectId on insert, and
 * Meteor collections are string-keyed — an ObjectId _id compares by reference
 * on the client, so `selectedId === doc._id` silently stops being true and any
 * selection built on it quietly breaks. That is exactly how the swipe deck's
 * card flip stopped working after the first sync.
 */
const UNMISTAKABLE = '23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz';
const meteorId = () => Array.from(crypto.randomBytes(17))
  .map(byte => UNMISTAKABLE[byte % UNMISTAKABLE.length])
  .join('');

const args = process.argv.slice(2);
const REGISTER = args.find(a => !a.startsWith('--'));
const DRY = args.includes('--dry-run');
const PRUNE = args.includes('--prune');
const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:3001/meteor';

if (!REGISTER) {
  console.error('usage: node tools/sync-register.mjs <register.json> [--dry-run] [--prune]');
  process.exit(1);
}

const reg = JSON.parse(fs.readFileSync(REGISTER, 'utf8'));
const { clubs, events } = transform(reg);
const DATASET = reg.dataset_name;

const client = new MongoClient(MONGO_URL);
await client.connect();
const db = client.db();
const Clubs = db.collection('ClubsCollection');
const Events = db.collection('EventsCollection');

/* ------------------------------------------------------------------ adopt */

/**
 * Claim records that predate the stable id. Matching is on what the publisher
 * would call the same thing — a club's name, an event's name and start minute —
 * and only ever fills in a missing sourceId, so it can never re-point a record
 * that already has one.
 */
const adopt = async (col, docs, keyOf, label) => {
  const orphans = await col.find({ sourceId: { $exists: false } }).toArray();
  if (orphans.length === 0) {
    return 0;
  }
  const wanted = new Map(docs.map(d => [keyOf(d), d.sourceId]));
  const taken = new Set((await col.find({ sourceId: { $exists: true } }, { projection: { sourceId: 1 } })
    .toArray()).map(d => d.sourceId));

  const ops = [];
  for (const row of orphans) {
    const id = wanted.get(keyOf(row));
    if (id && !taken.has(id)) {
      taken.add(id);
      ops.push({ updateOne: { filter: { _id: row._id }, update: { $set: { sourceId: id, importedFrom: DATASET } } } });
    }
  }
  if (ops.length && !DRY) {
    await col.bulkWrite(ops, { ordered: false });
  }
  console.log(`${label.padEnd(7)} adopted ${ops.length} of ${orphans.length} pre-existing record(s)`);
  return ops.length;
};

/* ------------------------------------------------------------------ index */

// The upsert key. Unique and sparse: app-created records carry no sourceId and
// must not collide with each other on its absence.
if (!DRY) {
  for (const col of [Clubs, Events]) {
    await col.createIndex({ sourceId: 1 }, { unique: true, sparse: true });
  }
}

/* ------------------------------------------------------- numeric club ids */

/**
 * clubID is the number events point at, so it has to survive a refresh even if
 * the register reorders. Existing clubs keep the number they already have; only
 * genuinely new ones draw from the top of the range.
 */
const existing = await Clubs.find({}, { projection: { sourceId: 1, clubID: 1 } }).toArray();
const idBySource = new Map(existing.filter(c => c.sourceId).map(c => [c.sourceId, c.clubID]));
let nextClubId = existing.reduce((max, c) => Math.max(max, c.clubID || 0), 0);

const clubDocs = clubs.map(club => {
  const known = idBySource.get(club.sourceId);
  if (known) {
    return { ...club, clubID: known };
  }
  nextClubId += 1;
  idBySource.set(club.sourceId, nextClubId);
  return { ...club, clubID: nextClubId };
});

// Events reference their host by that number, so resolve after the ids settle.
const clubIdByName = new Map(clubDocs.map(c => [c.name.toLowerCase(), c.clubID]));
const eventDocs = events.map(event => ({
  ...event,
  eventID: (event.hostName && clubIdByName.get(event.hostName.toLowerCase())) || 0,
  date: new Date(event.date),
  ...(event.endDate ? { endDate: new Date(event.endDate) } : {}),
}));

/* ----------------------------------------------------------------- upsert */

/**
 * $set carries the register's view; $unset removes what it has stopped
 * publishing, so a cost that disappears upstream disappears here too rather
 * than lingering as a stale row on a card.
 */
const syncInto = async (col, docs, label) => {
  const before = await col.countDocuments({ importedFrom: DATASET });
  if (DRY) {
    const known = new Set((await col.find({ importedFrom: DATASET }, { projection: { sourceId: 1 } })
      .toArray()).map(d => d.sourceId));
    const fresh = docs.filter(d => !known.has(d.sourceId)).length;
    console.log(`${label.padEnd(7)} would upsert ${docs.length}  (${fresh} new, ${docs.length - fresh} updated, ${before} present)`);
    return { inserted: fresh, updated: docs.length - fresh, removed: 0 };
  }

  const ops = docs.map(doc => {
    const { sourceId, ...rest } = doc;
    // Anything the schema allows but this record does not carry is cleared, so
    // a refresh can retract a field as well as change one.
    const clearable = ['description', 'endDate', 'cost', 'audience', 'registrationNote',
      'phone', 'email', 'region', 'hostName', 'membership', 'categories', 'tags', 'schedule'];
    const unset = Object.fromEntries(clearable.filter(k => rest[k] === undefined).map(k => [k, '']));
    return {
      updateOne: {
        filter: { sourceId },
        update: {
          $set: { ...rest, sourceId, importedFrom: DATASET, lastSyncedAt: new Date() },
          // Only applies when the upsert actually inserts; an existing record
          // keeps the _id every membership and swipe already points at.
          $setOnInsert: { _id: meteorId() },
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
        },
        upsert: true,
      },
    };
  });

  const result = await col.bulkWrite(ops, { ordered: false });
  const inserted = result.upsertedCount;
  const updated = result.matchedCount;

  let removed = 0;
  if (PRUNE) {
    const keep = docs.map(d => d.sourceId);
    // Scoped to this dataset: a club someone created in the app has no
    // importedFrom and is never a candidate.
    const gone = await col.deleteMany({ importedFrom: DATASET, sourceId: { $nin: keep } });
    removed = gone.deletedCount;
  }

  console.log(`${label.padEnd(7)} ${String(inserted).padStart(4)} new  ${String(updated).padStart(4)} updated  ${String(removed).padStart(4)} pruned`);
  return { inserted, updated, removed };
};

console.log(`\n${DATASET}`);
console.log(`${MONGO_URL}${DRY ? '   (dry run — nothing written)' : ''}\n`);

// Minute precision: the same listing re-published may differ by seconds.
const minute = date => new Date(date).toISOString().slice(0, 16);
await adopt(Clubs, clubDocs, c => c.name.toLowerCase(), 'clubs');
await adopt(Events, eventDocs, e => `${e.title.toLowerCase()}|${minute(e.date)}`, 'events');

const c = await syncInto(Clubs, clubDocs, 'clubs');
const e = await syncInto(Events, eventDocs, 'events');

if (!DRY && !PRUNE) {
  const staleC = await Clubs.countDocuments({ importedFrom: DATASET, sourceId: { $nin: clubDocs.map(d => d.sourceId) } });
  const staleE = await Events.countDocuments({ importedFrom: DATASET, sourceId: { $nin: eventDocs.map(d => d.sourceId) } });
  if (staleC + staleE > 0) {
    console.log(`\n${staleC + staleE} record(s) are no longer in the register. Re-run with --prune to remove them.`);
  }
}

console.log(`\ntotal  ${c.inserted + e.inserted} new, ${c.updated + e.updated} updated, ${c.removed + e.removed} pruned`);
await client.close();
