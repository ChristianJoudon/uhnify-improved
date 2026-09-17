import React from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import swal from 'sweetalert';
import { FLAG_REASONS } from '../../api/moderation/Moderation';

const reasonLabel = value => (FLAG_REASONS.find(known => known.value === value) || { label: value }).label;

const report = error => error && swal('Not done', error.reason || error.message, 'error');

/**
 * What people have reported, newest first, with the two things an
 * administrator can do about each. Taking a listing down asks for the reason,
 * because that sentence is what the person who posted it will read.
 */
const ModerationQueue = ({ flags }) => {
  const takeDown = flag => swal({
    title: `Take down "${flag.listingTitle || 'this listing'}"?`,
    text: 'It comes off every wall. Whoever posted it is shown the reason you give.',
    content: { element: 'input', attributes: { placeholder: reasonLabel(flag.reason) } },
    buttons: ['Leave it up', 'Take it down'],
    dangerMode: true,
  }).then(answer => answer !== null && Meteor.call(
    'moderation.resolveFlag',
    flag._id,
    'takedown',
    typeof answer === 'string' ? answer : '',
    report,
  ));

  if (flags.length === 0) {
    return (
      <div className="mb-empty">
        <h3>Nothing reported.</h3>
        <p>When someone flags a listing it shows up here.</p>
      </div>
    );
  }
  return (
    <div className="mb-panel">
      {flags.map(flag => (
        <div key={flag._id} className="moderation-row">
          <div className="moderation-row-main">
            <strong>{flag.listingTitle || 'Untitled listing'}</strong>
            <p>{reasonLabel(flag.reason)}{flag.note ? ` — “${flag.note}”` : ''}</p>
          </div>
          <div className="moderation-row-actions">
            <button type="button" className="btn btn-soft-primary" onClick={() => Meteor.call('moderation.resolveFlag', flag._id, 'dismiss', '', report)}>
              Dismiss
            </button>
            <button type="button" className="btn btn-outline-danger-soft" onClick={() => takeDown(flag)}>
              Take down
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};

ModerationQueue.propTypes = {
  flags: PropTypes.arrayOf(PropTypes.shape({
    _id: PropTypes.string.isRequired,
    listingTitle: PropTypes.string,
    reason: PropTypes.string,
    note: PropTypes.string,
  })).isRequired,
};

export default ModerationQueue;
