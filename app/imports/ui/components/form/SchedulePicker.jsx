import React from 'react';
import PropTypes from 'prop-types';
import { DAY_NAMES, scheduleLabel } from '../../../api/club/schedule';

/**
 * Builds the structured schedule the calendars already understand, instead of
 * asking someone to type "Every other Wednesday at 7 PM" and hoping the parser
 * agrees.
 */
const SchedulePicker = ({ value, onChange }) => {
  const days = value.days || [];

  const toggleDay = day => onChange({
    ...value,
    days: days.includes(day) ? days.filter(item => item !== day) : [...days, day].sort(),
  });

  const label = scheduleLabel(value);

  return (
    <div className="schedule-picker">
      <div className="day-row" role="group" aria-label="Meeting days">
        {DAY_NAMES.map((name, index) => (
          <button
            key={name}
            type="button"
            className={`day-pill${days.includes(index) ? ' is-on' : ''}`}
            aria-pressed={days.includes(index)}
            aria-label={name}
            onClick={() => toggleDay(index)}
          >
            {name.slice(0, 1)}
          </button>
        ))}
      </div>

      <div className="schedule-row">
        <label htmlFor="club-time">
          At
          <input
            id="club-time"
            type="time"
            value={value.time || '17:00'}
            onChange={event => onChange({ ...value, time: event.target.value })}
          />
        </label>
        <label htmlFor="club-cadence">
          How often
          <select
            id="club-cadence"
            value={value.cadence || 'weekly'}
            onChange={event => onChange({ ...value, cadence: event.target.value })}
          >
            <option value="weekly">Every week</option>
            <option value="biweekly">Every other week</option>
          </select>
        </label>
      </div>

      <p className="schedule-echo">
        {label ? <>Meets <strong>{label}</strong></> : 'Pick the days you meet.'}
      </p>
    </div>
  );
};

SchedulePicker.propTypes = {
  value: PropTypes.shape({
    days: PropTypes.arrayOf(PropTypes.number),
    time: PropTypes.string,
    cadence: PropTypes.string,
  }).isRequired,
  onChange: PropTypes.func.isRequired,
};

export default SchedulePicker;
