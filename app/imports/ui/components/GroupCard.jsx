import React from 'react';
import PropTypes from 'prop-types';
import { imagePath } from '../utilities/helpers';

/**
 * Groups are persistent where events are time-sensitive — so a group card always
 * leads with its next real-world opportunity rather than reading as a directory row.
 */
const GroupCard = ({ club, neighborhood, next, members, onJoin, isMember }) => (
  <article className="mb-group">
    <div className="mb-group-mark">
      <img src={imagePath(club.image)} alt="" loading="lazy" />
    </div>
    <div className="mb-group-body">
      <h3 className="mb-group-name">{club.name}</h3>
      <p className="mb-group-meta">
        {(club.categories && club.categories[0]) || 'Group'}
        {neighborhood ? ` · ${neighborhood}` : ''}
        {members ? ` · ${members} members` : ''}
      </p>
      {next && <span className="mb-group-next"><i />Next: {next}</span>}
      {onJoin && (
        <div className="mb-card-actions">
          <button type="button" className={`btn ${isMember ? 'btn-soft-primary' : 'btn-solid-primary'}`} onClick={onJoin} disabled={isMember}>
            {isMember ? 'Joined' : 'Join'}
          </button>
        </div>
      )}
    </div>
  </article>
);

GroupCard.propTypes = {
  club: PropTypes.shape({
    _id: PropTypes.string,
    name: PropTypes.string,
    image: PropTypes.string,
    categories: PropTypes.arrayOf(PropTypes.string),
  }).isRequired,
  neighborhood: PropTypes.string,
  next: PropTypes.string,
  members: PropTypes.number,
  onJoin: PropTypes.func,
  isMember: PropTypes.bool,
};

GroupCard.defaultProps = {
  neighborhood: '',
  next: '',
  members: 0,
  onJoin: null,
  isMember: false,
};

export default GroupCard;
