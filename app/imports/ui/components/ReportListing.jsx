import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import { Flag } from '../utilities/icons';
import { FLAG_NOTE_MAX, FLAG_REASONS } from '../../api/moderation/Moderation';

/**
 * "Report" on a listing's sheet.
 *
 * Anyone can post here, so anyone has to be able to say "this one is wrong" —
 * it is the other half of that decision. Quiet until pressed, because most
 * people opening a sheet are deciding whether to go, not whether to complain;
 * then one question, an optional line, and a plain thank-you. Signed-out
 * visitors are sent to sign in rather than shown a form that will refuse them.
 */
const ReportListing = ({ kind, listingId }) => {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [state, setState] = useState({ sending: false, sent: false, trouble: '' });

  if (state.sent) {
    return <p className="report-listing-done" role="status">Thanks — someone will take a look.</p>;
  }
  if (!open) {
    return (
      <button type="button" className="report-listing-open" onClick={() => setOpen(true)}>
        <Flag size={13} aria-hidden="true" />
        Report this {kind === 'club' ? 'group' : 'event'}
      </button>
    );
  }
  if (!Meteor.userId()) {
    return <p className="report-listing-done">Sign in to report a listing.</p>;
  }

  const send = event => {
    event.preventDefault();
    setState({ sending: true, sent: false, trouble: '' });
    Meteor.call('moderation.flag', kind, listingId, reason, note, error => setState({
      sending: false,
      sent: !error,
      trouble: error ? (error.reason || error.message) : '',
    }));
  };

  return (
    <form className="report-listing" onSubmit={send}>
      <fieldset>
        <legend>What is wrong with it?</legend>
        {FLAG_REASONS.map(known => (
          <label key={known.value} className="report-listing-reason">
            <input
              type="radio"
              name="report-reason"
              value={known.value}
              checked={reason === known.value}
              onChange={() => setReason(known.value)}
            />
            {known.label}
          </label>
        ))}
      </fieldset>
      <label htmlFor="report-note">
        Anything that would help <span className="field-hint">(optional)</span>
        <textarea
          id="report-note"
          rows={2}
          maxLength={FLAG_NOTE_MAX}
          value={note}
          onChange={event => setNote(event.target.value)}
        />
      </label>
      {state.trouble && <p className="auth-error" role="alert">{state.trouble}</p>}
      <div className="report-listing-actions">
        <button type="submit" className="btn btn-soft-primary" disabled={!reason || state.sending}>Send report</button>
        <button type="button" className="btn btn-link" onClick={() => setOpen(false)}>Never mind</button>
      </div>
    </form>
  );
};

ReportListing.propTypes = {
  kind: PropTypes.oneOf(['event', 'club']).isRequired,
  listingId: PropTypes.string.isRequired,
};

export default ReportListing;
