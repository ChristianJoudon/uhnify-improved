import React from 'react';
import { Button, Card, Image } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { PencilSquare, Trash } from 'react-bootstrap-icons';
import PropTypes from 'prop-types';
import swal from 'sweetalert';
import { Meteor } from 'meteor/meteor';
import { formatEventDate, imagePath, DEFAULT_EVENT_IMAGE } from '../utilities/helpers';

const EventCardAdmin = ({ event }) => {
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
            swal('Deleted', 'Event removed successfully.', 'success');
          }
        });
      }
    });
  };

  return (
    <Card className="admin-card h-100">
      <div className="admin-card-header-image">
        <Image src={imagePath(event.image, DEFAULT_EVENT_IMAGE)} alt={event.title} />
      </div>
      <Card.Body className="d-flex flex-column">
        <Card.Title>{event.title}</Card.Title>
        <div className="meta-line">{formatEventDate(event.date)} · {event.location}</div>
        <div className="club-card-actions mt-auto">
          <Button as={Link} to={`/edit/event/${event._id}`} className="btn-soft-primary"><PencilSquare /> Edit</Button>
          <Button type="button" onClick={removeItem} className="btn-outline-danger-soft"><Trash /> Delete</Button>
        </div>
      </Card.Body>
    </Card>
  );
};

EventCardAdmin.propTypes = {
  event: PropTypes.shape({
    _id: PropTypes.string,
    title: PropTypes.string,
    date: PropTypes.instanceOf(Date),
    location: PropTypes.string,
    createdBy: PropTypes.string,
    eventID: PropTypes.number,
    image: PropTypes.string,
  }).isRequired,
};

export default EventCardAdmin;
