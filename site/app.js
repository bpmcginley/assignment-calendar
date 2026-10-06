// Due: Canvas + Gradescope deadlines. Static, offline-capable, decrypts data.enc.json on the device.
import * as T from './time.js';
import * as S from './store.js';
import { buildICS, downloadICS, slug } from './ics.js';

const APP_VERSION = '1.0';
const DONE_KEY = 'due.done.v1';
const { DAY, HOUR, MIN } = T;
const HOLIDAY = /holiday|no class|recess|break/i;
const EXAM = /\b(exam|midterm|final)s?\b/i;
const NOT_EXAM = /review|practice|prep|study|sheet|guide|solution|project|paper|essay|report|presentation|draft|survey/i;
const FIXED_SLOTS = { 'COMPSCI 230': 1, 'COMPSCI 250': 2, 'COMPSCI 383': 3 };
const SRC_NAME = { canvas: 'Canvas', gradescope: 'Gradescope' };
const REFRESH_EVERY = 5 * MIN;
const FETCH_TIMEOUT = 15000;
const SHELL_PATHS = ['index.html', 'app.css', 'app.js', 'time.js', 'store.js', 'ics.js'];

// Wide layout only with real height: a landscape iPhone (393-440px tall) keeps the phone layout.
const wideMQ = matchMedia('(min-width: 768px) and (min-height: 560px)');
const finePointer = matchMedia('(pointer: fine)');
const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const isWide = () => wideMQ.matches;

const state = {
  payload: null,
  items: [],
  gen: null,
  courses: [],
  courseMap: new Map(),
  dataSource: null,        // 'enc' | 'plain'
  blob: null,              // last encrypted file seen
  keys: null,              // {base, aes, salt, iter}
  locked: false,
  fetching: false,
  showChecking: false,
  lastFetchAt: 0,
  fetchProblem: null,      // null | 'failed' | 'offline'
  loadFailed: false,
  freshMsg: null,
  freshMsgUntil: 0,
  tab: 'upcoming',         // Upcoming on every launch (not persisted)
  filter: 'all',           // never persisted
  expanded: new Set(),     // session only
  selectedId: null,        // wide-screen detail pane
  calSel: T.dayKey(new Date()),
  calOffset: 0,            // phone strip, in 4-week steps
  calMonth: T.dayKey(new Date()).slice(0, 7),
  overrides: S.lsGet(DONE_KEY, {}),
  sig: '',
  dayKey: T.dayKey(new Date()),
  shellBuild: null,        // short hash of the app files this page was loaded from
};
if (typeof state.overrides !== 'object' || Array.isArray(state.overrides)) state.overrides = {};

// ---------------------------------------------------------------- DOM helper

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

// ---------------------------------------------------------------- data model

function isExam(it) {
  if (it.kind === 'event') return EXAM.test(it.title) && !NOT_EXAM.test(it.title);
  return /\b(exam|midterm)s?\b/i.test(it.title) && !NOT_EXAM.test(it.title);
}

function normalize(raw) {
  const out = [];
  for (const it of Array.isArray(raw) ? raw : []) {
    if (!it || typeof it !== 'object' || !it.id || !it.due) continue;
    const due = new Date(it.due);
    if (Number.isNaN(+due)) continue;
    // A 12:00 AM deadline belongs to the night before: "due Wednesday at midnight", not Thursday.
    const midnight = !it.all_day && due.getHours() === 0 && due.getMinutes() === 0;
    const day = it.all_day ? T.utcDayKey(due) : T.dayKey(midnight ? new Date(due - 1) : due);
    const late = it.late_due ? new Date(it.late_due) : null;
    const n = {
      ...it,
      title: String(it.title || 'Untitled'),
      course: String(it.course || 'Other'),
      kind: it.kind === 'event' ? 'event' : 'assignment',
      _due: due,
      _day: day,
      _dayDate: T.keyToDate(day),
      _late: late && !Number.isNaN(+late) ? late : null,
      _midnight: midnight,
    };
    n._holiday = n.kind === 'event' && HOLIDAY.test(n.title);
    n._exam = !n._holiday && isExam(n);
    out.push(n);
  }
  out.sort((a, b) => (a._day === b._day ? a._due - b._due : a._day < b._day ? -1 : 1) || a.title.localeCompare(b.title));
  return out;
}

function hash(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return x >>> 0;
}

function computeCourses() {
  const codes = [...new Set(state.items.filter((i) => !i._holiday).map((i) => i.course))].sort();
  const dept = (c) => { const m = /^(.*?)\s*\d/.exec(c); return m ? m[1] : null; };
  // Courses in the main department show just their number ("230"); others keep the full code
  // ("MATH 235H"). One stray Gradescope course shouldn't turn every label into "COMPSCI 230".
  const counts = new Map();
  for (const c of codes) { const d = dept(c); if (d) counts.set(d, (counts.get(d) || 0) + 1); }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const mainDept = ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
  const short = (c) => mainDept !== null && dept(c) === mainDept;
  const used = new Set();
  const slots = new Map();
  for (const c of codes) {
    const f = FIXED_SLOTS[c.toUpperCase()];
    if (f) { slots.set(c, f); used.add(f); }
  }
  for (const c of codes) {
    if (slots.has(c)) continue;
    let s = hash(c.toUpperCase()) % 8;
    for (let k = 0; k < 8 && used.has(s + 1); k++) s = (s + 1) % 8;
    slots.set(c, s + 1);
    used.add(s + 1);
  }
  state.courses = codes.map((c) => ({ code: c, label: short(c) ? c.slice(dept(c).length).trim() : c, slot: slots.get(c) }));
  state.courseMap = new Map(state.courses.map((c) => [c.code, c]));
}
const courseOf = (code) => state.courseMap.get(code) || { code, label: code, slot: 6 };

function setPayload(p) {
  state.payload = p;
  state.gen = new Date(p.generated_at);
  if (Number.isNaN(+state.gen)) state.gen = new Date();
  state.items = normalize(p.items);
  computeCourses();
  if (state.filter !== 'all' && !state.courseMap.has(state.filter)) state.filter = 'all';
  if (state.selectedId && !itemById(state.selectedId)) state.selectedId = null;
  state.loadFailed = false;
}

const itemById = (id) => state.items.find((i) => i.id === id);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function isDone(it) {
  if (it.kind === 'event') return false;
  return hasOwn(state.overrides, it.id) ? !!state.overrides[it.id] : !!it.done;
}
const filterOk = (it) => state.filter === 'all' || it.course === state.filter;
const isPast = (it, now) => (it.all_day ? it._day < T.dayKey(now) : it._due <= now);
const onGradescope = (it) => it.source === 'gradescope' || it.also?.source === 'gradescope';
const gsSubmitted = (it) => !!it.status && !/no submission/i.test(it.status);
function sourceText(it) {
  if (it.also && it.also.source !== it.source) return 'Gradescope + Canvas';
  return SRC_NAME[it.source] || 'Canvas';
}

// ---------------------------------------------------------------- grouping

function buildGroups(now) {
  const today = T.startOfDay(now);
  const tk = T.dayKey(today);
  const kp = (n) => T.dayKey(T.addDays(today, n));
  const k7 = kp(7), k14 = kp(14), km7 = kp(-7);
  const late = [], days = new Map(), nextweek = [], later = [], past = [], done = [];
  const addDay = (k, it) => { if (!days.has(k)) days.set(k, []); if (it) days.get(k).push(it); };

  for (const it of state.items) {
    if (it._holiday || !filterOk(it)) continue;
    if (isDone(it)) { if (it._day >= km7) done.push(it); continue; }
    const pastDue = isPast(it, now);
    if (pastDue && it.kind !== 'event' && it._late && it._late > now) { late.push(it); continue; }
    if (it._day === tk) { addDay(tk, it); continue; }
    if (pastDue) { if (it.kind !== 'event' && it._day >= km7) past.push(it); continue; }
    if (it._day < k7) addDay(it._day, it);
    else if (it._day < k14) nextweek.push(it);
    else later.push(it);
  }

  const holidays = new Map();
  for (const it of state.items) {
    if (!it._holiday || it._day < tk || it._day >= k7) continue;
    if (!holidays.has(it._day)) holidays.set(it._day, new Set());
    holidays.get(it._day).add(it.title.replace(/\s*[-:]\s*no classes?\.?$/i, '').trim() || it.title);
    addDay(it._day);
  }

  const groups = [];
  if (late.length) groups.push({ key: 'late', ctx: 'late', title: 'Late window open', items: late, count: `${late.length} open` });
  for (const k of [...days.keys()].sort()) {
    const d = T.keyToDate(k);
    const diff = T.dayDiff(today, d);
    const items = days.get(k);
    const title = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : T.wdLong(d);
    const sub = diff <= 1 ? T.wdmd(d) : T.md(d);
    groups.push({
      key: `day:${k}`, ctx: diff === 0 ? 'today' : 'day', title, sub, items,
      count: items.length ? `${items.length} due` : '',
      note: holidays.has(k) ? `No classes: ${[...holidays.get(k)].join(', ')}` : null,
    });
  }
  if (nextweek.length) {
    const a = T.addDays(today, 7), b = T.addDays(today, 13);
    const sub = a.getMonth() === b.getMonth() ? `${T.md(a)} – ${b.getDate()}` : `${T.md(a)} – ${T.md(b)}`;
    groups.push({ key: 'nextweek', ctx: 'nextweek', title: 'Next week', sub, items: nextweek, count: `${nextweek.length} due` });
  }
  if (later.length) groups.push({ key: 'later', ctx: 'later', title: 'Later', items: later, count: `${later.length} due`, collapsible: true });
  if (past.length) {
    past.reverse();
    groups.push({ key: 'past', ctx: 'past', title: 'Past 7 days, not marked done', items: past, count: `${past.length} not done`, collapsible: true });
  }
  if (done.length) groups.push({ key: 'done', ctx: 'done', title: 'Done', items: done, count: `${done.length} done`, collapsible: true });
  return groups;
}

