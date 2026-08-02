import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { X } from 'react-bootstrap-icons';

/**
 * Free-text entries as chips: type and press Enter (or comma) to commit, click
 * the × or press Backspace on an empty field to remove the last one.
 */
const ChipInput = ({ id, values, onChange, placeholder, max, hint }) => {
  const [draft, setDraft] = useState('');

  const add = raw => {
    const value = raw.trim().replace(/\s+/g, ' ');
    if (!value || values.length >= max) {
      return;
    }
    if (!values.some(existing => existing.toLowerCase() === value.toLowerCase())) {
      onChange([...values, value]);
    }
    setDraft('');
  };

  const handleKey = event => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add(draft);
    } else if (event.key === 'Backspace' && draft === '' && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div className="chip-input">
      <div className="chip-input-box">
        {values.map(value => (
          <span key={value} className="chip-input-chip">
            {value}
            <button type="button" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter(item => item !== value))}>
              <X size={13} />
            </button>
          </span>
        ))}
        <input
          id={id}
          type="text"
          value={draft}
          placeholder={values.length === 0 ? placeholder : ''}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={handleKey}
          onBlur={() => add(draft)}
        />
      </div>
      <span className="field-hint">
        {values.length >= max ? `That's the maximum of ${max}.` : hint}
      </span>
    </div>
  );
};

ChipInput.propTypes = {
  id: PropTypes.string,
  values: PropTypes.arrayOf(PropTypes.string).isRequired,
  onChange: PropTypes.func.isRequired,
  placeholder: PropTypes.string,
  max: PropTypes.number,
  hint: PropTypes.string,
};

ChipInput.defaultProps = {
  id: undefined,
  placeholder: '',
  max: 10,
  hint: 'Press Enter after each one.',
};

export default ChipInput;
