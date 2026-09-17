import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import swal from 'sweetalert';

/**
 * The owner's switches: who can find a listing, whether anyone can see who is
 * in it, and — for a group — whether joining asks first.
 *
 * One component for the two create forms and the two manage pages, because
 * the sentences under these switches are promises ("Not other members, not
 * friends, not you") and a promise worded four times is worded four ways
 * within a month.
 *
 * It holds no state and calls no method. A form keeps the values until it is
 * submitted; a manage page sends each change the moment it is made (see
 * usePrivacySettings). Either way the parent hands the values in and hears
 * about ONE key at a time through `onChange`, which is the shape the server's
 * setPrivacy methods take: a key left out is a setting left alone.
 *
 * What the component does own is the two rules the server enforces, drawn
 * before anyone can trip over them:
 *   - a locked anonymous switch is on and cannot be moved, and says why;
 *   - "Approve each person" cannot be on while the listing is anonymous,
 *     because approving a request means reading a name.
 * The server refuses both anyway. Drawing them is so that nobody has to find
 * out by being refused.
 */

const LOCKED_HELP = 'Always on for support, health, LGBTQ+ and faith listings.';

const COPY = {
  club: {
    private: 'Only people with your invite link can find and join this.',
    anonymous: 'Nobody can see who is in this. Not other members, not friends, not you.',
  },
  event: {
    private: 'Only members of the host group can see this.',
    anonymous: 'Nobody can see who is going. Not other guests, not friends, not you.',
  },
};