function nextUp(now) {
  const tk = T.dayKey(now);
  return state.items.find((it) => it.kind === 'assignment' && !it._holiday && filterOk(it) && !isDone(it)
    && (it.all_day ? it._day >= tk : it._due > now));
}
function nextExam(now) {
  const tk = T.dayKey(now);
  const limit = T.dayKey(T.addDays(T.startOfDay(now), 30));
  return state.items.find((it) => it._exam && filterOk(it) && !isDone(it) && it._day >= tk && it._day <= limit
    && (it.all_day || it._due > now || it._day === tk));
}

// ---------------------------------------------------------------- phrases

/** Clock time, or "midnight" for a 12:00 AM deadline (filed under the day before). */
const timeOf = (it) => (it._midnight ? 'midnight' : T.time(it._due));

function whenPhrase(it, now) {
  const diff = T.dayDiff(now, it._dayDate);
  if (it.all_day) {
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    return diff < 7 ? T.wdmd(it._dayDate) : T.md(it._dayDate);
  }
  const t = timeOf(it);
  if (diff === 0) return it._midnight ? 'midnight tonight' : it._due.getHours() >= 17 ? `tonight ${t}` : `today ${t}`;
  if (diff === 1) return `tomorrow ${t}`;
  if (diff > 1 && diff < 7) return `${T.wd(it._dayDate)} ${t}`;
  return `${T.md(it._dayDate)}, ${t}`;
}

function whenSpoken(it, now) {
  const diff = T.dayDiff(now, it._dayDate);
  const day = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : diff === -1 ? 'yesterday'
    : `${T.wdLong(it._dayDate)}, ${T.mdLong(it._dayDate)}`;
  if (it.all_day) return `${day}, all day`;
  return diff === 0 && it._midnight ? 'tonight at midnight' : `${day} at ${timeOf(it)}`;
}

function statusText(it, ctx, now, done) {
  if (ctx === 'late') return `Was due ${T.wd(it._dayDate)} ${timeOf(it)}`;
  if (done && state.overrides[it.id] === true && !it.done) return 'Marked done';
  if (onGradescope(it) && gsSubmitted(it)) return it.status;
  if (!done && it._late && it._late > now) return `Late until ${T.wd(it._late)} ${T.time(it._late)}`;
  return null;
}

function rightCols(it, ctx, now, done) {
  const t = it.all_day ? 'All day' : it._midnight ? 'Midnight' : T.time(it._due);
  const out = { r1: t, r2: null, cd: null };
  const soon = (d) => !done && d > now && d - now < DAY;
  switch (ctx) {
    case 'late':
      out.r1 = T.time(it._late);
      out.r2 = T.countdown(it._late - now);
      out.cd = it._late;
      break;
    case 'nextweek':
      out.r1 = T.wd(it._dayDate); out.r2 = t; break;
    case 'past':
      out.r1 = T.wd(it._dayDate); out.r2 = t; break;
    case 'later': case 'done':
      out.r1 = T.md(it._dayDate); out.r2 = t; break;
    default: // today, day, cal
      if (!it.all_day && soon(it._due)) { out.r2 = T.countdown(it._due - now); out.cd = it._due; }
  }
  return out;
}

function rowLabel(it, ctx, now) {
  const done = isDone(it);
  const parts = [];
  if (it.kind === 'event') parts.push(it._exam ? 'Exam' : 'Event');
  parts.push(it.course, it.title);
  if (ctx === 'late') {
    parts.push(`was due ${whenSpoken(it, now)}`, `late window closes ${T.wd(it._late)} at ${T.time(it._late)}`,
      `${T.countdownSpoken(it._late - now)} left`);
  } else {
    parts.push(`due ${whenSpoken(it, now)}`);
    if (!done && !it.all_day && it._due > now && it._due - now < DAY) parts.push(`${T.countdownSpoken(it._due - now)} left`);
    const st = statusText(it, ctx, now, done);
    if (st && st !== 'Marked done') parts.push(st);
  }
  parts.push(sourceText(it));
  if (it.kind !== 'event') parts.push(done ? 'done' : 'not done');
  return parts.join(', ') + '.';
}

// ---------------------------------------------------------------- components

function courseSq(code) {
  return h('span', { class: `sq c${courseOf(code).slot}`, 'aria-hidden': 'true' });
}

function rowEl(it, ctx, now) {
  const done = isDone(it);
  const li = h('li', {
    class: `row${ctx === 'today' && !done ? ' is-today' : ''}${done ? ' is-done' : ''}${state.selectedId === it.id && isWide() && state.tab === 'upcoming' ? ' is-selected' : ''}`,
    'data-id': it.id,
    'data-ctx': ctx,
  });

  if (it.kind === 'event') {
    li.append(h('span', { class: 'check-hit', 'aria-hidden': 'true' }));
  } else {
    const cb = h('input', { type: 'checkbox', class: 'check', 'aria-label': `Done: ${courseOf(it.course).label} ${it.title}`, tabindex: '-1' });
    cb.checked = done;
    cb.addEventListener('change', () => toggleDone(it, cb.checked, li));
    li.append(h('label', { class: 'check-hit' }, cb));
  }

  const st = statusText(it, ctx, now, done);
  const rc = rightCols(it, ctx, now, done);
  const r2 = rc.r2 ? h('span', { class: `r2${rc.cd && !done ? ' danger' : ''}`, 'data-cd': rc.cd ? rc.cd.toISOString() : null }, rc.r2) : null;
  const btn = h('button', {
    type: 'button',
    class: 'row-main',
    tabindex: '-1',
    'aria-label': rowLabel(it, ctx, now),
    'aria-current': li.classList.contains('is-selected') ? 'true' : null,
    onclick: () => openDetail(it.id, btn),
  },
  h('span', { class: 'row-inner' },
    h('span', { class: 'row-mid' },
      h('span', { class: 'row-title' },
        it.kind === 'event' ? h('span', { class: 'ev-tag' }, it._exam ? 'Exam' : 'Event') : null,
        it.title),
      h('span', { class: 'row-meta' },
        courseSq(it.course), courseOf(it.course).label, ` · ${sourceText(it)}`, st ? ` · ${st}` : null)),
    h('span', { class: 'row-right' }, h('span', { class: 'r1' }, rc.r1), r2)));
  li.append(btn);
  return li;
}

