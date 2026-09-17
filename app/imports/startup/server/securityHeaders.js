import { Meteor } from 'meteor/meteor';
import { WebApp } from 'meteor/webapp';

/**
 * The response headers every page and asset goes out with.
 *
 * Nothing set any of these before. That left the app embeddable in anyone's
 * iframe — a page that frames the sign-in form and overlays it is the classic
 * clickjack — and left the browser free to guess at content types and to send
 * the full referring URL to every third party a listing links to.
 *
 * The Content-Security-Policy is deliberately `frame-ancestors` alone. Meteor
 * injects its runtime configuration into the page as an inline script, and a
 * policy with a `script-src` blocks that script and with it the whole client;
 * the app boots to a blank page. Hashing that script, or moving to nonces, is
 * its own piece of work for a later phase. `frame-ancestors` is the one
 * directive that is safe on its own, and it is the one that matters most.
 * `X-Frame-Options` says the same thing to browsers that predate it.
 *
 * Strict-Transport-Security is only sent when ROOT_URL says the site is https.
 * The header is a promise — that this hostname and every subdomain of it will
 * answer over TLS for the next year — and a browser that has heard it once
 * will not try plain http again until then. That is the right promise for the
 * production deployment and the wrong one for anything else, so the
 * deployment has to say so itself, and ROOT_URL is where it does.
 */
export const securityHeadersFor = ({ rootUrl } = {}) => {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
    // Geolocation is the one the app uses (the origin picker asks for it);
    // the rest are named so that a script that ends up on the page cannot.
    'Permissions-Policy': 'camera=(), microphone=(), payment=(), geolocation=(self)',
  };
  if (typeof rootUrl === 'string' && rootUrl.startsWith('https://')) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
};

// ROOT_URL is what Meteor itself reads to decide the site's address, so it is
// the authority on whether the site is https. It is fixed for the life of the
// process, so the set is computed once rather than on every request.
const rootUrl = process.env.ROOT_URL || Meteor.absoluteUrl.defaultOptions.rootUrl;
const HEADERS = Object.entries(securityHeadersFor({ rootUrl }));

// The RAW handlers, which run before Meteor's own static-asset and page
// handlers; the ordinary connectHandlers run after them, by which point the
// response for a static file has already been sent without us.
WebApp.rawConnectHandlers.use((req, res, next) => {
  HEADERS.forEach(([name, value]) => res.setHeader(name, value));
  next();
});
