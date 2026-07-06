export const DEFAULT_CLUB_IMAGE = '/images/LogoCircle.png';
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
