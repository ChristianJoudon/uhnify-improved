const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = value => String(value).padStart(2, '0');

export const dateKeyFor = value => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const dateForKey = key => {
  const match = typeof key === 'string' ? DATE_KEY.exec(key) : null;
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
};

export const startOfMonth = value => {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), 1);
};

export const monthCellsFor = value => {
  const month = startOfMonth(value);
  const firstCell = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay());
  const lastOfMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const lastCell = new Date(
    lastOfMonth.getFullYear(),
    lastOfMonth.getMonth(),
    lastOfMonth.getDate() + (6 - lastOfMonth.getDay()),
  );
  const todayKey = dateKeyFor(new Date());
  const cells = [];
  for (const date = new Date(firstCell); date <= lastCell; date.setDate(date.getDate() + 1)) {
    const cellDate = new Date(date);
    const key = dateKeyFor(cellDate);
    cells.push({
      key,
      date: cellDate,
      dayNumber: cellDate.getDate(),
      inMonth: cellDate.getMonth() === month.getMonth(),
      isToday: key === todayKey,
    });
  }
  return cells;
};

export const eventsByDate = events => {
  const grouped = {};
  events.forEach(event => {
    const key = dateKeyFor(event.date);
    if (!key) return;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(event);
  });
  return grouped;
};

const eventTime = event => {
  const date = event.date instanceof Date ? event.date : new Date(event.date);
  return Number.isNaN(date.getTime()) ? Number.POSITIVE_INFINITY : date.getTime();
};

export const sortAgendaEvents = (events, sort = 'soonest') => {
  if (sort === 'title') {
    return [...events].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  }
  const ordered = [...events].sort((a, b) => eventTime(a) - eventTime(b));
  return sort === 'latest' ? ordered.reverse() : ordered;
};

export const shiftedDateKey = (key, days) => {
  const date = dateForKey(key);
  if (!date) return null;
  date.setDate(date.getDate() + days);
  return dateKeyFor(date);
};

export const shiftedMonthDate = (value, months) => {
  const date = startOfMonth(value);
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
};
