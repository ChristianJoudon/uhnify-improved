import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import { Badge, Button, Modal } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import swal from 'sweetalert';
import { Plus } from '../utilities/icons';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { isOpenToAll } from '../../api/listing/audience';
import { isListingOwner } from '../../api/listing/ownership';
import { isAnonymousListing, withHostSignals } from '../../api/privacy/FriendActivityPrivacy';
import PosterArt from './PosterArt';
import CardFields from './CardFields';
import ReportListing from './ReportListing';
import { isPhoto, normalizeCategories } from '../utilities/helpers';
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
 * they clicked, larger. An organizer-uploaded photo is preserved; otherwise
 * the topic field and motif stay consistent with the card the reader opened.
 * Legacy category cover art must never quietly return on this second side.
 *
 * Rows come from the card schema with no limit, so the sheet is exactly the
 * card's facts plus the ones the card had no room for. A field the record never
 * published still draws nothing.
 *
 * The action's words are the one place the two kinds must not share. Saying yes
 * to an event is going to it; saying yes to a group is joining it. Both read
 * "I'm in" here once, while the deck called the same event action "Save" and
 * the list of them was headed "Saved" — one stored decision under three names.
 *
 * The sheet is also where a listing's privacy is said out loud: a "Private" or
 * "Anonymous" chip when it applies, and how many people are in it. On the
 * sheet and not on the card, because a wall of posters each wearing two chips
 * and a number is a wall of chips. "Anonymous" is the EFFECTIVE answer — the
 * owner's flag, a host group's, or a sensitive listing nobody flagged — asked
 * of the same function the server asks, since a chip that read the stored flag
 * alone would leave a recovery meeting looking like it keeps a guest list.
 */
const KINDS = {
  event: {
    collection: () => Events.collection,
    schema: EVENT_FIELDS,
    topic: topicForEvent,
    heading: record => record.title,
    joined: "You're going",
    join: "I'm going",
    count: record => record.goingCount,
    countLabel: count => `${count} going`,
    anonymousMeans: 'Nobody can see who is going.',
    managePath: record => `/manage/event/${record._id}`,
  },
  club: {
    collection: () => Clubs.collection,
    schema: CLUB_FIELDS,
    topic: topicForClub,
    heading: record => record.name,
    joined: "You're in",
    join: 'Join',
    count: record => record.memberCount,
    countLabel: count => `${count} ${count === 1 ? 'member' : 'members'}`,
    anonymousMeans: 'Nobody can see who is in this.',
    managePath: record => `/manage/group/${record._id}`,
  },
};

