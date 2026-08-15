export const FRIEND_ACTIVITY_VISIBILITY = Object.freeze({
  private: 'private',
  shareable: 'shareable',
});

const categoriesFor = record => {
  if (!record) return [];
  if (Array.isArray(record.categories)) return record.categories;
  return record.categories ? [record.categories] : [];
};

/**
 * Friend activity is opt-in at the row level. Missing source records fail
 * closed, and the sensitive support-group category is never shareable.
 */
export const friendActivityVisibilityFor = record => {
  if (!record) return FRIEND_ACTIVITY_VISIBILITY.private;
  return categoriesFor(record).includes('support_group')
    ? FRIEND_ACTIVITY_VISIBILITY.private
    : FRIEND_ACTIVITY_VISIBILITY.shareable;
};
