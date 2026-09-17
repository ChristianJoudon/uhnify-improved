import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { DAY_NAMES, WEEK_ORDINALS } from '../../../api/club/schedule';
import Segmented from './Segmented';
import {
  DEFAULT_START,
  echoLabel,
  endHint,
  initialEnd,
  lengthChoices,
  lengthLabel,
  lengthSpoken,
  scheduleFrom,
  toggleWeek,
  weekUnknown,
  weeksFor,
  withEndMode,
} from './SchedulePickerModel';

const CADENCES = [
  { value: 'weekly', label: 'Every week' },
  { value: 'biweekly', label: 'Every other week' },
  { value: 'monthly', label: 'Once a month' },
];

const END_MODES = [
  { value: 'at', label: 'Ends at' },
  { value: 'lasts', label: 'Lasts' },
  { value: 'none', label: 'No end' },
];

/**
 * A line that explains itself only when it has to. The box is always in the
 * page and the words come and go inside it: a screen reader announces a change
 * to a region it was already listening to, and says nothing about one that
 * arrives with its words already in it.
 */
const Hint = ({ id, children }) => (
  <div id={id} role="status">
    {children ? <span className="field-hint">{children}</span> : null}
  </div>
);

Hint.propTypes = {
  id: PropTypes.string.isRequired,
  children: PropTypes.string,
};

Hint.defaultProps = {
  children: '',
};

/**
 * Builds the structured schedule the calendars already understand, instead of
 * asking someone to type "Every other Wednesday at 7 PM" and hoping the parser
 * agrees.
 *
 * It knew one start and two cadences. A group that meets on the first and
 * third Thursday from 6:30 to 8 had to be entered as every Thursday at 6:30,
 * and the calendar then sent its members to an empty room two weeks in four.
 *
 * What it hands to `onChange` is always the stored shape (scheduleFrom). How
 * the end was asked for, and the weeks to go back to after a look at "Every
 * week", are held here and nowhere else; SchedulePickerModel has the reasons.
 */
const SchedulePicker = ({ value, onChange }) => {
  const days = value.days || [];
  const time = value.time || DEFAULT_START;
  const cadence = value.cadence || 'weekly';
  const weeks = cadence === 'monthly' ? value.weeks || [] : [];

  const [end, setEnd] = useState(() => initialEnd(value));
  const [rememberedWeeks, setRememberedWeeks] = useState(value.weeks || []);
  // A listing can arrive saying "monthly" and no more — the register's importer
  // wrote eight of them. That is a different thing to tell someone than "you
  // have unpicked every week", so how it arrived is remembered.
  const [arrivedUnknown] = useState(() => weekUnknown(value));

  const send = (patch, nextEnd = end) => onChange(scheduleFrom({ days, time, cadence, weeks, ...patch }, nextEnd));

  const changeEnd = nextEnd => {
    setEnd(nextEnd);
    send({}, nextEnd);
  };

  const toggleDay = day => send({
    days: days.includes(day) ? days.filter(item => item !== day) : [...days, day].sort((a, b) => a - b),
  });

  const pickWeek = week => {
    const next = toggleWeek(weeks, week);
    setRememberedWeeks(next);
    send({ weeks: next });
  };

  const label = echoLabel(value);
  const weekHint = arrivedUnknown
    ? 'Pick which week — the listing only said monthly'
    : 'Pick which week — without one it stays off the calendar';

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
        {/* Three options. This was a dropdown, which meant opening an OS menu
            to choose between "every week" and "every other week". */}
        <Segmented
          name="club-cadence"
          label="How often"
          size="sm"
          value={cadence}
          options={CADENCES}
          onChange={next => send({ cadence: next, weeks: weeksFor(next, rememberedWeeks, arrivedUnknown) })}
        />
      </div>

      {cadence === 'monthly' && (
        <div className="schedule-row">
          <div className="schedule-field">
            <span className="field-label" id="club-weeks-label">Which week</span>
            {/* Toggles, not a choice of one: "first and third Thursday" is the
                commonest monthly schedule there is. */}
            <div className="day-row" role="group" aria-labelledby="club-weeks-label" aria-describedby="club-weeks-hint">
              {WEEK_ORDINALS.map(ordinal => (
                <button
                  key={ordinal.value}
                  type="button"
                  className={`day-pill day-pill--word${weeks.includes(ordinal.value) ? ' is-on' : ''}`}
                  aria-pressed={weeks.includes(ordinal.value)}
                  onClick={() => pickWeek(ordinal.value)}
                >
                  {ordinal.label}
                </button>
              ))}
            </div>
            <Hint id="club-weeks-hint">{weeks.length === 0 ? weekHint : ''}</Hint>
          </div>
        </div>
      )}

      <div className="schedule-row">
        <label className="schedule-time" htmlFor="club-time">
          Starts
          <input
            id="club-time"
            type="time"
            value={time}
            // The end follows from here: a length is kept and the end moves
            // with the start; a typed end stays put and is checked again.
            onChange={event => send({ time: event.target.value || DEFAULT_START })}
          />
        </label>

        {/* One group for the end, asked both ways, because people think of it
            both ways. Whichever they answer, what is stored is an end time. */}
        <div className="schedule-field schedule-field--end">
          <Segmented
            name="club-end"
            label="Ends"
            size="sm"
            value={end.mode}
            options={END_MODES}
            onChange={mode => changeEnd(withEndMode(time, end, mode))}
          />
          {end.mode === 'at' && (
            <input
              id="club-end-time"
              type="time"
              aria-label="Ends at"
              aria-describedby="club-end-hint"
              value={end.at}
              onChange={event => changeEnd({ ...end, at: event.target.value })}
            />
          )}
          {end.mode === 'lasts' && (
            <div className="day-row" role="group" aria-label="How long it lasts" aria-describedby="club-end-hint">
              {lengthChoices(end.length).map(minutes => (
                <button
                  key={minutes}
                  type="button"
                  className={`day-pill day-pill--word${end.length === minutes ? ' is-on' : ''}`}
                  aria-pressed={end.length === minutes}
                  aria-label={lengthSpoken(minutes)}
                  onClick={() => changeEnd({ ...end, length: minutes })}
                >
                  {lengthLabel(minutes)}
                </button>
              ))}
            </div>
          )}
          <Hint id="club-end-hint">{endHint(time, end)}</Hint>
        </div>
      </div>

      <p className="schedule-echo" aria-live="polite">
        {label ? <>Meets <strong>{label}</strong></> : 'Pick the days you meet.'}
      </p>
    </div>
  );
};

SchedulePicker.propTypes = {
  value: PropTypes.shape({
    days: PropTypes.arrayOf(PropTypes.number),
    time: PropTypes.string,
    endTime: PropTypes.string,
    cadence: PropTypes.string,
    weeks: PropTypes.arrayOf(PropTypes.oneOfType([PropTypes.number, PropTypes.string])),
  }).isRequired,
  onChange: PropTypes.func.isRequired,
};

export default SchedulePicker;
