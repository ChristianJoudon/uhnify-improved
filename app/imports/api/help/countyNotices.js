/**
 * The County of Kauaʻi's latest press releases, read from the index page the
 * county publishes, for the top of the help page.
 *
 * During Lowell the county posted recovery updates, water-conservation
 * notices and road closures there several times a day. The ingestion
 * pipeline reaches the same page through its sitemap, but files everything
 * as an event for review; this reads the newest few directly, for a page
 * that has to be current without anybody approving anything. The index is
 * plain server-rendered HTML — one <article> per release with a title, a
 * "Published on" line and a first paragraph — so a handful of expressions
 * read it; if the county changes its template, this returns nothing and the
 * page says so rather than guessing.
 */
const ENTITIES = [
  [/&amp;/g, '&'],
  [/&#39;|&#x27;/g, '’'],
  [/&quot;/g, '"'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&nbsp;/g, ' '],
];

const decodeEntities = value => ENTITIES.reduce((out, [pattern, plain]) => out.replace(pattern, plain), value);

const clean = value => decodeEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const publishedOn = text => {
  const match = /published on\s+([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(text);
  if (!match) {
    return null;
  }
  const month = MONTHS.indexOf(match[1].toLowerCase().slice(0, 3));
  return month === -1 ? null : new Date(Date.UTC(Number(match[3]), month, Number(match[2]), 20));
};

const ARTICLE = /<article>([\s\S]*?)<\/article>/gi;
const LINK = /<a\s+href="([^"]+)"/i;
const TITLE = /<h2[^>]*class="[^"]*list-item-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i;
const PUBLISHED = /<p[^>]*class="[^"]*published-on[^"]*"[^>]*>([\s\S]*?)<\/p>/i;
const PARAGRAPH = /<p(?![^>]*class="[^"]*(?:published-on|oc-thumbnail)[^"]*")[^>]*>([\s\S]*?)<\/p>/gi;

/** [{ title, url, publishedOn, summary }], newest first as the page lists them. */
export const parseCountyNotices = (html, { limit = 8 } = {}) => [...html.matchAll(ARTICLE)]
  .map(match => match[1])
  .map(article => {
    const href = LINK.exec(article)?.[1];
    const title = TITLE.exec(article)?.[1];
    if (!href || !title || !/\/County-Press-Releases\//.test(href)) {
      return null;
    }
    const published = PUBLISHED.exec(article)?.[1] ?? '';
    const paragraphs = [...article.matchAll(PARAGRAPH)].map(m => clean(m[1])).filter(Boolean);
    return {
      title: clean(title),
      url: decodeEntities(href),
      publishedOn: publishedOn(clean(published)),
      summary: (paragraphs[0] || '').slice(0, 300),
    };
  })
  .filter(Boolean)
  .slice(0, limit);

export const COUNTY_PRESS_RELEASES_URL = 'https://www.kauai.gov/County-Press-Releases';
