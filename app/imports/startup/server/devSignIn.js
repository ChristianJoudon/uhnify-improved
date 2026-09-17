import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';

/**
 * One-click sign-in for the development accounts. Development only.
 *
 * The seeded accounts exist so that the app can be looked at signed in, and
 * the only way in was to type `john@foo.com` and its password into the form —
 * every session, from memory, because a browser pointed at a different port
 * each week never autofills it. That is friction for the person building the
 * app and a wall for anything checking its work: a signed-in screen that is
 * tedious to reach is a signed-in screen nobody looks at.
 *
 * So the sign-in page grows a button per development account, and this is the
 * login handler behind them. It hands out a session with no password, which is
 * exactly as dangerous as it sounds, and so it is fenced four ways, every one
 * of which has to hold:
 *
 *   1. The server is running in development mode. The handler is not even
 *      registered otherwise, so a production build has nothing to call.
 *   2. `public.devSignIn` lists the address. That key exists only in the
 *      development settings file, and productionGuard refuses to start a
 *      production server that carries it.
 *   3. The address is one of `defaultAccounts` — the seeded accounts, never a
 *      real person's. A development database restored from production data
 *      does not make its users reachable this way.
 *   4. The request came from this machine, at every hop. A loopback address
 *      alone is not enough, because a reverse proxy on the same host reaches
 *      the app from 127.0.0.1 on behalf of the whole internet. "No forwarded
 *      header at all" is not the test either — that was the first attempt, and
 *      it refused everyone, because Meteor's own development proxy forwards
 *      every request (run-proxy.js, `xfwd: true`). The test is that EVERY
 *      address in X-Forwarded-For is this machine. It cannot be spoofed from
 *      outside: each proxy appends the address it actually saw, so a remote
 *      visitor who sends `X-Forwarded-For: 127.0.0.1` arrives as
 *      `127.0.0.1, <their real address>`, and is refused for the second entry.
 *
 * The rule is a pure function so the tests can walk every fence without a
 * connection or a settings file.
 */

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

const listed = (list, email) => Array.isArray(list) && list.includes(email);

/** Why this request may not sign in, in words, or null when it may. */
export const devSignInRefusal = ({ isDevelopment, settings, connection, email }) => {
  if (isDevelopment !== true) {
    return 'Development sign-in is not available on this server.';
  }
  if (typeof email !== 'string' || !listed(settings?.public?.devSignIn, email)) {
    return 'That address is not a development account.';
  }
  const seeded = (settings?.defaultAccounts || []).map(account => account?.email);
  if (!seeded.includes(email)) {
    return 'That address is not a development account.';
  }
  const forwarded = `${connection?.httpHeaders?.['x-forwarded-for'] || ''}`
    .split(',').map(hop => hop.trim()).filter(Boolean);
  if (!LOOPBACK.includes(connection?.clientAddress) || !forwarded.every(hop => LOOPBACK.includes(hop))) {
    return 'Development sign-in only answers this machine.';
  }
  return null;
};

if (Meteor.isDevelopment && Array.isArray(Meteor.settings.public?.devSignIn)) {
  Accounts.registerLoginHandler('devSignIn', function devSignIn(request) {
    // Not ours: let the password and resume handlers have it.
    if (!request || request.devSignIn === undefined) {
      return undefined;
    }
    const refusal = devSignInRefusal({
      isDevelopment: Meteor.isDevelopment,
      settings: Meteor.settings,
      connection: this.connection,
      email: request.devSignIn,
    });
    if (refusal) {
      return { error: new Meteor.Error(403, refusal) };
    }
    const user = Meteor.users.findOne({ username: request.devSignIn }, { fields: { _id: 1 } });
    if (!user) {
      return { error: new Meteor.Error(403, 'That development account has not been created yet. Restart the server on an empty database.') };
    }
    return { userId: user._id };
  });
}
