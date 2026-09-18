import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import swal from 'sweetalert';
import { AREA_LEVELS, BRIEFING_SECTIONS } from '../../api/help/Help';
import { formatShortDate } from '../utilities/helpers';

const report = error => error && swal('Not saved', error.reason || error.message, 'error');

const EMPTY = {
  section: 'glance',
  order: '',
  title: '',
  headline: '',
  details: '',
  level: 'interruptions',
  gettingAround: '',
  powerWater: '',
  beachesParks: '',
  recheck: '',
  url: '',
  sourceLabel: '',
};

/** What each section calls its fields, so the form asks in the report's own words. */
const LABELS = {
  glance: { title: 'Topic (Flights, Roads, Power & water…)', headline: 'The short answer', details: 'The rest of it' },
  area: { title: 'Area (Hanalei, Poʻipū / Kōloa…)', headline: 'One line of advice' },
  ahead: { title: 'Window (October 1–31)', details: 'What to expect', recheck: 'When to check again' },
  question: { title: 'The question', details: 'The answer' },
  link: { title: 'What it is (KIUC power restoration)' },
};

const Field = ({ id, label, value, onChange, rows, type, maxLength, required }) => (
  <label htmlFor={id}>
    {label}
    {rows
      ? <textarea id={id} rows={rows} maxLength={maxLength} value={value} onChange={e => onChange(e.target.value)} required={required} />
      : <input id={id} type={type || 'text'} maxLength={maxLength} value={value} onChange={e => onChange(e.target.value)} required={required} />}
  </label>
);

Field.propTypes = {
  id: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
  onChange: PropTypes.func.isRequired,
  rows: PropTypes.number,
  type: PropTypes.string,
  maxLength: PropTypes.number,
  required: PropTypes.bool,
};

Field.defaultProps = { rows: 0, type: 'text', maxLength: 2000, required: false };

/**
 * The administrator's side of the situation report: its header and switch,
 * one form for an item of any section, and the items grouped the way the
 * page draws them. The form changes shape with the section, because an
 * area has roads and water and a question has an answer, and a form that
 * shows every field for every kind is a form nobody fills in twice.
 */