const DetailsModal = ({ show, onHide, record: snapshot, kind, isIn, requested, onAct }) => {
  const [newTag, setNewTag] = useState('');
  const [shared, setShared] = useState(false);
  const shape = KINDS[kind];

  // Prefer the live minimongo doc so a tag added here appears at once; the prop
  // is a snapshot taken when the sheet was opened.
  const live = useTracker(
    () => (snapshot?._id ? shape.collection().findOne(snapshot._id) : null),
    [snapshot?._id, kind],
  );
  const record = live || snapshot;

  // An event is as anonymous as the group that hosts it, so its hosts are read
  // beside it — whichever of them this browser has been sent.
  const hostNumber = kind === 'event' ? record?.eventID : undefined;
  const hosts = useTracker(
    () => (Number.isInteger(hostNumber) ? Clubs.collection.find({ clubID: hostNumber }).fetch() : []),
    [hostNumber],
  );

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

  // Callers keep the modal mounted and clear the record on hide, so this branch
  // ran during the CLOSING animation too — the sheet you just dismissed flashed
  // "Loading…" on its way out. Nothing to show and nothing to close: render
  // nothing.
  if (!record && !show) {
    return null;
  }

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
  const photo = isPhoto(record.image) ? record.image : '';
  const isPrivate = !isOpenToAll(record);
  const anonymous = isAnonymousListing(kind === 'event' ? withHostSignals(record, hosts) : record);
  const count = shape.count(record) || 0;
  // `owner` reaches a browser only through the owner's own publication, so
  // this is true for the person who made the listing and for nobody else.
  const mine = isListingOwner(Meteor.userId(), record);
  // Asked and not yet answered. Membership wins: an approved request is one.
  const waiting = requested && !isIn;
  // Called off, not taken away: whoever said they were going still finds it
  // here, saying so. There is nothing left to say yes to, so the action goes.
  const cancelled = kind === 'event' && record.cancellationStatus === 'canceled';
  const shareUrl = `${window.location.origin}/${kind === 'event' ? 'e' : 'g'}/${record._id}`;
  const share = () => {
    const title = shape.heading(record);
    if (navigator.share) {
      navigator.share({ title, url: shareUrl }).catch(() => {});
      return;
    }
    navigator.clipboard?.writeText(shareUrl).then(() => {
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    });
  };

  return (
    <Modal show={show} onHide={onHide} centered size="lg" className="details-modal">
      <Modal.Header closeButton>
        <div className="modal-title-block">
          {/* Only a real match may name itself. topicFor hands back a label
              for unmatched records too, and printing it would assert a subject
              nothing was matched on — so an unmatched record falls back to its
              own first category, or to no eyebrow at all. */}
          {(topic.matched ? (topic.activityLabel || topic.label) : categories[0]) && (
            <span className="eyebrow">
              {topic.matched ? (topic.activityLabel || topic.label) : categories[0]}
            </span>
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
            <PosterArt topic={topic} image={photo} placeholder="" />
          </div>

          <div>
            {(cancelled || isPrivate || anonymous || count > 0) && (
              <div className="mb-chip-row details-status">
                {cancelled && <span className="mb-chip mb-chip--sm mb-chip--static mb-chip--cancelled">Cancelled</span>}
                {isPrivate && <span className="mb-chip mb-chip--sm mb-chip--static">Private</span>}
                {anonymous && (
                  <span className="mb-chip mb-chip--sm mb-chip--static" title={shape.anonymousMeans}>Anonymous</span>
                )}
                {count > 0 && <span className="details-count">{shape.countLabel(count)}</span>}
              </div>
            )}

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
        {/* Where it came from. Most of what is on the walls was published by
            somebody else first, and a listing that names them — with a way
            through to the original — is both the honest thing and the one that
            lets a reader check a detail this copy may have got wrong. */}
        {record.source?.publisher && (
          <p className="details-source">
            From{' '}
            {record.source.url
              ? <a href={record.source.url} target="_blank" rel="noopener noreferrer">{record.source.publisher}</a>
              : record.source.publisher}
          </p>
        )}
        {!mine && <ReportListing kind={kind} listingId={record._id} />}
      </Modal.Body>

      <Modal.Footer>
        {/* The link somebody texts a friend. The phone's share sheet where
            there is one; the clipboard where there is not. */}
        <button type="button" className="mb-section-link me-auto" onClick={share}>
          {shared ? 'Link copied' : 'Share'}
        </button>
        {/* For the person who runs it, and quiet: the sheet is for reading, and
            this is the way through to where the listing is changed. */}
        {mine && <Link className="mb-section-link" to={shape.managePath(record)}>Manage</Link>}
        {/* The same one action the card carried, so the sheet is never a dead
            end — a reader who opened it to decide can decide here. A request
            already made is the one state with nothing left to press. */}
        {onAct && !(cancelled && !isIn) && (
          <button
            type="button"
            className={`btn ${isIn || waiting ? 'btn-soft-primary' : 'btn-match'}`}
            onClick={() => onAct(record)}
            aria-pressed={isIn}
            disabled={waiting}
          >
            {(isIn && shape.joined) || (waiting && 'Requested') || shape.join}
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
  /** A group this person has asked to join and not yet heard back from. */
  requested: PropTypes.bool,
  /** Omit to render no action, for a surface where there is nothing to join. */
  onAct: PropTypes.func,
};

DetailsModal.defaultProps = {
  record: null,
  kind: 'club',
  isIn: false,
  requested: false,
  onAct: null,
};

export default DetailsModal;
