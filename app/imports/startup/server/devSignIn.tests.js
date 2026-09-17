import { Meteor } from 'meteor/meteor';
import { assert } from 'chai';
import { devSignInRefusal } from './devSignIn';

/* eslint-env mocha */

const SETTINGS = {
  public: { devSignIn: ['john@foo.com', 'admin@foo.com'] },
  defaultAccounts: [
    { email: 'admin@foo.com', password: 'changeme', role: 'admin' },
    { email: 'john@foo.com', password: 'changeme' },
  ],
};

const local = { clientAddress: '127.0.0.1', httpHeaders: { host: 'localhost:3010' } };

const request = overrides => ({
  isDevelopment: true,
  settings: SETTINGS,
  connection: local,
  email: 'john@foo.com',
  ...overrides,
});

if (Meteor.isServer) {
  describe('development sign-in', function () {
    it('lets a seeded account in from this machine, in development', function () {
      assert.isNull(devSignInRefusal(request()));
      assert.isNull(devSignInRefusal(request({ email: 'admin@foo.com' })));
      ['::1', '::ffff:127.0.0.1'].forEach(clientAddress => {
        assert.isNull(devSignInRefusal(request({ connection: { ...local, clientAddress } })), clientAddress);
      });
    });

    it('does not exist outside development, whatever the settings say', function () {
      [false, undefined, 'true', 1].forEach(isDevelopment => {
        assert.match(devSignInRefusal(request({ isDevelopment })), /not available/, String(isDevelopment));
      });
    });

    it('is off unless the settings list the address', function () {
      [undefined, {}, { public: {} }, { ...SETTINGS, public: { devSignIn: true } }, { ...SETTINGS, public: { devSignIn: [] } }]
        .forEach(settings => assert.match(devSignInRefusal(request({ settings })), /not a development account/));
    });

    it('never reaches an account that was not seeded, even if it is listed', function () {
      const settings = { ...SETTINGS, public: { devSignIn: ['john@foo.com', 'someone@real.example'] } };
      assert.match(
        devSignInRefusal(request({ settings, email: 'someone@real.example' })),
        /not a development account/,
      );
    });

    it('refuses an address that is not a string', function () {
      [undefined, null, 7, { $ne: null }, ['john@foo.com']].forEach(email => {
        assert.match(devSignInRefusal(request({ email })), /not a development account/);
      });
    });

    it('answers only this machine', function () {
      ['10.0.0.8', '203.0.113.9', undefined, ''].forEach(clientAddress => {
        assert.match(
          devSignInRefusal(request({ connection: { ...local, clientAddress } })),
          /only answers this machine/,
          String(clientAddress),
        );
      });
      assert.match(devSignInRefusal(request({ connection: undefined })), /only answers this machine/);
    });

    it('accepts the hop Meteor\'s own development proxy adds', function () {
      // run-proxy.js forwards with xfwd: true, so EVERY development request
      // carries this header. Refusing the header outright refused everyone.
      ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.1, ::1'].forEach(chain => {
        const connection = { clientAddress: '127.0.0.1', httpHeaders: { 'x-forwarded-for': chain } };
        assert.isNull(devSignInRefusal(request({ connection })), chain);
      });
    });

    it('refuses a request any hop of which came from somewhere else', function () {
      // nginx on the same host connects from 127.0.0.1 for every visitor on
      // the internet, and says who they were in this header.
      [
        '203.0.113.9',
        '203.0.113.9, 127.0.0.1',
        // A visitor who sends a forged "127.0.0.1" still has their real
        // address appended by the first proxy that sees them.
        '127.0.0.1, 203.0.113.9',
        '127.0.0.1, 203.0.113.9, 127.0.0.1',
        'unknown',
      ].forEach(chain => {
        const connection = { clientAddress: '127.0.0.1', httpHeaders: { 'x-forwarded-for': chain } };
        assert.match(devSignInRefusal(request({ connection })), /only answers this machine/, chain);
      });
    });
  });
}
