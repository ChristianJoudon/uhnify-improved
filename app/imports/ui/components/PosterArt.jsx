import React from 'react';
import PropTypes from 'prop-types';
import TopicMotif from './TopicMotif';

/**
 * The poster face, shared by the club card and the create-form previews, so a
 * draft looks exactly like the thing it will become.
 */
const PosterArt = ({ topic, eyebrow, title, tagline, image, placeholder }) => (
  <div
    className="mb-poster-art"
    style={image ? undefined : { background: topic.field, color: topic.ink }}
  >
    {image && <img className="mb-poster-photo" src={image} alt="" />}
    <div className={`mb-poster-copy${image ? ' on-photo' : ''}`}>
      {eyebrow && <span className="mb-poster-eyebrow">{eyebrow}</span>}
      <h3 className={`mb-poster-title${title ? '' : ' is-placeholder'}`}>{title || placeholder}</h3>
      {tagline && <p className="mb-poster-tagline">{tagline}</p>}
    </div>
    {!image && <TopicMotif name={topic.motif} />}
  </div>
);

PosterArt.propTypes = {
  topic: PropTypes.shape({
    field: PropTypes.string,
    ink: PropTypes.string,
    motif: PropTypes.string,
  }).isRequired,
  eyebrow: PropTypes.string,
  title: PropTypes.string,
  tagline: PropTypes.string,
  image: PropTypes.string,
  placeholder: PropTypes.string,
};

PosterArt.defaultProps = {
  eyebrow: '',
  title: '',
  tagline: '',
  image: '',
  placeholder: 'Untitled',
};

export default PosterArt;
