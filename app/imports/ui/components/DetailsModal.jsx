import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import { Badge, Button, Modal } from 'react-bootstrap';
import swal from 'sweetalert';
import { Plus } from 'react-bootstrap-icons';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import PosterArt from './PosterArt';
import CardFields from './CardFields';
import { normalizeCategories } from '../utilities/helpers';
import { CLUB_FIELDS, EVENT_FIELDS } from '../utilities/cardFields';
import { topicForClub, topicForEvent } from '../utilities/topics';

/**
 * The sheet behind a card.
 *
 * One component for both kinds, because the reader is asking one question —
 * "tell me the rest of it" — and an app that answered it two different ways
 * depending on what was clicked would be two apps. Only the schema and the
 * collection change; everything else is the same sheet.
 *
 * The card's own poster is redrawn at the top rather than the record's uploaded
 * logo: the reader clicked a poster, and the sheet should be the same object
 * they clicked, larger. This is also the one surface where the topic's cover
 * art earns its place — a single poster on screen, not a wall of twenty.
 *
 * Rows come from the card schema with no limit, so the sheet is exactly the
 * card's facts plus the ones the card had no room for. A field the record never
 * published still draws nothing.
 */
const KINDS = {
  event: {
    collection: () => Events.collection,
    schema: EVENT_FIELDS,
    topic: topicForEvent,
    heading: record => record.title,
    joined: "You're in",
    join: "I'm in",
  },
  club: {
    collection: () => Clubs.collection,
    schema: CLUB_FIELDS,
    topic: topicForClub,
    heading: record => record.name,
    joined: "You're in",
    join: "I'm in",
  },
};

const DetailsModal = ({ show, onHide, record: snapshot, kind, isIn, onAct }) => {
  const [newTag, setNewTag] = useState('');
  const shape = KINDS[kind];

  // Prefer the live minimongo doc so a tag added here appears at once; the prop
  // is a snapshot taken when the sheet was opened.
  const live = useTracker(
    () => (snapshot?._id ? shape.collection().findOne(snapshot._id) : null),
    [snapshot?._id, kind],
  );
  const record = live || snapshot;

  const addTag = () => {
    const tag = newTag.trim();
    if (!record || tag.length < 2) {
      return;
    }
    Meteor.call('clubs.addTag', record._id, tag, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      } else {
        setNewTag('');
      }
    });
  };

  if (!record) {
    return (
      <Modal show={show} onHide={onHide} centered size="lg" className="details-modal">
        <Modal.Header closeButton />
        <Modal.Body>Loading…</Modal.Body>
        <Modal.Footer>
          <Button className="btn-solid-primary" onClick={onHide}>Close</Button>
        </Modal.Footer>
      </Modal>
    );
  }

  const topic = shape.topic(record);
  const categories = normalizeCategories(record.categories);
  const tags = record.tags || [];
  // Same rule as the card: only a genuinely uploaded photo takes the face.
  const photo = record.image && record.image.startsWith('data:') ? record.image : '';

  return (
    <Modal show={show} onHide={onHide} centered size="lg" className="details-modal">
      <Modal.Header closeButton>
        <div className="modal-title-block">
          {/* Only a real match may name itself. topicFor hands back a label
              for unmatched records too, and printing it would assert a subject
              nothing was matched on — so an unmatched record falls back to its
              own first category, or to no eyebrow at all. */}
          {(topic.matched ? topic.label : categories[0]) && (
            <span className="eyebrow">{topic.matched ? topic.label : categories[0]}</span>
          )}
          {/* A real heading: react-bootstrap renders ModalTitle as a div by
              default, so the sheet's title was the one title-scale string in
              the app set in DM Sans instead of Bricolage. */}
          <Modal.Title as="h2">{shape.heading(record)}</Modal.Title>
        </div>
      </Modal.Header>

      <Modal.Body>
        <div className="details-modal-grid">
          <div className="details-modal-poster">
            <PosterArt topic={topic} image={photo} placeholder="" art />
          </div>

          <div>
            <CardFields record={record} schema={shape.schema} className="details-fields" />

            {record.description && <p className="details-copy">{record.description}</p>}

            {(categories.length > 0 || tags.length > 0) && (
              <div className="club-card-categories">
                {categories.map(category => <Badge key={`cat-${category}`} className="club-category-tag">{category}</Badge>)}
                {tags.map(tag => <Badge key={`tag-${tag}`} className="club-category-tag">{tag}</Badge>)}
              </div>
            )}

            {/* Members annotate a group in the group's own vocabulary. An event
                is over in an evening, so it has nothing to annotate. */}
            {kind === 'club' && Meteor.userId() && (
              <div className="details-tag-add">
                {/* A plain input, not Form.Control: that renders `form-control
                    mb-field` and the app's own `.form-control` rule is
                    !important, so it beat every part of `.mb-field` the field
                    was asked for. `.mb-field` alone is the whole treatment. */}
                <input
                  type="text"
                  className="mb-field"
                  aria-label="Add a tag"
                  placeholder="Add a tag (members)…"
                  value={newTag}
                  maxLength={28}
                  onChange={event => setNewTag(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addTag(); } }}
                />
                <button type="button" className="mb-icon-btn" aria-label="Add tag" onClick={addTag}><Plus size={18} /></button>
              </div>
            )}
          </div>
        </div>
      </Modal.Body>

      <Modal.Footer>
        {/* The same one action the card carried, so the sheet is never a dead
            end — a reader who opened it to decide can decide here. */}
        {onAct && (
          <button
            type="button"
            className={`btn ${isIn ? 'btn-soft-primary' : 'btn-match'}`}
            onClick={() => onAct(record)}
            aria-pressed={isIn}
          >
            {isIn ? shape.joined : shape.join}
          </button>
        )}
        <Button className="btn-solid-primary" onClick={onHide}>Close</Button>
      </Modal.Footer>
    </Modal>
  );
};

DetailsModal.propTypes = {
  show: PropTypes.bool.isRequired,
  onHide: PropTypes.func.isRequired,
  /** Any event or club; the schema is what knows how to read it. */
  record: PropTypes.shape({ _id: PropTypes.string }),
  kind: PropTypes.oneOf(['event', 'club']),
  /** Already going / already a member — the action reads back what is true. */
  isIn: PropTypes.bool,
  /** Omit to render no action, for a surface where there is nothing to join. */
  onAct: PropTypes.func,
};

DetailsModal.defaultProps = {
  record: null,
  kind: 'club',
  isIn: false,
  onAct: null,
};

export default DetailsModal;
