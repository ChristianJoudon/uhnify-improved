import React from 'react';

const SKIN = ['#8d5524', '#c68642', '#f1c27d', '#7a4a21', '#e0ac69', '#a9673a'];
const HAIR = ['#2b2118', '#3f2d20', '#1c1a19', '#5a3a22', '#2b2118', '#141312'];
const SHIRT = ['#e6ae35', '#4c8177', '#e96d76', '#657d8c', '#f8f1e7', '#e6ae35'];

/**
 * Layer 2 — narrative editorial art: people packed into a matchbox like matches.
 * "A collection of people who fit together", stated without explanatory UI.
 * Deliberately loose silhouettes; the interface around it stays exact.
 */
const PeopleBoxArt = () => (
  <svg viewBox="0 0 560 400" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="People standing together inside an open matchbox">
    <rect width="560" height="400" fill="#f8f1e7" />

    {/* loose ink squiggles for paper texture */}
    <path d="M40 60c40-14 78 12 118-2" stroke="#e5d6c2" strokeWidth="3" fill="none" strokeLinecap="round" />
    <path d="M400 44c34 10 68-6 104 6" stroke="#e5d6c2" strokeWidth="3" fill="none" strokeLinecap="round" />

    {/* inner tray */}
    <rect x="96" y="120" width="368" height="150" rx="8" fill="#efe2cd" stroke="#303234" strokeWidth="3" />

    {/* the people-matches */}
    <g>
      {[0, 1, 2, 3, 4, 5].map(index => {
        const x = 128 + index * 58;
        const lift = index % 2 === 0 ? 0 : 12;
        return (
          <g key={index} transform={`translate(${x} ${96 + lift})`}>
            {/* stem / body */}
            <rect x="6" y="46" width="34" height="132" rx="8" fill={SHIRT[index]} stroke="#303234" strokeWidth="3" />
            {/* head */}
            <circle cx="23" cy="34" r="20" fill={SKIN[index]} stroke="#303234" strokeWidth="3" />
            {/* hair */}
            <path d="M3 30a20 20 0 0 1 40 0c0-14-8-22-20-22S3 16 3 30Z" fill={HAIR[index]} />
            {/* eyes: two calm dashes */}
            <path d="M15 34h5M27 34h5" stroke="#303234" strokeWidth="2.6" strokeLinecap="round" />
          </g>
        );
      })}
    </g>

    {/* outer sleeve, drawn over the lower half of the figures */}
    <g>
      <rect x="80" y="236" width="400" height="112" rx="10" fill="#df5834" stroke="#303234" strokeWidth="3" />
      {/* striker panel */}
      <rect x="80" y="300" width="400" height="48" rx="8" fill="#303234" />
      {/* starburst label */}
      <path
        d="M300 246l10 12 15-7-4 16 16 3-12 11 12 11-16 3 4 16-15-7-10 12-10-12-15 7 4-16-16-3 12-11-12-11 16-3-4-16 15 7z"
        fill="#f8f1e7"
        stroke="#303234"
        strokeWidth="2.5"
      />
      <text x="300" y="284" textAnchor="middle" fontFamily="Bricolage Grotesque, sans-serif" fontSize="17" fontWeight="750" fill="#df5834">
        NEARBY
      </text>
    </g>

    {/* one lit match drifting away — the invitation */}
    <g transform="translate(468 92) rotate(18)">
      <rect x="0" y="14" width="7" height="70" rx="3.5" fill="#f0d8b8" stroke="#303234" strokeWidth="2.5" />
      <ellipse cx="3.5" cy="12" rx="8" ry="11" fill="#df5834" />
    </g>
  </svg>
);

export default PeopleBoxArt;
