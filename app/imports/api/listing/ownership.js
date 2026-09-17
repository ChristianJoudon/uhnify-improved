import { Meteor } from 'meteor/meteor';
import { Roles } from 'meteor/alanning:roles';

/**
 * Who a listing belongs to, asked one way.
 *
 * `owner` on a group or an event is the creator's ACCOUNT NAME — which for
 * every account this app makes is an email address — not a userId. That is
 * older than this file and is why the public publications withhold the field.
 * The comparison used to be written out wherever it was needed, and a second
 * copy is how one of them ends up comparing against a userId and quietly
 * answering "no" to every owner. The methods and the publications both ask
 * here.
 */

/**
 * The name an account goes by: its username, else its first address. An
 * account that cannot be found has no name, and the userId is handed back so
 * a record stamped by a caller with no account document still says something.
 */
export const accountNameOf = userId => {
  const user = Meteor.users.findOne(userId, { fields: { username: 1, emails: 1 } });
  return user?.username || user?.emails?.[0]?.address || userId;
};

/**
 * Everything isListingOwner reads. A caller that loads a listing only to ask
 * whose it is projects to these, for the reason LISTING_PRIVACY_FIELDS gives:
 * a field the projection left out reads as absent, and here an absent
 * `importedFrom` is what says "a person made this".
 */
export const OWNERSHIP_FIELDS = Object.freeze({ owner: 1, importedFrom: 1 });

/**
 * Whether this person made this listing.
 *
 * Both sides have to be there. A listing can have no owner at all, and a
 * signed-out caller has no name: without the two guards
 * `undefined === undefined` would make every visitor the owner of every
 * listing that lacks one.
 *
 * An imported listing was made by nobody. The register stamps the address of
 * whoever ran the import on all of its records, and the intake pipeline
 * stamps its own name, so `owner` on those is provenance and not a person.
 * That was harmless while owning a listing bought the right to remove a tag.
 * It now buys the invite link, the privacy switches and the member list, and
 * an account name is whatever was typed at sign-up: on a deployment where the
 * importing address has no account, the first person to register it would
 * have been handed every imported group on the island. An administrator still
 * manages these, by role, which is who imported them in the first place.
 */
export const isListingOwner = (userId, record) => Boolean(userId)
  && Boolean(record?.owner)
  && record.importedFrom === undefined
  && record.owner === accountNameOf(userId);

/**
 * The same question as a selector, for a cursor over a person's own listings.
 * Here rather than written out beside the cursor so that the two cannot come
 * to disagree about an imported record.
 */
export const ownedListingSelector = userId => ({
  owner: accountNameOf(userId),
  importedFrom: { $exists: false },
});

/** The owner, or an administrator acting for them. */
export const canManageListing = (userId, record) => Boolean(userId) && Boolean(record)
  && (isListingOwner(userId, record) || Roles.userIsInRole(userId, 'admin'));
