import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';

/** Friend edges. One doc per pair: requester -> receiver, pending until accepted. */
class FriendsCollection {
  constructor() {
    this.name = 'FriendsCollection';
    this.collection = new Mongo.Collection(this.name);
    this.schema = new SimpleSchema({
      requesterId: String,
      receiverId: String,
      // Direction-independent pair identity ("idA:idB", sorted) — unique per pair.
      pairKey: { type: String, optional: true },
      status: { type: String, allowedValues: ['pending', 'accepted'] },
      createdAt: { type: Date, optional: true },
      respondedAt: { type: Date, optional: true },
    });
    this.collection.attachSchema(this.schema);
    this.userPublicationName = `${this.name}.publication.user`;
    if (Meteor.isServer) {
      Meteor.startup(() => {
        // One edge per pair, enforced at the database so a request race cannot duplicate.
        this.collection.rawCollection().createIndex({ pairKey: 1 }, { unique: true, sparse: true }).catch(() => {});
      });
    }
  }
}

export const Friends = new FriendsCollection();
