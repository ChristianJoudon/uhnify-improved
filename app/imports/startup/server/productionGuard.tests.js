/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { enforceSettings, settingsProblems, settingsWarnings } from './productionGuard';

/**
 * These feed the rule functions and the enforcer settings objects of their
 * own, and the enforcer a stub log, and never touch Meteor.settings or
 * Meteor.isProduction: other suites read the former and one of them (the
 * ingestion review suite) toggles and restores it. The guard itself already
 * ran once when this file imported it, against the development file, and only
 * warned — had it thrown, this file would not have loaded at all.
 */

/** A production-shaped file that passes every rule, to break one thing at a
    time from. */
const SAFE = {
  defaultAccounts: [
    { email: 'admin@matchbook.kauai', password: 'correct-horse-battery-staple-9', role: 'admin' },
  ],
};

const ENV = {
  MAIL_URL: 'smtp://user:pass@smtp.matchbook.kauai:587',
  ROOT_URL: 'https://matchbook.kauai',
};

const withAccount = overrides => ({
  ...SAFE,
  defaultAccounts: [{ ...SAFE.defaultAccounts[0], ...overrides }],
});

/** Collects what the enforcer would have printed, so a test reads the lines
    back instead of scraping the suite's own output. */
const stubLog = () => {
  const lines = { warn: [], error: [] };
  return {
    lines,
    warn: line => lines.warn.push(line),
    error: line => lines.error.push(line),
  };
};

/**
 * The parts of config/settings.development.json these rules look at, copied
 * rather than imported: that file sits outside app/ and is not on the build
 * path under `meteor test`. The last test in this file checks the copy against
 * the settings the suite was actually started with — package.json's test
 * script and CI both take those from that same file — so the copy cannot
 * drift without a test saying so.
 */
const DEVELOPMENT_SETTINGS = {
  public: { communityIngestionSandbox: true, devSignIn: ['john@foo.com', 'admin@foo.com'] },
  defaultAccounts: [
    { email: 'admin@foo.com', password: 'changeme', role: 'admin' },
    { email: 'john@foo.com', password: 'changeme' },
  ],
};

/** app/.deploy/settings.sample.json, likewise: what a deployment that copied
    it and changed nothing would hand the guard. */
const SAMPLE_SETTINGS = {
  monti: { appId: 'REPLACE-ME', appSecret: 'REPLACE-ME' },
  defaultAccounts: [
    { email: 'admin@your-domain.example', password: 'REPLACE-WITH-A-LONG-RANDOM-PASSWORD', role: 'admin' },
    { email: 'member@your-domain.example', password: 'REPLACE-WITH-A-LONG-RANDOM-PASSWORD' },
  ],
};

