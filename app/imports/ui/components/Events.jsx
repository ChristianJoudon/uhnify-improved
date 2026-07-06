import React from 'react';
import { Card, Image } from 'react-bootstrap';
import PropTypes from 'prop-types';
import { formatEventDate, formatShortDate, imagePath, DEFAULT_EVENT_IMAGE } from '../utilities/helpers';

/** A quiet event tile: inset image, date pill, title, one meta line. */
const EventCard = ({ event }) => (
  <Card className="event-card h-100">
    <div className="event-card-media">
      <Image src={imagePath(event.image, DEFAULT_EVENT_IMAGE)} alt={event.title} />
      <span className="event-date-pill">{formatShortDate(event.date)}</span>
    </div>
    <Card.Body>
      <Card.Title className="event-card-title">{event.title}</Card.Title>
      <div className="meta-line">{formatEventDate(event.date)} · {event.location}</div>
    </Card.Body>
  </Card>
);

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
