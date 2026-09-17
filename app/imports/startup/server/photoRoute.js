import { WebApp } from 'meteor/webapp';
import { ListingPhotos, PHOTO_CONTENT_TYPES } from '../../api/photos/ListingPhotos';

/* eslint-disable no-console */

/**
 * GET /photo/<kind>/<ownerId> — an uploaded photo, as a file a browser can
 * cache.
 *
 * This is the other half of moving photos out of the documents (see
 * api/photos/ListingPhotos.js). A photo that arrived inside a DDP document
 * could not be cached by anything; one that arrives from a URL is fetched
 * once. The path a listing stores ends in `?v=<when the photo last changed>`,
 * so the address changes whenever the picture does, and that is what makes it
 * honest to call the response immutable and let the browser keep it for a
 * year. The same bytes asked for under any other address — no `v`, or an old
 * one — are sent `no-cache`, because for that address the promise is not
 * true: the next photo will answer to it as well.
 *
 * WHO CAN FETCH ONE: anybody who has the URL. That includes the photo of a
 * private group or a private event, and it is on purpose rather than by
 * oversight. Meteor signs people in over the websocket and keeps the token in
 * localStorage; there is no cookie, so the request an <img> makes carries
 * nothing that says who is asking, and there is nothing here to check it
 * against. What stands between a stranger and a private listing's photo is
 * that they cannot know its address: the _id in the path is seventeen random
 * characters that are only ever sent to people the publications allow to see
 * the listing. Somebody who was let in can pass the address on, exactly as
 * they could pass on the picture. So the photo is not the membership, and
 * nothing that must stay secret belongs in one. This route does not pretend
 * otherwise; it is unlisted, not access-controlled.
 *
 * What it is strict about is what it will send. Three image types and nothing
 * else, whatever a row claims about itself, and `nosniff` with them, so that
 * nothing stored here can ever be served as a page on the app's own origin.
 */

const PHOTO_URL = /^\/photo\/(event|club|profile)\/([A-Za-z0-9]{1,40})$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** A strong validator made of the two things that change when the photo does.
    Hashing the bytes would say no more and would mean decoding them to answer
    a request whose whole point is not to. */
const etagOf = photo => `"${photo.updatedAt.getTime().toString(36)}-${photo.bytes.toString(36)}"`;

/** If-None-Match is a list, may be `*`, and a cache may have marked our tag
    weak on the way. For a GET any of those is a match. */
const matchesEtag = (header, etag) => typeof header === 'string' && header.split(',')
  .map(candidate => candidate.trim().replace(/^W\//, ''))
  .some(candidate => candidate === '*' || candidate === etag);

const NOT_FOUND = { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not found' };

/**
 * The response for a request, as plain data: `null` when the URL is not this
 * route's at all, otherwise { status, headers, body }. Kept apart from the
 * handler so that every branch can be tested without a socket.
 *
 * A path under /photo/ that is not exactly a kind and a well-formed id is
 * answered 404 before the database is opened — the id goes into a query, and
 * nothing goes into a query that has not been looked at first.
 */
export const photoResponseFor = ({ method, url, headers = {} }) => {
  const [path, query = ''] = `${url}`.split('?');
  if (!path.startsWith('/photo/')) {
    return null;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, headers: { Allow: 'GET, HEAD' }, body: '' };
  }
  const match = PHOTO_URL.exec(path);
  if (!match) {
    return NOT_FOUND;
  }
  const selector = { kind: match[1], ownerId: match[2] };
  // Without the payload first: a browser checking a copy it already holds is
  // told so from a few dozen bytes, not from half a megabyte read to be
  // thrown away.
  const photo = ListingPhotos.collection.findOne(selector, { fields: { data: 0 } });
  if (!photo || !PHOTO_CONTENT_TYPES.includes(photo.contentType)) {
    return NOT_FOUND;
  }

  const etag = etagOf(photo);
  const current = query === `v=${photo.updatedAt.getTime()}`;
  const caching = { 'Cache-Control': current ? IMMUTABLE : 'no-cache', ETag: etag };
  if (matchesEtag(headers['if-none-match'], etag)) {
    return { status: 304, headers: caching, body: '' };
  }

  const stored = ListingPhotos.collection.findOne(selector, { fields: { data: 1 } });
  if (!stored) {
    return NOT_FOUND;
  }
  const body = Buffer.from(stored.data, 'base64');
  return {
    status: 200,
    headers: {
      ...caching,
      'Content-Type': photo.contentType,
      'Content-Length': body.length,
      'X-Content-Type-Options': 'nosniff',
    },
    body,
  };
};

WebApp.connectHandlers.use((req, res, next) => {
  let response;
  try {
    response = photoResponseFor({ method: req.method, url: req.url, headers: req.headers });
  } catch (error) {
    // Answered rather than thrown: an error that escapes a handler here ends
    // nothing, and the browser would wait on the image until it gave up.
    console.error('[photo] could not serve', `${req.url}`.split('?')[0], error.message);
    response = { status: 500, headers: {}, body: '' };
  }
  if (!response) {
    next();
    return;
  }
  res.writeHead(response.status, response.headers);
  res.end(req.method === 'HEAD' ? undefined : response.body);
});
