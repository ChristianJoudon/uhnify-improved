import React from 'react';
import PropTypes from 'prop-types';

/**
 * Poster motifs. One simple, bold drawing per topic, tinted from the poster's
 * own ink so it sits inside the field rather than on top of it. Deliberately
 * loose — the irregularity lives here, never in the layout around it.
 */

const Outdoors = () => (
  <g>
    <path d="M100 22l26 44h-16l22 38h-18l20 34H66l20-34H68l22-38H74z" fill="currentColor" opacity="0.9" />
    <rect x="94" y="138" width="12" height="20" rx="3" fill="currentColor" opacity="0.55" />
    <circle cx="46" cy="46" r="15" fill="currentColor" opacity="0.28" />
    <path d="M8 158c34-10 60 8 92-2s58 6 92-4" stroke="currentColor" strokeWidth="4" fill="none" opacity="0.35" strokeLinecap="round" />
  </g>
);

const Music = () => (
  <g>
    <circle cx="70" cy="128" r="21" fill="currentColor" opacity="0.9" />
    <rect x="86" y="38" width="9" height="92" rx="4" fill="currentColor" opacity="0.9" />
    <circle cx="140" cy="112" r="17" fill="currentColor" opacity="0.65" />
    <rect x="153" y="34" width="8" height="80" rx="4" fill="currentColor" opacity="0.65" />
    <path d="M86 38c28-8 52-2 75-4v22c-24 2-47-4-75 4z" fill="currentColor" opacity="0.8" />
  </g>
);

const Books = () => (
  <g>
    <rect x="42" y="66" width="30" height="92" rx="5" fill="currentColor" opacity="0.85" />
    <rect x="78" y="52" width="28" height="106" rx="5" fill="currentColor" opacity="0.6" />
    <rect x="112" y="74" width="26" height="84" rx="5" fill="currentColor" opacity="0.9" />
    <rect x="142" y="88" width="24" height="70" rx="5" fill="currentColor" opacity="0.45" transform="rotate(11 154 123)" />
    <path d="M48 88h18M84 74h16M118 96h14" stroke="currentColor" strokeWidth="3.5" opacity="0.35" strokeLinecap="round" />
  </g>
);

const Food = () => (
  <g>
    <path d="M62 44v42a14 14 0 0 0 28 0V44" stroke="currentColor" strokeWidth="7" fill="none" opacity="0.9" strokeLinecap="round" />
    <rect x="72" y="86" width="8" height="72" rx="4" fill="currentColor" opacity="0.9" />
    <path d="M132 44c14 0 22 16 22 34s-8 22-22 22" stroke="currentColor" strokeWidth="7" fill="none" opacity="0.7" strokeLinecap="round" />
    <rect x="128" y="96" width="8" height="62" rx="4" fill="currentColor" opacity="0.7" />
    <circle cx="100" cy="132" r="26" fill="currentColor" opacity="0.18" />
  </g>
);

const Art = () => (
  <g>
    <path d="M100 40c34 0 60 22 60 50 0 20-16 26-30 26-10 0-16 6-16 14 0 10-8 16-20 16-32 0-54-24-54-56s26-50 60-50z" fill="currentColor" opacity="0.8" />
    <circle cx="76" cy="76" r="9" fill="currentColor" opacity="0.35" />
    <circle cx="108" cy="66" r="9" fill="currentColor" opacity="0.35" />
    <circle cx="132" cy="90" r="9" fill="currentColor" opacity="0.35" />
    <circle cx="80" cy="112" r="9" fill="currentColor" opacity="0.35" />
  </g>
);

const Community = () => (
  <g>
    <circle cx="66" cy="66" r="19" fill="currentColor" opacity="0.85" />
    <circle cx="134" cy="66" r="19" fill="currentColor" opacity="0.6" />
    <circle cx="100" cy="104" r="22" fill="currentColor" opacity="0.95" />
    <path d="M32 154c0-20 16-32 34-32s34 12 34 32z" fill="currentColor" opacity="0.55" />
    <path d="M100 154c0-20 16-32 34-32s34 12 34 32z" fill="currentColor" opacity="0.4" />
  </g>
);

const Wellness = () => (
  <g>
    <circle cx="100" cy="62" r="20" fill="currentColor" opacity="0.9" />
    <path d="M100 88c22 0 38 16 38 38 0 14-16 24-38 24s-38-10-38-24c0-22 16-38 38-38z" fill="currentColor" opacity="0.6" />
    <path d="M40 126c14-16 30-16 42-6M160 126c-14-16-30-16-42-6" stroke="currentColor" strokeWidth="5" fill="none" opacity="0.45" strokeLinecap="round" />
  </g>
);

const Night = () => (
  <g>
    <path d="M124 34a52 52 0 1 0 44 74A56 56 0 0 1 124 34z" fill="currentColor" opacity="0.9" />
    <circle cx="52" cy="52" r="4" fill="currentColor" opacity="0.7" />
    <circle cx="40" cy="96" r="3" fill="currentColor" opacity="0.5" />
    <circle cx="66" cy="128" r="3.5" fill="currentColor" opacity="0.6" />
    <path d="M96 146l4-11 4 11 11 4-11 4-4 11-4-11-11-4z" fill="currentColor" opacity="0.55" />
  </g>
);

const MOTIFS = {
  outdoors: Outdoors,
  music: Music,
  books: Books,
  food: Food,
  art: Art,
  community: Community,
  wellness: Wellness,
  night: Night,
};

const TopicMotif = ({ name, className }) => {
  const Shape = MOTIFS[name] || Community;
  return (
    <svg className={className} viewBox="0 0 200 176" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <Shape />
    </svg>
  );
};

TopicMotif.propTypes = {
  name: PropTypes.string,
  className: PropTypes.string,
};

TopicMotif.defaultProps = {
  name: 'community',
  className: 'mb-motif',
};

export default TopicMotif;