if (Meteor.isServer) {
  describe('production settings guard', function () {
    describe('problems', function () {
      it('accepts a file with long random passwords at its own domain', function () {
        assert.deepEqual(settingsProblems(SAFE, { env: ENV }), []);
      });

      it('has nothing to say about an empty or absent settings object', function () {
        assert.deepEqual(settingsProblems(undefined), []);
        assert.deepEqual(settingsProblems({}), []);
        assert.deepEqual(settingsProblems({ defaultAccounts: [] }, { env: {} }), []);
      });

      it('refuses the development file for exactly its four problems', function () {
        const problems = settingsProblems(DEVELOPMENT_SETTINGS, { env: {} });

        assert.lengthOf(problems, 4);
        assert.include(problems[0], 'defaultAccounts[0] (admin@foo.com)');
        assert.include(problems[0], 'the password is one everyone tries first');
        assert.include(problems[0], 'foo.com, which is a placeholder domain');
        assert.include(problems[1], 'defaultAccounts[1] (john@foo.com)');
        assert.include(problems[2], 'public.communityIngestionSandbox is on');
        assert.include(problems[3], 'public.devSignIn is on');
      });

      it('refuses the development sign-in in any form, and says nothing when it is absent', function () {
        [['john@foo.com'], true, 'yes', []].forEach(value => {
          const problems = settingsProblems({ ...SAFE, public: { devSignIn: value } });
          // An empty list is truthy in JavaScript, and that is the right answer
          // here: the key itself is what does not belong.
          assert.lengthOf(problems, 1, JSON.stringify(value));
          assert.include(problems[0], 'public.devSignIn is on', JSON.stringify(value));
        });
        [undefined, null, false, 0, ''].forEach(value => {
          assert.deepEqual(settingsProblems({ ...SAFE, public: { devSignIn: value } }), [], String(value));
        });
      });

      it('refuses the sample file deployed without being edited', function () {
        const problems = settingsProblems(SAMPLE_SETTINGS, { env: {} });

        assert.lengthOf(problems, 3);
        assert.include(problems[0], 'admin@your-domain.example');
        assert.include(problems[0], 'the password is one everyone tries first');
        assert.include(problems[0], 'your-domain.example, which is a placeholder domain');
        assert.include(problems[1], 'member@your-domain.example');
        assert.include(problems[2], 'monti.appSecret is the placeholder "REPLACE-ME"');
      });

      it('names both faults of one account in one sentence', function () {
        const problems = settingsProblems(withAccount({ email: 'kai@foo.com', password: 'short' }));

        assert.lengthOf(problems, 1);
        assert.include(problems[0], 'the password is 5 characters long (the minimum is 12), and the address is at foo.com');
      });

      it('refuses a password shorter than twelve characters and accepts one of twelve', function () {
        const eleven = settingsProblems(withAccount({ password: 'k3fj8Qw2pLm' }));
        assert.lengthOf(eleven, 1);
        assert.include(eleven[0], 'the password is 11 characters long (the minimum is 12)');

        assert.deepEqual(settingsProblems(withAccount({ password: 'k3fj8Qw2pLmZ' })), []);
      });

      it('treats a missing password as an empty one', function () {
        const problems = settingsProblems(withAccount({ password: undefined }));

        assert.lengthOf(problems, 1);
        assert.include(problems[0], 'the password is 0 characters long');
      });

      it('refuses every password on the denylist, whatever its case or length', function () {
        [
          'changeme', 'password', 'admin', 'letmein', '12345678',
          'ChangeMe', 'PASSWORD', 'REPLACE-WITH-A-LONG-RANDOM-PASSWORD',
        ].forEach(password => {
          const problems = settingsProblems(withAccount({ password }));
          assert.lengthOf(problems, 1, password);
          assert.include(problems[0], 'the password is one everyone tries first', password);
        });
      });

      it('refuses the account\'s own address or local part as its password, even when long', function () {
        const email = 'operations-team-lead@matchbook.kauai';

        [email, 'Operations-Team-Lead@matchbook.kauai', 'operations-team-lead', 'OPERATIONS-TEAM-LEAD'].forEach(password => {
          const problems = settingsProblems(withAccount({ email, password }));
          assert.lengthOf(problems, 1, password);
          assert.include(problems[0], 'the password is one everyone tries first', password);
        });
      });

      it('refuses a placeholder domain however strong the password', function () {
        ['kai@foo.com', 'kai@example.com', 'KAI@Example.COM', 'kai@your-domain.example', 'kai@anything.example'].forEach(email => {
          const problems = settingsProblems(withAccount({ email }));
          assert.lengthOf(problems, 1, email);
          assert.include(problems[0], 'which is a placeholder domain', email);
          assert.notInclude(problems[0], 'password', email);
        });
      });

      it('does not mistake a real domain that merely contains a placeholder for one', function () {
        assert.deepEqual(settingsProblems(withAccount({ email: 'kai@foo.community' })), []);
        assert.deepEqual(settingsProblems(withAccount({ email: 'kai@example.coop' })), []);
      });

      it('refuses the ingestion sandbox switch in any truthy form and ignores it otherwise', function () {
        [true, 'true', 1].forEach(value => {
          const problems = settingsProblems({ ...SAFE, public: { communityIngestionSandbox: value } });
          assert.lengthOf(problems, 1, String(value));
          assert.include(problems[0], 'public.communityIngestionSandbox is on', String(value));
        });

        [false, 0, undefined].forEach(value => {
          assert.deepEqual(settingsProblems({ ...SAFE, public: { communityIngestionSandbox: value } }), [], String(value));
        });
        assert.deepEqual(settingsProblems({ ...SAFE, public: {} }), []);
      });

      it('refuses a placeholder monitoring secret wherever the agent would read it', function () {
        const settingsCases = [
          ['monti.appSecret', { ...SAFE, monti: { appId: 'abc123', appSecret: 'changeme' } }],
          ['kadira.appSecret', { ...SAFE, kadira: { appId: 'abc123', appSecret: 'REPLACE-ME' } }],
        ];
        settingsCases.forEach(([name, settings]) => {
          const problems = settingsProblems(settings, { env: {} });
          assert.lengthOf(problems, 1, name);
          assert.include(problems[0], `${name} is the placeholder`, name);
        });

        ['MONTI_APP_SECRET', 'KADIRA_APP_SECRET'].forEach(name => {
          const problems = settingsProblems(SAFE, { env: { [name]: 'changeme' } });
          assert.lengthOf(problems, 1, name);
          assert.include(problems[0], `${name} is the placeholder "changeme"`, name);
        });

        assert.deepEqual(settingsProblems({ ...SAFE, monti: { appId: 'abc123', appSecret: 'f3a9c1e7b2d84f6a' } }, { env: {} }), []);
      });
    });

    describe('warnings', function () {
      it('is quiet when mail and https are both configured', function () {
        assert.deepEqual(settingsWarnings(SAFE, { env: ENV }), []);
      });

      it('warns when no mail transport is configured by either route', function () {
        const { MAIL_URL, ...withoutMail } = ENV;
        const warnings = settingsWarnings(SAFE, { env: withoutMail });

        assert.lengthOf(warnings, 1);
        assert.include(warnings[0], 'MAIL_URL is unset');
        assert.include(warnings[0], 'password reset');

        const viaSettings = { ...SAFE, packages: { email: { service: 'Mailgun', user: 'postmaster', password: 'not-checked-here' } } };
        assert.deepEqual(settingsWarnings(viaSettings, { env: withoutMail }), []);
      });

      it('warns about a missing, plain-http or malformed ROOT_URL, but not on localhost', function () {
        const { ROOT_URL, ...withoutRoot } = ENV;

        const unset = settingsWarnings(SAFE, { env: withoutRoot });
        assert.lengthOf(unset, 1);
        assert.include(unset[0], 'ROOT_URL is unset');

        ['http://matchbook.kauai', 'not a url'].forEach(rootUrl => {
          const warnings = settingsWarnings(SAFE, { env: { ...ENV, ROOT_URL: rootUrl } });
          assert.lengthOf(warnings, 1, rootUrl);
          assert.include(warnings[0], `ROOT_URL is ${rootUrl}, not https://`, rootUrl);
        });

        ['http://localhost:3010/', 'http://127.0.0.1:3010', 'http://[::1]:3010/'].forEach(rootUrl => {
          assert.deepEqual(settingsWarnings(SAFE, { env: { ...ENV, ROOT_URL: rootUrl } }), [], rootUrl);
        });
      });

      it('keeps warnings out of the problems list, so they can never refuse a start', function () {
        assert.deepEqual(settingsProblems(SAFE, { env: {} }), []);
      });
    });

    describe('enforcement', function () {
      it('refuses to start production on the development file, naming each problem first', function () {
        const log = stubLog();

        assert.throws(
          () => enforceSettings(DEVELOPMENT_SETTINGS, { isProduction: true, env: ENV, log }),
          /Production settings are unsafe/,
        );
        assert.lengthOf(log.lines.error, 4);
        log.lines.error.forEach(line => assert.match(line, /^\[settings\] refusing to start: /));
        assert.include(log.lines.error[0], 'admin@foo.com');
        assert.include(log.lines.error[1], 'john@foo.com');
        assert.include(log.lines.error[2], 'public.communityIngestionSandbox is on');
        assert.include(log.lines.error[3], 'public.devSignIn is on');
        assert.deepEqual(log.lines.warn, [], 'nothing is softened to a warning in production');
      });

      it('only warns about the same problems, in the same words, outside production', function () {
        const log = stubLog();
        let problems;

        assert.doesNotThrow(() => {
          problems = enforceSettings(DEVELOPMENT_SETTINGS, { isProduction: false, env: ENV, log });
        });
        assert.lengthOf(problems, 4);
        assert.deepEqual(log.lines.error, []);
        assert.lengthOf(log.lines.warn, 4);
        log.lines.warn.forEach((line, index) => {
          assert.equal(line, `[settings] production would refuse to start: ${problems[index]}`);
        });
      });

      it('starts production on a safe file without a word', function () {
        const log = stubLog();

        assert.deepEqual(enforceSettings(SAFE, { isProduction: true, env: ENV, log }), []);
        assert.deepEqual(log.lines.error, []);
        assert.deepEqual(log.lines.warn, []);
      });

      it('prints warnings under the same prefix in either mode, and they never refuse a start', function () {
        [true, false].forEach(isProduction => {
          const log = stubLog();
          const mode = `isProduction: ${isProduction}`;

          assert.deepEqual(enforceSettings(SAFE, { isProduction, env: {}, log }), [], mode);
          assert.deepEqual(log.lines.error, [], mode);
          assert.lengthOf(log.lines.warn, 2, mode);
          assert.include(log.lines.warn[0], '[settings] No mail transport is configured', mode);
          assert.include(log.lines.warn[1], '[settings] ROOT_URL is unset', mode);
        });
      });
    });

    describe('the copy of the development file above', function () {
      it('matches the settings this suite was started with', function () {
        assert.deepEqual(
          Meteor.settings.defaultAccounts,
          DEVELOPMENT_SETTINGS.defaultAccounts,
          'config/settings.development.json and DEVELOPMENT_SETTINGS in this test have drifted apart; update the copy so the guard is tested against what the file really says',
        );
        assert.deepEqual(
          Meteor.settings.public?.devSignIn,
          DEVELOPMENT_SETTINGS.public.devSignIn,
          'public.devSignIn in config/settings.development.json and in this test have drifted apart',
        );
      });
    });
  });
}