function groupEl(g, now) {
  const hid = `gh-${g.key.replace(/[^a-z0-9]+/gi, '-')}`;
  if (g.collapsible && !state.expanded.has(g.key)) {
    const n = g.items.length;
    return h('section', { class: 'group', 'aria-label': g.title },
      h('div', { class: 'inset' },
        h('button', {
          type: 'button', class: 'collapsed-btn', 'aria-expanded': 'false', 'data-focus-key': `grp:${g.key}`,
          onclick: () => { state.expanded.add(g.key); renderUpcoming(new Date()); focusFirstRowOf(g.key); },
        }, h('span', null, `${g.title} · ${n} ${n === 1 ? 'item' : 'items'}`), h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'))));
  }
  const sec = h('section', { class: 'group', 'aria-labelledby': hid, 'data-group': g.key },
    h('h2', { class: `group-h${g.ctx === 'today' ? ' is-today' : ''}`, id: hid },
      h('span', null, h('span', { class: 'h-main' }, g.title), g.sub ? h('span', { class: 'h-sub' }, ` · ${g.sub}`) : null),
      g.count ? h('span', { class: 'h-count' }, g.count) : null));
  if (g.note) sec.append(h('p', { class: 'group-note' }, g.note));
  if (g.items.length) sec.append(h('ul', { class: 'inset' }, g.items.map((it) => rowEl(it, g.ctx, now))));
  return sec;
}

function focusFirstRowOf(key) {
  const b = $(`#groups [data-group="${CSS.escape(key)}"] .row-main`);
  if (b) { setActiveRow(b.closest('.row')); b.focus(); }
}

// ---------------------------------------------------------------- rendering

function freshText(now) {
  if (state.freshMsg && Date.now() < state.freshMsgUntil) return state.freshMsg;
  if (state.showChecking) return 'Checking for new data…';
  if (!state.gen) return state.loadFailed ? "Couldn't load data." : '';
  let s = `Updated ${T.ago(state.gen, now)}`;
  if (state.filter !== 'all') s += ` · Showing ${courseOf(state.filter).label} only`;
  return s;
}

function sourceStatuses() {
  const p = state.payload;
  if (!p) return [];
  const ids = (Array.isArray(p.sources) && p.sources.length) ? p.sources
    : Object.keys(p.source_status || {}).length ? Object.keys(p.source_status) : ['canvas', 'gradescope'];
  return ids.map((id) => {
    const name = SRC_NAME[id] || id;
    const st = p.source_status?.[id];
    if (st) return { id, name, ok: !!st.ok, last: st.last_success ? new Date(st.last_success) : null, error: st.error || null };
    // Older payloads: derive from errors[] and generated_at.
    const err = (p.errors || []).find((e) => new RegExp(name, 'i').test(e));
    return { id, name, ok: !err, last: err ? null : state.gen, error: err ? err.replace(/^.*?:\s*/, '').replace(/\s*Showing its last saved data\.?$/, '') : null };
  });
}

function noticeFor(now) {
  if (!state.payload) return null;
  const gen = state.gen;
  const age = now - gen;
  const demo = !!state.payload.demo;
  if (state.fetchProblem) {
    // The device couldn't reach the site: say so, not "the automatic update may have stopped".
    const base = state.fetchProblem === 'offline' ? 'Offline.' : "Couldn't load new data.";
    const cls = age > DAY ? 'danger' : age > 3 * HOUR ? 'warn' : state.fetchProblem === 'offline' ? 'muted' : 'warn';
    return { cls, text: `${base} Showing data from ${T.stamp(gen, now)}.` };
  }
  if (!demo) {
    if (age > DAY) return { cls: 'danger', text: `Data hasn't updated since ${T.stamp(gen, now)}. The automatic update may have stopped. See Settings.` };
    if (age > 3 * HOUR) return { cls: 'warn', text: `Data is ${Math.floor(age / HOUR)} hours old. Deadlines added since then won't show yet.` };
    const srcs = sourceStatuses();
    const bad = srcs.find((s) => !s.ok);
    if (bad) {
      const good = srcs.filter((s) => s.ok).map((s) => s.name);
      const since = bad.last ? ` since ${T.stamp(bad.last, now)}` : '';
      const tail = good.length ? ` ${good.join(' and ')} ${good.length > 1 ? 'are' : 'is'} current.` : '';
      return { cls: 'warn', text: `${bad.name} hasn't updated${since}.${tail}` };
    }
  }
  if (demo) return { cls: 'muted', text: 'Showing sample data, not your courses.' };
  return null;
}

function renderChrome(now = new Date()) {
  const ft = freshText(now);
  $('#fresh-text').textContent = ft;
  $('#desk-fresh').textContent = ft;
  const n = noticeFor(now);
  for (const el of [$('#notice-upcoming'), $('#notice-calendar')]) {
    el.hidden = !n;
    if (n) { el.className = `notice ${n.cls}`; el.textContent = n.text; }
  }
  for (const el of $$('[data-last-updated]')) el.textContent = lastUpdatedText(now);
  for (const el of $$('[data-focus-key="set-refresh"]')) el.textContent = state.fetching ? 'Checking for new data…' : 'Refresh now';
}

function nextUpLabel(nu, now) {
  const urgent = !nu.all_day && nu._due - now < DAY;
  return `Next up: ${nu.course}, ${nu.title}, due ${whenSpoken(nu, now)}${urgent ? `, ${T.countdownSpoken(nu._due - now)} left` : ''}.`;
}

function renderSummary(now) {
  const root = $('#summary');
  root.replaceChildren();
  if (!state.payload) return;
  const nu = nextUp(now);
  if (nu) {
    const urgent = !nu.all_day && nu._due - now < DAY;
    const label = courseOf(nu.course).label;
    let amount;
    if (nu.all_day) amount = `due ${whenPhrase(nu, now)}`;
    else {
      const ms = nu._due - now;
      // Under 2 days the countdown ticks in place (data-cd); "N days" changes are caught by signature().
      const span = ms < 2 * DAY
        ? h('span', { 'data-cd': nu._due.toISOString() }, T.countdown(ms))
        : `${Math.floor(ms / DAY)} days`;
      amount = h('span', { class: urgent ? 'danger' : null }, span, ' left');
    }
    root.append(h('button', {
      type: 'button', class: 'sum-line', 'data-focus-key': 'nextup',
      'aria-label': nextUpLabel(nu, now),
      onclick: (e) => openDetail(nu.id, e.currentTarget),
    },
    h('span', { class: 'sum-label' }, 'Next up'),
    h('span', { class: 'sum-text' }, courseSq(nu.course), `${label} · ${nu.title} · `,
      amount, nu.all_day ? null : `, ${whenPhrase(nu, now)}`)));
  }
  const ex = nextExam(now);
  if (ex) {
    const diff = T.dayDiff(now, ex._dayDate);
    const label = courseOf(ex.course).label;
    root.append(h('button', {
      type: 'button', class: 'sum-line', 'data-focus-key': 'nextexam',
      'aria-label': `Next exam: ${ex.course}, ${ex.title}, ${T.wdLong(ex._dayDate)}, ${T.mdLong(ex._dayDate)}, ${T.relDays(diff)}.`,
      onclick: (e) => openDetail(ex.id, e.currentTarget),
    },
    h('span', { class: 'sum-label' }, 'Next exam'),
    h('span', { class: 'sum-text' }, courseSq(ex.course), `${label} ${ex.title} · ${T.wdmd(ex._dayDate)} · ${T.relDays(diff)}`)));
  }
}

function renderFilter() {
  const root = $('#filter');
  root.replaceChildren();
  root.className = 'filter';
  if (!state.payload || state.courses.length < 2) { root.className = ''; return; }
  const asSelect = () => {
    const sel = h('select', { class: 'filter-select', 'aria-label': 'Course', 'data-focus-key': 'filter-select' },
      h('option', { value: 'all' }, 'All courses'),
      state.courses.map((c) => h('option', { value: c.code }, c.label)));
    sel.value = state.filter;
    sel.addEventListener('change', () => setFilter(sel.value));
    root.replaceChildren(sel);
  };
  if (state.courses.length > 5) return asSelect();
  const opts = [{ code: 'all', label: 'All' }, ...state.courses];
  const track = h('div', { class: 'seg-track' }, opts.map((c) => h('button', {
    type: 'button', class: 'seg-btn', 'aria-pressed': String(state.filter === c.code),
    'aria-label': c.code === 'all' ? 'All courses' : c.code,
    'data-focus-key': `filter:${c.code}`,
    onclick: () => setFilter(c.code),
  }, c.label)));
  root.append(h('div', { class: 'seg', role: 'group', 'aria-label': 'Course' }, track));
  // Labels that don't fit (long codes, larger text sizes) fall back to a menu instead of running off-screen.
  // (Buttons flex down to fit, so check whether any label spills out of its button.)
  if (track.offsetWidth && [...track.children].some((b) => b.scrollWidth > b.clientWidth + 1)) asSelect();
}

function setFilter(code) {
  state.filter = code;
  renderAll({ keepFocus: true });
}

function renderGroups(now) {
  const root = $('#groups');
  root.replaceChildren();
  if (!state.payload) {
    root.append(h('div', { class: 'empty' }, h('p', null, state.loadFailed
      ? "Couldn't load deadlines. Check your connection, then try Refresh again."
      : 'Loading deadlines…')));
    return;
  }
  const real = state.items.filter((i) => !i._holiday);
  if (!real.length) {
    root.append(h('div', { class: 'empty' }, h('p', null, 'No deadlines found. If that looks wrong, check Data sources in Settings.')));
    return;
  }
  const groups = buildGroups(now);
  const soonKeys = new Set(['late']);
  const hasSoon = groups.some((g) => (soonKeys.has(g.key) || g.key.startsWith('day:')) && g.items.length);
  const hasOpen = groups.some((g) => g.key !== 'done' && g.key !== 'past' && g.items.length);

  if (state.filter !== 'all' && !hasOpen) {
    root.append(h('div', { class: 'empty' },
      h('p', null, `Nothing due for ${courseOf(state.filter).label} right now.`),
      h('button', { type: 'button', class: 'text-btn', 'data-focus-key': 'show-all', onclick: () => setFilter('all') }, 'Show all courses')));
  } else if (!hasSoon) {
    const nx = nextUp(now);
    const box = h('div', { class: 'empty' }, h('p', null, 'Nothing due in the next 7 days.'));
    if (nx) {
      box.append(h('button', {
        type: 'button', class: 'text-btn', 'data-focus-key': 'empty-next',
        onclick: (e) => openDetail(nx.id, e.currentTarget),
      }, `Next: ${courseOf(nx.course).label} ${nx.title}, ${T.wdmd(nx._dayDate)}.`));
    }
    root.append(box);
  }
  for (const g of groups) root.append(groupEl(g, now));
  initRoving(root);
}

function renderUpcoming(now = new Date()) {
  renderSummary(now);
  renderFilter();
  renderGroups(now);
  if (isWide()) renderDetailPane(now);
}

function renderDetailPane(now = new Date()) {
  const pane = $('#detail-pane');
  const it = state.selectedId && itemById(state.selectedId);
  pane.replaceChildren(it ? detailContent(it, now, { sheet: false }) : h('p', { class: 'placeholder' }, 'Select an item to see details.'));
}

// ---------------------------------------------------------------- detail

function detailContent(it, now, { sheet }) {
  const done = isDone(it);
  const wrap = h('div', { class: 'detail' });
  if (sheet) {
    wrap.append(h('div', { class: 'sheet-bar' },
      h('button', { type: 'button', class: 'text-btn hit', onclick: () => closeSheet() }, 'Done')));
  }
  wrap.append(
    h('p', { class: 'd-course' }, courseSq(it.course), it.course, it.kind === 'event' ? ` · ${it._exam ? 'Exam' : 'Event'}` : ''),
    h('h2', { class: 'd-title', id: sheet ? 'detail-title' : 'pane-title', tabindex: '-1' }, it.title));

  const rows = [];
  let dueMain, dueSub;
  if (it.all_day) {
    dueMain = `${T.wdmd(it._dayDate)}, all day`;
    dueSub = T.relDays(T.dayDiff(now, it._dayDate));
  } else {
    dueMain = it._midnight ? `${T.wdmd(it._dayDate)}, midnight` : `${T.wdmd(it._due)}, ${T.time(it._due)}`;
    dueSub = it._midnight ? `12:00 AM ${T.wd(it._due)} · ${T.relLong(it._due - now)}` : T.relLong(it._due - now);
  }
  rows.push(['Due', dueMain, dueSub]);
  if (it._late) rows.push(['Late until', `${T.wdmd(it._late)}, ${T.time(it._late)}`, T.relLong(it._late - now)]);
  if (it.kind !== 'event') {
    let st;
    if (onGradescope(it)) st = gsSubmitted(it) ? it.status : 'No submission on Gradescope';
    else st = "Canvas doesn't report submissions";
    rows.push(['Status', st, state.overrides[it.id] === true ? 'Marked done on this device' : state.overrides[it.id] === false ? 'Marked not done on this device' : null]);
  }
  const srcs = [it.source, it.also?.source].filter((s, i, a) => s && a.indexOf(s) === i);
  srcs.sort((a, b) => (a === 'gradescope' ? -1 : b === 'gradescope' ? 1 : 0));
  rows.push(['Source', srcs.map((s) => SRC_NAME[s] || s).join(' and ')]);
  wrap.append(h('dl', { class: 'd-group' }, rows.map(([k, v, sub]) => h('div', { class: 'kv' },
    h('dt', null, k), h('dd', null, v, sub ? h('span', { class: 'sub' }, sub) : null)))));

  const links = [];
  const add = (src, url) => { const u = safeUrl(url); if (u && !links.some((l) => l.src === src)) links.push({ src, u }); };
  add(it.source, it.url);
  if (it.also) add(it.also.source, it.also.url);
  links.sort((a, b) => (a.src === 'gradescope' ? -1 : b.src === 'gradescope' ? 1 : 0));

  const acts = h('div', { class: 'd-group' });
  for (const l of links) {
    acts.append(h('a', { class: 'act', href: l.u, target: '_blank', rel: 'noopener noreferrer' }, `Open in ${SRC_NAME[l.src] || l.src}`));
  }
  if (it.kind !== 'event') {
    acts.append(h('button', {
      type: 'button', class: 'act', 'data-focus-key': 'detail-mark',
      onclick: () => toggleDone(it, !isDone(it), null),
    }, done ? 'Mark as not done' : 'Mark as done'));
  }
  acts.append(h('button', {
    type: 'button', class: 'act',
    onclick: () => downloadICS(`${slug(`${it.course} ${it.title}`)}.ics`, buildICS([it], { alarms: true })),
  }, 'Add to Calendar'));
  wrap.append(acts);

  if (done && onGradescope(it) && !gsSubmitted(it)) wrap.append(h('p', { class: 'd-foot' }, 'Not submitted on Gradescope yet.'));
  return wrap;
}

let sheetReturn = null;
let sheetPushed = false;
let sheetItemId = null;

function openDetail(id, from) {
  const it = itemById(id);
  if (!it) return;
  const now = new Date();
  if (isWide() && state.tab === 'upcoming') {
    state.selectedId = id;
    for (const r of $$('#groups .row')) {
      const on = r.dataset.id === id;
      r.classList.toggle('is-selected', on);
      const b = r.querySelector('.row-main');
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
    renderDetailPane(now);
    $('#pane-title')?.focus({ preventScroll: true });
    $('#detail-pane').scrollTop = 0;
    return;
  }
  const dlg = $('#sheet');
  sheetItemId = id;
  sheetReturn = from || document.activeElement;
  dlg.replaceChildren(detailContent(it, now, { sheet: true }));
  if (!dlg.open) {
    dlg.showModal();
    try { history.pushState({ dueSheet: id }, ''); sheetPushed = true; } catch { sheetPushed = false; }
  }
  dlg.scrollTop = 0;
  $('#detail-title', dlg)?.focus({ preventScroll: true });
}

function closeSheet() {
  const dlg = $('#sheet');
  if (dlg.open) dlg.close();
}

/** Focus the row for an item if it is on screen, else the view's title (never leave focus on <body>). */
function focusItemOrTitle(id) {
  if (state.locked) return;
  const row = id && $(`#view-${state.tab} .row[data-id="${CSS.escape(id)}"]`);
  let t = row && row.querySelector('.row-main');
  if (t) setActiveRow(row);
  if (!t && isWide() && state.tab === 'upcoming') t = $('#groups .row-main[tabindex="0"]');
  if (!t) {
    const hd = $(`#view-${state.tab} .large-title`);
    if (hd && hd.offsetParent) { hd.tabIndex = -1; t = hd; }
  }
  t?.focus({ preventScroll: true });
}

function onSheetClosed() {
  const closedId = sheetItemId;
  sheetItemId = null;
  if (sheetPushed) {
    sheetPushed = false;
    if (history.state && history.state.dueSheet) history.back();
  }
  const ret = sheetReturn;
  sheetReturn = null;
  if (state.locked) return;
  if (ret && ret.isConnected) { ret.focus({ preventScroll: true }); return; }
  // The opener was re-rendered (tick, refresh) or its row moved (marked done): find its replacement.
  const key = ret?.dataset?.focusKey;
  const again = key && $(`[data-focus-key="${CSS.escape(key)}"]`);
  if (again) { again.focus({ preventScroll: true }); return; }
  focusItemOrTitle(ret?.closest?.('[data-id]')?.dataset.id || closedId);
}

function refreshSheet() {
  const dlg = $('#sheet');
  if (!dlg.open || !sheetItemId) return;
  const it = itemById(sheetItemId);
  if (!it) { closeSheet(); return; }
  const focusKey = document.activeElement?.dataset?.focusKey;
  const st = dlg.scrollTop;
  dlg.replaceChildren(detailContent(it, new Date(), { sheet: true }));
  dlg.scrollTop = st;
  const el = focusKey && $(`[data-focus-key="${focusKey}"]`, dlg);
  if (el) el.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- done marks

function setOverride(it, val) {
  const o = state.overrides;
  const prev = hasOwn(o, it.id) ? o[it.id] : undefined;
  if (val === !!it.done) delete o[it.id]; else o[it.id] = val;
  S.lsSet(DONE_KEY, o);
  return prev;
}
function restoreOverride(id, prev) {
  if (prev === undefined) delete state.overrides[id]; else state.overrides[id] = prev;
  S.lsSet(DONE_KEY, state.overrides);
}

function toggleDone(it, val, li) {
  const prev = setOverride(it, val);
  const fromRow = !!li;
  const hadFocus = li && li.contains(document.activeElement);
  const nextRow = li && (li.nextElementSibling || li.previousElementSibling);
  const nextId = nextRow?.dataset.id;

  const finish = () => {
    renderAll({ keepFocus: !hadFocus });
    if (hadFocus) {
      const target = (nextId && $(`#groups .row[data-id="${CSS.escape(nextId)}"]`)) || $('#groups .row');
      const cb = $(`.row[data-id="${CSS.escape(it.id)}"] .check`, $(`#view-${state.tab}`));
      const f = cb && state.tab === 'calendar' ? cb : target?.querySelector('.check, .row-main');
      if (f) { setActiveRow(f.closest('.row')); f.focus({ preventScroll: true }); }
    }
    const msg = val ? `Marked done: ${it.title}` : 'Marked not done';
    if ($('#sheet').open || $('#settings-dialog').open) { announce(msg); return; }
    // Keyboard users get longer, and a shortcut, since the toast is at the end of the page.
    const kbd = hadFocus && finePointer.matches;
    toast(kbd ? `${msg}. Press Z to undo.` : msg, () => {
      restoreOverride(it.id, prev);
      renderAll({ keepFocus: false });
      const cb = $(`#view-${state.tab} .row[data-id="${CSS.escape(it.id)}"] .check`);
      if (cb) { setActiveRow(cb.closest('.row')); cb.focus(); } else focusItemOrTitle(it.id);
    }, hadFocus ? 10000 : 5000);
  };

  if (fromRow && state.tab === 'upcoming') {
    setTimeout(() => {
      if (!li.isConnected) { finish(); return; }
      collapseRow(li).then(finish);
    }, 500);
  } else {
    finish();
  }
}

function collapseRow(li) {
  if (reduceMQ.matches) return Promise.resolve();
  return new Promise((resolve) => {
    const h0 = li.offsetHeight;
    li.style.height = `${h0}px`;
    li.classList.add('collapsing');
    void li.offsetHeight;
    li.style.height = '0px';
    li.style.opacity = '0';
    let doneFlag = false;
    const end = () => { if (!doneFlag) { doneFlag = true; resolve(); } };
    li.addEventListener('transitionend', end, { once: true });
    setTimeout(end, 260);
  });
}

// ---------------------------------------------------------------- toast & announcements

let toastTimer = null;
let toastLeft = 0;
let toastStarted = 0;
let toastHover = false;

function toast(msg, undo, life = 5000) {
  const region = $('#toast-region');
  clearTimeout(toastTimer);
  const el = h('div', { class: 'toast' },
    h('span', { class: 'toast-msg' }, msg),
    undo ? h('button', { type: 'button', class: 'toast-undo', onclick: () => { hideToast(); undo(); } }, 'Undo') : null);
  el.addEventListener('focusin', pauseToast);
  el.addEventListener('focusout', resumeToast);
  el.addEventListener('pointerenter', () => { toastHover = true; pauseToast(); });
  el.addEventListener('pointerleave', () => { toastHover = false; resumeToast(); });
  region.replaceChildren(el);
  toastHover = false;
  toastTimer = null;
  toastLeft = life;
  resumeToast();
}
function pauseToast() {
  if (!toastTimer) return; // already paused: don't subtract the same interval twice
  clearTimeout(toastTimer);
  toastTimer = null;
  toastLeft -= Date.now() - toastStarted;
}
function resumeToast() {
  const el = $('#toast-region .toast');
  if (!el || toastHover || el.contains(document.activeElement)) return;
  clearTimeout(toastTimer);
  toastStarted = Date.now();
  toastTimer = setTimeout(hideToast, Math.max(1500, toastLeft));
}
function hideToast() {
  clearTimeout(toastTimer);
  toastTimer = null;
  $('#toast-region').replaceChildren();
}

function announce(text) {
  const el = $('#sr-live');
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 50);
}

// ---------------------------------------------------------------- roving rows

function setRowTab(row, on) {
  for (const el of row.querySelectorAll('.row-main, .check')) el.tabIndex = on ? 0 : -1;
}
function setActiveRow(row) {
  if (!row) return;
  const cont = row.closest('[data-roving]');
  if (!cont) return;
  cont.dataset.active = row.dataset.id;
  for (const r of $$('.row', cont)) setRowTab(r, r === row);
}
function initRoving(cont) {
  const rows = $$('.row', cont);
  if (!rows.length) return;
  const active = rows.find((r) => r.dataset.id === cont.dataset.active) || rows[0];
  for (const r of rows) setRowTab(r, r === active);
}

function onRowKeydown(e) {
  const row = e.target.closest?.('.row');
  const cont = row?.closest('[data-roving]');
  if (!cont) return;
  const onCheck = e.target.matches('.check');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const rows = $$('.row', cont);
    const i = rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1);
    if (i < 0 || i >= rows.length) return;
    e.preventDefault();
    const next = rows[i];
    setActiveRow(next);
    (onCheck && next.querySelector('.check') || next.querySelector('.row-main')).focus();
  } else if (e.key === 'ArrowLeft' && !onCheck) {
    const cb = row.querySelector('.check');
    if (cb) { e.preventDefault(); cb.focus(); }
  } else if (e.key === 'ArrowRight' && onCheck) {
    e.preventDefault();
    row.querySelector('.row-main').focus();
  } else if (e.key === 'Enter' && onCheck) {
    e.preventDefault();
    row.querySelector('.row-main').click();
  }
}

// ---------------------------------------------------------------- calendar

function dayIndex() {
  const map = new Map();
  for (const it of state.items) {
    if (!map.has(it._day)) map.set(it._day, { items: [], holidays: [], open: 0, exam: false });
    const d = map.get(it._day);
    if (it._holiday) { if (!d.holidays.includes(it.title)) d.holidays.push(it.title); continue; }
    d.items.push(it);
    if (it.kind !== 'event' && !isDone(it)) d.open++;
    if (it._exam) d.exam = true;
  }
  return map;
}

function stripStart(now) {
  const today = T.startOfDay(now);
  return T.addDays(today, -today.getDay() + state.calOffset * 28);
}

function selectDay(key, now = new Date()) {
  state.calSel = key;
  const d = T.keyToDate(key);
  state.calMonth = key.slice(0, 7);
  // keep the phone strip on the selected day
  const start = stripStart(now);
  const diff = T.dayDiff(start, d);
  if (diff < 0) state.calOffset -= Math.ceil(-diff / 28);
  else if (diff >= 35) state.calOffset += Math.floor((diff - 35) / 28) + 1;
}

function calCell(d, idx, now, { monthRef, desktop }) {
  const k = T.dayKey(d);
  const info = idx.get(k);
  const today = T.dayKey(now) === k;
  const sel = state.calSel === k;
  const out = d.getMonth() !== monthRef;
  const openN = info ? info.open : 0;
  const labelParts = [`${T.wdLong(d)}, ${T.mdLong(d)}`];
  if (today) labelParts.push('today');
  labelParts.push(openN ? `${openN} due` : 'nothing due');
  if (info?.exam) labelParts.push('exam');
  if (info?.holidays.length) labelParts.push('no classes');

  const btn = h('button', {
    type: 'button', class: 'cal-day', tabindex: sel ? '0' : '-1', 'data-day': k, 'data-focus-key': `cal:${k}`,
    'aria-label': labelParts.join(', '), 'aria-current': today ? 'date' : null,
    onclick: () => { selectDay(k, now); renderCalendar(new Date()); $(`[data-day="${k}"]`)?.focus(); },
  }, h('span', { class: 'cal-num', 'aria-hidden': 'true' }, d.getDate()));

  if (desktop) {
    const list = info ? info.items : [];
    const lines = [];
    if (info?.holidays.length) lines.push(h('span', { class: 'mline hol', 'aria-hidden': 'true' }, 'No classes'));
    for (const it of list.slice(0, 3)) {
      lines.push(h('span', { class: 'mline', 'aria-hidden': 'true' }, courseSq(it.course), `${courseOf(it.course).label} ${it.title}`));
    }
    if (list.length > 3) lines.push(h('span', { class: 'mline more', 'aria-hidden': 'true' }, `+${list.length - 3} more`));
    btn.append(...lines);
  } else {
    if (openN) btn.append(h('span', { class: 'cal-count', 'aria-hidden': 'true' }, openN));
    if (info?.exam) btn.append(h('span', { class: 'cal-exam', 'aria-hidden': 'true' }, 'Exam'));
  }
  return h('div', {
    class: `cal-cell${today ? ' today' : ''}${out ? ' out' : ''}`, role: 'gridcell', 'aria-selected': String(sel),
  }, btn);
}

function calGrid(start, weeks, idx, now, opts) {
  const dow = h('div', { class: 'cal-dow', role: 'row' },
    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((c, i) => h('span', {
      role: 'columnheader', 'aria-label': ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i],
    }, opts.desktop ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i] : c)));
  const grid = h('div', { class: `cal-grid${opts.desktop ? ' month-grid' : ''}`, role: 'grid', 'aria-label': opts.label });
  grid.append(dow);
  for (let w = 0; w < weeks; w++) {
    const row = h('div', { class: 'cal-week', role: 'row' });
    for (let i = 0; i < 7; i++) row.append(calCell(T.addDays(start, w * 7 + i), idx, now, opts));
    grid.append(row);
  }
  grid.addEventListener('keydown', onGridKey);
  return grid;
}

