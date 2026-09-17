import { isPhotoPath } from '../../api/listing/limits';

/* No club default. The retired Umify mark used to stand in here, which put a
   previous product's logo on the footer of all twenty-four imported groups —
   none of which publishes an image. A group with no logo simply shows none;
   its poster is already its artwork. */
export const DEFAULT_CLUB_IMAGE = '';
export const DEFAULT_EVENT_IMAGE = '/images/codingWorkshop.png';
export const DEFAULT_PROFILE_IMAGE = '/images/defaultprofilepic.png';

export const CLUB_CATEGORY_OPTIONS = [
  'Academic/Professional',
  'Arts',
  'Cultural',
  'Ethnic/Cultural',
  'Fraternity/Sorority',
  'Honorary Society',
  'Leisure/Recreational',
  'Political',
  'Religious/Spiritual',
  'Service',
  'Sports/Leisure',
  'Student Affairs',
  'Technology',
  'Other',
];

/**
 * Is this an uploaded photo, as opposed to app art or a logo URL? Only an
 * upload earns a poster's face, so eight components each asked this with
 * `startsWith('data:')`. That was the whole truth while an upload lived inline
 * on its listing — which also sent up to half a megabyte of base64 to every
 * visitor, with every document, whether or not the card was ever scrolled to.
 *
 * Uploads now live in their own collection and the listing carries the path
 * they are served from, so there are two right answers and both have to be
 * here: the path, and a data: URL — which is still what a form holds as its
 * unsaved preview, and what a row the migration has not reached still stores.
 * Asked in one place so the next change of storage is one edit, not eight.
 *
 * The path half is the server's own test, isPhotoPath, and not a copy of it.
 * For a while this file spelled '/photo/' out for itself; had the place photos
 * are served from ever moved, every poster would have quietly lost its photo
 * and nothing would have failed.
 */
export const isPhoto = value => isPhotoPath(value) || (typeof value === 'string' && value.startsWith('data:'));

/* A photo path needs no branch of its own: it is already root-relative, so the
   leading-slash case hands it back whole — version query included, which is
   what lets the year-long cache be replaced the moment the photo is. */
export const imagePath = (value, fallback = DEFAULT_CLUB_IMAGE) => {
  const image = value || fallback;
  if (!image) {
    return fallback;
  }
  if (image.startsWith('http') || image.startsWith('data:') || image.startsWith('/')) {
    return image;
  }
  return `/${image}`;
};

export const profileImagePath = value => imagePath(value, DEFAULT_PROFILE_IMAGE);

export const normalizeCategories = categories => {
  if (!categories) {
    return [];
  }
  if (Array.isArray(categories)) {
    return categories.filter(Boolean).map(category => `${category}`.trim()).filter(Boolean);
  }
  return `${categories}`
    .split(',')
    .map(category => category.trim())
    .filter(Boolean);
};

export const categoriesToText = categories => normalizeCategories(categories).join(', ');

export const truncateText = (text = '', maxLength = 180) => {
  if (!text || text.length <= maxLength) {
    return text || '';
  }
  return `${text.slice(0, maxLength).trim()}…`;
};

export const formatEventDate = value => {
  if (!value) {
    return 'Date TBD';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Date TBD';
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
};

export const formatShortDate = value => {
  if (!value) {
    return 'TBD';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'TBD';
  }
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
};

export const sortByName = items => [...items].sort((a, b) => (a.name || '').localeCompare(b.name || ''));

export const sortByDate = items => [...items].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
