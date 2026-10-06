// Date and time formatting. en-US, device time zone.
export const MIN = 60000;
export const HOUR = 36e5;
export const DAY = 864e5;

const L = 'en-US';
const fTime = new Intl.DateTimeFormat(L, { hour: 'numeric', minute: '2-digit' });
const fWd = new Intl.DateTimeFormat(L, { weekday: 'short' });
const fWdLong = new Intl.DateTimeFormat(L, { weekday: 'long' });
const fMd = new Intl.DateTimeFormat(L, { month: 'short', day: 'numeric' });
const fMdLong = new Intl.DateTimeFormat(L, { month: 'long', day: 'numeric' });
const fMonthYear = new Intl.DateTimeFormat(L, { month: 'long', year: 'numeric' });

const pad = (n) => String(n).padStart(2, '0');

export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const utcDayKey = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export function keyToDate(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}
/** Whole calendar days from a to b (DST-safe). */
export const dayDiff = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);

export const time = (d) => fTime.format(d);            // 11:59 PM
export const wd = (d) => fWd.format(d);                // Tue
export const wdLong = (d) => fWdLong.format(d);        // Tuesday
export const md = (d) => fMd.format(d);                // Oct 6
export const mdLong = (d) => fMdLong.format(d);        // October 6
export const wdmd = (d) => `${wd(d)} ${md(d)}`;        // Tue Oct 6
export const monthYear = (d) => fMonthYear.format(d);  // October 2026

/** "2:10 PM" today, "Tue 2:10 PM" within the last 6 days, else "Sep 28, 2:10 PM". */
export function stamp(d, now = new Date()) {
  const diff = dayDiff(d, now);
  if (diff === 0) return time(d);
  if (diff > 0 && diff < 7) return `${wd(d)} ${time(d)}`;
  return `${md(d)}, ${time(d)}`;
}

/** "just now", "12 min ago", "3 hr ago", then "Mon 2:10 PM". */
export function ago(d, now = new Date()) {
  const ms = now - d;
  if (ms < MIN) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MIN)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} hr ago`;
  return stamp(d, now);
}

/** "38m", "4h 12m", "2d 3h". */
export function countdown(ms) {
  const m = Math.max(0, Math.floor(ms / MIN));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "4 hours 12 minutes" for screen readers. */
export function countdownSpoken(ms) {
  const m = Math.max(0, Math.floor(ms / MIN));
  if (m < 60) return plural(m, 'minute');
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${plural(h, 'hour')} ${plural(m % 60, 'minute')}` : plural(h, 'hour');
  const d = Math.floor(h / 24);
  return h % 24 ? `${plural(d, 'day')} ${plural(h % 24, 'hour')}` : plural(d, 'day');
}

/** "in 1 day, 7 hours", "in 38 minutes", "2 days ago". */
export function relLong(ms) {
  const future = ms >= 0;
  const a = Math.abs(ms);
  const m = Math.floor(a / MIN);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  let s;
  if (future) {
    if (d >= 1) s = h % 24 ? `${plural(d, 'day')}, ${plural(h % 24, 'hour')}` : plural(d, 'day');
    else if (h >= 1) s = m % 60 ? `${plural(h, 'hour')}, ${plural(m % 60, 'minute')}` : plural(h, 'hour');
    else s = plural(Math.max(1, m), 'minute');
    return `in ${s}`;
  }
  if (d >= 1) s = plural(d, 'day');
  else if (h >= 1) s = plural(h, 'hour');
  else if (m >= 1) s = plural(m, 'minute');
  else return 'just now';
  return `${s} ago`;
}

/** Relative calendar-day phrase: "today", "tomorrow", "in 3 days", "yesterday", "2 days ago". */
export function relDays(n) {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}
