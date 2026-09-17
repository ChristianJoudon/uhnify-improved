import { Meteor } from 'meteor/meteor';

/* eslint-disable no-console */

/**
 * How long MatchBook keeps what it writes down about people.
 *
 * Until now the answer was "forever". The recommendation request log expired
 * after 400 days and nothing else expired at all: every swipe, every card that
 * crossed a screen, every RSVP and every audited method call was kept for the
 * life of the database, and the architecture document listed a retention
 * policy under "must be chosen before launch".
 *
 * It is chosen here, and enforced by MongoDB rather than by a job somebody has
 * to remember to schedule: a TTL index deletes a document once its date field
 * is older than the limit. `Meteor.settings.retention` can shorten or lengthen
 * either limit without a code change:
 *
 *   behaviourDays  what a person did — interactions, impressions, item states,
 *                  RSVPs, attendance, the request log and the graph edges
 *                  derived from them. Eighteen months: long enough to see a
 *                  second year of an annual event, short enough to mean it.
 *   auditDays      the method audit trail. A year.
 */
export const RETENTION_DEFAULT_DAYS = { behaviourDays: 548, auditDays: 365 };

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Read at call time so a changed settings file is what the next start applies.
 *
 * A value that is not a positive number falls back to the default and says so.
 * The alternative is worse in both directions: MongoDB rejects a nonsense
 * expiry, which would leave the collection with no limit at all, and accepts
 * zero, which would delete the whole behaviour log within a minute of boot.
 */
export const retentionDays = name => {
  const fallback = RETENTION_DEFAULT_DAYS[name];
  const supplied = Meteor.settings?.retention?.[name];
  if (supplied === undefined || supplied === null) {
    return fallback;
  }
  const days = Number(supplied);
  if (Number.isFinite(days) && days >= 1) {
    return days;
  }
  console.error(`[retention] ${name} must be a number of days, 1 or more; using ${fallback}.`);
  return fallback;
};

export const retentionSeconds = name => Math.round(retentionDays(name) * DAY_SECONDS);

const sameSpec = (left, right) => JSON.stringify(left || null) === JSON.stringify(right || null);

const indexesOf = async raw => {
  try {
    return await raw.indexes();
  } catch (error) {
    // NamespaceNotFound: nothing has been written yet, so the collection does
    // not exist and neither do its indexes. createIndex will make both.
    if (error?.code === 26) {
      return [];
    }
    throw error;
  }
};

/**
 * Make one TTL index say what the settings say.
 *
 * `createIndex` alone is not enough, and the way it fails is the reason this
 * function exists. Asked for an index that already exists with a different
 * `expireAfterSeconds`, MongoDB refuses with an options conflict — so changing
 * the retention setting and restarting would log one error line and go on
 * deleting on the OLD schedule indefinitely. An existing index is therefore
 * brought into line with `collMod`, which changes the expiry in place.
 *
 * `collMod` cannot change what an index covers. If an index on this field
 * exists with a different partial filter, that is refused loudly rather than
 * adjusted: the filter is what keeps expiry away from documents that must
 * never expire, and a wrong one is not something to paper over at boot.
 *
 * Resolves to 'created', 'changed' or 'unchanged'. Rejects on anything else;
 * callers log it, because retention that silently is not happening is the
 * failure this whole file is about.
 */
export const ensureTtlIndex = async ({ collection, field, seconds, partialFilterExpression }) => {
  const raw = collection.rawCollection();
  const keys = { [field]: 1 };
  const existing = (await indexesOf(raw)).find(index => sameSpec(index.key, keys));
  if (!existing) {
    await raw.createIndex(keys, {
      expireAfterSeconds: seconds,
      ...(partialFilterExpression ? { partialFilterExpression } : {}),
    });
    return 'created';
  }
  if (!sameSpec(existing.partialFilterExpression, partialFilterExpression)) {
    throw new Error(`${raw.collectionName}.${field} is indexed with a different partial filter; `
      + 'drop that index so the retention index can be built.');
  }
  if (existing.expireAfterSeconds === seconds) {
    return 'unchanged';
  }
  await collection.rawDatabase().command({
    collMod: raw.collectionName,
    index: { keyPattern: keys, expireAfterSeconds: seconds },
  });
  return 'changed';
};

/**
 * Apply one retention limit to a list of `{ collection, field, partialFilterExpression }`.
 * Every entry is attempted even if an earlier one fails, so one bad index
 * cannot leave the rest of the list without a limit.
 */
export const ensureRetention = async (name, targets) => {
  const seconds = retentionSeconds(name);
  const results = await Promise.allSettled(targets.map(target => ensureTtlIndex({ ...target, seconds })));
  const failures = results
    .map((result, index) => ({ result, target: targets[index] }))
    .filter(({ result }) => result.status === 'rejected');
  failures.forEach(({ result, target }) => {
    console.error(
      `[retention] ${target.collection.rawCollection().collectionName} has NO expiry:`,
      result.reason?.message,
    );
  });
  return { seconds, failed: failures.length };
};
