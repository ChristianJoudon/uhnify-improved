/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import http from 'http';
import { securityHeadersFor } from './securityHeaders';

/**
 * Two layers, tested separately. The pure function decides WHAT to send; the
 * request at the end proves the handler is actually installed, because a
 * header set in a function nobody wired up protects nothing — which is the
 * state the app was in before this file existed.
 */

/** The headers of a GET against the running test server, lower-cased by Node. */
const headersOf = url => new Promise((resolve, reject) => {
  http.get(url, response => {
    response.resume();
    resolve(response.headers);
  }).on('error', reject);
});

if (Meteor.isServer) {
  describe('security headers', function () {
    it('sends the always-on set for a plain http root', function () {
      const headers = securityHeadersFor({ rootUrl: 'http://localhost:3010' });
      assert.equal(headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
      assert.equal(headers['X-Frame-Options'], 'DENY');
      assert.equal(headers['Content-Security-Policy'], "frame-ancestors 'none'");
      assert.equal(headers['Permissions-Policy'], 'camera=(), microphone=(), payment=(), geolocation=(self)');
    });

    it('withholds Strict-Transport-Security from a plain http root', function () {
      // Absent, not undefined: the installer sets every entry it is handed,
      // and setHeader with an undefined value throws.
      assert.notProperty(securityHeadersFor({ rootUrl: 'http://localhost:3010' }), 'Strict-Transport-Security');
      assert.notProperty(securityHeadersFor({}), 'Strict-Transport-Security');
      assert.notProperty(securityHeadersFor({ rootUrl: undefined }), 'Strict-Transport-Security');
    });

    it('adds a year of Strict-Transport-Security for an https root', function () {
      const headers = securityHeadersFor({ rootUrl: 'https://matchbook.example' });
      assert.equal(headers['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
      // The rest of the set is unchanged by the scheme.
      assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    });

    it('is installed on the running server', async function () {
      const headers = await headersOf(Meteor.absoluteUrl());
      assert.equal(headers['x-content-type-options'], 'nosniff');
      assert.equal(headers['x-frame-options'], 'DENY');
      assert.equal(headers['content-security-policy'], "frame-ancestors 'none'");
      // The test server is plain http, so the strict-transport header must
      // not have leaked into a localhost response.
      assert.notProperty(headers, 'strict-transport-security');
    });
  });
}
