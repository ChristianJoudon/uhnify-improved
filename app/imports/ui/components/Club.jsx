import React from 'react';
import PropTypes from 'prop-types';
import { GeoAlt } from 'react-bootstrap-icons';
import TopicMotif from './TopicMotif';
import { imagePath, normalizeCategories } from '../utilities/helpers';
import { topicFor } from '../utilities/topics';
import { scheduleLabel } from '../../api/club/schedule';

/**
 * A club as a printed poster: the artwork IS the card. The topic decides the
 * field colour and motif; the footer carries the practical line — where, how
 * far, and the one action. `tier` sets the poster's footprint in the masonry.
 */
const Club = ({ club, onAddToProfile, onViewDetails, isMember, tier, distance }) => {
  const categories = normalizeCategories(club.categories);
  // Categories and tags describe the club; its name is only a weak hint.
  const topic = topicFor(categories, club.tags, club.name, club.description);
  const when = scheduleLabel(club.schedule) || club.meetingTime;

  return (
    <article className={`mb-poster mb-poster-${tier}`}>
      {/* The panel stays inert: a stretched button inside the heading opens the
          sheet, so the name remains a real heading and the schedule and tagline
          stay readable text instead of being swallowed by a button's label. */}
      <div className="mb-poster-art" style={{ background: topic.field, color: topic.ink }}>
        <div className="mb-poster-copy">
          {when && <span className="mb-poster-eyebrow">{when}</span>}
          <h3 className="mb-poster-title">
            <button type="button" className="mb-poster-open" onClick={() => onViewDetails(club)}>
              {club.name}
            </button>
          </h3>
          {tier === 'lg' && club.description && (
            <p className="mb-poster-tagline">{club.description}</p>
          )}
        </div>
        <TopicMotif name={topic.motif} />
      </div>

      <div className="mb-poster-foot">
        <img className="mb-poster-mark" src={imagePath(club.image)} alt="" loading="lazy" />
        <span className="mb-poster-meta">
          {distance && <><GeoAlt size={12} /> {distance}</>}
          <em>{topic.label}</em>
        </span>
        <button
          type="button"
          className={`btn ${isMember ? 'btn-soft-primary' : 'btn-match'} mb-poster-cta`}
          onClick={() => onAddToProfile(club._id)}
          disabled={isMember}
        >
          {isMember ? "You're in" : "I'm in"}
        </button>
      </div>
    </article>
  );
};

Club.propTypes = {
  club: PropTypes.shape({
    _id: PropTypes.string,
    clubID: PropTypes.number,
    name: PropTypes.string,
    description: PropTypes.string,
    location: PropTypes.string,
    image: PropTypes.string,
    meetingTime: PropTypes.string,
    categories: PropTypes.arrayOf(PropTypes.string),
    tags: PropTypes.arrayOf(PropTypes.string),
    schedule: PropTypes.shape({
      days: PropTypes.arrayOf(PropTypes.number),
      time: PropTypes.string,
      cadence: PropTypes.string,
    }),
  }).isRequired,
  onAddToProfile: PropTypes.func,
  onViewDetails: PropTypes.func.isRequired,
  isMember: PropTypes.bool,
  tier: PropTypes.oneOf(['lg', 'md', 'sm']),
  distance: PropTypes.string,
};

Club.defaultProps = {
  onAddToProfile: () => {},
  isMember: false,
  tier: 'md',
  distance: '',
};

export default Club;
