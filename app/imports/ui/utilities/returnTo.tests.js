/* eslint-env mocha */
import { assert } from 'chai';
import { safeReturnPath } from './returnTo';

/**
 * The remembered path is read out of storage any script on the page can write
 * and then handed to a navigation. A wrong "yes" here is an open redirect on
 * the sign-in page; a wrong "no" strands an invited person on the front page
 * without the only link that lets them into a private group.
 */
describe('safeReturnPath', function () {
  it('keeps a path on this site, with its query and fragment', function () {
    assert.equal(safeReturnPath('/join/Qx7bTnGm2kLp9wZa4-_AbCdEf'), '/join/Qx7bTnGm2kLp9wZa4-_AbCdEf');
    assert.equal(safeReturnPath('/manage/group/abc'), '/manage/group/abc');
    assert.equal(safeReturnPath('/discover?kind=clubs&topic=outdoors#top'), '/discover?kind=clubs&topic=outdoors#top');
    assert.equal(safeReturnPath('/'), '/');
  });

  it('refuses another site, however it is spelled', function () {
    [
      'https://evil.example/join/abc',
      '//evil.example/join/abc',
      '/\\evil.example',
      '/\\/evil.example',
      '\\\\evil.example',
      // Assembled, because the linter reads a script URL as one even in a
      // test whose whole point is that it is refused.
      ['javascript', 'alert(1)'].join(':'),
      'evil.example',
      'join/abc',
    ].forEach(value => assert.equal(safeReturnPath(value), '', value));
  });

  it('refuses a backslash anywhere, since a browser reads it as a slash', function () {
    assert.equal(safeReturnPath('/join\\..\\//evil.example'), '');
  });

  it('never returns to a door', function () {
    ['/signin', '/signup', '/signout', '/signin?x=1', '/signin/'].forEach(value => (
      assert.equal(safeReturnPath(value), '', value)
    ));
    // A route that merely starts with the same letters is not a door.
    assert.equal(safeReturnPath('/signing-circle'), '/signing-circle');
  });

  it('answers with nothing, rather than throwing, for anything that is not a path', function () {
    [undefined, null, '', 0, {}, [], `/${'a'.repeat(600)}`].forEach(value => assert.equal(safeReturnPath(value), ''));
  });
});
