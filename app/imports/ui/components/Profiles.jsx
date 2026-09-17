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
const ProfileCard = ({ profile, banned }) => {
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

  const toggleBan = () => {
    const done = error => error && swal('Not done', error.reason || error.message, 'error');
    if (banned) {
      Meteor.call('moderation.unban', profile.userId, done);
      return;
    }
    swal({
      title: `Ban ${name}?`,
      text: 'They cannot sign in, their open sessions end, and what they posted comes down. Say why — it is the record of the decision.',
      content: { element: 'input', attributes: { placeholder: 'Why' } },
      buttons: ['Not now', 'Ban'],
      dangerMode: true,
    }).then(reason => typeof reason === 'string' && Meteor.call('moderation.ban', profile.userId, reason, done));
  };

  return (
    <article className="mb-panel admin-person">
      {/* Decorative: the name it would announce is the very next element. */}
      <img className="admin-person-avatar" src={profileImagePath(profile.picture)} alt="" loading="lazy" decoding="async" />
      <div className="admin-person-body">
        <h3 className="admin-person-name">{name}</h3>
        <p className="admin-person-email">{profile.email}</p>
        {/* The one screen where a made-up name stands beside the account it
            belongs to — which is how "Sleepy Honu has been unkind" becomes a
            person somebody can talk to. Administrators only: no other
            publication sends the field for anybody but the reader themself. */}
        {profile.anonymousName && (
          <p className="admin-person-email">Anonymous name: {profile.anonymousName}</p>
        )}
        <span className="mb-chip mb-chip--static mb-chip--sm admin-person-role">{profile.title || 'Student'}</span>
        {/* Suspends the ACCOUNT: no sign-in, open sessions ended, their
            listings taken down. Lifting it does not put the listings back. */}
        {profile.userId && profile.userId !== Meteor.userId() && (
          <button type="button" className="btn btn-link admin-person-ban" onClick={toggleBan}>
            {banned ? 'Lift the ban' : 'Ban this account'}
          </button>
        )}
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
  banned: PropTypes.bool,
  profile: PropTypes.shape({
    userId: PropTypes.string,
    _id: PropTypes.string,
    UH_ID: PropTypes.number,
    email: PropTypes.string,
    firstName: PropTypes.string,
    lastName: PropTypes.string,
    title: PropTypes.string,
    picture: PropTypes.string,
    anonymousName: PropTypes.string,
  }).isRequired,
};

ProfileCard.defaultProps = {
  banned: false,
};

export default ProfileCard;
