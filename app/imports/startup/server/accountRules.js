import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';
import { EMAIL_SHAPE, TEXT_LIMITS } from '../../api/listing/limits';

/**
 * An account goes by its own email address, and by nothing else.
 *
 * `owner` on a group or an event is the ACCOUNT NAME of whoever made it (see
 * api/listing/ownership.js), and the name is the username when there is one.
 * The sign-up page always sends the email as the username, so the two were
 * the same thing by habit — and only by habit. `Accounts.createUser` is
 * callable from any browser console, and it takes whatever username it is
 * given so long as nobody has it yet, whatever the email beside it says. That
 * made "is this listing mine?" a question anybody could answer yes to, by
 * signing up under the name a listing was stamped with and an address of
 * their own. It mattered little while owning a listing bought the removal of
 * a tag. It now buys the invite link, the privacy switches and the list of
 * members.
 *
 * So the habit is a rule: a new account's username, if it has one, is its
 * first email address, and that address is shaped like one. It is its own
 * module, and not a few lines in Accounts.js, because that file creates the
 * default accounts as it loads and so cannot be loaded by a test.
 *
 * What this does NOT do is prove the address is theirs. Nothing in the app
 * verifies an email yet, so a listing stamped with an address nobody has
 * registered still goes to whoever registers it first. Imported listings are
 * kept out of that by isListingOwner; verification is what closes it.
 */
export const newAccountProblem = user => {
  const address = user?.emails?.[0]?.address;
  if (typeof address !== 'string' || address.length > TEXT_LIMITS.email || !EMAIL_SHAPE.test(address)) {
    return 'invalid-email';
  }
  if (user.username !== undefined && user.username !== address) {
    return 'invalid-username';
  }
  return null;
};

Accounts.validateNewUser(user => {
  const problem = newAccountProblem(user);
  if (problem) {
    throw new Meteor.Error(problem, 'Sign up with your email address.');
  }
  return true;
});
