import React from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { GeoAlt, PencilSquare, Trash } from 'react-bootstrap-icons';
import swal from 'sweetalert';
import { Meteor } from 'meteor/meteor';
import PosterArt from './PosterArt';
import { formatEventDate } from '../utilities/helpers';
import { topicFor } from '../utilities/topics';

/**
 * An event on the admin dashboard — the same poster as Discover and Landing,
 * with edit and delete in the footer instead of the going CTA. See
 * ClubItemAdmin for why this composes the poster face rather than reusing
 * EventPoster whole.
 */
const EventCardAdmin = ({ event }) => {
  // The event's own words only. EventPoster falls back to the host club's
  // categories, but the host is not published to this page and fetching it
  // would be a data change, not an appearance one.
  const topic = topicFor(event.title, event.description);
  // The seeded stock art is not this app's design and reads as clutter beside
  // a drawn poster; only an uploaded image earns the face.
  const photo = event.image && event.image.startsWith('data:') ? event.image : '';

  const removeItem = () => {
    swal({
      title: 'Delete event?',
      text: `This will permanently remove ${event.title}.`,
      icon: 'warning',
      buttons: true,
      dangerMode: true,
    }).then(confirmed => {
      if (confirmed) {
        Meteor.call('Events.remove', event._id, error => {
          if (error) {
            swal('Error', error.reason || error.message, 'error');
          } else {
            swal('Deleted', 'Event removed.', 'success');
          }
        });
      }
    });
  };

  return (
    <article className="mb-poster mb-poster-sm">
      {/* The absolute date, not EventPoster's "Tonight": this list includes
          events that have already happened, and an admin is auditing records. */}
      <PosterArt topic={topic} eyebrow={formatEventDate(event.date)} image={photo} title={event.title} />

      <div className="mb-poster-foot">
        <span className="mb-poster-meta"><GeoAlt size={12} /> {event.location}</span>
        <span className="mb-poster-tools">
          <Link to={`/edit/event/${event._id}`} className="mb-icon-btn" aria-label={`Edit ${event.title}`}>
            <PencilSquare size={14} />
          </Link>
          <button
            type="button"
            className="mb-icon-btn mb-icon-btn--danger"
            onClick={removeItem}
            aria-label={`Delete ${event.title}`}
          >
            <Trash size={14} />
          </button>
        </span>
      </div>
    </article>
  );
};

EventCardAdmin.propTypes = {
  event: PropTypes.shape({
    _id: PropTypes.string,
    title: PropTypes.string,
    description: PropTypes.string,
    date: PropTypes.instanceOf(Date),
    location: PropTypes.string,
    createdBy: PropTypes.string,
    eventID: PropTypes.number,
    image: PropTypes.string,
  }).isRequired,
};

export default EventCardAdmin;
