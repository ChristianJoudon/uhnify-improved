import React from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import CategoryPoster from './CategoryPoster';
import { DEFAULT_EVENT_IMAGE, imagePath } from '../utilities/helpers';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * A compact printed notice: poster, prominent date, place and distance before
 * description, host, then the two actions that matter. One accent per card.
 */
const MatchEventCard = ({ event, hostName, neighborhood, distance, saved, onSave, onGoing, going }) => {
  const date = event.date instanceof Date ? event.date : new Date(event.date);
  const valid = !Number.isNaN(date.getTime());
  const hasPhoto = Boolean(event.image) && event.image !== DEFAULT_EVENT_IMAGE;

  return (
    <article className="mb-card">
      <Link to="/upcoming-events" className="mb-card-poster" aria-label={event.title}>
        {hasPhoto
          ? <img src={imagePath(event.image, DEFAULT_EVENT_IMAGE)} alt="" loading="lazy" />
          : <CategoryPoster seed={event._id || event.title} label={event.title} />}
        {neighborhood && <span className="mb-tag">{neighborhood}</span>}
      </Link>

      <div className="mb-card-body">
        <div className="mb-card-topline">
          <div className="mb-date">
            <div className="mb-date-dow">{valid ? DOW[date.getDay()] : '—'}</div>
            <div className="mb-date-day">{valid ? date.getDate() : '?'}</div>
          </div>
          <div className="mb-place">
            <strong>{event.location || 'Location to come'}</strong>
            {distance ? `${distance} away` : 'Nearby'}
          </div>
        </div>

        <h3 className="mb-card-title">{event.title}</h3>
        {hostName && <p className="mb-card-host">Hosted by {hostName}</p>}

        <div className="mb-card-actions">
          <button type="button" className={`btn ${going ? 'btn-solid-primary' : 'btn-soft-primary'}`} onClick={onGoing}>
            {going ? "You're in" : "I'm going"}
          </button>
          <button
            type="button"
            className={`mb-save${saved ? ' is-saved' : ''}`}
            onClick={onSave}
            aria-pressed={saved}
            aria-label={saved ? `Remove ${event.title} from saved` : `Save ${event.title}`}
          >
            <span className="mb-save-head" />
            {saved ? 'Saved' : 'Save'}
          </button>
        </div>
      </div>
    </article>
  );
};

MatchEventCard.propTypes = {
  event: PropTypes.shape({
    _id: PropTypes.string,
    title: PropTypes.string,
    date: PropTypes.oneOfType([PropTypes.instanceOf(Date), PropTypes.string]),
    location: PropTypes.string,
    image: PropTypes.string,
  }).isRequired,
  hostName: PropTypes.string,
  neighborhood: PropTypes.string,
  distance: PropTypes.string,
  saved: PropTypes.bool,
  going: PropTypes.bool,
  onSave: PropTypes.func,
  onGoing: PropTypes.func,
};

MatchEventCard.defaultProps = {
  hostName: '',
  neighborhood: '',
  distance: '',
  saved: false,
  going: false,
  onSave: () => {},
  onGoing: () => {},
};

export default MatchEventCard;
