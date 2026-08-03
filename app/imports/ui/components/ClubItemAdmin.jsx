import React from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { PencilSquare, Trash } from 'react-bootstrap-icons';
import swal from 'sweetalert';
import { Meteor } from 'meteor/meteor';
import PosterArt from './PosterArt';
import { imagePath, normalizeCategories } from '../utilities/helpers';
import { topicFor } from '../utilities/topics';
import { scheduleLabel } from '../../api/club/schedule';

/**
 * A club on the admin dashboard. It is the same poster object as the one on
 * Find Clubs — a club should not look like a different kind of thing depending
 * on who is signed in. Only the footer differs: where a member gets the join
 * CTA, an admin gets edit and delete. Club.jsx hard-codes that CTA, so this
 * composes the shared poster face rather than wrapping the component around a
 * control that has no meaning here.
 */
const ClubItemAdmin = ({ club }) => {
  // Same source order as Club.jsx, so a club keeps its colour across the app.
  const topic = topicFor(normalizeCategories(club.categories), club.tags, club.name, club.description);
  const when = scheduleLabel(club.schedule) || club.meetingTime;
  // Only a genuinely uploaded photo becomes the poster face; the seeded logo
  // art stays the small footer mark.
  const photo = club.image && club.image.startsWith('data:') ? club.image : '';

  const removeItem = () => {
    swal({
      title: 'Delete club?',
      text: `This will permanently remove ${club.name} and its user memberships.`,
      icon: 'warning',
      buttons: true,
      dangerMode: true,
    }).then(confirmed => {
      if (confirmed) {
        Meteor.call('Clubs.remove', club._id, error => {
          if (error) {
            swal('Error', error.reason || error.message, 'error');
          } else {
            swal('Deleted', 'Group removed.', 'success');
          }
        });
      }
    });
  };

  return (
    <article className="mb-poster mb-poster-sm">
      <PosterArt topic={topic} eyebrow={when} image={photo} title={club.name} />

      <div className="mb-poster-foot">
        {club.image && <img className="mb-poster-mark" src={imagePath(club.image)} alt="" loading="lazy" />}
        <span className="mb-poster-meta">{club.location}</span>
        <span className="mb-poster-tools">
          {/* Icon-only: the club's name is directly above, so a label on each
              button would repeat it twice per card across the whole grid. */}
          <Link to={`/edit/${club._id}`} className="mb-icon-btn" aria-label={`Edit ${club.name}`}>
            <PencilSquare size={14} />
          </Link>
          <button
            type="button"
            className="mb-icon-btn mb-icon-btn--danger"
            onClick={removeItem}
            aria-label={`Delete ${club.name}`}
          >
            <Trash size={14} />
          </button>
        </span>
      </div>
    </article>
  );
};

ClubItemAdmin.propTypes = {
  club: PropTypes.shape({
    _id: PropTypes.string,
    name: PropTypes.string,
    description: PropTypes.string,
    image: PropTypes.string,
    location: PropTypes.string,
    meetingTime: PropTypes.string,
    owner: PropTypes.string,
    categories: PropTypes.arrayOf(PropTypes.string),
    tags: PropTypes.arrayOf(PropTypes.string),
    schedule: PropTypes.shape({
      days: PropTypes.arrayOf(PropTypes.number),
      time: PropTypes.string,
      cadence: PropTypes.string,
    }),
  }).isRequired,
};

export default ClubItemAdmin;
