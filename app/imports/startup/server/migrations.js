import { AuditLog } from '../../api/audit/AuditLog';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventSwipes } from '../../api/events/EventSwipes';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { Profiles } from '../../api/profiles/Profiles';
import { isPhotoRefusal, savePhoto } from '../../api/photos/photoStore';
import { PARTICIPATION_ACTIONS, PARTICIPATION_SUMMARY } from './auditTrail';

/* eslint-disable no-console */

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

/**
 * Make every stored count agree with the rows it counts.
 *
 * A group's `memberCount` and an event's `goingCount` are kept by the methods
 * as people join, leave and RSVP. They are stored, rather than counted when
 * asked, because an anonymous listing publishes a number and nothing else —
 * there is no list on the client to take the length of.
 *
 * A stored count can be wrong in three ways, and this is the answer to all of
 * them. Every listing older than the fields has no count at all. A membership
 * or a swipe written around the methods — the seed, an import, a hand in the
 * database — was never counted. And two writes landing together can each move
 * a count the other already moved. None of those is worth a lock; all of them
 * are put right here, from the rows themselves, at the next boot.
 *
 * Going is counted the way the app reads it: a 'going' swipe on an event. It
 * runs after renameInterestedSwipes, so an old right swipe is already called
 * 'going' by the time it is counted. A listing nobody is in gets a zero
 * rather than no field, so after the first boot no reader has to decide what
 * an absent count means.
 *
 * Only what differs is written, which is what makes it cheap on every boot
 * after the first and keeps `updatedAt` meaning "somebody edited this".
 * Returns how many of each were corrected, so the log can say so once.
 */
export const backfillListingCounts = () => {
  const tally = (rows, key) => rows.reduce(
    (counts, row) => counts.set(row[key], (counts.get(row[key]) || 0) + 1),
    new Map(),
  );
  const members = tally(ProfileClubs.collection.find({}, { fields: { clubId: 1 } }).fetch(), 'clubId');
  const going = tally(EventSwipes.collection.find(
    { decision: 'going', kind: { $ne: 'club' } },
    { fields: { eventId: 1 } },
  ).fetch(), 'eventId');

  // Fetched before the first write, as above, and projected to the one field:
  // a listing can carry a photo inline.
  const settle = (collection, field, counts) => collection.find({}, { fields: { [field]: 1 } }).fetch()
    .filter(record => record[field] !== (counts.get(record._id) || 0))
    .map(record => collection.update(record._id, { $set: { [field]: counts.get(record._id) || 0 } }))
    .length;

  return {
    clubs: settle(Clubs.collection, 'memberCount', members),
    events: settle(Events.collection, 'goingCount', going),
  };
};

/**
 * Move every photo still stored on its document out to the photo store.
 *
 * An upload used to be written where it was used: a data URL of up to 700,000
 * characters in a group's or an event's `image`, or a profile's `picture`.
 * Publications send whole documents, so one poster with a photo cost every
 * visitor half a megabyte over the websocket, and the people directory sent
 * every member's avatar to every signed-in user — none of it cacheable. The
 * methods no longer store a photo that way (api/photos/photoStore.js); this
 * is for the ones already stored. Each goes to ListingPhotos under its
 * document's _id, and the field is left holding the path it is served from.
 * The seeded register carries no photos, so on a fresh database this finds
 * nothing.
 *
 * A photo that cannot be moved is LEFT EXACTLY AS IT IS. The rows this meets
 * were accepted under older checks — for a long time, anything that began
 * 'data:image/' and was under 2.8 MB — so some will be a GIF, or larger than
 * the ceiling is now, and the store refuses those as it would refuse them
 * today. Refusing to move one is not a reason to destroy it: it is somebody's
 * photo, it still draws, and the count of them is returned so the log can
 * say they are there. They go on costing what they always cost until their
 * owner replaces them.
 *
 * "Cannot be moved" means the store REFUSED it, and only that. The catch
 * below used to take every failure for a refusal, so a write the database
 * turned down, or a schema that would not take the path, was counted as one
 * more bad photo — reported on every boot in words that blamed the picture,
 * naming no record, with the real error thrown away. A refusal is now logged
 * with the record it is about and the store's reason, which is what somebody
 * needs to find the listing still sending half a megabyte to every visitor.
 * Anything else is logged as the error it is and counted apart, as `failed`.
 * Neither stops the boot, or the rows after it.
 *
 * It is idempotent by construction: it selects on the field still being a
 * data URL, and a moved one no longer is. A run cut short between storing the
 * photo and rewriting the field simply stores the same bytes again next boot.
 * `updatedAt` is not touched, so it goes on meaning "somebody edited this".
 *
 * The _ids are read first and each photo is then fetched alone, so the cursor
 * is never walking what the updates are changing, and the process never holds
 * more than one payload at a time.
 */
const PHOTO_HOLDERS = [
  { label: 'clubs', kind: 'club', holder: Clubs, field: 'image' },
  { label: 'events', kind: 'event', holder: Events, field: 'image' },
  { label: 'profiles', kind: 'profile', holder: Profiles, field: 'picture' },
];

export const movePhotosOutOfDocuments = () => {
  const counts = { clubs: 0, events: 0, profiles: 0, left: 0, failed: 0 };
  PHOTO_HOLDERS.forEach(({ label, kind, holder, field }) => {
    holder.collection.find({ [field]: /^data:/ }, { fields: { _id: 1 } }).fetch().forEach(({ _id }) => {
      const record = holder.collection.findOne(_id, { fields: { [field]: 1 } });
      // Removed since the _ids were read. There is no photo left to move, and
      // nothing to report about a record that is not there.
      if (!record) {
        return;
      }
      try {
        const path = savePhoto({ kind, ownerId: _id, dataUrl: record[field] });
        holder.collection.update(_id, { $set: { [field]: path } });
        counts[label] += 1;
      } catch (error) {
        if (isPhotoRefusal(error)) {
          counts.left += 1;
          console.warn(`[photos] left inline: ${label} ${_id} (${error.error})`);
        } else {
          counts.failed += 1;
          console.error(`[photos] could not move: ${label} ${_id}: ${error.message}`);
        }
      }
    });
  });
  return counts;
};

/**
 * Take the listing ids out of the trail entries that already carry them.
 *
 * The trail no longer writes down WHICH listing a join, an RSVP or a tag was
 * about (see PARTICIPATION_ACTIONS in auditTrail.js): with the actor beside
 * it, that was the member list of every anonymous group, kept for a year and
 * sent to every administrator. Fixing what is written from now on leaves the
 * entries already there saying it, so their summaries are replaced with what
 * a new entry would say.
 *
 * The trail is append-only and this is the one place that rule gives way,
 * deliberately and narrowly: no entry is removed, and who called what, when
 * and how it ended all stay. Only the argument summary goes, on the actions
 * that should never have had one. Returns how many entries were changed;
 * after the first boot that is none.
 */
export const redactParticipationAudit = () => AuditLog.collection.update(
  { action: { $in: [...PARTICIPATION_ACTIONS] }, summary: { $ne: PARTICIPATION_SUMMARY } },
  { $set: { summary: PARTICIPATION_SUMMARY } },
  { multi: true },
);
