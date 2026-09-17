/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import http from 'http';
import { ListingPhotos } from '../../api/photos/ListingPhotos';
import { removePhoto, savePhoto } from '../../api/photos/photoStore';
import { photoResponseFor } from './photoRoute';

/**
 * Two layers, as with the security headers. photoResponseFor decides what to
 * answer and is asked directly, branch by branch; the requests at the end go
 * through the running server, because a route nobody installed serves
 * nothing — and importing the module above is what installs it here, since
 * `meteor test` never loads server/main.js.
 */

const request = (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const outgoing = http.request(Meteor.absoluteUrl(path.replace(/^\//, '')), { method, headers }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
  });
  outgoing.on('error', reject);
  outgoing.end();
});

if (Meteor.isServer) {
  describe('photo route', function () {
    const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 3)]);
    const jpeg = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;
    const get = (url, headers) => photoResponseFor({ method: 'GET', url, headers });

    beforeEach(function () {
      ListingPhotos.collection.remove({});
    });

    describe('what it answers', function () {
      it('sends the decoded bytes under the stored type, to be kept for a year', function () {
        const path = savePhoto({ kind: 'event', ownerId: 'abc123', dataUrl: jpeg });
        const response = get(path);
        assert.equal(response.status, 200);
        assert.isTrue(response.body.equals(JPEG_BYTES));
        assert.equal(response.headers['Content-Type'], 'image/jpeg');
        assert.equal(response.headers['Content-Length'], JPEG_BYTES.length);
        assert.equal(response.headers['Cache-Control'], 'public, max-age=31536000, immutable');
        assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
        assert.match(response.headers.ETag, /^"[a-z0-9]+-[a-z0-9]+"$/);
      });

      it('serves each kind from its own key', function () {
        ['event', 'club', 'profile'].forEach(kind => {
          assert.equal(get(savePhoto({ kind, ownerId: 'abc123', dataUrl: jpeg })).status, 200);
        });
        assert.equal(get('/photo/club/abc124').status, 404);
      });

      /**
       * "Immutable" is a promise about an address. It is true of the address
       * that carries the photo's own version, and of no other: the bare path,
       * or last month's version, will answer with the next photo too.
       */
      it('promises immutability only to the address that names this version', function () {
        const path = savePhoto({ kind: 'event', ownerId: 'abc123', dataUrl: jpeg });
        ['/photo/event/abc123', '/photo/event/abc123?v=1', `${path}&again=1`, '/photo/event/abc123?'].forEach(url => {
          const response = get(url);
          assert.equal(response.status, 200, url);
          assert.equal(response.headers['Cache-Control'], 'no-cache', url);
        });
      });

      it('gives a replaced photo a new validator', function () {
        const before = get(savePhoto({ kind: 'event', ownerId: 'abc123', dataUrl: jpeg })).headers.ETag;
        Meteor._sleepForMs(3);
        const after = get(savePhoto({ kind: 'event', ownerId: 'abc123', dataUrl: jpeg })).headers.ETag;
        assert.notEqual(before, after);
      });

      it('answers 304 to a browser that already holds this photo', function () {
        const path = savePhoto({ kind: 'event', ownerId: 'abc123', dataUrl: jpeg });
        const etag = get(path).headers.ETag;
        [etag, `W/${etag}`, `"something-else", ${etag}`, '*'].forEach(header => {
          const response = get(path, { 'if-none-match': header });
          assert.equal(response.status, 304, header);
          assert.equal(response.body, '');
          assert.equal(response.headers.ETag, etag);
          assert.equal(response.headers['Cache-Control'], 'public, max-age=31536000, immutable');
        });
        assert.equal(get(path, { 'if-none-match': '"something-else"' }).status, 200);
        assert.equal(get(path, { 'if-none-match': etag.replace(/"/g, '') }).status, 200, 'an unquoted tag is not ours');
      });

      it('does not read the payload to answer a 304', function () {
        const path = savePhoto({ kind: 'event', ownerId: 'abc123', dataUrl: jpeg });
        const etag = get(path).headers.ETag;
        const { findOne } = ListingPhotos.collection;
        const projections = [];
        ListingPhotos.collection.findOne = function watched(selector, options) {
          projections.push(options?.fields);
          return findOne.call(this, selector, options);
        };
        try {
          get(path, { 'if-none-match': etag });
        } finally {
          ListingPhotos.collection.findOne = findOne;
        }
        assert.deepEqual(projections, [{ data: 0 }]);
      });

      it('answers 404 for a photo that is not there, or no longer there', function () {
        assert.equal(get('/photo/event/abc123?v=1').status, 404);
        const path = savePhoto({ kind: 'event', ownerId: 'abc123', dataUrl: jpeg });
        removePhoto({ kind: 'event', ownerId: 'abc123' });
        assert.equal(get(path).status, 404);
      });

      /**
       * The id goes into a query, so nothing reaches the query that has not
       * been looked at. The database is made to fail loudly for the length of
       * the test: a 404 here is one that never opened it.
       */
      it('answers 404 to a bad kind or a badly shaped id without opening the database', function () {
        savePhoto({ kind: 'event', ownerId: 'abc123', dataUrl: jpeg });
        const { findOne } = ListingPhotos.collection;
        ListingPhotos.collection.findOne = () => { throw new Error('the database was opened'); };
        try {
          [
            '/photo/poster/abc123',
            '/photo/Event/abc123',
            '/photo/event/',
            '/photo/event',
            '/photo/',
            '/photo/event/abc-123',
            '/photo/event/abc%31%32%33',
            '/photo/event/abc123/',
            '/photo/event/abc123/extra',
            '/photo/event/../event/abc123',
            '/photo/event/abc123.jpg',
            `/photo/event/${'a'.repeat(41)}`,
            '/photo/event/$ne',
            '/photo//abc123',
          ].forEach(url => assert.equal(get(url).status, 404, url));
        } finally {
          ListingPhotos.collection.findOne = findOne;
        }
      });

      /**
       * The schema only lets the three image types in, but a row can be
       * written around a schema. Served as text/html from the app's own
       * origin, a stored payload would be a page with the run of the site.
       */
      it('never serves a row that claims to be anything but one of the three image types', function () {
        ['text/html', 'image/svg+xml', 'application/javascript', 'image/jpeg; charset=x', undefined].forEach((contentType, i) => {
          ListingPhotos.collection.insert({
            kind: 'event',
            ownerId: `forged${i}`,
            contentType,
            data: Buffer.from('<script>alert(1)</script>').toString('base64'),
            bytes: 25,
            updatedAt: new Date(),
          }, { bypassCollection2: true });
          assert.equal(get(`/photo/event/forged${i}`).status, 404, `${contentType}`);
        });
      });

      it('is a route for reading, and says so', function () {
        const path = savePhoto({ kind: 'event', ownerId: 'abc123', dataUrl: jpeg });
        ['POST', 'PUT', 'DELETE', 'PATCH'].forEach(method => {
          const response = photoResponseFor({ method, url: path });
          assert.equal(response.status, 405, method);
          assert.equal(response.headers.Allow, 'GET, HEAD');
        });
        assert.equal(photoResponseFor({ method: 'HEAD', url: path }).status, 200);
      });

      it('leaves every other address to the rest of the app', function () {
        ['/', '/photo', '/photos/event/abc123', '/images/codingWorkshop.png', '/manage/group/abc123', '/x/photo/event/abc123'].forEach(url => {
          assert.isNull(get(url), url);
        });
      });
    });

    describe('on the running server', function () {
      it('serves a photo with its headers, and a photo-sized one whole', async function () {
        const large = Buffer.concat([JPEG_BYTES, Buffer.alloc(400000, 5)]);
        const path = savePhoto({ kind: 'club', ownerId: 'served1', dataUrl: `data:image/jpeg;base64,${large.toString('base64')}` });
        const response = await request(path);
        assert.equal(response.status, 200);
        assert.isTrue(response.body.equals(large));
        assert.equal(response.headers['content-type'], 'image/jpeg');
        assert.equal(response.headers['content-length'], `${large.length}`);
        assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
        assert.equal(response.headers['x-content-type-options'], 'nosniff');
        assert.isString(response.headers.etag);
      });

      it('answers a conditional request with 304 and no body', async function () {
        const path = savePhoto({ kind: 'event', ownerId: 'served2', dataUrl: jpeg });
        const { headers } = await request(path);
        const again = await request(path, { headers: { 'If-None-Match': headers.etag } });
        assert.equal(again.status, 304);
        assert.lengthOf(again.body, 0);
        assert.equal(again.headers.etag, headers.etag);
      });

      it('answers HEAD with the headers and no body', async function () {
        const path = savePhoto({ kind: 'profile', ownerId: 'served3', dataUrl: jpeg });
        const response = await request(path, { method: 'HEAD' });
        assert.equal(response.status, 200);
        assert.equal(response.headers['content-length'], `${JPEG_BYTES.length}`);
        assert.lengthOf(response.body, 0);
      });

      it('answers 404 rather than the app’s page for an unknown id, a bad kind and a bad id', async function () {
        const responses = await Promise.all(['/photo/event/nobody1', '/photo/poster/served1', '/photo/event/not-an-id'].map(path => request(path)));
        responses.forEach(response => {
          assert.equal(response.status, 404);
          assert.notInclude(response.body.toString(), '<html', 'not the single-page app answering for it');
        });
      });

      it('answers 405 to a write', async function () {
        const response = await request('/photo/event/served2', { method: 'POST' });
        assert.equal(response.status, 405);
      });
    });
  });
}
