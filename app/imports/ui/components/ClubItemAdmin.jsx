import React from 'react';
import PropTypes from 'prop-types';
import { Button, Card, Image } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { PencilSquare, Trash } from 'react-bootstrap-icons';
import swal from 'sweetalert';
import { Meteor } from 'meteor/meteor';
import { imagePath, normalizeCategories } from '../utilities/helpers';

/** Renders a single club in the Admin dashboard. */
const ClubItemAdmin = ({ club }) => {
  const categories = normalizeCategories(club.categories);
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
            swal('Deleted', 'Club removed successfully.', 'success');
          }
        });
      }
    });
  };

  return (
    <Card className="admin-card h-100">
      <div className="admin-card-header-image">
        <Image src={imagePath(club.image)} alt={club.name} />
        {categories[0] && <span className="club-card-badge">{categories[0]}</span>}
      </div>
      <Card.Body className="d-flex flex-column">
        <Card.Title>{club.name}</Card.Title>
        <div className="meta-line">{club.meetingTime} · {club.location}</div>
        <div className="club-card-actions mt-auto">
          <Button as={Link} to={`/edit/${club._id}`} className="btn-soft-primary"><PencilSquare /> Edit</Button>
          <Button type="button" onClick={removeItem} className="btn-outline-danger-soft"><Trash /> Delete</Button>
        </div>
      </Card.Body>
    </Card>
  );
};

ClubItemAdmin.propTypes = {
  club: PropTypes.shape({
    _id: PropTypes.string,
    name: PropTypes.string,
    image: PropTypes.string,
    location: PropTypes.string,
    meetingTime: PropTypes.string,
    owner: PropTypes.string,
    categories: PropTypes.arrayOf(PropTypes.string),
  }).isRequired,
};

export default ClubItemAdmin;
