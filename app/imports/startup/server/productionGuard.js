import { Meteor } from 'meteor/meteor';

/* eslint-disable no-console */

/**
 * Refuse to run production on the development secrets.
 *
 * This repository is public, and so is config/settings.development.json: it
 * creates admin@foo.com with the password "changeme" and gives it the admin
 * role. Accounts.js creates every `defaultAccounts` entry whenever the users
 * collection is empty — which is exactly the state of a fresh production
 * database — so a deployment that reuses the development file, or the sample
 * file unchanged, comes up with an administrator whose password is on GitHub.
 * Until this file, nothing stood between that and the first visitor to try it.
 *
 * So the settings are checked at load and, in production, a bad file is fatal.
 * That is on purpose. A server that does not start is an outage somebody
 * notices within minutes and fixes by editing one file; a server that starts
 * with a published admin password is a breach nobody notices until it has been
 * used. The rules are few and literal rather than clever, so that what gets
 * refused is exactly what the message says.
 *
 * It has to be the FIRST import in server/main.js. Imported after Accounts.js,
 * the accounts have already been created by the time this throws, and the
 * database now holds the very credentials this exists to keep out of it.
 *
 * In development the same findings are printed as warnings, in the same words,
 * so the file gets fixed before deploy day instead of being found by a refused
 * start. The two rule functions and the enforcer that reacts to them are pure
 * and exported so the tests can feed them settings objects, and a stub log,
 * without touching Meteor.settings or Meteor.isProduction.
 */

const MIN_PASSWORD_LENGTH = 12;

/**
 * Passwords this repository's settings files have shipped with, plus the few
 * everyone tries first. Compared case-insensitively, and an account's own
 * address and local part count as members too. Length is no defence against
 * this list: the sample file's placeholder is thirty-five characters long and
 * is refused all the same, because it is in a public repository.
 */
const DENIED_PASSWORDS = [
  'changeme',
  'password',
  'admin',
  'letmein',
  '12345678',
  'replace-with-a-long-random-password',
];

/** Domains nobody deploying this app can receive mail at: the development
    file's, and the reserved documentation ones the sample file uses. */
const PLACEHOLDER_DOMAINS = ['foo.com', 'example.com'];
const PLACEHOLDER_SUFFIXES = ['.example'];

/** What the sample file ships as the monitoring secret now, and what it shipped
    before. An agent reporting under either is reporting to somebody else. */
const PLACEHOLDER_SECRETS = ['changeme', 'replace-me'];

const text = value => (value === undefined || value === null ? '' : String(value));

/** [local part, domain], both lowercased; the domain is '' when there is no @. */
const splitAddress = email => {
  const address = text(email).toLowerCase();
  const at = address.lastIndexOf('@');
  return at === -1 ? [address, ''] : [address.slice(0, at), address.slice(at + 1)];
};

const isPlaceholderDomain = domain => PLACEHOLDER_DOMAINS.includes(domain)
  || PLACEHOLDER_SUFFIXES.some(suffix => domain.endsWith(suffix));

const passwordProblem = (password, email) => {
  const raw = text(password);
  const candidate = raw.toLowerCase();
  const [localPart] = splitAddress(email);
  const isOwnAddress = candidate !== '' && (candidate === text(email).toLowerCase() || candidate === localPart);
  if (DENIED_PASSWORDS.includes(candidate) || isOwnAddress) {
    return 'the password is one everyone tries first';
  }
  if (raw.length < MIN_PASSWORD_LENGTH) {
    return `the password is ${raw.length} characters long (the minimum is ${MIN_PASSWORD_LENGTH})`;
  }
  return null;
};

/**
 * One sentence per account rather than one per rule, so a file with two bad
 * accounts reads as two things to fix and each sentence says all of what is
 * wrong with that one.
 */
const accountProblem = (account, index) => {
  const { email, password } = account || {};
  const reasons = [];
  const weak = passwordProblem(password, email);
  if (weak) {
    reasons.push(weak);
  }
  const [, domain] = splitAddress(email);
  if (isPlaceholderDomain(domain)) {
    reasons.push(`the address is at ${domain}, which is a placeholder domain`);
  }
  return reasons.length ? `defaultAccounts[${index}] (${email || 'no email'}): ${reasons.join(', and ')}.` : null;
};

