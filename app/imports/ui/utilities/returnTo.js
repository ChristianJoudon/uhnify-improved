/**
 * Where a person was going when the app asked them to sign in first.
 *
 * Signing in always landed on the front page. That was survivable while every
 * protected page was one tap from the nav, and stopped being so with invite
 * links: somebody sent `/join/<token>` who has no account yet is bounced to
 * sign-in, makes one, and is dropped on the home page holding nothing — the
 * link was the only way into a private group, and it is gone from the address
 * bar. So the route guard writes the path down before it redirects, and the
 * two doors (sign in, sign up) go there afterwards.
 *
 * sessionStorage, not a query string and not localStorage. An invite token is
 * a capability, and a `?next=` would put it in the address of the sign-in
 * page, its history entry and any screenshot of it. And it should not outlive
 * the tab: a path remembered last week has no business deciding where a fresh
 * sign-in goes today.
 */
const STORAGE_KEY = 'mb.returnTo';

/** Longer than any route this app has, shorter than anything worth storing. */
const PATH_MAX = 512;

/** Returning to a door would leave the person looking at the form they just
    filled in — or, for sign-out, undo the sign-in on arrival. */
const DOORS = ['/signin', '/signup', '/signout'];

/**
 * The path, if it is one this app may send somebody to; otherwise ''.
 *
 * Only ever a path on this origin. The value is read back out of storage that
 * any script on the page can write, and handed to a navigation, so it is
 * treated as untrusted: it must start with exactly one '/', because '//host'
 * is another site written without its scheme, and it must survive being parsed
 * as a URL without acquiring a host — browsers read '\' as '/', which is how
 * '/\host' gets past a test that only looks at the first two characters.
 */
export const safeReturnPath = value => {
  if (typeof value !== 'string' || value.length > PATH_MAX || !value.startsWith('/') || value.startsWith('//')) {
    return '';
  }
  const base = 'http://return.invalid';
  let parsed;
  try {
    parsed = new URL(value, base);
  } catch (error) {
    return '';
  }
  if (parsed.origin !== base || value.includes('\\')) {
    return '';
  }
  const door = DOORS.some(path => parsed.pathname === path || parsed.pathname.startsWith(`${path}/`));
  return door ? '' : `${parsed.pathname}${parsed.search}${parsed.hash}`;
};

// Storage can be missing or refuse (a locked-down browser, a full quota). The
// worst that follows is the old behaviour — landing on the front page — so a
// failure here is never worth showing anyone.
const storage = () => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch (error) {
    return null;
  }
};

/** Written by the route guard on its way to the sign-in page. */
export const rememberReturnTo = path => {
  const safe = safeReturnPath(path);
  const store = storage();
  if (!safe || !store) {
    return;
  }
  try {
    store.setItem(STORAGE_KEY, safe);
  } catch (error) {
    // See `storage`.
  }
};

/**
 * Read once and forgotten. Taken rather than peeked at, so the path is used
 * for the sign-in it was remembered for and cannot redirect a later one.
 * Checked again on the way out: what was safe to write is not proof of what
 * is there to read.
 */
export const takeReturnTo = () => {
  const store = storage();
  if (!store) {
    return '';
  }
  try {
    const value = store.getItem(STORAGE_KEY);
    store.removeItem(STORAGE_KEY);
    return safeReturnPath(value);
  } catch (error) {
    return '';
  }
};