function onGridKey(e) {
  const btn = e.target.closest?.('.cal-day');
  if (!btn) return;
  const cur = T.keyToDate(btn.dataset.day);
  const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  let target = null;
  if (delta) target = T.addDays(cur, delta);
  else if (e.key === 'Home') target = T.addDays(cur, -cur.getDay());
  else if (e.key === 'End') target = T.addDays(cur, 6 - cur.getDay());
  else if (e.key === 'PageUp') target = new Date(cur.getFullYear(), cur.getMonth() - 1, Math.min(cur.getDate(), 28));
  else if (e.key === 'PageDown') target = new Date(cur.getFullYear(), cur.getMonth() + 1, Math.min(cur.getDate(), 28));
  if (!target) return;
  e.preventDefault();
  const k = T.dayKey(target);
  selectDay(k);
  renderCalendar(new Date());
  $(`#cal [data-day="${k}"]`)?.focus();
}

function dayListEl(now, idx) {
  const k = state.calSel;
  const d = T.keyToDate(k);
  const info = idx.get(k);
  const isToday = k === T.dayKey(now);
  const wrap = h('div', { class: 'day-list', id: 'cal-list', 'data-roving': '' });
  const n = info ? info.open : 0;
  const sec = h('section', { class: 'group', 'aria-labelledby': 'cal-day-h' },
    h('h2', { class: `group-h${isToday ? ' is-today' : ''}`, id: 'cal-day-h' },
      h('span', null, h('span', { class: 'h-main' }, `${T.wdLong(d)}, ${T.md(d)}`)),
      n ? h('span', { class: 'h-count' }, `${n} due`) : null));
  if (info?.holidays.length) sec.append(h('p', { class: 'group-note' }, `No classes: ${info.holidays.join(', ')}`));
  if (info?.items.length) {
    sec.append(h('ul', { class: 'inset' }, info.items.map((it) => rowEl(it, isToday ? 'today' : 'cal', now))));
  } else {
    sec.append(h('p', { class: 'day-empty' }, 'Nothing due.'));
  }
  wrap.append(sec);
  initRoving(wrap);
  return wrap;
}

