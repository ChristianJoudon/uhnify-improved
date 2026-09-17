import { Events } from '../../api/events/Events';

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