const Switch = ({ id, label, help, checked, disabled, onChange }) => (
  <div>
    <label className="mb-switch" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-help`}
        onChange={event => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
    <p id={`${id}-help`} className="mb-switch-help">{help}</p>
  </div>
);

Switch.propTypes = {
  id: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  help: PropTypes.string.isRequired,
  checked: PropTypes.bool.isRequired,
  disabled: PropTypes.bool.isRequired,
  onChange: PropTypes.func.isRequired,
};

const PrivacyToggles = ({ kind, idPrefix, value, anonymousLocked, lockedHelp, following, onFollow, disabled, trouble, onRetry, onChange }) => {
  const isPrivate = value.visibility === 'private';
  // Locked means on, whatever the stored flag says: a sensitive listing is
  // anonymous because of what it is, and its own flag is usually false.
  const anonymous = anonymousLocked || value.anonymous === true;

  const approveHelp = () => {
    if (anonymous) {
      return 'Not available for an anonymous group — you cannot see who is asking.';
    }
    // True, and otherwise a surprise: the link is the owner's own yes, so the
    // server lets its holder straight in past this switch.
    return isPrivate
      ? 'You say yes before someone joins. People with your invite link skip this.'
      : 'You say yes before someone joins.';
  };

  return (
    <div className="mb-switch-list">
      {following && (
        <p className="form-note mb-switch-note">Following {following}&apos;s settings</p>
      )}

      <Switch
        id={`${idPrefix}-private`}
        label="Private"
        help={COPY[kind].private}
        checked={isPrivate}
        disabled={disabled}
        onChange={on => onChange({ visibility: on ? 'private' : 'public' })}
      />

      {kind === 'club' && (
        <Switch
          id={`${idPrefix}-approve`}
          label="Approve each person"
          help={approveHelp()}
          checked={!anonymous && value.approveMembers === true}
          disabled={disabled || anonymous}
          onChange={on => onChange({ approveMembers: on })}
        />
      )}

      <Switch
        id={`${idPrefix}-anonymous`}
        label="Anonymous"
        help={anonymousLocked ? (lockedHelp || LOCKED_HELP) : COPY[kind].anonymous}
        checked={anonymous}
        disabled={disabled || anonymousLocked}
        onChange={on => onChange({ anonymous: on })}
      />

      {!following && onFollow && (
        <button type="button" className="mb-switch-follow" onClick={onFollow}>Use the group&apos;s settings</button>
      )}

      {/* Switches that are all greyed out and say nothing read as a page that
          has broken for good. The server's sentence says what happened, and
          usually how long to wait; the way out sits beside it. */}
      {trouble && (
        <p className="panel-empty" role="status">
          {trouble}
          {onRetry && (
            <>
              {' '}
              <button type="button" className="mb-switch-follow" onClick={onRetry}>Try again</button>
            </>
          )}
        </p>
      )}
    </div>
  );
};

PrivacyToggles.propTypes = {
  kind: PropTypes.oneOf(['club', 'event']).isRequired,
  /** Two of these can share a page with other forms; ids must not collide. */
  idPrefix: PropTypes.string.isRequired,
  value: PropTypes.shape({
    visibility: PropTypes.oneOf(['public', 'private']),
    anonymous: PropTypes.bool,
    approveMembers: PropTypes.bool,
  }).isRequired,
  /** Anonymity is not the owner's to switch off: the server said so, or the
      same test it runs said so about a listing not yet saved. */
  anonymousLocked: PropTypes.bool,
  /** Why it is locked, when the reason is not the usual one. */
  lockedHelp: PropTypes.string,
  /** An event still following its host: the group's name. Empty once the
      owner has set anything by hand. */
  following: PropTypes.string,
  /** Offered only where going back to the group's settings is possible. */
  onFollow: PropTypes.func,
  disabled: PropTypes.bool,
  /** Why the switches cannot be trusted just now, in the server's words, and
      how to ask it again. A manage page's; a form has nothing to fail at. */
  trouble: PropTypes.string,
  onRetry: PropTypes.func,
  /** Called with exactly one key: { visibility } | { anonymous } | { approveMembers }. */
  onChange: PropTypes.func.isRequired,
};

PrivacyToggles.defaultProps = {
  anonymousLocked: false,
  lockedHelp: '',
  following: '',
  onFollow: null,
  disabled: false,
  trouble: '',
  onRetry: null,
};

/**
 * A manage page's copy of a listing's privacy, where the server's answer is
 * the only truth.
 *
 * Each change is sent the moment the switch moves — the reason Settings gives
 * for its own switch applies twice over here: a switch reading "Private" over
 * a group the server still publishes is not a stale form, it is a false
 * promise. Both setPrivacy methods answer with how things now stand, so the
 * page shows THAT and never its own guess: turning Anonymous on comes back
 * with "Approve each person" off, and the second switch moves because the
 * server moved it.
 *
 * Asked with no settings, the methods write nothing and report — which is how
 * the page learns about the lock. `watch` is everything that can move the
 * answer from outside this page, and when it changes the page asks again.
 * That is the record's own stored settings as much as the words that lock it:
 * a member adding the tag 'recovery' moves the lock, but so does the host
 * group going private, which rewrites every event still following it, and so
 * does an administrator or a second tab. With the settings left out, the last
 * answer went on being drawn over a record that had since changed — "Private"
 * off, on an event that was private.
 *
 * While nothing has come back yet, `settings` is the caller's own reading of
 * the record, so the switches are drawn in place rather than popping in. A
 * read that fails goes back to exactly that: the answer it was meant to
 * replace is dropped, because the only reason to have asked is that it may no
 * longer be true, and the switches stay disabled over the record's reading
 * until the server has spoken again. `trouble` is what it said instead, and
 * `retry` asks once more. They exist because the first version of this kept
 * neither: one refused read — the rate limit allows twenty a minute, and
 * every mount spends one — left a page of grey switches with no word of why
 * and no way forward but reloading.
 */
export const usePrivacySettings = (method, listingId, fallback, watch = '') => {
  // Kept with the listing it is about. The route can change from one manage
  // page to another without this hook unmounting, and the last group's answer
  // must not be drawn over the next group's switches while its own is fetched.
  const [answer, setAnswer] = useState(null);
  const [saving, setSaving] = useState(false);
  const [trouble, setTrouble] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!listingId) {
      return undefined;
    }
    let active = true;
    setTrouble('');
    Meteor.call(method, listingId, {}, (error, result) => {
      if (!active) {
        return;
      }
      if (error || !result) {
        setAnswer(null);
        setTrouble(error?.reason || error?.message || 'We could not check these settings just now.');
        return;
      }
      setAnswer({ listingId, result });
    });
    return () => {
      active = false;
    };
  }, [method, listingId, watch, attempt]);

  const change = patch => {
    setSaving(true);
    Meteor.call(method, listingId, patch, (error, result) => {
      setSaving(false);
      if (error) {
        // The switch is drawn from the last answer, which did not change, so
        // it falls back by itself to what is true.
        swal('Not changed', error.reason || error.message, 'error');
      } else if (result) {
        setAnswer({ listingId, result });
      }
    });
  };

  // `answer &&`, not `answer?.`: before the record has arrived both sides are
  // undefined, `undefined === undefined` is true, and the next thing read is
  // `null.result`. That crashed every manage page opened directly or reloaded —
  // it only ever worked when the person arrived by a link from a page that had
  // already loaded the record.
  const current = answer && answer.listingId === listingId ? answer.result : null;
  return {
    settings: current || fallback,
    loaded: current !== null,
    saving,
    change,
    trouble,
    retry: () => setAttempt(count => count + 1),
  };
};

export default PrivacyToggles;
