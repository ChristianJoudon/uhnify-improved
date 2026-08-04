import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';

/**
 * Every state change, in the order it happened.
 *
 * The app had no record of who did what. A group could be renamed, a member
 * removed, an event deleted, and afterwards there was no way to answer either
 * of the two questions that actually get asked — "when did this change?" and
 * "who changed it?". Four of the eight collections do not even carry a
 * timestamp, so the documents themselves cannot say.
 *
 * This is append-only by construction: nothing in the app updates or removes an
 * entry, and there is no method that can. It is written by a single wrapper
 * around the method layer rather than by calls scattered through the methods
 * themselves — see startup/server/auditTrail.js — because a trail that each new
 * method has to remember to write to is a trail with holes in it.
 *
 * What it deliberately does NOT hold: argument values of any size. Profile
 * pictures and event images travel through these methods as multi-megabyte
 * base64 strings, and a log that copied them would outgrow the data it
 * describes within a day. Arguments are summarised, never stored whole.
 */
class AuditLogCollection {
  constructor() {
    this.name = 'AuditLogCollection';
    this.collection = new Mongo.Collection(this.name);
    this.schema = new SimpleSchema({
      /** When, always server clock — a client's clock is not evidence. */
      at: Date,
      /** The signed-in caller, or null for anything the server did itself. */
      actorId: { type: String, optional: true },
      /** Denormalised on purpose: an account can be deleted, and the trail
          still has to be able to say who it was. */
      actorEmail: { type: String, optional: true },
      /** The method name, which is the app's own vocabulary for what happened. */
      action: String,
      /** Whether the call succeeded, and the error code if it did not. Failed
          attempts are the more interesting half for anything security-shaped. */
      outcome: { type: String, allowedValues: ['ok', 'error'] },
      errorCode: { type: String, optional: true },
      /** A short, redacted description of the arguments. Never their values. */
      summary: { type: String, optional: true },
      /** How long it took, so a slow method is visible without another tool. */
      ms: { type: SimpleSchema.Integer, optional: true },
    });
    this.collection.attachSchema(this.schema);
    this.adminPublicationName = `${this.name}.publication.admin`;
  }
}

export const AuditLog = new AuditLogCollection();