function renderCalendar(now = new Date()) {
  const root = $('#cal');
  const prevActive = $('#cal-list')?.dataset.active;
  const fk = root.contains(document.activeElement) ? document.activeElement.dataset?.focusKey : null;
  root.replaceChildren();
  const idx = dayIndex();
  if (isWide()) {
    const [y, m] = state.calMonth.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const start = T.addDays(first, -first.getDay());
    const last = new Date(y, m, 0);
    const weeks = Math.ceil((first.getDay() + last.getDate()) / 7);
    const go = (dm) => {
      const nm = new Date(y, m - 1 + dm, 1);
      state.calMonth = T.dayKey(nm).slice(0, 7);
      const keepDay = Math.min(T.keyToDate(state.calSel).getDate(), new Date(nm.getFullYear(), nm.getMonth() + 1, 0).getDate());
      state.calSel = T.dayKey(new Date(nm.getFullYear(), nm.getMonth(), keepDay));
      renderCalendar(new Date());
    };
    const head = h('div', { class: 'month-head' },
      h('button', { type: 'button', class: 'text-btn', 'aria-label': 'Previous month', 'data-focus-key': 'm-prev', onclick: () => go(-1) }, '‹'),
      h('h2', { class: 'month-name', 'aria-live': 'polite' }, T.monthYear(first)),
      h('button', { type: 'button', class: 'text-btn', 'aria-label': 'Next month', 'data-focus-key': 'm-next', onclick: () => go(1) }, '›'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'text-btn', 'data-focus-key': 'm-today', onclick: () => { selectDay(T.dayKey(new Date())); state.calOffset = 0; renderCalendar(new Date()); } }, 'Today'));
    const grid = calGrid(start, weeks, idx, now, { monthRef: m - 1, desktop: true, label: T.monthYear(first) });
    const list = dayListEl(now, idx);
    root.append(h('div', { class: 'cal-split' },
      h('div', { class: 'month-side' }, head, h('div', { class: 'month' }, grid)),
      h('div', { class: 'day-side' }, list)));
  } else {
    const start = stripStart(now);
    const mid = T.addDays(start, 17);
    const grid = calGrid(start, 5, idx, now, { monthRef: mid.getMonth(), desktop: false, label: `${T.md(start)} to ${T.md(T.addDays(start, 34))}` });
    const step = (n) => { state.calOffset += n; selectDay(T.dayKey(T.addDays(T.keyToDate(state.calSel), n * 28))); renderCalendar(new Date()); };
    root.append(
      h('p', { class: 'cal-month-label', 'aria-live': 'polite' }, T.monthYear(mid)),
      h('div', { class: 'cal-wrap' }, grid),
      h('div', { class: 'cal-nav' },
        h('button', { type: 'button', class: 'text-btn', 'data-focus-key': 's-prev', onclick: () => step(-1) }, '‹ Earlier'),
        h('button', { type: 'button', class: 'text-btn', 'data-focus-key': 's-today', onclick: () => { state.calOffset = 0; selectDay(T.dayKey(new Date())); renderCalendar(new Date()); } }, 'Today'),
        h('button', { type: 'button', class: 'text-btn', 'data-focus-key': 's-next', onclick: () => step(1) }, 'Later ›')),
      dayListEl(now, idx));
  }
  const list = $('#cal-list');
  if (list && prevActive) { list.dataset.active = prevActive; initRoving(list); }
  // Month/strip buttons were just replaced; day buttons re-focus themselves via their cal: keys.
  if (fk && !fk.startsWith('cal:')) $(`#cal [data-focus-key="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- settings

function settingsContent(now = new Date()) {
  const frag = document.createDocumentFragment();
  const section = (title, rows, note) => {
    const id = `set-${title.toLowerCase().replace(/\W+/g, '-')}`;
    frag.append(h('section', { class: 'set-section', 'aria-labelledby': id },
      h('h2', { class: 'set-h', id }, title),
      h('div', { class: 'inset' }, rows.filter(Boolean)),
      note ? h('p', { class: 'set-note' }, note) : null));
  };
  const textRow = (text, cls, attrs) => h('div', { class: `set-row${cls ? ` ${cls}` : ''}`, ...attrs }, text);
  const btnRow = (text, fn, cls, key) => h('button', { type: 'button', class: `set-row${cls ? ` ${cls}` : ''}`, onclick: fn, 'data-focus-key': key }, text);

  section('Data', [
    textRow(lastUpdatedText(now), null, { 'data-last-updated': '' }),
    btnRow(state.fetching ? 'Checking for new data…' : 'Refresh now', () => refresh({ manual: true }), null, 'set-refresh'),
  ], 'New data is published about every 30 minutes. The app checks when you open it.');

  const srcs = sourceStatuses();
  if (srcs.length) {
    section('Data sources', srcs.map((s) => {
      if (s.ok) return textRow(`${s.name}: Working${s.last ? `, updated ${T.stamp(s.last, now)}` : ''}`);
      let err = s.error ? String(s.error).trim() : '';
      if (err) { err = err[0].toUpperCase() + err.slice(1); if (!/[.!?]$/.test(err)) err += '.'; }
      return textRow(`${s.name}: Not updating${s.last ? ` since ${T.stamp(s.last, now)}` : ''}.${err ? ` ${err}` : ''}`, 'warn');
    }), state.payload?.demo ? 'This is sample data.' : null);
  }

  section('Calendar', [
    btnRow('Export upcoming deadlines (.ics)', exportAll, null, 'set-export'),
  ], "This is a snapshot. It won't update by itself.");

  section('This device', [
    textRow('Done marks are saved on this device only.', 'muted'),
    btnRow('Clear done marks', clearDoneMarks, null, 'set-clear'),
    state.dataSource === 'enc' || state.keys ? btnRow('Forget passphrase on this device', forgetPassphrase, 'danger-text', 'set-forget') : null,
  ]);

  section('About', [
    textRow(`Version ${APP_VERSION}${state.shellBuild ? ` (${state.shellBuild})` : ''}`, null, { 'data-version': '' }),
  ], 'Install on iPhone: open this page in Safari, tap Share (on iOS 26 it is under the ••• button), then Add to Home Screen. Leave “Open as Web App” on, tap Add, and open Due from your Home Screen. On Windows, use Install in the Edge or Chrome address bar.');
  return frag;
}

function lastUpdatedText(now) {
  const g = state.gen;
  return g ? `Last updated: ${T.wdmd(g)}, ${T.time(g)} (${T.ago(g, now)})` : 'Not loaded yet';
}

function renderSettings(now = new Date()) {
  const target = $('#settings-dialog').open ? $('#settings-dialog-body') : $('#settings');
  target.replaceChildren(settingsContent(now));
}

function openSettingsDialog() {
  const dlg = $('#settings-dialog');
  $('#settings-dialog-body').replaceChildren(settingsContent());
  if (!dlg.open) dlg.showModal();
  $('.modal-bar .text-btn', dlg)?.focus();
}

function exportAll() {
  const now = new Date();
  const tk = T.dayKey(now);
  const items = state.items.filter((it) => !it._holiday && !isDone(it) && (it.all_day ? it._day >= tk : it._due > now));
  if (!items.length) { announce('Nothing to export.'); toastIfPossible('Nothing upcoming to export.'); return; }
  downloadICS('due-deadlines.ics', buildICS(items, { name: 'Due deadlines' }));
}

function toastIfPossible(msg) {
  if (!$('#sheet').open && !$('#settings-dialog').open) toast(msg);
  else announce(msg);
}

function confirmDialog({ title, message, ok }) {
  const dlg = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-msg').textContent = message;
  const okBtn = $('#confirm-ok');
  okBtn.textContent = ok;
  okBtn.className = 'text-btn hit danger-text';
  dlg.returnValue = '';
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
    $('button[value="cancel"]', dlg).focus();
  });
}

async function clearDoneMarks() {
  const ret = document.activeElement;
  const yes = await confirmDialog({
    title: 'Clear done marks?',
    message: 'Items you marked on this device go back to what Canvas and Gradescope report.',
    ok: 'Clear',
  });
  if (yes) {
    state.overrides = {};
    S.lsDel(DONE_KEY);
    renderAll({ keepFocus: true });
    announce('Done marks cleared.');
  }
  if (ret?.isConnected) ret.focus();
}

async function forgetPassphrase() {
  const ret = document.activeElement;
  const yes = await confirmDialog({
    title: 'Forget passphrase?',
    message: "You'll need to enter it again to see your deadlines.",
    ok: 'Forget',
  });
  if (!yes) { if (ret?.isConnected) ret.focus(); return; }
  await S.clearKeys();
  await S.clearCachedBlob();
  state.keys = null;
  state.payload = null;
  state.items = [];
  state.gen = null;
  state.selectedId = null;
  if ($('#settings-dialog').open) $('#settings-dialog').close();
  if ($('#sheet').open) closeSheet();
  hideToast();
  if (state.blob) showUnlock();
  else refresh();
}

// ---------------------------------------------------------------- render orchestration

function captureFocus() {
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  const row = a.closest?.('.row');
  if (row) return { id: row.dataset.id, check: a.matches('.check'), view: a.closest('.view')?.id };
  if (a.dataset?.focusKey) return { key: a.dataset.focusKey };
  return null;
}
function restoreFocus(f) {
  if (!f) return;
  let el = null;
  if (f.id) {
    const row = $(`#${f.view || `view-${state.tab}`} .row[data-id="${CSS.escape(f.id)}"]`);
    if (row) { setActiveRow(row); el = (f.check && row.querySelector('.check')) || row.querySelector('.row-main'); }
  } else if (f.key) {
    el = $(`[data-focus-key="${CSS.escape(f.key)}"]`);
  }
  if (el && el !== document.activeElement) el.focus({ preventScroll: true });
}

