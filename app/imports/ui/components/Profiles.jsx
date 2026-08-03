import React from 'react';
import PropTypes from 'prop-types';
import { Trash } from 'react-bootstrap-icons';
import swal from 'sweetalert';
import { Meteor } from 'meteor/meteor';
import { profileImagePath } from '../utilities/helpers';

/**
 * A person on the admin dashboard. A person is not a poster — there is no
 * artwork to be the card — so this is a plain panel with a face on it, which
 * also keeps it visually subordinate to the club and event posters above.
 */
const ProfileCard = ({ profile }) => {
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || profile.email;

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
            swal('Deleted', 'Profile removed.', 'success');
          }
        });
      }
    });
  };

  return (
    <article className="mb-panel admin-person">
      {/* Decorative: the name it would announce is the very next element. */}
      <img className="admin-person-avatar" src={profileImagePath(profile.picture)} alt="" loading="lazy" />
      <div className="admin-person-body">
        <h3 className="admin-person-name">{name}</h3>
        <p className="admin-person-email">{profile.email}</p>
        <span className="mb-chip mb-chip--static mb-chip--sm admin-person-role">{profile.title || 'Student'}</span>
      </div>
      <button
        type="button"
        className="mb-icon-btn mb-icon-btn--danger"
        onClick={removeItem}
        aria-label={`Delete the profile for ${name}`}
      >
        <Trash size={14} />
      </button>
    </article>
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
