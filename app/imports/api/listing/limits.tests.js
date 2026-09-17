/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { IMAGE_DATA_URL_MAX, IMAGE_URL_MAX, imageProblem } from './limits';

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
  });
}
