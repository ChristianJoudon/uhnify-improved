import React, { useMemo, useRef, useState } from 'react';
import { Container, Form } from 'react-bootstrap';
import swal from 'sweetalert';
import { Meteor } from 'meteor/meteor';
import { useNavigate } from 'react-router-dom';
import { Camera, Trash } from 'react-bootstrap-icons';
import PosterArt from '../components/PosterArt';
import ChipInput from '../components/form/ChipInput';
import SchedulePicker from '../components/form/SchedulePicker';
import { scheduleLabel } from '../../api/club/schedule';
import { TOPICS, TOPIC_KEYS, topicFor } from '../utilities/topics';

const NAME_MAX = 70;
const ABOUT_MAX = 240;
const MAX_IMAGE_BYTES = 2000000;

const AddClub = () => {
  const navigate = useNavigate();
  const fileInput = useRef(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: '',
    description: '',
    location: '',
    contactInfo: '',
    topicKey: '',
    tags: [],
    image: '',
    schedule: { days: [], time: '17:00', cadence: 'weekly' },
  });

  const set = (field, value) => setForm(current => ({ ...current, [field]: value }));

  // Until a topic is picked, the preview shows what the club would be filed as
  // from its own words — the same resolution the finder will apply.
  const topic = useMemo(
    () => (form.topicKey ? { key: form.topicKey, ...TOPICS[form.topicKey], field: TOPICS[form.topicKey].fields[0] }
      : topicFor(form.name, form.description, form.tags)),
    [form.topicKey, form.name, form.description, form.tags],
  );

  const when = scheduleLabel(form.schedule);
  const valid = form.name.trim() && form.description.trim() && form.location.trim() && form.schedule.days.length > 0;

  const pickImage = event => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image')) {
      swal('Not an image', 'Please choose an image file.', 'error');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      swal('Too large', 'Please choose an image under 2 MB.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = e => set('image', e.target.result);
    reader.readAsDataURL(file);
  };

  const submit = event => {
    event.preventDefault();
    if (!valid || saving) {
      return;
    }
    setSaving(true);
    Meteor.call('Clubs.insert', {
      name: form.name.trim(),
      description: form.description.trim(),
      location: form.location.trim(),
      image: form.image || undefined,
      // The stored text stays human-readable; the structured schedule is what
      // the calendars actually expand.
      meetingTime: when || 'Schedule to come',
      contactInfo: form.contactInfo.trim() || undefined,
      categories: topic.label,
      tags: form.tags,
      schedule: form.schedule,
    }, error => {
      setSaving(false);
      if (error) {
        swal('Could not create', error.reason || error.message, 'error');
      } else {
        swal('Created', `${form.name.trim()} is live.`, 'success').then(() => navigate('/search-clubs'));
      }
    });
  };

  return (
    <Container id="add-clubs" className="page-shell py-4">
      <div className="page-intro">
        <h1>Start a group</h1>
        <p>People will find this by topic, distance, and when it meets.</p>
      </div>

      <div className="create-layout">
        <aside className="create-preview">
          <span className="create-preview-label">Preview</span>
          <div className="mb-poster mb-poster-lg">
            <PosterArt
              topic={topic}
              eyebrow={when}
              title={form.name}
              tagline={form.description}
              image={form.image}
              placeholder="Your group name"
            />
            <div className="mb-poster-foot">
              <span className="mb-poster-meta">
                {form.location || 'Where you meet'}
                <em>{topic.label}</em>
              </span>
            </div>
          </div>
          <p className="field-hint mt-2">This is how it appears in Nearby.</p>
        </aside>

        <form className="create-form" onSubmit={submit}>
          <section className="form-block">
            <h3>The basics</h3>
            <label htmlFor="name">
              Name
              <input
                id="name"
                type="text"
                value={form.name}
                maxLength={NAME_MAX}
                placeholder="Sunrise Hiking Crew"
                onChange={e => set('name', e.target.value)}
                required
              />
              <span className="field-hint">{form.name.length}/{NAME_MAX}</span>
            </label>

            <label htmlFor="description">
              What it&apos;s about
              <textarea
                id="description"
                rows={3}
                value={form.description}
                maxLength={ABOUT_MAX}
                placeholder="Who it's for and what you actually do."
                onChange={e => set('description', e.target.value)}
                required
              />
              <span className="field-hint">{form.description.length}/{ABOUT_MAX}</span>
            </label>

            <label htmlFor="location">
              Where you meet
              <input
                id="location"
                type="text"
                value={form.location}
                placeholder="Campus Center, Room 203"
                onChange={e => set('location', e.target.value)}
                required
              />
            </label>
          </section>

          <section className="form-block">
            <h3>When you meet</h3>
            <SchedulePicker value={form.schedule} onChange={value => set('schedule', value)} />
          </section>

          <section className="form-block">
            <h3>Topic</h3>
            <p className="form-note">Sets the poster and decides who gets shown this.</p>
            <div className="topic-picker">
              {TOPIC_KEYS.map(key => {
                const option = TOPICS[key];
                const on = form.topicKey === key;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`topic-pick${on ? ' is-on' : ''}`}
                    aria-pressed={on}
                    style={on ? { background: option.chip, borderColor: option.chipInk, color: option.chipInk } : undefined}
                    onClick={() => set('topicKey', on ? '' : key)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>

            <div className="mt-3">
              <span className="field-label">Tags</span>
              <ChipInput
                id="tags"
                values={form.tags}
                onChange={value => set('tags', value)}
                placeholder="board games, beginners welcome…"
                hint="Press Enter after each. These help people find you."
              />
            </div>
          </section>

          <section className="form-block">
            <h3>Photo</h3>
            <div className="photo-row">
              <button type="button" className="btn btn-soft-primary" onClick={() => fileInput.current.click()}>
                <Camera /> {form.image ? 'Replace photo' : 'Add a photo'}
              </button>
              {form.image && (
                <button type="button" className="btn btn-outline-danger-soft" onClick={() => set('image', '')}>
                  <Trash /> Remove
                </button>
              )}
              <Form.Control ref={fileInput} type="file" accept="image/*" onChange={pickImage} className="d-none" />
            </div>
            <span className="field-hint">Optional — without one we design a poster from your topic.</span>
          </section>

          <section className="form-block">
            <h3>Contact</h3>
            <label htmlFor="contactInfo">
              How people reach you
              <input
                id="contactInfo"
                type="text"
                value={form.contactInfo}
                placeholder="hello@yourgroup.org"
                onChange={e => set('contactInfo', e.target.value)}
              />
            </label>
          </section>

          <div className="create-actions">
            <button id="submit" type="submit" className="btn btn-solid-primary" disabled={!valid || saving}>
              {saving ? 'Creating…' : 'Create group'}
            </button>
            {!valid && <span className="field-hint">Name, what it&apos;s about, where, and at least one day.</span>}
          </div>
        </form>
      </div>
    </Container>
  );
};

export default AddClub;
