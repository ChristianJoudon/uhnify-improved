import React from 'react';
import PropTypes from 'prop-types';

/**
 * One of a few, all on show.
 *
 * This replaces the native `<select>` everywhere the choice is short. That was
 * five places, and in the worst of them — a club's meeting cadence — a dropdown
 * was hiding a choice between exactly two things.
 *
 * The reason is not only that the OS widget looks nothing like the rest of the
 * app. It is that on macOS the open menu is drawn by the operating system,
 * outside the page, where no stylesheet reaches it: not the paper, not the
 * corner radius, not the typeface, not the tick. Restyling a select gets you a
 * handsome closed state and the same grey system menu the moment it is pressed.
 * The only way to be rid of that menu is to not need one — so when there are
 * five options or fewer, all five are on the line and the choice costs one tap
 * instead of two.
 *
 * Built on real radio inputs rather than buttons with ARIA. A radio group gets
 * arrow-key navigation, roving focus, form semantics and the correct screen
 * reader announcement from the platform, for free and correctly; the same
 * behaviour hand-rolled over `role="radio"` is a hundred lines that has to be
 * right on every browser. The inputs are hidden from sight, never from the
 * accessibility tree.
 */
const Segmented = ({ label, unit, name, value, options, onChange, size }) => (
  <div className={`mb-segmented-field${size === 'sm' ? ' is-sm' : ''}`}>
    {/* A group needs a name, not a label element: each option already carries
        its own, so a <label> here would be the second one and screen readers
        would read the whole thing twice. */}
    {label && <span className="mb-segmented-label" id={`${name}-label`}>{label}</span>}
    {/* No aria-label fallback to `name`: that is a grouping key like
        "mb-events-sort", and announcing it is worse than announcing nothing.
        A group with no visible caption is simply unnamed, and each option
        still names itself. */}
    <div className="mb-segmented" role="radiogroup" aria-labelledby={label ? `${name}-label` : undefined}>
      {options.map(option => (
        <label className="mb-segment" key={option.value} htmlFor={`${name}-${option.value}`}>
          <input
            id={`${name}-${option.value}`}
            type="radio"
            name={name}
            value={option.value}
            checked={String(value) === String(option.value)}
            onChange={() => onChange(option.value)}
            /* The radius track holds bare numerals so five of them fit a phone
               line — which reads correctly and announces as "2", "5", "10".
               `spoken` restores the sentence for anyone listening. */
            aria-label={option.spoken}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
    {unit && <span className="mb-segmented-unit">{unit}</span>}
  </div>
);

Segmented.propTypes = {
  /** The word before the options — "Within", "Sort". Omit for a bare group. */
  label: PropTypes.string,
  /** The word after them — "miles". Reads as a sentence: Within [25] miles. */
  unit: PropTypes.string,
  /** Groups the radios and seeds each option's id, so it must be unique per page. */
  name: PropTypes.string.isRequired,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
  options: PropTypes.arrayOf(PropTypes.shape({
    value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
    label: PropTypes.node.isRequired,
    /** Read instead of `label` by a screen reader, when the visible text is an
        abbreviation that only makes sense beside the group's caption. */
    spoken: PropTypes.string,
  })).isRequired,
  onChange: PropTypes.func.isRequired,
  /** `sm` is chip height, for a control that is not the point of its row. */
  size: PropTypes.oneOf(['md', 'sm']),
};

Segmented.defaultProps = {
  label: '',
  unit: '',
  size: 'md',
};

export default Segmented;