function scroller() { return isWide() ? $('#list-pane') : null; }
function captureAnchor() {
  if (state.tab !== 'upcoming') return null;
  const sc = scroller();
  const topLine = sc ? sc.getBoundingClientRect().top : $('#topbar').getBoundingClientRect().bottom;
  for (const li of $$('#groups .row')) {
    const r = li.getBoundingClientRect();
    if (r.bottom > topLine + 1) return { id: li.dataset.id, y: r.top };
  }
  return null;
}
function restoreAnchor(a) {
  if (!a) return;
  const li = $(`#groups .row[data-id="${CSS.escape(a.id)}"]`);
  if (!li) return;
  const dy = li.getBoundingClientRect().top - a.y;
  if (!dy) return;
  const sc = scroller();
  if (sc) sc.scrollTop += dy; else window.scrollBy(0, dy);
}

function signature(now) {
  if (!state.payload) return '';
  const parts = [T.dayKey(now), state.filter];
  for (const g of buildGroups(now)) parts.push(g.key, g.items.map((i) => i.id).join(','));
  // rows whose countdown is visible (crossing into the last 24h changes the row)
  for (const it of state.items) if (!it.all_day && it._due > now && it._due - now < DAY) parts.push(`s:${it.id}`);
  const nu = nextUp(now);
  parts.push(`n:${nu?.id}`, `x:${nextExam(now)?.id}`);
  // Next up shows "N days left" until 2 days out, then a countdown that tick() updates in place.
  if (nu && !nu.all_day) { const ms = nu._due - now; parts.push(ms < 2 * DAY ? 'nd:cd' : `nd:${Math.floor(ms / DAY)}`); }
  const n = noticeFor(now);
  parts.push(`notice:${n?.text.replace(/\d+/g, '#')}`);
  return parts.join('|');
}