const BriefingEditor = ({ briefing, items }) => {
  const [head, setHead] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const draft = head || { title: briefing?.title || '', lead: briefing?.lead || '', note: briefing?.note || '' };
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const labels = LABELS[form.section] || {};

  const setBriefing = active => Meteor.call('help.setBriefing', { active, ...draft }, error => {
    if (error) {
      report(error);
      return;
    }
    setHead(null);
  });
  const save = event => {
    event.preventDefault();
    const order = form.order === '' ? undefined : Number(form.order);
    Meteor.call('help.upsertBriefingItem', { ...form, order }, error => {
      if (error) {
        report(error);
        return;
      }
      setForm({ ...EMPTY, section: form.section });
    });
  };
  const edit = item => {
    setForm({
      ...EMPTY,
      ...Object.fromEntries(Object.entries(item).filter(([key, value]) => key in EMPTY && value !== undefined && value !== null)),
      _id: item._id,
      order: item.order,
    });
    // The form is above forty rows of report; "Edit" on the thirtieth must
    // not look like nothing happened.
    document.getElementById('help-admin-brief-item')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const remove = item => swal({ title: `Take "${item.title}" off the report?`, buttons: ['Keep it', 'Take it off'], dangerMode: true })
    .then(yes => yes && Meteor.call('help.removeBriefingItem', item._id, report));
  const loadExample = () => Meteor.call('help.loadBriefingExample', (error, count) => {
    if (error) {
      report(error);
      return;
    }
    swal('Loaded', `${count} lines from the Lowell example. Every one of them is a September reading — edit before turning the report on.`, 'success');
  });

  return (
    <>
      <section className="form-block" aria-labelledby="help-admin-brief">
        <h3 id="help-admin-brief">The situation report {briefing?.active ? '— on' : '— off'}</h3>
        <p className="field-hint">What the island looks like right now, area by area, with a date on it. Shown on the help page above where-to-find-help while it is on.</p>
        <Field id="brief-title" label="Title" maxLength={120} value={draft.title} onChange={value => setHead({ ...draft, title: value })} />
        <Field id="brief-lead" label="The position, in a sentence or two" rows={2} maxLength={400} value={draft.lead} onChange={value => setHead({ ...draft, lead: value })} />
        <Field id="brief-note" label="The caveat under it" maxLength={300} value={draft.note} onChange={value => setHead({ ...draft, note: value })} />
        <div className="moderation-row-actions">
          <button type="button" className="btn btn-match" onClick={() => setBriefing(true)}>{briefing?.active ? 'Update the report' : 'Turn the report on'}</button>
          {briefing?.active && <button type="button" className="btn btn-soft-primary" onClick={() => setBriefing(false)}>Turn it off</button>}
          {items.length === 0 && <button type="button" className="btn btn-soft-primary" onClick={loadExample}>Load the Lowell example</button>}
        </div>
        {briefing?.updatedAt && <p className="field-hint">Last changed {formatShortDate(briefing.updatedAt)}.</p>}
      </section>

      <form className="form-block" onSubmit={save} aria-labelledby="help-admin-brief-item">
        <h3 id="help-admin-brief-item">{form._id ? 'Edit a line of the report' : 'Add a line to the report'}</h3>
        <label htmlFor="brief-section">
          Which part
          <select id="brief-section" value={form.section} onChange={e => set('section', e.target.value)}>
            {BRIEFING_SECTIONS.map(section => <option key={section.value} value={section.value}>{section.label}</option>)}
          </select>
        </label>
        <Field id="brief-item-title" label={labels.title || 'Title'} maxLength={160} value={form.title} onChange={value => set('title', value)} required />
        {form.section === 'area' && (
          <label htmlFor="brief-level">
            How disrupted
            <select id="brief-level" value={form.level} onChange={e => set('level', e.target.value)}>
              {AREA_LEVELS.map(level => <option key={level.value} value={level.value}>{level.label}</option>)}
            </select>
          </label>
        )}
        {labels.headline && <Field id="brief-headline" label={labels.headline} maxLength={200} value={form.headline} onChange={value => set('headline', value)} />}
        {labels.details && <Field id="brief-details" label={labels.details} rows={3} maxLength={2000} value={form.details} onChange={value => set('details', value)} />}
        {form.section === 'area' && (
          <>
            <Field id="brief-roads" label="Getting around" maxLength={500} value={form.gettingAround} onChange={value => set('gettingAround', value)} />
            <Field id="brief-power" label="Power & water" maxLength={500} value={form.powerWater} onChange={value => set('powerWater', value)} />
            <Field id="brief-parks" label="Beaches & parks" maxLength={500} value={form.beachesParks} onChange={value => set('beachesParks', value)} />
          </>
        )}
        {labels.recheck && <Field id="brief-recheck" label={labels.recheck} maxLength={200} value={form.recheck} onChange={value => set('recheck', value)} />}
        {form.section !== 'link' && <Field id="brief-source" label="Who says so" maxLength={120} value={form.sourceLabel} onChange={value => set('sourceLabel', value)} />}
        <Field id="brief-url" label={form.section === 'link' ? 'The page (https)' : 'Their page (https)'} type="url" maxLength={500} value={form.url} onChange={value => set('url', value)} required={form.section === 'link'} />
        <Field id="brief-order" label="Position in its section (blank = last)" type="number" value={form.order} onChange={value => set('order', value)} />
        <div className="moderation-row-actions">
          <button type="submit" className="btn btn-solid-primary">{form._id ? 'Save' : 'Add'}</button>
          {form._id && <button type="button" className="btn btn-link" onClick={() => setForm(EMPTY)}>Never mind</button>}
        </div>
      </form>

      {BRIEFING_SECTIONS.map(section => {
        const rows = items.filter(item => item.section === section.value);
        return rows.length > 0 && (
          <section key={section.value} className="form-block" aria-labelledby={`help-admin-brief-${section.value}`}>
            <h3 id={`help-admin-brief-${section.value}`}>{section.label} · {rows.length}</h3>
            {rows.map(item => (
              <div key={item._id} className="moderation-row">
                <div className="moderation-row-main">
                  <strong>{item.title}</strong>
                  {' '}
                  <span className="field-hint">
                    #{item.order}
                    {item.level ? ` · ${AREA_LEVELS.find(level => level.value === item.level)?.label}` : ''}
                    {item.updatedAt ? ` · ${formatShortDate(item.updatedAt)}` : ''}
                  </span>
                  {(item.headline || item.details) && <p>{item.headline || item.details}</p>}
                </div>
                <div className="moderation-row-actions">
                  <button type="button" className="btn btn-soft-primary" onClick={() => edit(item)}>Edit</button>
                  <button type="button" className="btn btn-outline-danger-soft" onClick={() => remove(item)}>Remove</button>
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </>
  );
};

BriefingEditor.propTypes = {
  briefing: PropTypes.shape({
    active: PropTypes.bool,
    title: PropTypes.string,
    lead: PropTypes.string,
    note: PropTypes.string,
    updatedAt: PropTypes.instanceOf(Date),
  }),
  items: PropTypes.arrayOf(PropTypes.shape({
    _id: PropTypes.string,
    section: PropTypes.string,
    order: PropTypes.number,
    title: PropTypes.string,
    headline: PropTypes.string,
    details: PropTypes.string,
    level: PropTypes.string,
    updatedAt: PropTypes.instanceOf(Date),
  })).isRequired,
};

BriefingEditor.defaultProps = { briefing: null };

export default BriefingEditor;
