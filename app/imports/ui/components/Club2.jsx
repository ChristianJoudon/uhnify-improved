import React from 'react';
import PropTypes from 'prop-types';
import { Button, Card, Image } from 'react-bootstrap';
import { DoorOpen } from 'react-bootstrap-icons';
import { imagePath, normalizeCategories } from '../utilities/helpers';

/** A quiet tile for a club the user has joined. */
const Club2 = ({ club, onRemoveFromProfile, onViewDetails }) => {
  const categories = normalizeCategories(club.categories);

  return (
    <Card className="club-card saved-card h-100">
      <div className="club-card-media compact">
        <Image src={imagePath(club.image)} alt={club.name} />
        {categories[0] && <span className="club-card-badge">{categories[0]}</span>}
      </div>
      <Card.Body className="d-flex flex-column">
        <Card.Title className="club-card-title">{club.name}</Card.Title>
        <div className="meta-line">{club.meetingTime} · {club.location}</div>
        <div className="club-card-actions mt-3">
          <Button type="button" onClick={() => onViewDetails(club)} className="btn-soft-primary">
            Details
          </Button>
          <Button type="button" onClick={() => onRemoveFromProfile(club._id)} className="btn-outline-danger-soft">
            <DoorOpen size={15} /> Leave
          </Button>
        </div>
      </Card.Body>
    </Card>
  );
};

Club2.propTypes = {
  club: PropTypes.shape({
    _id: PropTypes.string,
    clubID: PropTypes.number,
    name: PropTypes.string,
    image: PropTypes.string,
    meetingTime: PropTypes.string,
    location: PropTypes.string,
    description: PropTypes.string,
    categories: PropTypes.arrayOf(PropTypes.string),
  }).isRequired,
  onRemoveFromProfile: PropTypes.func.isRequired,
  onViewDetails: PropTypes.func.isRequired,
};

export default Club2;
