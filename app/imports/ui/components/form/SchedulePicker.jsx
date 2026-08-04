import React from 'react';
import PropTypes from 'prop-types';
import { DAY_NAMES, scheduleLabel } from '../../../api/club/schedule';
import Segmented from './Segmented';

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
        {/* Two options. This was a dropdown, which meant opening an OS menu to
            choose between "every week" and "every other week". */}
        <Segmented
          name="club-cadence"
          label="How often"
          size="sm"
          value={value.cadence || 'weekly'}
          options={[
            { value: 'weekly', label: 'Every week' },
            { value: 'biweekly', label: 'Every other week' },
          ]}
          onChange={cadence => onChange({ ...value, cadence })}
        />
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
