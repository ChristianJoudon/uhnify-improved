import React from 'react';
import PropTypes from 'prop-types';

/**
 * The MatchBook wordmark: drawn serif letterforms in the match orange, with a
 * struck match ruled underneath the word.
 *
 * The file is deliberately named differently from the mark it replaced. Serving
 * new artwork from the same path means every returning reader keeps the old one
 * out of their cache until it expires — the one change nobody would think to
 * hard-refresh for.
 *
 * Artwork rather than type-plus-SVG now, because the letterforms carry a
 * hand-drawn character no available typeface did. The file is cut to the ink
 * with no surrounding padding, so the CSS height is the height of the mark
 * itself and every surface can size it against its own type.
 */
const Wordmark = ({ className }) => (
  <img
    src="/images/matchbook-logo.png"
    alt="MatchBook"
    className={`mb-wordmark ${className}`.trim()}
  />
);

Wordmark.propTypes = {
  className: PropTypes.string,
};

Wordmark.defaultProps = {
  className: '',
};

export default Wordmark;