function renderAll({ keepFocus = true, anchor = null } = {}) {
  const now = new Date();
  const f = keepFocus ? captureFocus() : null;
  state.dayKey = T.dayKey(now);
  renderChrome(now);
  renderUpcoming(now);
  if (state.tab === 'calendar') renderCalendar(now);
  if (state.tab === 'settings' || $('#settings-dialog').open) renderSettings(now);
  refreshSheet();
  if (anchor) restoreAnchor(anchor);
  if (f && !$('#sheet').open) restoreFocus(f);
  state.sig = signature(now);
}

/** Every 60s: re-render only when something visible changed; otherwise update countdowns in place. */
function tick() {
  if (state.locked || !state.payload) { renderChrome(); return; }
  const now = new Date();
  const sig = signature(now);
  if (sig !== state.sig || T.dayKey(now) !== state.dayKey) { renderAll({ keepFocus: true }); return; }
  renderChrome(now);
  for (const el of $$('[data-cd]')) el.textContent = T.countdown(new Date(el.dataset.cd) - now);
  for (const btn of $$('.row .row-main')) {
    const row = btn.closest('.row');
    const it = itemById(row.dataset.id);
    if (it) btn.setAttribute('aria-label', rowLabel(it, row.dataset.ctx, now));
  }
  const nu = nextUp(now);
  const sum = $('#summary [data-focus-key="nextup"]');
  if (nu && sum) sum.setAttribute('aria-label', nextUpLabel(nu, now));
}

// ---------------------------------------------------------------- tabs, chrome

function setTab(tab) {
  if (tab === 'settings' && isWide()) { openSettingsDialog(); return; }
  if (state.locked) return;
  const changed = state.tab !== tab;
  state.tab = tab;
  for (const v of ['upcoming', 'calendar', 'settings']) $(`#view-${v}`).hidden = v !== tab;
  for (const b of $$('.tab')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  for (const b of $$('.desk-header .seg-btn')) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
  const now = new Date();
  if (tab === 'calendar') renderCalendar(now);
  if (tab === 'settings') renderSettings(now);
  if (changed && !isWide()) window.scrollTo(0, 0);
  observeTitle();
  updateTopbar();
}

let titleObserver = null;
function observeTitle() {
  titleObserver?.disconnect();
  const bar = $('#topbar');
  bar.classList.remove('show-title');
  const t = $(`#view-${state.tab} .large-title`);
  if (!t || isWide() || !('IntersectionObserver' in window)) return;
  $('#compact-title').textContent = t.textContent;
  const hgt = bar.offsetHeight || 44;
  titleObserver = new IntersectionObserver(([e]) => {
    bar.classList.toggle('show-title', !e.isIntersecting && e.boundingClientRect.top < hgt);
  }, { rootMargin: `-${hgt}px 0px 0px 0px`, threshold: 0 });
  titleObserver.observe(t);
}
function updateTopbar() {
  $('#topbar').classList.toggle('scrolled', window.scrollY > 0);
}

// ---------------------------------------------------------------- unlock

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
let continueInSafari = false;

function showApp() {
  state.locked = false;
  $('#unlock').hidden = true;
  $('#app').hidden = false;
  observeTitle();
}

function showUnlock(reason) {
  state.locked = true;
  hideToast();
  for (const d of $$('dialog[open]')) d.close();
  $('#app').hidden = true;
  $('#unlock').hidden = false;
  $('#unlock-lede').textContent = reason === 'changed'
    ? 'The passphrase was changed. Enter the new one.'
    : 'Enter your calendar passphrase. You only need to do this once on this device.';
  $('#unlock-error').textContent = '';
  if (!S.hasCrypto()) {
    $('#unlock-error').textContent = 'This browser can’t decrypt here. Open the app over https.';
  }
  const gate = isIOS() && !isStandalone() && !continueInSafari;
  $('#install-notice').hidden = !gate;
  $('#unlock-form').hidden = gate;
  if (!gate && !isIOS()) setTimeout(() => $('#pass').focus(), 0);
}

function setUnlockBusy(busy) {
  const btn = $('#unlock-btn');
  btn.disabled = busy;
  btn.textContent = busy ? 'Unlocking…' : 'Unlock';
  $('#pass').readOnly = busy;
}

async function onUnlockSubmit(e) {
  e.preventDefault();
  const input = $('#pass');
  if ($('#unlock-btn').disabled) return;
  const pass = input.value;
  const err = $('#unlock-error');
  if (!pass) { err.textContent = 'Enter the passphrase.'; input.focus(); return; }
  if (!S.hasCrypto()) return;
  setUnlockBusy(true);
  err.textContent = '';
  try {
    let blob = state.blob;
    if (!blob) {
      const r = await fetchT('data.enc.json');
      blob = await r.json();
      state.blob = blob;
    }
    let result = await S.tryPassphrase(pass, blob);
    if (!result && pass.trim() !== pass && pass.trim()) result = await S.tryPassphrase(pass.trim(), blob);
    if (!result) {
      err.textContent = "That passphrase didn't work. Check for typos or extra spaces.";
      setUnlockBusy(false);
      input.focus();
      input.select();
      return;
    }
    state.keys = result.keys;
    await S.saveKeys(result.keys);
    try { navigator.storage?.persist?.(); } catch { /* optional */ }
    input.value = '';
    $('#pass').type = 'password';
    $('#pass-toggle').textContent = 'Show';
    $('#pass-toggle').setAttribute('aria-pressed', 'false');
    state.dataSource = 'enc';
    setPayload(result.payload);
    if (!navigator.serviceWorker?.controller) S.writeCachedBlob(blob);
    state.tab = 'upcoming';
    showApp();
    setTab('upcoming');
    renderAll({ keepFocus: false });
    // The Upcoming heading is hidden on wide screens; focus the first row there instead.
    const target = isWide() ? ($('#groups .row-main[tabindex="0"]') || $('.desk-header .brand')) : $('#t-upcoming');
    if (!target.matches('button')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  } catch {
    err.textContent = "Couldn't unlock. Check your connection and try again.";
  } finally {
    if ($('#unlock-btn').disabled) setUnlockBusy(false);
  }
}

// ---------------------------------------------------------------- fetching

/** fetch with a timeout, so a stalled connection can't leave "Checking for new data…" up forever. */
async function fetchT(url, ms = FETCH_TIMEOUT) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { cache: 'no-store', signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Decrypt with the stored key. Returns payload, or null after switching to Unlock. */
async function decryptWithStored(blob) {
  const keys = state.keys || await S.loadKeys();
  if (!keys) return { locked: 'empty' };
  state.keys = keys;
  const iter = blob.iter || 600000;
  let aes = keys.salt === blob.salt && (keys.iter || 600000) === iter ? keys.aes : null;
  let fresh = null;
  if (!aes) {
    if (!keys.base) return { locked: 'empty' };
    aes = await S.deriveAes(keys.base, blob.salt, iter);
    fresh = { ...keys, aes, salt: blob.salt, iter };
  }
  try {
    const payload = await S.decryptBlob(aes, blob);
    if (fresh) { state.keys = fresh; S.saveKeys(fresh); }
    return { payload };
  } catch {
    return { locked: 'changed' };
  }
}

async function refresh({ manual = false } = {}) {
  if (state.fetching || state.locked) return;
  state.fetching = true;
  state.lastFetchAt = Date.now();
  state.freshMsg = null;
  const slow = setTimeout(() => { state.showChecking = true; renderChrome(); }, manual ? 0 : 400);
  if (manual) { state.showChecking = true; renderChrome(); }
  const prevGen = state.payload?.generated_at;
  const prevProblem = state.fetchProblem;
  let outcome = null;
  try {
    const res = await fetchT('data.enc.json');
    if (res.status === 404) {
      const r2 = await fetchT('data.json');
      if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
      const payload = await r2.json();
      state.dataSource = 'plain';
      state.fetchProblem = null;
      outcome = accept(payload, prevGen);
    } else {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fromCache = res.headers.get('X-Due-Cache') === '1';
      const blob = await res.json();
      if (!S.isEncBlob(blob)) throw new Error('bad file');
      state.blob = blob;
      state.dataSource = 'enc';
      if (!fromCache && !navigator.serviceWorker?.controller) S.writeCachedBlob(blob);
      state.fetchProblem = fromCache ? (navigator.onLine === false ? 'offline' : 'failed') : null;
      const r = await decryptWithStored(blob);
      if (r.locked) {
        state.payload = null; state.items = []; state.gen = null;
        showUnlock(r.locked === 'changed' ? 'changed' : undefined);
        return;
      }
      outcome = accept(r.payload, prevGen);
    }
  } catch {
    if (!state.payload) {
      // No network and nothing on screen yet: try the encrypted cache directly.
      const cached = await S.readCachedBlob();
      if (cached) {
        state.blob = cached;
        const r = await decryptWithStored(cached);
        if (r.payload) { outcome = accept(r.payload, prevGen); }
        else if (r.locked) { showUnlock(r.locked === 'changed' ? 'changed' : undefined); return; }
      }
      if (!state.payload) state.loadFailed = true;
    }
    state.fetchProblem = navigator.onLine === false ? 'offline' : 'failed';
    if (state.locked && !state.blob) {
      // Can't show unlock without a file to test against; show the app with the failure message.
      showApp();
    }
  } finally {
    clearTimeout(slow);
    state.fetching = false;
    state.showChecking = false;
    if (!state.locked) {
      if ($('#app').hidden) { showApp(); setTab(state.tab); }
      if (outcome === 'same' && manual) {
        const next = new Date(state.gen.getTime() + 30 * MIN);
        state.freshMsg = next > new Date()
          ? `No newer data yet. The next update usually arrives by ${T.time(next)}.`
          : 'No newer data yet. Updates usually arrive about every 30 minutes.';
        state.freshMsgUntil = Date.now() + 4000;
        setTimeout(() => renderChrome(), 4050);
        announce(state.freshMsg);
      } else if (manual && outcome === 'new') {
        announce('Deadlines updated.');
      } else if (manual && state.fetchProblem) {
        announce(state.fetchProblem === 'offline' ? 'Offline.' : "Couldn't load new data.");
      }
      // Nothing changed (the common case every 5 minutes): update the text lines only, so focus and the
      // VoiceOver cursor stay put. 'new' already rendered inside accept().
      const unchanged = (outcome === 'same' || (outcome === null && state.payload)) && state.fetchProblem === prevProblem;
      if (outcome === 'new' || unchanged) renderChrome();
      else renderAll({ keepFocus: true });
    }
  }
}

/** Returns 'same' | 'new'. */
function accept(payload, prevGen) {
  if (!payload || typeof payload !== 'object') throw new Error('bad payload');
  if (prevGen && payload.generated_at === prevGen && state.payload) return 'same';
  const anchor = state.payload ? captureAnchor() : null;
  setPayload(payload);
  if (state.locked) showApp();
  if ($('#app').hidden) showApp();
  renderAll({ keepFocus: true, anchor });
  return 'new';
}

// ---------------------------------------------------------------- service worker

let swReg = null;
let shellChanged = false; // newer app files are cached; reload the next time the app is shown
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (!/^https:$|^http:$/.test(location.protocol)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }).catch(() => {});
  // A new worker took over (after SKIP_WAITING), or the worker cached changed app files.
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) shellChanged = true; });
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'SHELL_UPDATED') shellChanged = true; });
}
/** Called when the app comes to the foreground. Returns true if it is reloading. */
function maybeReloadForUpdate() {
  const typing = state.locked && $('#pass').value;
  if (shellChanged && !$('dialog[open]') && !typing) { location.reload(); return true; }
  // iOS resumes Home Screen apps from memory and only checks sw.js on navigation; check now.
  swReg?.update().catch(() => {});
  return false;
}

