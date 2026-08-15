import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { topicForEvent } from '../utilities/topics';
import {
  dateForKey,
  dateKeyFor,
  eventsByDate,
  monthCellsFor,
  shiftedDateKey,
  shiftedMonthDate,
  sortAgendaEvents,
  startOfMonth,
} from './CountFirstCalendarModel';
import './CountFirstCalendar.css';

const WEEKDAYS = [
  ['Sunday', 'Sun', 'S'],
  ['Monday', 'Mon', 'M'],
  ['Tuesday', 'Tue', 'T'],
  ['Wednesday', 'Wed', 'W'],
  ['Thursday', 'Thu', 'T'],
  ['Friday', 'Fri', 'F'],
  ['Saturday', 'Sat', 'S'],
];

const MONTH_LABEL = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });
const DAY_LABEL = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});
const TIME_LABEL = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

const CountFirstCalendar = ({ events, onOpen, sort }) => {
  const today = useMemo(() => new Date(), []);
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(today));
  const [selectedDateKey, setSelectedDateKey] = useState(() => dateKeyFor(today));
  const gridRef = useRef(null);
  const focusSelected = useRef(false);
  const grouped = useMemo(() => eventsByDate(events), [events]);
  const cells = useMemo(() => monthCellsFor(visibleMonth), [visibleMonth]);
  const selectedEvents = useMemo(
    () => sortAgendaEvents(grouped[selectedDateKey] || [], sort),
    [grouped, selectedDateKey, sort],
  );
  const selectedDate = dateForKey(selectedDateKey) || today;

  useEffect(() => {
    if (!focusSelected.current) return;
    focusSelected.current = false;
    gridRef.current?.querySelector(`[data-date-key="${selectedDateKey}"]`)?.focus();
  }, [cells, selectedDateKey]);

  const selectDate = (key, moveFocus = false) => {
    const date = dateForKey(key);
    if (!date) return;
    focusSelected.current = moveFocus;
    setSelectedDateKey(key);
    if (date.getMonth() !== visibleMonth.getMonth() || date.getFullYear() !== visibleMonth.getFullYear()) {
      setVisibleMonth(startOfMonth(date));
    }
  };

  const changeMonth = amount => {
    const month = shiftedMonthDate(visibleMonth, amount);
    setVisibleMonth(month);
    setSelectedDateKey(dateKeyFor(month));
  };

  const handleDayKeyDown = (event, key) => {
    const date = dateForKey(key);
    if (!date) return;
    let nextKey = null;
    if (event.key === 'ArrowLeft') nextKey = shiftedDateKey(key, -1);
    if (event.key === 'ArrowRight') nextKey = shiftedDateKey(key, 1);
    if (event.key === 'ArrowUp') nextKey = shiftedDateKey(key, -7);
    if (event.key === 'ArrowDown') nextKey = shiftedDateKey(key, 7);
    if (event.key === 'Home') nextKey = shiftedDateKey(key, -date.getDay());
    if (event.key === 'End') nextKey = shiftedDateKey(key, 6 - date.getDay());
    if (event.key === 'PageUp') nextKey = dateKeyFor(new Date(date.getFullYear(), date.getMonth() - 1, 1));
    if (event.key === 'PageDown') nextKey = dateKeyFor(new Date(date.getFullYear(), date.getMonth() + 1, 1));
    if (!nextKey) return;
    event.preventDefault();
    selectDate(nextKey, true);
  };

  return (
    <section className="calendar-container count-first-calendar" aria-label="Event calendar">
      <div className="count-first-calendar__toolbar">
        <button
          type="button"
          className="count-first-calendar__today"
          onClick={() => selectDate(dateKeyFor(today))}
        >
          Today
        </button>
        <h2 className="count-first-calendar__month" aria-live="polite">
          {MONTH_LABEL.format(visibleMonth)}
        </h2>
        <div className="count-first-calendar__month-nav" aria-label="Change month">
          <button type="button" onClick={() => changeMonth(-1)} aria-label="Previous month">
            <span aria-hidden="true">←</span>
          </button>
          <button type="button" onClick={() => changeMonth(1)} aria-label="Next month">
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      <div
        ref={gridRef}
        className="count-first-calendar__grid"
        role="grid"
        aria-label={`${MONTH_LABEL.format(visibleMonth)} event counts`}
      >
        <div className="count-first-calendar__week" role="row">
          {WEEKDAYS.map(([full, compact, narrow]) => (
            <div key={full} className="count-first-calendar__weekday" role="columnheader" aria-label={full}>
              <span className="count-first-calendar__weekday-compact" aria-hidden="true">{compact}</span>
              <span className="count-first-calendar__weekday-narrow" aria-hidden="true">{narrow}</span>
            </div>
          ))}
        </div>
        {Array.from({ length: cells.length / 7 }, (_, weekIndex) => (
          <div className="count-first-calendar__week" role="row" key={cells[weekIndex * 7].key}>
            {cells.slice(weekIndex * 7, (weekIndex + 1) * 7).map(cell => {
              const count = grouped[cell.key]?.length || 0;
              const selected = cell.key === selectedDateKey;
              const countLabel = count === 1 ? '1 event' : `${count} events`;
              return (
                <div
                  key={cell.key}
                  className={`count-first-calendar__cell${cell.inMonth ? '' : ' is-outside'}`}
                  role="gridcell"
                  aria-selected={selected}
                >
                  <button
                    type="button"
                    className={`count-first-calendar__day${selected ? ' is-selected' : ''}${cell.isToday ? ' is-today' : ''}`}
                    data-date-key={cell.key}
                    tabIndex={selected ? 0 : -1}
                    aria-current={cell.isToday ? 'date' : undefined}
                    aria-label={`${DAY_LABEL.format(cell.date)}, ${countLabel}`}
                    onClick={() => selectDate(cell.key)}
                    onKeyDown={event => handleDayKeyDown(event, cell.key)}
                  >
                    <span className="count-first-calendar__date">{cell.dayNumber}</span>
                    {count > 0 && (
                      <span className="count-first-calendar__count has-events">
                        <span className="count-first-calendar__count-number">{count}</span>
                        <span className="count-first-calendar__count-word"> {count === 1 ? 'event' : 'events'}</span>
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <section className="count-first-calendar__agenda" aria-labelledby="selected-day-heading">
        <div className="count-first-calendar__agenda-heading">
          <div>
            <p className="count-first-calendar__eyebrow">Selected day</p>
            <h3 id="selected-day-heading">{DAY_LABEL.format(selectedDate)}</h3>
          </div>
          <span aria-live="polite">
            {selectedEvents.length} {selectedEvents.length === 1 ? 'event' : 'events'}
          </span>
        </div>

        {selectedEvents.length === 0 ? (
          <p className="count-first-calendar__agenda-empty">No events match these filters on this date.</p>
        ) : (
          <ul className="count-first-calendar__agenda-list">
            {selectedEvents.map(event => {
              const date = event.date instanceof Date ? event.date : new Date(event.date);
              const topic = topicForEvent(event);
              return (
                <li key={event._id}>
                  <button
                    type="button"
                    className="count-first-calendar__agenda-item"
                    style={{ '--calendar-topic-wash': topic.chip, '--calendar-topic-ink': topic.chipInk }}
                    onClick={() => onOpen(event)}
                  >
                    <time dateTime={date.toISOString()}>{TIME_LABEL.format(date)}</time>
                    <span className="count-first-calendar__agenda-copy">
                      <strong>{event.title || 'Untitled event'}</strong>
                      <span>{[event.location, topic.activityLabel || topic.label].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="count-first-calendar__agenda-action">View details</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
};

CountFirstCalendar.propTypes = {
  events: PropTypes.arrayOf(PropTypes.shape({
    _id: PropTypes.string.isRequired,
    title: PropTypes.string,
    date: PropTypes.oneOfType([PropTypes.instanceOf(Date), PropTypes.string]).isRequired,
    location: PropTypes.string,
  })).isRequired,
  onOpen: PropTypes.func.isRequired,
  sort: PropTypes.oneOf(['soonest', 'latest', 'title']).isRequired,
};

export default CountFirstCalendar;
