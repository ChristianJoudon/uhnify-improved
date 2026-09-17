import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import swal from 'sweetalert';
import { ClubJoinRequests } from '../../api/club/ClubJoinRequests';

/**
 * "Join", asked one way from every page that offers it.
 *
 * There were five copies of this call — three walls, the deck and the sheet
 * each page opens — and every one of them read only the error. That was the
 * whole answer while joining either worked or did not. It now has a third
 * outcome: a group whose organizer approves people takes a REQUEST, and the
 * server says so with `{ status: 'requested' }` rather than an error, because
 * nothing went wrong. A page that ignored the result told the person nothing
 * at all, and left a button that still said "Join" over a request already
 * made. Written once, here, so the sixth caller cannot forget it.
 */

/** What a person is told when their join turned into a request. */
export const REQUEST_SENT = 'Request sent — the organizer will let you in.';

/**
 * The refusals that are not faults. "This group is private" under a red
 * "Error" reads as the app having broken; it is the group saying no, and the
 * server's own sentence (shown verbatim beneath) already says why.
 */
const CALM_TITLES = {
  'invite-required': 'Invite only',
  'request-declined': 'Not yet',
};

/**
 * The bare call, as a promise of the server's answer:
 * `{ status: 'joined', membershipId }` or `{ status: 'requested', requestId }`.
 *
 * The invite token travels in the options object and nowhere else — see
 * 'profileClubs.add' for why it must not be a bare argument.
 */
export const joinGroup = (clubId, { context = {}, inviteToken } = {}) => new Promise((resolve, reject) => {
  Meteor.call('profileClubs.add', clubId, context, inviteToken ? { inviteToken } : {}, (error, result) => (
    error ? reject(error) : resolve(result)
  ));
});

/** A refusal, said the way the rest of the app says one. */
export const tellJoinError = error => swal(
  CALM_TITLES[error.error] || 'Error',
  error.reason || error.message,
  CALM_TITLES[error.error] ? 'info' : 'error',
);

/**
 * Join and say what happened, for a wall or a sheet. Joining says nothing: the
 * button turning into "You're in" is the answer. A request is said out loud,
 * because "Requested" on a button does not say who decides or what comes next.
 * Resolves with the server's answer, or with nothing when it refused.
 */
export const joinGroupAndTell = (clubId, options) => joinGroup(clubId, options).then(result => {
  if (result?.status === 'requested') {
    swal({ text: REQUEST_SENT, icon: 'success' });
  }
  return result;
}, error => {
  tellJoinError(error);
});

const NONE = new Set();

/**
 * The groups this person has asked to join and not yet heard back from, as a
 * set of group ids — what turns a card's "Join" into "Requested".
 *
 * Only pending ones. An approved request is a membership by the time anyone
 * reads it, and a declined one goes back to offering "Join": pressing it is
 * how the person learns how long the wait is, which the server words better
 * than a greyed-out button could.
 */
export const useRequestedGroupIds = () => useTracker(() => {
  const userId = Meteor.userId();
  if (!userId) {
    return NONE;
  }
  Meteor.subscribe(ClubJoinRequests.minePublicationName);
  return new Set(ClubJoinRequests.collection.find({ userId, status: 'pending' }).map(request => request.clubId));
}, []);