/** The monitoring agent takes its key from either settings block or either
    environment pair, so all four places are checked. */
const monitoringSecrets = (settings, env) => [
  ['monti.appSecret', settings.monti?.appSecret],
  ['kadira.appSecret', settings.kadira?.appSecret],
  ['MONTI_APP_SECRET', env.MONTI_APP_SECRET],
  ['KADIRA_APP_SECRET', env.KADIRA_APP_SECRET],
];

/**
 * Everything production must refuse, as sentences an operator can act on.
 *
 * The list is the same in every mode; whether it is fatal is the loader's
 * decision at the bottom of this file, not this function's.
 */
export const settingsProblems = (settings, { env = {} } = {}) => {
  const config = settings || {};
  const environment = env || {};
  const accounts = Array.isArray(config.defaultAccounts) ? config.defaultAccounts : [];
  const problems = accounts.map(accountProblem).filter(Boolean);

  if (config.public?.communityIngestionSandbox) {
    problems.push('public.communityIngestionSandbox is on. That is the local ingestion sandbox, a development switch, and anything under public is sent to every browser.');
  }

  monitoringSecrets(config, environment).forEach(([name, secret]) => {
    if (PLACEHOLDER_SECRETS.includes(text(secret).toLowerCase())) {
      problems.push(`${name} is the placeholder "${secret}", not a key from the monitoring dashboard.`);
    }
  });

  return problems;
};

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const isLocalUrl = url => {
  try {
    return LOCAL_HOSTS.includes(new URL(url).hostname);
  } catch (error) {
    return false;
  }
};

/**
 * Things a deployment is worse off without but can run without, so they are
 * said once and not enforced. Mail is the important one: until a transport is
 * configured, "forgot your password" is a dead end, and Meteor prints the
 * message it would have sent into this log instead. Plain http is exempt on
 * localhost, which only ever this machine can reach.
 */
export const settingsWarnings = (settings, { env = {} } = {}) => {
  const config = settings || {};
  const environment = env || {};
  const warnings = [];

  if (!environment.MAIL_URL && !config.packages?.email) {
    warnings.push('No mail transport is configured (MAIL_URL is unset and settings.packages.email is absent), so password reset and address verification cannot send; Meteor prints those emails here instead.');
  }

  const rootUrl = environment.ROOT_URL;
  if (!rootUrl) {
    warnings.push('ROOT_URL is unset, so links in email cannot be built.');
  } else if (!rootUrl.startsWith('https://') && !isLocalUrl(rootUrl)) {
    warnings.push(`ROOT_URL is ${rootUrl}, not https://, so sign-ins and session tokens travel in the clear.`);
  }

  return warnings;
};

/**
 * The reaction to the two lists. It is a function, not module-level code,
 * because the throw is the whole point of this file and a throw at import
 * time cannot be exercised by a test: the call at the bottom hands it the
 * real settings, the tests hand it their own and a stub log, and the branch
 * that refuses production gets proven rather than trusted. Returns the
 * problems so a caller can act on them without reading the log back.
 */
export const enforceSettings = (settings, { isProduction = false, env = {}, log = console } = {}) => {
  const problems = settingsProblems(settings, { env });
  settingsWarnings(settings, { env }).forEach(warning => log.warn(`[settings] ${warning}`));

  if (isProduction && problems.length) {
    problems.forEach(problem => log.error(`[settings] refusing to start: ${problem}`));
    // Thrown, not logged and carried past, on purpose. Of the two ways this can
    // go wrong, a server that will not start is the one that gets noticed and
    // fixed; a server running with a published admin password is the one that
    // gets used. Fail closed.
    throw new Error('Production settings are unsafe; see the lines above.');
  }

  // The same findings in the same words, as warnings, so the developer sees
  // exactly what production would refuse.
  problems.forEach(problem => log.warn(`[settings] production would refuse to start: ${problem}`));
  return problems;
};

// Once, when the module loads, and never per request.
enforceSettings(Meteor.settings, { isProduction: Meteor.isProduction, env: process.env });
