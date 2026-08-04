import { Mongo } from 'meteor/mongo';
import { Meteor } from 'meteor/meteor';

/**
 * Numbers that only ever go up.
 *
 * `clubID` used to be allocated as max-plus-one over the collection, which is
 * wrong twice.
 *
 * It is a race: two people creating a group at the same moment both read the
 * same maximum and both insert the same number. There is no unique index on
 * the field to catch it, and `findClubByAnyId` resolves a duplicate to
 * whichever document Mongo returns first — so one of the two groups quietly
 * becomes unreachable by its own id.
 *
 * And it reuses. Delete the newest group and the next one created takes its
 * number back. Events carry `eventID` as their host group's NUMBER rather than
 * its `_id`, and deleting a group deliberately does not delete its events — so
 * the new group silently inherits the old one's listings. Somebody else's
 * events appear on a page belonging to a group that never held them.
 *
 * A counter fixes both at once: `$inc` is atomic, so concurrent callers get
 * different numbers, and the sequence never looks at what exists, so a deleted
 * number is never handed out again.
 */
class CountersCollection {
  constructor() {
    this.name = 'CountersCollection';
    this.collection = new Mongo.Collection(this.name);
    // No schema attached on purpose: collection2 validation on a document this
    // hot buys nothing, and the only writer is `nextId` below.
  }

  /**
   * The next number in a named sequence, atomically.
   *
   * `seedFrom` is the highest value already in use, and is consulted only when
   * the counter does not exist yet — the first call on an existing database has
   * to start above the data that predates the counter, or it would re-issue
   * every number from one.
   */
  nextId(name, seedFrom = 0) {
    const raw = this.collection.rawCollection();
    const existing = this.collection.findOne(name);
    if (!existing) {
      this.collection.insert({ _id: name, seq: seedFrom });
    }
    // findOneAndUpdate rather than update-then-read: the point of this file is
    // that two callers cannot receive the same number.
    const result = Meteor.wrapAsync(raw.findOneAndUpdate, raw)(
      { _id: name },
      { $inc: { seq: 1 } },
      { returnDocument: 'after', upsert: true },
    );
    return result?.value?.seq ?? result?.seq;
  }
}

export const Counters = new CountersCollection();
