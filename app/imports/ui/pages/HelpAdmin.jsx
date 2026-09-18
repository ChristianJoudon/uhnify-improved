import React, { useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import { Container } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import swal from 'sweetalert';
import PageHead from '../components/PageHead';
import { EmergencyState, HelpResources, RESOURCE_KINDS, RESOURCE_STATUSES } from '../../api/help/Help';
import { formatShortDate } from '../utilities/helpers';

const report = error => error && swal('Not saved', error.reason || error.message, 'error');

const EMPTY = { kind: 'water', name: '', details: '', location: '', region: '', hours: '', status: 'open', sourcePublisher: '', sourceUrl: '' };

/**
 * The administrator's side of the help page: the switch for the banner, and
 * a form small enough to fill in from a phone standing in a parking lot.
 * Every row has one-tap Open / Closed, because the round somebody makes
 * after a storm is "is it still there?", not "let me edit the description".
 */
const HelpAdmin = () => {
  const { emergency, resources } = useTracker(() => {
    Meteor.subscribe(HelpResources.publicationName);
    Meteor.subscribe(EmergencyState.publicationName);
    return {
      emergency: EmergencyState.collection.findOne(EmergencyState.id),
      resources: HelpResources.collection.find({}, { sort: { kind: 1, name: 1 } }).fetch(),
    };
  });
  const [form, setForm] = useState(EMPTY);
  const [banner, setBanner] = useState(null);
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const bannerDraft = banner || { headline: emergency?.headline || '', message: emergency?.message || '' };

  const save = event => {
    event.preventDefault();
    Meteor.call('help.upsertResource', form, error => {
      if (error) {
        report(error);
        return;
      }
      setForm(EMPTY);
    });
  };
  const edit = resource => setForm({
    _id: resource._id,
    kind: resource.kind,
    name: resource.name,
    details: resource.details || '',
    location: resource.location || '',
    region: resource.region || '',
    hours: resource.hours || '',
    status: resource.status,
    sourcePublisher: resource.source?.publisher || '',
    sourceUrl: resource.source?.url || '',
  });
  const setStatus = (resource, status) => Meteor.call('help.setResourceStatus', resource._id, status, report);
  const remove = resource => swal({ title: `Take "${resource.name}" off the page?`, buttons: ['Keep it', 'Take it off'], dangerMode: true })
    .then(yes => yes && Meteor.call('help.removeResource', resource._id, report));
  const setEmergency = active => Meteor.call('help.setEmergency', { active, ...bannerDraft }, error => {
    if (error) {
      report(error);
      return;
    }
    setBanner(null);
  });

  return (
    <Container id="help-admin" className="page-shell py-4">
      <PageHead title="Help page" eyebrow="Admin" action={<Link to="/help" className="btn btn-soft-primary">See the page</Link>}>
        What the island is told during an emergency, and where to find help.
      </PageHead>

      <section className="form-block" aria-labelledby="help-admin-banner">
        <h3 id="help-admin-banner">The banner {emergency?.active ? '— on' : '— off'}</h3>
        <label htmlFor="banner-headline">
          Headline
          <input id="banner-headline" type="text" maxLength={120} value={bannerDraft.headline} onChange={e => setBanner({ ...bannerDraft, headline: e.target.value })} placeholder="Hurricane Lowell recovery" />
        </label>
        <label htmlFor="banner-message">
          One line under the title of the help page
          <input id="banner-message" type="text" maxLength={500} value={bannerDraft.message} onChange={e => setBanner({ ...bannerDraft, message: e.target.value })} placeholder="Water and ice distribution is open daily." />
        </label>
        <div className="moderation-row-actions">
          <button type="button" className="btn btn-match" onClick={() => setEmergency(true)}>{emergency?.active ? 'Update the banner' : 'Turn the banner on'}</button>
          {emergency?.active && <button type="button" className="btn btn-soft-primary" onClick={() => setEmergency(false)}>Turn it off</button>}
        </div>
        {emergency?.updatedAt && <p className="field-hint">Last changed {formatShortDate(emergency.updatedAt)}.</p>}
      </section>

      <form className="form-block" onSubmit={save} aria-labelledby="help-admin-add">
        <h3 id="help-admin-add">{form._id ? 'Edit a place' : 'Add a place'}</h3>
        <label htmlFor="res-kind">
          What it gives
          <select id="res-kind" value={form.kind} onChange={e => set('kind', e.target.value)}>
            {RESOURCE_KINDS.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
          </select>
        </label>
        <label htmlFor="res-name">Name<input id="res-name" type="text" maxLength={160} value={form.name} onChange={e => set('name', e.target.value)} required /></label>
        <label htmlFor="res-details">Details<textarea id="res-details" rows={2} maxLength={2000} value={form.details} onChange={e => set('details', e.target.value)} /></label>
        <label htmlFor="res-location">Where (an address or a place a map can find)<input id="res-location" type="text" maxLength={240} value={form.location} onChange={e => set('location', e.target.value)} /></label>
        <label htmlFor="res-region">Area<input id="res-region" type="text" maxLength={80} value={form.region} onChange={e => set('region', e.target.value)} placeholder="North Shore" /></label>
        <label htmlFor="res-hours">Hours<input id="res-hours" type="text" maxLength={200} value={form.hours} onChange={e => set('hours', e.target.value)} placeholder="Daily 8 AM–4 PM" /></label>
        <label htmlFor="res-status">
          Right now
          <select id="res-status" value={form.status} onChange={e => set('status', e.target.value)}>
            {RESOURCE_STATUSES.map(status => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <label htmlFor="res-publisher">Who says so<input id="res-publisher" type="text" maxLength={120} value={form.sourcePublisher} onChange={e => set('sourcePublisher', e.target.value)} placeholder="County of Kauaʻi" /></label>
        <label htmlFor="res-url">Their page (https)<input id="res-url" type="url" maxLength={500} value={form.sourceUrl} onChange={e => set('sourceUrl', e.target.value)} /></label>
        <div className="moderation-row-actions">
          <button type="submit" className="btn btn-solid-primary">{form._id ? 'Save' : 'Add'}</button>
          {form._id && <button type="button" className="btn btn-link" onClick={() => setForm(EMPTY)}>Never mind</button>}
        </div>
      </form>

      <section className="form-block" aria-labelledby="help-admin-list">
        <h3 id="help-admin-list">On the page · {resources.length}</h3>
        {resources.map(resource => (
          <div key={resource._id} className="moderation-row">
            <div className="moderation-row-main">
              <strong>{resource.name}</strong> <span className="field-hint">{RESOURCE_KINDS.find(k => k.value === resource.kind)?.label} · {resource.status}{resource.verifiedAt ? ` · checked ${formatShortDate(resource.verifiedAt)}` : ''}</span>
              {resource.location && <p>{resource.location}</p>}
            </div>
            <div className="moderation-row-actions">
              <button type="button" className="btn btn-soft-primary" onClick={() => setStatus(resource, 'open')}>Open</button>
              <button type="button" className="btn btn-soft-primary" onClick={() => setStatus(resource, 'closed')}>Closed</button>
              <button type="button" className="btn btn-soft-primary" onClick={() => edit(resource)}>Edit</button>
              <button type="button" className="btn btn-outline-danger-soft" onClick={() => remove(resource)}>Remove</button>
            </div>
          </div>
        ))}
      </section>
    </Container>
  );
};

export default HelpAdmin;
