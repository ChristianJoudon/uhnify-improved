/* eslint-env mocha */
import { assert } from 'chai';
import { DEFAULT_PROFILE_IMAGE, imagePath, isPhoto, profileImagePath } from './helpers';

/**
 * Every card decides whether to put a picture on its face by asking isPhoto,
 * so a wrong answer here is a wall of listings that lost their photos — or one
 * that put the seeded stock art back on every poster.
 */
describe('isPhoto', function () {
  const stored = '/photo/event/Qx7bTnGm2kLp9wZa4?v=1789603200000';

  it('knows a stored photo by the path it is served from', function () {
    assert.isTrue(isPhoto(stored));
    assert.isTrue(isPhoto('/photo/club/abc?v=1'));
    assert.isTrue(isPhoto('/photo/profile/abc?v=1'));
  });

  it('still knows a data: URL, which a form preview and an unmigrated row both hold', function () {
    assert.isTrue(isPhoto('data:image/jpeg;base64,/9j/4AAQSkZJRg=='));
  });

  it('does not mistake app art, a logo URL or a bare filename for an upload', function () {
    assert.isFalse(isPhoto('/images/codingWorkshop.png'));
    assert.isFalse(isPhoto('https://example.org/logo.png'));
    assert.isFalse(isPhoto('images/acm.png'));
    // Near misses: the prefix is a path segment, not a substring.
    assert.isFalse(isPhoto('/photos/event/abc'));
    assert.isFalse(isPhoto('https://example.org/photo/event/abc'));
  });

  it('answers false, rather than throwing, for a listing with no image at all', function () {
    [undefined, null, '', 0, {}].forEach(value => assert.isFalse(isPhoto(value)));
  });
});

describe('imagePath', function () {
  it('hands a stored photo path back whole, version query included', function () {
    const stored = '/photo/club/Qx7bTnGm2kLp9wZa4?v=1789603200000';
    assert.equal(imagePath(stored), stored);
    const avatar = '/photo/profile/Qx7bTnGm2kLp9wZa4?v=1789603200000';
    assert.equal(profileImagePath(avatar), avatar);
  });

  it('keeps doing what it did for everything else', function () {
    assert.equal(imagePath('https://example.org/logo.png'), 'https://example.org/logo.png');
    assert.equal(imagePath('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
    assert.equal(imagePath('/images/acm.png'), '/images/acm.png');
    assert.equal(imagePath('images/acm.png'), '/images/acm.png');
    assert.equal(imagePath(''), '');
    assert.equal(profileImagePath(undefined), DEFAULT_PROFILE_IMAGE);
  });
});
