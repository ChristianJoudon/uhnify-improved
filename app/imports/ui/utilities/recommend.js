/**
 * Content-based club relevance scoring — the first layer of recommendations.
 * Later layers (collaborative filtering, social-graph ranking) can add terms here.
 */

const overlap = (a, b) => {
  const setB = new Set(b.map(value => value.toLowerCase()));
  return a.filter(value => setB.has(value.toLowerCase())).length;
};

const fuzzyOverlap = (interests, tags) => {
  let hits = 0;
  interests.forEach(interest => {
    const low = interest.toLowerCase();
    tags.forEach(tag => {
      const tagLow = tag.toLowerCase();
      if (tagLow.includes(low) || low.includes(tagLow)) {
        hits += 1;
      }
    });
  });
  return hits;
};

// Deterministic per-club jitter so equal-score clubs interleave instead of clumping alphabetically.
const jitter = clubId => {
  let hash = 0;
  for (let i = 0; i < clubId.length; i++) {
    hash = (hash * 31 + clubId.charCodeAt(i)) % 997;
  }
  return hash / 997;
};

/**
 * Score a club for the signed-in user.
 * interests: profile interest strings; friendClubIds: Set of club _ids friends joined.
 */
export const scoreClub = (club, { interests = [], friendClubIds = new Set() } = {}) => {
  const categories = club.categories || [];
  const tags = club.tags || [];
  let score = 0;
  score += 2 * overlap(interests, categories);
  score += 3 * fuzzyOverlap(interests, tags);
  if (friendClubIds.has(club._id)) {
    score += 2.5;
  }
  score += jitter(club._id);
  return score;
};

/**
 * Split scored clubs into masonry size tiers: matches get room to breathe.
 * Clubs without a personal match fall back to deterministic variety (never a flat
 * wall of identical tiles) — the jitter fraction of the score picks their tier.
 */
export const sizeTier = score => {
  if (score >= 4) {
    return 'lg';
  }
  if (score >= 1.5) {
    return 'md';
  }
  const variety = score % 1; // jitter component, uniform-ish in [0, 1)
  if (variety > 0.8) {
    return 'lg';
  }
  if (variety > 0.35) {
    return 'md';
  }
  return 'sm';
};
