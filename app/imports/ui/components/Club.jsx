import React from 'react';
import PropTypes from 'prop-types';
import { Badge, Button, Card, Image } from 'react-bootstrap';
import { CheckCircleFill, PlusCircle, Stars } from 'react-bootstrap-icons';
import { imagePath, normalizeCategories } from '../utilities/helpers';

/**
 * A club tile for the finder waterfall. `tier` sets the masonry footprint:
 * lg (tall image, tags, match reason) > md (standard) > sm (compact, no image).
 */
const Club = ({ club, onAddToProfile, onViewDetails, isMember, tier, matchLabel }) => {
  const categories = normalizeCategories(club.categories);
  const tags = (club.tags || []).slice(0, tier === 'lg' ? 3 : 2);
  return (
    <Card className={`club-card2 discovery-card club-tile-${tier}`}>
      <div className="club-card-media">
        <Image src={imagePath(club.image)} alt={club.name} loading="lazy" />
        {categories[0] && <span className="club-card-badge">{categories[0]}</span>}
      </div>
      <Card.Body className="d-flex flex-column">
        {tier === 'lg' && matchLabel && (
          <span className="match-pill"><Stars size={12} /> {matchLabel}</span>
        )}
        <Card.Title className="club-card-title">{club.name}</Card.Title>
        <div className="meta-line">{club.meetingTime} · {club.location}</div>
        {tags.length > 0 && tier !== 'sm' && (
          <div className="club-card-categories mt-2">
            {tags.map(tag => <Badge key={tag} className="club-category-tag">{tag}</Badge>)}
          </div>
        )}
        <div className="club-card-actions mt-3">
          <Button type="button" onClick={() => onViewDetails(club)} className="btn-soft-primary">
            Details
          </Button>
          <Button type="button" onClick={() => onAddToProfile(club._id)} className="btn-solid-primary" disabled={isMember}>
            {isMember ? <CheckCircleFill size={15} /> : <PlusCircle size={15} />}
            {isMember ? 'Joined' : 'Join'}
          </Button>
        </div>
      </Card.Body>
    </Card>
  );
};

Club.propTypes = {
  club: PropTypes.shape({
    _id: PropTypes.string,
    clubID: PropTypes.number,
    name: PropTypes.string,
    owner: PropTypes.string,
    description: PropTypes.string,
    location: PropTypes.string,
    image: PropTypes.string,
    meetingTime: PropTypes.string,
    contactInfo: PropTypes.string,
    categories: PropTypes.arrayOf(PropTypes.string),
    tags: PropTypes.arrayOf(PropTypes.string),
  }).isRequired,
  onAddToProfile: PropTypes.func,
  onViewDetails: PropTypes.func.isRequired,
  isMember: PropTypes.bool,
  tier: PropTypes.oneOf(['lg', 'md', 'sm']),
  matchLabel: PropTypes.string,
};

Club.defaultProps = {
  onAddToProfile: () => {},
  isMember: false,
  tier: 'md',
  matchLabel: '',
};

export default Club;
