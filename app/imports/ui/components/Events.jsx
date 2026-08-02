import React from 'react';
import { Card, Image } from 'react-bootstrap';
import PropTypes from 'prop-types';
import TopicMotif from './TopicMotif';
import { formatEventDate, formatShortDate } from '../utilities/helpers';
import { topicFor } from '../utilities/topics';

/** A quiet event tile: inset artwork, date pill, title, one meta line. */
const EventCard = ({ event }) => {
  // Same rule as the poster and swipe cards — only an uploaded photo becomes
  // the face; otherwise the tile is drawn from the event's own topic.
  const topic = topicFor(event.title, event.description);
  const photo = event.image && event.image.startsWith('data:') ? event.image : '';

  return (
    <Card className="event-card h-100">
      <div
        className={`event-card-media${photo ? ' has-photo' : ''}`}
        style={photo ? undefined : { background: topic.field, color: topic.ink }}
      >
        {photo
          ? <Image src={photo} alt={event.title} />
          : <TopicMotif name={topic.motif} />}
        <span className="event-date-pill">{formatShortDate(event.date)}</span>
      </div>
      <Card.Body>
        <Card.Title className="event-card-title">{event.title}</Card.Title>
        <div className="meta-line">{formatEventDate(event.date)} · {event.location}</div>
      </Card.Body>
    </Card>
  );
};

EventCard.propTypes = {
  event: PropTypes.shape({
    title: PropTypes.string,
    description: PropTypes.string,
    date: PropTypes.instanceOf(Date),
    location: PropTypes.string,
    createdBy: PropTypes.string,
    eventID: PropTypes.number,
    image: PropTypes.string,
  }).isRequired,
};

export default EventCard;
