/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import {
  IMAGE_DATA_URL_MAX,
  IMAGE_URL_MAX,
  PHOTO_KINDS,
  imageProblem,
  isPhotoPath,
  parsePhotoPath,
  photoPathFor,
  splitImageDataUrl,
} from './limits';

/**
 * What may be stored as a listing's image, decided from the bytes.
 *
 * The check this replaced looked at the first few characters of the string,
 * which is the part an uploader writes. These tests build their payloads from
 * real file headers so that a label and its bytes can be made to disagree —
 * the case that matters, and the one the old check could not see.
 */
if (Meteor.isServer) {
  describe('image check', function () {
    const JPEG = [0xff, 0xd8, 0xff, 0xe0];
    const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const WEBP = [...Buffer.from('RIFF'), 0x24, 0x00, 0x00, 0x00, ...Buffer.from('WEBP')];
    const dataUrl = (type, header) => `data:image/${type};base64,${Buffer.concat([Buffer.from(header), Buffer.alloc(64)]).toString('base64')}`;

    it('accepts a JPEG, PNG or WebP whose bytes say so', function () {
      assert.isNull(imageProblem(dataUrl('jpeg', JPEG)));
      assert.isNull(imageProblem(dataUrl('png', PNG)));
      assert.isNull(imageProblem(dataUrl('webp', WEBP)));
    });

    it('refuses a label the bytes contradict', function () {
      assert.equal(imageProblem(dataUrl('jpeg', PNG)), 'invalid-image', 'PNG bytes under a JPEG label');
      assert.equal(imageProblem(dataUrl('png', JPEG)), 'invalid-image', 'JPEG bytes under a PNG label');
      assert.equal(imageProblem(dataUrl('webp', [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE')])), 'invalid-image', 'a RIFF that is not WebP');
      assert.equal(imageProblem('data:image/jpeg;base64,/9'), 'invalid-image', 'too short to carry a header');
    });

    it('refuses a payload that is not an image at all', function () {
      assert.equal(imageProblem(`data:text/html;base64,${Buffer.from('<script>1</script>').toString('base64')}`), 'invalid-image');
      assert.equal(imageProblem('data:image/gif;base64,R0lGODlhAQABAAAAACw='), 'invalid-image', 'GIF is not one of the three');
      assert.equal(imageProblem('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), 'invalid-image', 'SVG can carry script');
    });

    it('refuses a plain-http link and a link long enough to be a payload', function () {
      assert.equal(imageProblem('http://example.com/photo.jpg'), 'invalid-image');
      assert.equal(imageProblem(`https://example.com/${'a'.repeat(IMAGE_URL_MAX)}`), 'invalid-image');
      assert.equal(imageProblem('images/photo.png'), 'invalid-image', 'only the absolute app path is known');
    });

    it('accepts an https link and one of the app’s own images', function () {
      assert.isNull(imageProblem('https://example.com/photo.jpg'));
      assert.isNull(imageProblem('/images/x.png'));
    });

    it('holds a photo to the size ceiling', function () {
      const photo = dataUrl('jpeg', JPEG);
      assert.isNull(imageProblem(photo.padEnd(IMAGE_DATA_URL_MAX, 'A')), 'exactly at the ceiling');
      assert.equal(imageProblem(photo.padEnd(IMAGE_DATA_URL_MAX + 1, 'A')), 'image-too-large');
    });

    it('refuses blank and anything that is not text', function () {
      assert.equal(imageProblem(''), 'invalid-image');
      assert.equal(imageProblem(undefined), 'invalid-image');
      assert.equal(imageProblem(42), 'invalid-image');
    });

    /**
     * A form that was opened on a listing with a photo sends the photo's path
     * back when it is saved, so the path has to pass. On its shape only: whose
     * photo it names is not something this module can know, and the tests for
     * that are beside photoFieldFor.
     */
    it('accepts the path of an uploaded photo, and only a well-formed one', function () {
      assert.isNull(imageProblem('/photo/event/Qx7bTnGm2kLp9wZa4?v=1789603200000'));
      assert.isNull(imageProblem('/photo/club/Qx7bTnGm2kLp9wZa4?v=1'));
      assert.isNull(imageProblem('/photo/profile/Qx7bTnGm2kLp9wZa4'), 'the version is a cache key, not part of the name');
      assert.equal(imageProblem('/photo/poster/Qx7bTnGm2kLp9wZa4?v=1'), 'invalid-image', 'a kind there is not');
      assert.equal(imageProblem('/photo/event/../club/abc?v=1'), 'invalid-image');
      assert.equal(imageProblem('/photo/event/abc?v=1&next=https://elsewhere.example'), 'invalid-image');
      assert.equal(imageProblem(`/photo/event/${'a'.repeat(41)}?v=1`), 'invalid-image');
      assert.equal(imageProblem('/photo/event/'), 'invalid-image');
      assert.equal(imageProblem('/photos/event/abc?v=1'), 'invalid-image', 'a near miss is not an app path either');
    });
  });

  describe('photo paths', function () {
    const updatedAt = new Date(1789603200000);

    it('writes the path the contract names', function () {
      assert.equal(photoPathFor({ kind: 'event', ownerId: 'Qx7bTnGm2kLp9wZa4', updatedAt }), '/photo/event/Qx7bTnGm2kLp9wZa4?v=1789603200000');
    });

    it('reads back whose photo a path names', function () {
      PHOTO_KINDS.forEach(kind => {
        assert.deepEqual(parsePhotoPath(photoPathFor({ kind, ownerId: 'abc123', updatedAt })), { kind, ownerId: 'abc123' });
      });
      assert.isNull(parsePhotoPath('/photo/event/has-a-hyphen?v=1'));
      assert.isNull(parsePhotoPath('https://example.org/photo/event/abc123'));
      assert.isNull(parsePhotoPath(undefined));
    });

    it('calls anything under /photo/ a photo path, which is what the UI’s isPhoto does', function () {
      assert.isTrue(isPhotoPath('/photo/event/abc?v=1'));
      assert.isTrue(isPhotoPath('/photo/nonsense'), 'meant as one; imageProblem is what says it is a bad one');
      assert.isFalse(isPhotoPath('/photos/event/abc'));
      assert.isFalse(isPhotoPath('/images/codingWorkshop.png'));
      assert.isFalse(isPhotoPath('data:image/jpeg;base64,/9j/4AAQ'));
      [undefined, null, '', 0, {}].forEach(value => assert.isFalse(isPhotoPath(value)));
    });

    it('takes an inline image apart, and nothing else', function () {
      assert.deepEqual(splitImageDataUrl('data:image/png;base64,iVBORw0KGgo='), { contentType: 'image/png', data: 'iVBORw0KGgo=' });
      assert.isNull(splitImageDataUrl('data:image/gif;base64,R0lGODlhAQABAAAAACw='));
      assert.isNull(splitImageDataUrl('data:text/html;base64,PGI+'));
      assert.isNull(splitImageDataUrl('/photo/event/abc?v=1'));
      assert.isNull(splitImageDataUrl(undefined));
    });
  });
}
