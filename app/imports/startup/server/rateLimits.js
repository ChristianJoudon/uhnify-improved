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
const APP_METHOD = /^(createUserProfile|Profiles\.|Clubs\.|clubs\.|Events\.|profileClubs\.|eventSwipes\.|friends\.)/;

/** Named limits: [calls, seconds]. Anything absent falls to GENERAL. */
const LIMITS = {
  // The deck. Fast by design, and the one place a limit would be felt.
  'eventSwipes.record': [40, 10],
  'eventSwipes.remove': [40, 10],
  // Enumerable: the reply tells you whether an account exists.
  'friends.request': [10, 60],
  createUserProfile: [5, 60],
  // Writes that carry an image, so each one is expensive to accept.
  'Clubs.insert': [8, 60],
  'Events.insert': [8, 60],
  'Profiles.update': [20, 60],
};

const GENERAL = [30, 10];

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

  /**
   * Sign-in attempts, keyed by address rather than connection — a connection is
   * free to discard and reopen, an address is not. This is the one rule whose
   * absence is a real credential-stuffing hole, and the reason it can be this
   * strict is that a person who has forgotten their password does not try
   * fifteen times in a minute.
   */
  DDPRateLimiter.addRule({
    type: 'method',
    name: 'login',
    clientAddress: () => true,
  }, 15, 60 * 1000);

  DDPRateLimiter.addRule({
    type: 'method',
    name: 'createUser',
    clientAddress: () => true,
  }, 5, 60 * 60 * 1000);

  // A refusal should read as "slow down", not as a fault in the app.
  DDPRateLimiter.setErrorMessage(({ timeToReset }) => {
    const seconds = Math.ceil((timeToReset || 0) / 1000);
    return `That was a lot at once. Try again in ${seconds || 1} second${seconds === 1 ? '' : 's'}.`;
  });

  return Object.keys(LIMITS).length + 3;
};

/** Exported for the tests, which assert the deck's limit stays above what a
    reader can physically produce. */
export const rateLimitFor = name => LIMITS[name] || GENERAL;
