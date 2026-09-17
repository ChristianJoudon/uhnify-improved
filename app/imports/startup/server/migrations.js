import { Events } from '../../api/events/Events';
import { EventSwipes } from '../../api/events/EventSwipes';

/**
 * Startup migrations. Each one is idempotent and cheap enough to run on every
 * boot, because "has this already run" is state nobody wants to keep — a
 * migration that can be re-run is one that cannot be half-applied.
 */

/**
 * Drop the creator's address from listings that never needed it.
 *
 * Every event the app made carried `createdBy` — the poster's account email —
 * beside `owner`, which held the same value. The two differed in exactly one
 * way: the public publications withheld `owner` and not `createdBy`, so the
 * copy nobody read was the one every signed-out visitor received. The
 * publications now withhold both, and the app no longer writes the field; this
 * clears what is already stored.
 *
 * Only the redundant copies go: every imported record (the seeded register
 * stamped the seeding admin on all 283 of its events) and any record whose
 * `createdBy` simply repeats its `owner`. A `createdBy` that says something
 * `owner` does not — an administrator once typed one into the old "Posted by"
 * box — is left alone, because dropping it would destroy a fact rather than a
 * duplicate.
 *
 * Returns how many were cleared, so the startup log can say so once and stay
 * quiet on every boot after.
 */
export const dropRedundantCreatedBy = () => {
  let cleared = 0;
  // Fetched before the first write, so the cursor is never walking a set that
  // each update is removing records from underneath it.
  Events.collection.find(
    { createdBy: { $exists: true } },
    { fields: { createdBy: 1, owner: 1, importedFrom: 1 } },
  ).fetch().forEach(event => {
    if (event.importedFrom !== undefined || event.createdBy === event.owner) {
      Events.collection.update(event._id, { $unset: { createdBy: '' } });
      cleared += 1;
    }
  });
  return cleared;
};

/**
 * Give every stored right swipe the name it now goes by.
 *
 * A right swipe used to be stored as 'interested' whatever it was on. The
 * owner's decision is that on an event it means "Going" — an RSVP — and on a
 * group it has always meant joining, so the one old value becomes two: 'going'
 * for events and 'joined' for groups. A row with no `kind` predates the deck's
 * groups mode, when there was nothing to swipe on but events, and is treated as
 * the event swipe it was.
 *
 * The schema no longer allows 'interested', which is not an obstacle here:
 * collection2 validates the modifier, not the document it lands on, so a plain
 * `$set` to a value the schema does allow goes through with validation ON —
 * and the new value is checked like any other write. Nothing else reads the
 * old rows first: this runs before the recommendation scaffold, which replays
 * every swipe and would otherwise replay a word that no longer means anything.
 *
 * Returns how many rows took each name, so the startup log can say so once and
 * stay quiet on every boot after.
 */
export const renameInterestedSwipes = () => {
  // Groups first, and the second selector still excludes them, so neither
  // update depends on the other having run.
  const joined = EventSwipes.collection.update(
    { decision: 'interested', kind: 'club' },
    { $set: { decision: 'joined' } },
    { multi: true },
  );
  const going = EventSwipes.collection.update(
    { decision: 'interested', kind: { $ne: 'club' } },
    { $set: { decision: 'going' } },
    { multi: true },
  );
  return { going, joined };
};
