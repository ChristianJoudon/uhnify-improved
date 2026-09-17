import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';

/**
 * Throttling, by connection.
 *
 * Nothing here was limited before, so every method could be called as fast as a
 * loop could issue them — which matters most for the ones that reveal something
 * by failing. `friends.request` against a list of ids enumerates who exists;
 * repeated `not-authorized` from `Clubs.remove` maps what is admin-only. The
 * audit trail records those attempts now; this stops them being free.
 *
 * There is deliberately NO CAPTCHA anywhere in this app, and nothing here needs
 * one: a limiter works at the DDP layer, costs the reader nothing, and never
 * asks a person to prove they are one.
 *
 * The numbers are set from what the INTERFACE can actually produce, not from a
 * round figure. The swipe deck is the fast one — a decisive reader gets through
 * a card a second and the undo button fires another — so its limit is well
 * above that, because a limiter that trips during ordinary use is a bug that
 * looks like a network fault. The rare, expensive or enumerable ones are tight.
 */

/** Everything the app owns, as a fallback for anything not named below. */
const APP_METHOD = /^(createUserProfile|Profiles\.|Clubs\.|clubs\.|Events\.|profileClubs\.|eventSwipes\.|friends\.|recommendations\.|recommendationInteractions\.|recommendationPreferences\.|ingestion\.|moderation\.)/;

/** Named limits: [calls, seconds]. Anything absent falls to GENERAL. */
const LIMITS = {
  // The deck. Fast by design, and the one place a limit would be felt.
  'eventSwipes.record': [40, 10],
  'eventSwipes.remove': [40, 10],
  'recommendationInteractions.record': [80, 10],
  'recommendations.get': [30, 10],
  // Enumerable: the reply tells you whether an account exists.
  'friends.request': [10, 60],
  createUserProfile: [5, 60],
  // Enumerable, and the one that matters most: the reply says whether a guess
  // at a private group's invite token was right, and a right guess is a way
  // in. The token is 256 random bits, so no rate makes guessing practical;
  // this makes it pointless to try. Ten a minute is a person opening every
  // invitation they were ever sent. 'profileClubs.add' checks a token too, and
  // stays on the general rule all the same: the deck joins groups through it
  // at swiping speed, and it answers only about the one group it was given.
  'clubs.inviteInfo': [10, 60],
  // Replacing a link is something an owner does once, after it leaked.
  'clubs.rotateInvite': [5, 60],
  // A whole roster with its photos, so each call is expensive to answer.
  'clubs.members': [10, 60],
  // Each one re-judges every member's and attendee's row and can rewrite a
  // group's events. Twenty a minute is somebody trying every switch on the
  // settings page several times over; a loop gets no further than that.
  'Clubs.setPrivacy': [20, 60],
  'Events.setPrivacy': [20, 60],
  // Writes that carry an image, so each one is expensive to accept.
  // A report is cheap to send and costs a person's attention to read.
  'moderation.flag': [6, 60],
  'Clubs.block': [20, 60],
  'Clubs.insert': [8, 60],
  'Events.insert': [8, 60],
  'Profiles.update': [20, 60],
  // Administrator-only source collection and public projection boundaries.
  'ingestion.runs.requestSource': [20, 60],
  'ingestion.runs.requestAll': [5, 60],
  'ingestion.research.request': [5, 60],
  'ingestion.candidates.approve': [30, 60],
  'ingestion.candidates.approveAll': [5, 60],
  'ingestion.candidates.saveEditorialOverrides': [30, 60],
};

const GENERAL = [30, 10];

/**
 * The two rules keyed by ADDRESS rather than connection: [calls, seconds].
 *
 * A connection is free to discard and reopen; an address is not. That is what
 * makes these the rules that matter against credential stuffing and account
 * farming — and also what makes them dangerous, because an address is not a
 * person. Everyone on a venue's Wi-Fi shares one. And behind a reverse proxy
 * that has not been told to trust `X-Forwarded-For` (HTTP_FORWARDED_COUNT, see
 * doc/production-environment.md) EVERY visitor shares the proxy's, and these
 * become limits on the whole site.
 *
 * So the numbers are set for a room, not for one person. Thirty sign-ins a
 * minute is what a launch party produces when the venue's Wi-Fi reconnects
 * everyone at once — and `login` here is the DDP method, which is also what a
 * browser calls to RESUME a stored session. accounts-base discards its stored
 * token on any refusal, so a resume login that trips this rule does not retry;
 * it logs the person out. That is the failure mode the old figure of fifteen
 * invited, and why this one errs generous. Twenty sign-ups an hour is a table
 * of friends all joining at once, twice over.
 *
 * There is no captcha here and there will not be one; that is decided. What
 * actually stops a farmed account from doing harm is that posting requires a
 * verified email and that listings are moderated. This rule only keeps the
 * farming from being free.
 */
const ADDRESS_LIMITS = {
  login: [30, 60],
  createUser: [20, 60 * 60],
};

export const installRateLimits = () => {
  if (!DDPRateLimiter) {
    return 0;
  }

  Object.entries(LIMITS).forEach(([name, [calls, seconds]]) => {
    DDPRateLimiter.addRule({
      type: 'method',
      name,
      // Per connection rather than per user: an attacker who is not logged in
      // has no userId to key on, and that is exactly the case worth limiting.
      connectionId: () => true,
    }, calls, seconds * 1000);
  });

  DDPRateLimiter.addRule({
    type: 'method',
    name: name => APP_METHOD.test(name) && !LIMITS[name],
    connectionId: () => true,
  }, GENERAL[0], GENERAL[1] * 1000);

  Object.entries(ADDRESS_LIMITS).forEach(([name, [calls, seconds]]) => {
    DDPRateLimiter.addRule({
      type: 'method',
      name,
      clientAddress: () => true,
    }, calls, seconds * 1000);
  });

  // A refusal should read as "slow down", not as a fault in the app.
  DDPRateLimiter.setErrorMessage(({ timeToReset }) => {
    const seconds = Math.ceil((timeToReset || 0) / 1000);
    return `That was a lot at once. Try again in ${seconds || 1} second${seconds === 1 ? '' : 's'}.`;
  });

  return Object.keys(LIMITS).length + Object.keys(ADDRESS_LIMITS).length + 1;
};

/** Exported for the tests, which assert the deck's limit stays above what a
    reader can physically produce. */
export const rateLimitFor = name => LIMITS[name] || GENERAL;

/** Exported for the tests, which pin the per-address figures to the reasoning
    above so that nobody tightens them back down without reading it. */
export const addressLimitFor = name => ADDRESS_LIMITS[name] || null;
