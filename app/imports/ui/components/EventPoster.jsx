import React from 'react';
import PropTypes from 'prop-types';
import { GeoAlt } from 'react-bootstrap-icons';
import PosterArt from './PosterArt';
import { normalizeCategories } from '../utilities/helpers';
import { topicFor } from '../utilities/topics';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The when-line, written the way a person would say it. "Tonight" and
 * "Tomorrow" beat a date the reader has to decode, and both are the whole
 * reason someone is on this page.
 */
const whenLabel = date => {
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((date.getTime() - midnight.getTime()) / DAY_MS);
  if (days === 0) {
    return `Tonight · ${time}`;
  }
  if (days === 1) {
    return `Tomorrow · ${time}`;
  }
  if (days < 7) {
    return `${DOW[date.getDay()]} · ${time}`;
  }
  return `${DOW[date.getDay()]} ${MONTH[date.getMonth()]} ${date.getDate()} · ${time}`;
};

/**
 * An event as a printed poster — the same object as the club poster, so one
 * wall of cards reads as one design. `tier` sets its footprint in the masonry;
 * only the largest carries a description.
 */
const EventPoster = ({ event, host, neighborhood, distance, going, onGoing, onOpen, tier }) => {
  const date = event.date instanceof Date ? event.date : new Date(event.date);
  const valid = !Number.isNaN(date.getTime());
  // The event's own words come first — unlike a club, an event is named for
  // what it is. Deferring to the host's category made an art exhibition run by
  // a sports club read as "wellness", and turned the whole wall one colour.
  // The host is the fallback for events named after a person or a place.
  const topic = topicFor(event.title, event.description, normalizeCategories(host?.categories), host?.tags);
  // Only a genuinely uploaded photo becomes the poster face. The seeded stock
  // art is not this app's design and reads as clutter beside a drawn poster.
  const photo = event.image && event.image.startsWith('data:') ? event.image : '';

  return (
    <article className={`mb-poster mb-poster-${tier}`}>
      <PosterArt
        topic={topic}
        eyebrow={valid ? whenLabel(date) : ''}
        image={photo}
        tagline={tier === 'lg' ? event.description : ''}
        title={(
          <button type="button" className="mb-poster-open" onClick={() => onOpen(event)}>
            {event.title}
          </button>
        )}
      />

      <div className="mb-poster-foot">
        <span className="mb-poster-meta">
          <GeoAlt size={12} /> {neighborhood || event.location || 'Nearby'}
          <em>{distance || topic.label}</em>
        </span>
        <button
          type="button"
          className={`btn ${going ? 'btn-soft-primary' : 'btn-match'} mb-poster-cta`}
          onClick={() => onGoing(event)}
          aria-pressed={going}
        >
          {going ? "You're in" : "I'm in"}
        </button>
      </div>
    </article>
  );
};

EventPoster.propTypes = {
  event: PropTypes.shape({
    _id: PropTypes.string,
    title: PropTypes.string,
    description: PropTypes.string,
    date: PropTypes.oneOfType([PropTypes.instanceOf(Date), PropTypes.string]),
    location: PropTypes.string,
    image: PropTypes.string,
  }).isRequired,
  host: PropTypes.shape({
    name: PropTypes.string,
    categories: PropTypes.arrayOf(PropTypes.string),
    tags: PropTypes.arrayOf(PropTypes.string),
  }),
  neighborhood: PropTypes.string,
  distance: PropTypes.string,
  going: PropTypes.bool,
  onGoing: PropTypes.func,
  onOpen: PropTypes.func,
  tier: PropTypes.oneOf(['lg', 'md', 'sm']),
};

EventPoster.defaultProps = {
  host: null,
  neighborhood: '',
  distance: '',
  going: false,
  onGoing: () => {},
  onOpen: () => {},
  tier: 'md',
};

export default EventPoster;