/** Short hash of the app files this page runs, shown in Settings > About. */
async function computeShellBuild() {
  try {
    if (!('caches' in self) || !crypto.subtle) return;
    const name = (await caches.keys()).find((k) => k.startsWith('due-shell-'));
    if (!name) return;
    const cache = await caches.open(name);
    const parts = [];
    for (const p of SHELL_PATHS) {
      const r = await cache.match(new URL(p, location.href).href);
      if (!r) return;
      parts.push(new Uint8Array(await r.arrayBuffer()));
    }
    const all = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of parts) { all.set(a, o); o += a.length; }
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
    state.shellBuild = [...d.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 7);
    for (const el of $$('[data-version]')) el.textContent = `Version ${APP_VERSION} (${state.shellBuild})`;
  } catch { /* optional */ }
}
function activateWaitingSW() {
  try { swReg?.waiting?.postMessage({ type: 'SKIP_WAITING' }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- events

function onGlobalKey(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.('input:not([type=checkbox]), textarea, select, [contenteditable="true"]')) return;
  if (state.locked) return;
  if (e.key === 'Escape' && isWide() && state.selectedId && state.tab === 'upcoming' && !$('dialog[open]')) {
    const id = state.selectedId;
    state.selectedId = null;
    renderUpcoming(new Date());
    const row = $(`#groups .row[data-id="${CSS.escape(id)}"]`);
    if (row) { setActiveRow(row); row.querySelector('.row-main').focus(); }
    return;
  }
  if ($('dialog[open]')) return;
  const undoBtn = $('#toast-region .toast-undo');
  if (undoBtn && (e.key === 'z' || e.key === 'Z' || e.key === 'u' || e.key === 'U')) { e.preventDefault(); undoBtn.click(); }
  else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); refresh({ manual: true }); }
  else if (e.key === '1') { e.preventDefault(); setTab('upcoming'); }
  else if (e.key === '2') { e.preventDefault(); setTab('calendar'); }
  else if (e.key === '3') { e.preventDefault(); setTab('settings'); }
}

/** A click on a modal dialog's own element is a backdrop tap only if it lands outside the dialog's box
 *  (the sheet's safe-area padding is inside the box and must not dismiss it). */
function onBackdrop(e, dlg) {
  if (e.target !== dlg) return false;
  const r = dlg.getBoundingClientRect();
  return e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right;
}

function wire() {
  document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { setTab(tabBtn.dataset.tab); return; }
    const act = e.target.closest('[data-action="refresh"]');
    if (act) refresh({ manual: true });
  });
  document.addEventListener('keydown', onRowKeydown);
  document.addEventListener('keydown', onGlobalKey);
  document.addEventListener('focusin', (e) => {
    const row = e.target.closest?.('.row');
    if (row && row.closest('[data-roving]')?.dataset.active !== row.dataset.id) setActiveRow(row);
  });

  // sheet
  const sheet = $('#sheet');
  sheet.addEventListener('click', (e) => { if (onBackdrop(e, sheet)) closeSheet(); });
  sheet.addEventListener('close', onSheetClosed);
  window.addEventListener('popstate', () => { if (sheet.open) { sheetPushed = false; sheet.close(); } });

  const sd = $('#settings-dialog');
  sd.addEventListener('click', (e) => { if (onBackdrop(e, sd) || e.target.closest('[data-close]')) sd.close(); });
  const cf = $('#confirm');
  cf.addEventListener('click', (e) => { if (onBackdrop(e, cf)) cf.close('cancel'); });

  // unlock
  $('#unlock-form').addEventListener('submit', onUnlockSubmit);
  $('#pass-toggle').addEventListener('click', () => {
    const p = $('#pass');
    const show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    $('#pass-toggle').textContent = show ? 'Hide' : 'Show';
    $('#pass-toggle').setAttribute('aria-pressed', String(show));
  });
  $('#continue-safari').addEventListener('click', () => {
    continueInSafari = true;
    $('#install-notice').hidden = true;
    $('#unlock-form').hidden = false;
    $('#pass').focus();
  });

  window.addEventListener('scroll', updateTopbar, { passive: true });
  const onWide = () => {
    if (isWide() && state.tab === 'settings') state.tab = 'upcoming';
    if (!isWide() && $('#settings-dialog').open) $('#settings-dialog').close();
    if (!state.locked && !$('#app').hidden) { setTab(state.tab); renderAll({ keepFocus: true }); }
  };
  wideMQ.addEventListener?.('change', onWide);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (maybeReloadForUpdate()) return;
      if (Date.now() - state.lastFetchAt > 60000) refresh();
      tick();
    } else {
      activateWaitingSW();
    }
  });
  window.addEventListener('online', () => { if (state.fetchProblem) refresh(); });
  window.addEventListener('offline', () => { if (state.payload) { state.fetchProblem = 'offline'; renderChrome(); } });

  setInterval(tick, 60000);
  setInterval(() => { if (document.visibilityState === 'visible' && !state.locked) refresh(); }, REFRESH_EVERY);
}

// ---------------------------------------------------------------- boot

async function boot() {
  registerSW();
  wire();
  state.keys = await S.loadKeys();
  computeShellBuild();
  if (state.keys) {
    // Ask again for persistent storage: WebKit may only grant it once the app runs from the Home Screen.
    navigator.storage?.persisted?.().then((p) => { if (!p) navigator.storage.persist?.(); }).catch(() => {});
    // Paint the last downloaded data right away, then check the network.
    const cached = await S.readCachedBlob();
    if (cached) {
      try {
        const r = await decryptWithStored(cached);
        if (r.payload) {
          state.blob = cached;
          state.dataSource = 'enc';
          setPayload(r.payload);
        }
      } catch { /* fall through to network */ }
    }
    showApp();
    setTab('upcoming');
    renderAll({ keepFocus: false });
    await refresh();
    return;
  }
  // No key on this device: show Unlock now instead of a blank page while the data file downloads.
  // onUnlockSubmit fetches the file itself if this prefetch hasn't finished.
  showUnlock();
  try {
    const res = await fetchT('data.enc.json');
    if (res.status === 404) { state.locked = false; await refresh(); return; } // plaintext preview data
    if (res.ok) { const b = await res.json(); if (S.isEncBlob(b) && !state.blob) state.blob = b; }
  } catch { /* offline: Unlock reports it on submit */ }
}

boot();
