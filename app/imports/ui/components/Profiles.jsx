import React from 'react';
import PropTypes from 'prop-types';
import { Button, Card, Image } from 'react-bootstrap';
import { Trash } from 'react-bootstrap-icons';
import swal from 'sweetalert';
import { Meteor } from 'meteor/meteor';
import { profileImagePath } from '../utilities/helpers';

/** Renders a profile card for the admin dashboard. */
const ProfileCard = ({ profile }) => {
  const removeItem = () => {
    swal({
      title: 'Delete profile?',
      text: `This removes the profile record for ${profile.email}.`,
      icon: 'warning',
      buttons: true,
      dangerMode: true,
    }).then(confirmed => {
      if (confirmed) {
        Meteor.call('Profiles.remove', profile._id, error => {
          if (error) {
            swal('Error', error.reason || error.message, 'error');
          } else {
            swal('Deleted', 'Profile removed successfully.', 'success');
          }
        });
      }
    });
  };

  return (
    <Card className="profile-card admin-profile-card h-100">
      <Card.Body className="text-center d-flex flex-column align-items-center">
        <Image src={profileImagePath(profile.picture)} alt={`${profile.firstName || 'User'} profile`} className="profile-avatar-lg" />
        <h4 className="mt-3 mb-1">{profile.firstName || ''} {profile.lastName || ''}</h4>
        <div className="profile-title-pill my-2">{profile.title || 'Student'}</div>
        <div className="meta-line">{profile.email}</div>
        <Button type="button" onClick={removeItem} className="btn-outline-danger-soft mt-auto"><Trash /> Delete</Button>
      </Card.Body>
    </Card>
  );
};

ProfileCard.propTypes = {
  profile: PropTypes.shape({
    _id: PropTypes.string,
    UH_ID: PropTypes.number,
    email: PropTypes.string,
    firstName: PropTypes.string,
    lastName: PropTypes.string,
    title: PropTypes.string,
    picture: PropTypes.string,
  }).isRequired,
};

export default ProfileCard;
