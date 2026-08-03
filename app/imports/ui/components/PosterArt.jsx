import React from 'react';
import PropTypes from 'prop-types';
import TopicMotif from './TopicMotif';

/**
 * The poster face, shared by the club card and the create-form previews, so a
 * draft looks exactly like the thing it will become.
 */
const PosterArt = ({ topic, eyebrow, title, tagline, image, placeholder, art }) => {
  // Three ways to dress a poster, in order of how specific they are: the
  // organizer's own photo, the topic's cover art, then the topic's pastel field
  // with its motif. `art` opts a surface out of the cover, because a wall of
  // twenty identical category posters says less than twenty pastel fields do.
  const cover = !image && art && topic.poster ? topic.poster : '';
  const onArt = Boolean(image || cover);
  return (
    <div
      className="mb-poster-art"
      style={onArt ? { background: '#303234', color: '#fff9f0' } : { background: topic.field, color: topic.ink }}
    >
      {image && <img className="mb-poster-photo" src={image} alt="" />}
      {cover && <img className="mb-poster-photo" src={cover} alt="" loading="lazy" />}
      <div className={`mb-poster-copy${onArt ? ' on-photo' : ''}`}>
        {eyebrow && <span className="mb-poster-eyebrow">{eyebrow}</span>}
        {/* A surface with nothing to head — the details sheet, whose title is
            already in the modal header — passes neither, and gets neither. */}
        {(title || placeholder) && (
          <h3 className={`mb-poster-title${title ? '' : ' is-placeholder'}`}>{title || placeholder}</h3>
        )}
        {tagline && <p className="mb-poster-tagline">{tagline}</p>}
      </div>
      {!onArt && <TopicMotif name={topic.motif} />}
    </div>
  );
};

PosterArt.propTypes = {
  topic: PropTypes.shape({
    field: PropTypes.string,
    ink: PropTypes.string,
    motif: PropTypes.string,
    poster: PropTypes.string,
  }).isRequired,
  eyebrow: PropTypes.string,
  // A node, so the club card can hand in its stretched open-button.
  title: PropTypes.node,
  tagline: PropTypes.string,
  image: PropTypes.string,
  placeholder: PropTypes.string,
  /** Use the topic's cover art when there is no uploaded photo. */
  art: PropTypes.bool,
};

PosterArt.defaultProps = {
  eyebrow: '',
  title: '',
  tagline: '',
  image: '',
  placeholder: 'Untitled',
  art: false,
};

export default PosterArt;
