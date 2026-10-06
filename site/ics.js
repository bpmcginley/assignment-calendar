// .ics generation, on the device.
import { addDays, keyToDate } from './time.js';

const pad = (n) => String(n).padStart(2, '0');
const utc = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const dateOnly = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

const enc = new TextEncoder();
function fold(line) {
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  let len = 0;
  for (const ch of line) {
    const l = enc.encode(ch).length;
    if (len + l > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; }
    cur += ch;
    len += l;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const srcName = (s) => (s === 'gradescope' ? 'Gradescope' : 'Canvas');

/**
 * items: normalized items (with _due and _day).
 * alarms: add reminders 1 day and 2 hours before.
 */
export function buildICS(items, { alarms = false, name = 'Assignment deadlines' } = {}) {
  const now = utc(new Date());
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Due//Assignment Calendar//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', `X-WR-CALNAME:${esc(name)}`];
  for (const it of items) {
    L.push('BEGIN:VEVENT', `UID:${esc(it.id)}@due.local`, `DTSTAMP:${now}`);
    if (it.all_day) {
      const d = keyToDate(it._day);
      L.push(`DTSTART;VALUE=DATE:${dateOnly(d)}`, `DTEND;VALUE=DATE:${dateOnly(addDays(d, 1))}`);
    } else {
      L.push(`DTSTART:${utc(it._due)}`, `DTEND:${utc(it._due)}`);
    }
    L.push(`SUMMARY:${esc(`${it.course}: ${it.title}`)}`);
    const where = [srcName(it.source), it.also ? srcName(it.also.source) : null].filter(Boolean).join(' and ');
    const desc = [`From ${where}.`, it.url ? it.url : null].filter(Boolean).join('\n');
    L.push(`DESCRIPTION:${esc(desc)}`);
    if (it.url && /^https?:/i.test(it.url)) L.push(`URL:${it.url}`);
    if (alarms) {
      for (const trig of ['-P1D', '-PT2H']) {
        L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(it.title)}`, `TRIGGER:${trig}`, 'END:VALARM');
      }
    }
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

/**
 * Must be called synchronously inside a click handler (no await before it).
 * Touch devices (the installed iPhone app has no Downloads UI) get the share sheet, which offers
 * Calendar or Save to Files. Mouse-first devices (the Windows laptop) keep a normal download.
 */
export function downloadICS(filename, text) {
  try {
    const file = new File([text], filename, { type: 'text/calendar' });
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
      navigator.share({ files: [file] }).catch(() => {});
      return;
    }
  } catch { /* fall back to a download */ }
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'deadline';
}
