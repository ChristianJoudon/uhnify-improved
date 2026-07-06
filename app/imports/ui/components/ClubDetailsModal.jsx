import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import { Badge, Button, Form, Image, Modal } from 'react-bootstrap';
import swal from 'sweetalert';
import { CalendarWeek, Envelope, GeoAlt, Plus } from 'react-bootstrap-icons';
import { Clubs } from '../../api/club/Club';
import { imagePath, normalizeCategories } from '../utilities/helpers';
import { scheduleLabel } from '../../api/club/schedule';

const ClubDetailsModal = ({ show, handleClose, club: clubProp }) => {
  const [newTag, setNewTag] = useState('');
  // Prefer the live minimongo doc so freshly added tags appear immediately;
  // the prop is a snapshot captured when the modal was opened.
  const liveClub = useTracker(() => (clubProp?._id ? Clubs.collection.findOne(clubProp._id) : null), [clubProp?._id]);
  const club = liveClub || clubProp;
  const categories = normalizeCategories(club?.categories);
  const tags = club?.tags || [];
  const schedule = scheduleLabel(club?.schedule);

  const addTag = () => {
    const tag = newTag.trim();
    if (!club || tag.length < 2) {
      return;
    }
    Meteor.call('clubs.addTag', club._id, tag, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      } else {
        setNewTag('');
      }
    });
  };

  return (
    <Modal show={show} onHide={handleClose} centered size="lg" className="details-modal">
      {club ? (
        <>
          <Modal.Header closeButton>
            <div className="modal-title-block">
              {categories[0] && <span className="eyebrow">{categories[0]}</span>}
              <Modal.Title>{club.name}</Modal.Title>
            </div>
          </Modal.Header>
          <Modal.Body>
            <div className="details-modal-grid">
              <Image src={imagePath(club.image)} alt={club.name} className="details-modal-image" />
              <div>
                <div className="details-list">
                  <div><CalendarWeek /> {schedule || club.meetingTime}</div>
                  <div><GeoAlt /> {club.location}</div>
                  {(club.contactInfo || club.owner) && <div><Envelope /> {club.contactInfo || club.owner}</div>}
                </div>
                <p className="details-copy mt-4">{club.description}</p>
                <div className="club-card-categories mt-4">
                  {categories.map(category => <Badge key={`cat-${category}`} className="club-category-tag">{category}</Badge>)}
                  {tags.map(tag => <Badge key={`tag-${tag}`} className="club-category-tag">{tag}</Badge>)}
                </div>
                {Meteor.userId() && (
                  <div className="d-flex align-items-center gap-2 mt-3">
                    <Form.Control
                      type="text"
                      placeholder="Add a tag (members)…"
                      value={newTag}
                      maxLength={28}
                      onChange={event => setNewTag(event.target.value)}
                      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addTag(); } }}
                      style={{ maxWidth: 240, minHeight: 40 }}
                    />
                    <button type="button" className="icon-btn" aria-label="Add tag" onClick={addTag}><Plus size={18} /></button>
                  </div>
                )}
              </div>
            </div>
          </Modal.Body>
        </>
      ) : (
        <Modal.Body>Loading…</Modal.Body>
      )}
      <Modal.Footer>
        <Button className="btn-solid-primary" onClick={handleClose}>Close</Button>
      </Modal.Footer>
    </Modal>
  );
};

ClubDetailsModal.propTypes = {
  show: PropTypes.bool.isRequired,
  handleClose: PropTypes.func.isRequired,
  club: PropTypes.shape({
    _id: PropTypes.string,
    name: PropTypes.string,
    owner: PropTypes.string,
    description: PropTypes.string,
    meetingTime: PropTypes.string,
    location: PropTypes.string,
    image: PropTypes.string,
    contactInfo: PropTypes.string,
    categories: PropTypes.arrayOf(PropTypes.string),
    tags: PropTypes.arrayOf(PropTypes.string),
    schedule: PropTypes.shape({
      days: PropTypes.arrayOf(PropTypes.number),
      time: PropTypes.string,
      cadence: PropTypes.string,
    }),
  }),
};

ClubDetailsModal.defaultProps = {
  club: null,
};

export default ClubDetailsModal;
