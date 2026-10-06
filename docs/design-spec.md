# Due: design spec for `site/`

Due is a static, installable web app. It shows one student's Canvas and Gradescope deadlines in a single list. It is used on an iPhone in short glances and sometimes on a Windows laptop for weekly planning. Within 3 seconds it must answer three questions: what is next, how long is left, and is it submitted. Trust comes first, so the age of the data is always visible.

Data comes from `data.enc.json` (see `data-contract.md`). The site has these files: `index.html`, `app.css`, `app.js`, `sw.js`, `manifest.webmanifest` and `icons/`. All URLs are relative, because Pages serves from `/<repo>/`.

## 1. Screens

The shell has a bottom tab bar with three tabs: **Upcoming** (the default on every launch), **Calendar** and **Settings**. Item detail opens as a bottom sheet (`<dialog>`) on a phone and in the right pane at 768px and wider. Unlock is the only screen with centered content.

### 1.1 Unlock

Unlock appears on first run, when the stored key is missing, or when the file's salt no longer matches. It is a 360px column, starting 20vh from the top, containing:

- "Assignment Calendar" (22/600).
- "Enter your calendar passphrase. You only need to do this once on this device." (secondary).
- A hidden username input (`autocomplete="username"`, value `assignment-calendar`), so iCloud Keychain offers to save the passphrase.
- The passphrase input:
  - `type=password`, `autocomplete="current-password"`, `enterkeyhint="go"`, `autocapitalize=off`, `spellcheck=false`.
  - 17px text, 48px tall.
  - A trailing "Show"/"Hide" text button.
- A full-width **Unlock** button with accent fill, 50px tall.

Unlock states:

- **While working**: the button reads "Unlocking…" and is disabled, and the input is read-only. PBKDF2 at 600k iterations takes about 1s, and no spinner is shown.
- **Wrong passphrase**: "That passphrase didn't work. Check for typos or extra spaces." appears in danger color under the field. Focus returns to the field with the text selected.
- **Salt changed**: "The passphrase was changed. Enter the new one."
- **iOS Safari tab, not standalone**: the form is hidden behind this notice and a "Continue in Safari" text button:

  > Install first. Tap Share, then Add to Home Screen, then open Due from your Home Screen and enter the passphrase there. The installed app doesn't share storage with Safari.

Storage:

- Import the derived key as a **non-extractable** AES-GCM `CryptoKey`, and store it in IndexedDB together with its salt.
- Never write the passphrase or the decrypted payload to disk.
- Call `navigator.storage.persist()` after the first unlock.
- If storage comes back empty, show Unlock again without comment.

### 1.2 Upcoming

From top to bottom:

1. **The large title "Upcoming"** (34/700). When it scrolls under the sticky top bar, a 17/600 compact title fades in (150ms, IntersectionObserver).
2. **The freshness line**: "Updated 12 min ago" (13px), followed by a **Refresh** text button in accent with a 44px hit area.
3. **A notice line**, only when one applies (§4).
4. **Next up**: "Next up  250 · HW 5 · 4h 12m left, tonight 11:59 PM". It skips events and done items, and tapping it opens the detail.
5. **Next exam**, shown only when an exam is within 30 days: "Next exam  250 Midterm · Thu Oct 16 · in 10 days".
6. **The course filter**: `All | 230 | 250 | 383`.
7. **The grouped list.** Groups appear in this order:

| Group | Contents | Default |
|---|---|---|
| Late window open | not done, `due` past, `late_due` future | open |
| Today · Tue Oct 6 | due today, not done (including earlier today) | open |
| Tomorrow · Wed Oct 7 | | open |
| Thursday · Oct 8 … | one group per day through today+6 | open |
| Next week | today+7 to today+13 | open |
| Later · 31 | beyond | collapsed |
| Past 7 days, not marked done · 4 | past, not done, late window closed, last 7 days, neutral color | collapsed |
| Done · 6 | done, due in the last 7 days or in the future | collapsed |

Group behavior:

- Empty groups are omitted.
- Headers are sticky and show a count on the right ("3 due").
- A collapsed group is one row, such as "Later · 31 items ›". It stays expanded for the rest of the session once opened.
- **Holidays** are `kind=event` items whose title matches `/holiday|no class|recess|break/i`. They are not rows. They appear as a footnote under the day header: "No classes: Indigenous Peoples' Day".
- **Past Canvas items are never red and never labeled "Overdue."** Canvas does not report submissions.

### 1.3 Calendar

**Phone.** A five-week strip starts on the Sunday of the current week. It has seven columns (S M T W T F S, 13px secondary) and 64px-tall cells. Each cell shows:

- The date numeral (15/400).
- The open-item count (13px tabular, secondary). It is omitted when the count is 0.
- "Exam" (11/600) on days that have an exam.

Today's numeral sits in a 28×28 accent square (radius 4) with white text. The selected day has a 1.5px text-colored outline. Days outside the current month use tertiary color.

Under the strip are the text buttons **‹ Earlier**, **Today** and **Later ›**, which step 4 weeks at a time. Below them is the selected day's list (today by default), under a header such as "Thursday, Oct 8", using the same rows as Upcoming. There are no swipe gestures.

**≥768px.** The month grid sits on the left. Each cell shows up to 3 lines of a course square plus "250 HW 5" (13px, ellipsis; this is the only truncation in the app), then "+2 more". The selected day's list sits on the right at 360px wide. Above the grid are "‹ October 2026 ›" and **Today**.

### 1.4 Item detail

The sheet contains, from top to bottom:

- A **Done** text button at the top right.
- An 8px course square and "COMPSCI 250" (15px secondary).
- The title (22/600), which wraps fully.
- An inset group of label/value rows:
  - **Due**: "Tue Oct 7, 11:59 PM" / "in 1 day, 7 hours".
  - **Late until**: shown only when there is a late deadline.
  - **Status**: the Gradescope text, "No submission on Gradescope", or "Canvas doesn't report submissions".
  - **Source**: "Gradescope", or "Gradescope and Canvas".
- An inset group of actions in accent text:
  - **Open in Gradescope** and/or **Open in Canvas**.
  - **Mark as done** / **Mark as not done**. This is absent for events.
  - **Add to Calendar**, which downloads a one-event `.ics` with alarms 1 day and 2 hours before.
- If the item is marked done but Gradescope shows no submission, the footnote "Not submitted on Gradescope yet."

On a phone, the sheet:

- Slides up in 200ms, with a maximum height of 90dvh and 12px top corners.
- Closes on scrim tap, Esc or Done.
- Pushes `history` state, so desktop Back works.

### 1.5 Settings

Settings is a set of inset groups:

- **Data**
  - "Last updated: Tue Oct 6, 4:30 PM (12 min ago)".
  - **Refresh now**.
  - "New data is published about every 30 minutes. The app checks when you open it."
- **Data sources**, one row each:
  - "Canvas: Working, updated 4:30 PM".
  - "Gradescope: Not updating since Tue 2:10 PM. Login failed." (warn color).
- **Calendar**
  - **Export upcoming deadlines (.ics)**, generated on the device from items that are not done.
  - "This is a snapshot. It won't update by itself."
- **This device**
  - "Done marks are saved on this device only."
  - **Clear done marks**, which asks for confirmation.
  - **Forget passphrase on this device**, in danger color. It asks for confirmation: "Forget passphrase? You'll need to enter it again to see your deadlines." with **Forget** / **Cancel**.
- **About**
  - "Version 1.0 (abc1234)".
  - The install steps.

## 2. Layout

**iPhone, 375–430pt portrait:**

- **Top bar**: sticky, with `padding-top: env(safe-area-inset-top)` and a `--bg` background. It gets a bottom hairline only once the page has scrolled.
- **Side padding**: `max(16px, env(safe-area-inset-left/right))`.
- **Inset groups**: 16px margins, 8px radius, `--surface` fill, no border.
- **Tab bar**: fixed to the bottom, 49px tall plus `env(safe-area-inset-bottom)`, `--surface` fill, top hairline.
- **Main content**: `padding-bottom: calc(49px + env(safe-area-inset-bottom) + 16px)`.
- **Toasts**: 8px above the tab bar.
- **Top-right corner**: nothing important goes there, except the sheet's Done button, which iOS convention puts there.
- **Density target**: about 9 two-line rows on a 375×667 screen.

**≥768px:**

- **Header**: a 56px top header replaces the tab bar. It holds "Due" (17/600), an Upcoming | Calendar segmented control, and on the right "Updated 12 min ago · Refresh · Settings".
- **Width**: the content has a maximum width of 1200px and is centered.
- **Upcoming**:
  - The list is `min(46vw, 480px)` wide and scrolls on its own.
  - The detail pane takes the rest of the width (max 640px). It has a hairline left border and the placeholder "Select an item to see details."
- **Settings**: a centered 520px dialog.

## 3. Tokens

### Type

The font stack is `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, sans-serif`. This gives SF Pro on iPhone, which reads as native and follows Dynamic Type, and Segoe UI on Windows. No webfonts are loaded, so the first paint is instant and text never swaps.

- On Apple devices, `html { font: -apple-system-body }` sets 1rem to 17px and scales with Dynamic Type.
- On other platforms, `html { font-size: 16px }`.
- All sizes are in rem.

| Token | Size / line height | Weight | Use |
|---|---|---|---|
| `--t-large` | 2rem (34) / 1.2 | 700 | large titles |
| `--t-title` | 1.294rem (22) / 1.27 | 600 | sheet and unlock titles |
| `--t-body` | 1rem (17) / 1.29 | 400/600 | row titles, buttons |
| `--t-sub` | 0.882rem (15) / 1.33 | 400/600 | row meta, time column, section headers (600) |
| `--t-foot` | 0.765rem (13) / 1.38 | 400 | freshness, notes, counts |
| `--t-cap` | 0.647rem (11) / 1.18 | 600 | tab labels, "Exam" |

Typography rules:

- Use only weights 400 and 600. The exception is the native 700 on large titles.
- Keep default tracking.
- Section headers are in sentence case.
- Apply `font-variant-numeric: tabular-nums` to every time, date, count and countdown.

### Spacing, radii, borders

- **Spacing scale**: 2, 4, 8, 12, 16, 24, 32, 48px (`--s1`–`--s8`).
  - Rows: 10px vertical and 12px horizontal padding, at least 52px tall, with a 2px gap between lines.
  - 24px between groups, and 6px from a header to its group.
- **Radii**:
  - `--r-sm` 4px: checkbox, today square.
  - `--r-md` 8px: groups, inputs, buttons, segmented control, toast.
  - `--r-lg` 12px: sheet top corners.
  - Rows inside a group have square corners.
- **Hairline**: 1px `--sep`, or 0.5px at `min-resolution: 2dppx`. Row separators are inset to the title edge.
- **Shadows**: none. Sheets sit over a flat scrim, `rgb(0 0 0/.32)` in light mode and `/.56` in dark mode.

### Color

Define every color on `:root`, and redefine them under `prefers-color-scheme: dark`. Set `<meta name="color-scheme" content="light dark">`, and give both `html` and `body` the background `var(--bg)`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F6F6F4` | `#121212` | page, theme-color |
| `--surface` | `#FFFFFF` | `#1C1C1E` | groups, tab bar, sheet |
| `--fill` | `#E9E9E5` | `#2C2C2E` | pressed rows, segmented track |
| `--text` | `#1C1C1A` | `#EDEDEA` | primary |
| `--text-2` | `#5E5E59` | `#A1A19D` | secondary (≥5.9:1) |
| `--text-3` | `#8E8E88` | `#6E6E6A` | out-of-month numerals, disabled |
| `--sep` | `#D6D6D0` | `#38383A` | hairlines |
| `--accent` | `#0F6B7A` | `#5DB8C6` | links, buttons, selected tab, today |
| `--on-accent` | `#FFFFFF` | `#0B1F22` | text on accent |
| `--danger` | `#B3261E` | `#F2847C` | <24h countdown, open late window, destructive actions |
| `--warn` | `#8A5A00` | `#DDB061` | stale data, failing source |

The accent is a deep petrol. It avoids indigo and purple and stays clear of every course hue. Warn is kept separate from danger: stale data is a different problem from a missed deadline, and showing it in red would teach the user to ignore red.

**Course palette.** Courses are shown only as an 8×8 square (radius 1px) next to a text label, so color is never the only signal.

| # | Light | Dark | Hue |
|---|---|---|---|
| c1 | `#3F6FB5` | `#86A9DE` | blue |
| c2 | `#C26A1A` | `#E8A160` | orange |
| c3 | `#A5508A` | `#D58DBE` | reddish purple |
| c4 | `#4C8A3F` | `#8FC07F` | green |
| c5 | `#A38420` | `#D6B95A` | ochre |
| c6 | `#697586` | `#A3AEBD` | slate |
| c7 | `#8A6A4F` | `#C2A285` | brown |
| c8 | `#7B5EA7` | `#B39DDB` | plum |

Course assignment and labels:

- Fixed map: COMPSCI 230 → c1, 250 → c2, 383 → c3. These three stay distinct under all three common color-vision deficiencies.
- Any other course gets a free slot from a stable hash of its code, never from sort order.
- When every course shares a department, labels show only the number ("250"). Otherwise they show the full code.

## 4. Components

### List row

Each row is an `<li>` whose body is a `<button>` that opens the detail.

```
[□]  HW 5: Recursion and Induction             11:59 PM
     ■ 250 · Gradescope · Late until Thu        4h 12m
```

**Left column** (44px, with a 44×44 hit area):

- Assignments get a real `<input type=checkbox>`: a 20px square, radius 4, with a 1.5px `--text-2` border.
- When checked, it has an `--accent` fill and a white check.
- Its click does not open the detail.
- Events have no checkbox.

**Middle:**

- **Line 1**: the title (17/400). It wraps fully.
- **Line 2**: the meta line (15px, `--text-2`), made of:
  - The course square and label.
  - " · Canvas", " · Gradescope" or " · Gradescope + Canvas".
  - At most one status: "Submitted", "18.0 / 20.0", "Late until Thu 11:59 PM", "Was due Mon 11:59 PM" (in the late window), or "Marked done".
- **Events**: the title is prefixed with "Exam" or "Event" (13/600, `--text-2`). A title matching `/exam|midterm|final/i` gets "Exam".

**Right column** (min 5.5em, right-aligned, tabular). It shows only what the header doesn't:

| Group | Line 1 | Line 2 |
|---|---|---|
| Today / Tomorrow / weekdays | "11:59 PM" or "All day" | if <24h: "4h 12m" or "38m", `--danger` when not done |
| Next week | "Mon" | "11:59 PM" |
| Later | "Oct 28" | "11:59 PM" |
| Late window | late-deadline time | its countdown, `--danger` |

**State styling:**

- Today's titles use weight 600.
- Done rows appear only in the Done group, with a checked box and the title in `--text-2`. They get no strikethrough and no opacity change.
- Past-not-marked rows stay neutral.

**Large text.** Below about 16em of row width, the right column wraps into a third line, so nothing clips at 200% text size.

**Accessible name.** For example: "COMPSCI 250, HW 5: Recursion and Induction, due today at 11:59 PM, 4 hours 12 minutes left, Gradescope, not done."

### Section header

- A sticky `<h2>` on a `--bg` background, 32px tall, with a 16px inset.
- "Today" is 15/600 (in `--accent` for Today only), followed by " · Tue Oct 6" (400, `--text-2`).
- The count sits on the right.

### Course filter

- A segmented control: a `--fill` track, radius 8, 32px visible height inside a 44px hit area.
- The selected segment is `--surface` with a hairline border.
- It selects one course or All.
- **It does not persist.** It resets to All on every launch, so a forgotten filter cannot hide a deadline.
- While a filter is active, the freshness line adds "Showing 250 only".
- With more than 5 courses, it becomes a native `<select>`.

### Toast

- A flat `--text` background with `--bg` text, radius 8, 48px tall.
- Copy: "Marked done: HW 5", plus an **Undo** button (600) in the other theme's accent (`#5DB8C6` in light mode, `#0F6B7A` in dark mode).
- It stays for 5s and pauses while focused.
- It has `role=status`.

### Notices

A notice is one line of 13px text with no box. Only the most severe one shows.

| Condition | Color | Copy |
|---|---|---|
| Data >24h old | danger | "Data hasn't updated since Mon 2:10 PM. The automatic update may have stopped. See Settings." |
| Data 3–24h old | warn | "Data is 4 hours old. Deadlines added since then won't show yet." |
| One source failing | warn | "Gradescope hasn't updated since Tue 2:10 PM. Canvas is current." |
| Fetch failed | warn | "Couldn't load new data. Showing data from 2:10 PM." |
| Offline | text-2 | "Offline. Showing data from Tue 2:10 PM." |
| Demo file | text-2 | "Showing sample data, not your courses." |

### Empty states

| Situation | Copy |
|---|---|
| Nothing due in 7 days | "Nothing due in the next 7 days." then "Next: 383 Project 2, Mon Oct 20." (tappable) |
| All filtered out | "Nothing due for 250 right now." with the button **Show all courses** |
| No items at all | "No deadlines found. If that looks wrong, check Data sources in Settings." |
| First load, no cache | "Loading deadlines…" (no spinner) |
| Empty calendar day | "Nothing due." |

The list is never empty while cached data exists.

### Tab bar icons

The icons are inline SVG on a 24px grid, with a 1.75px stroke, square caps and no fills. Inactive icons use `--text-2`. The active icon and its label use `--accent` and carry `aria-current="page"`.

- **Upcoming**: three lines, each with a 3px square before it.
- **Calendar**: a rectangle with a top rule and two binder ticks.
- **Settings**: two slider lines, each with a 5px open-square knob.

## 5. Interactions

**Mark done:**

1. Tapping the checkbox checks it instantly.
2. After 500ms, the row collapses (180ms) and the toast appears.
3. **Undo** restores the row and moves focus back to its checkbox.
4. Overrides are stored in `localStorage["due.done.v1"]` as `{id: bool}`. Only IDs are stored, never titles, and every access is wrapped in try/catch.

Unchecking an item that Gradescope reports as submitted stores `false` and shows the toast "Marked not done".

**Filter.** The list re-renders instantly. Next up and Next exam follow the filter.

**Refresh:**

- **Triggers**: launch; `visibilitychange` to visible when the last fetch was more than 60s ago; every 5 minutes while the app is visible; and the Refresh button.
- **Request**: `fetch('data.enc.json', {cache:'no-store'})`, falling back to `data.json` on a 404.
- **During the fetch**: "Checking for new data…".
- **If `generated_at` is unchanged**: "No newer data yet. The next update usually arrives by 5:00 PM." (`generated_at` + 30 min) for 4s.
- **If the data is new**: re-render in place, anchoring the scroll position to the first visible row's ID.
- **Relative times** re-render every 60s.

**Time formats** (en-US, device time zone):

- **Updated**: "just now", "12 min ago", "3 hr ago", then "Mon 2:10 PM".
- **Countdowns**: "38m", "4h 12m".
- **Detail view**: "in 1 day, 7 hours" or "2 days ago".
- **All-day items**: shown on the UTC date of `due`.

**Links.** Use real `<a target="_blank" rel="noopener">` links, which iOS opens in a Safari sheet. Never call `window.open` after `await`.

**Keyboard:**

- All controls are native elements.
- `↑`/`↓` move between rows (roving tabindex). Enter opens a row. Space toggles a focused checkbox.
- `Esc` closes the sheet.
- `r` refreshes. `1`, `2` and `3` switch tabs. These shortcuts are ignored inside inputs.
- Calendar grids use `role=grid` with arrow keys.
- `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`.

**Screen readers:**

- Each day group is a `<section aria-labelledby>` around a `<ul>`.
- Countdowns are not live regions. Only the toast and the result of a manual refresh are announced.
- When the sheet opens, focus moves to its title. When it closes, focus returns to the row.

**Motion:**

- Only three things animate: the sheet (200ms), row collapse (180ms) and the compact title (150ms). All use `cubic-bezier(.2,0,0,1)`, and all are off under `prefers-reduced-motion`.
- Pressed states use `:active { background: var(--fill) }`, and nothing depends on hover.

## 6. iOS install

**`<head>`:**

- `viewport` set to `width=device-width, initial-scale=1, viewport-fit=cover`, with no `user-scalable=no`.
- `color-scheme`.
- Two media-scoped `theme-color` tags: `#F6F6F4` and `#121212`.
- `apple-mobile-web-app-capable` and `mobile-web-app-capable`, both `yes`.
- `apple-mobile-web-app-status-bar-style=default`. Never `black-translucent` (WebKit bug 301994).
- `apple-mobile-web-app-title=Due`.
- `format-detection=telephone=no`.
- The manifest link, and `apple-touch-icon` pointing to `icons/apple-touch-icon.png`.

**Manifest:**

- `id` `"./"`, `name` `"Assignment Calendar"`, `short_name` `"Due"`.
- `start_url` and `scope` both `"./"`, `display` `"standalone"`.
- `theme_color` and `background_color` both `#F6F6F4`.
- Icons at 192 and 512, plus a 512 maskable.

**CSS:**

- `-webkit-text-size-adjust: 100%`.
- Use `dvh`, never `100vh`.
- Inputs at 16px or larger.
- `-webkit-tap-highlight-color: transparent`.
- `touch-action: manipulation` on controls.
- `overscroll-behavior: contain` on the sheet only.

**No splash images.** The cached shell paints `--bg` and the cached data immediately.

**Service worker** (`sw.js`, scope `./`):

- **Shell** (`index.html`, `app.css`, `app.js`, manifest, icons): cache-first in `due-shell-v{N}`. Old shell caches are deleted on activate, and navigations are served from the cached `index.html`.
- **`data.enc.json`**: network-first with `cache:'no-store'`. Each success is written to `due-data`. On failure, the cached copy is served, and the page shows the Offline notice with that copy's `generated_at`.
- **Updates**: a new worker waits. When the page becomes hidden, it posts `SKIP_WAITING`, so the next launch gets the new shell. There is no update prompt.

**Fetcher dependency.** The payload needs a `source_status` field: `{canvas: {ok, last_success, error}, gradescope: {…}}`. `build.py` must also keep the last good items for a failing source. Until both changes land, the app derives source status from `errors[]` and `generated_at`.

## 7. App icon

The icon is a calendar page with one day filled in. Draw it with Pillow at 1024², then downsample with LANCZOS.

- **Background**: solid `#F2F1EC`, fully opaque, square corners.
- **Binder bar**: an `#1C1C1A` rectangle at x 128–896, y 178–234.
- **Grid**: 4 columns × 3 rows of 168px cells with 32px gaps, spanning x 128–896 and y 278–846. Each cell is drawn with `draw.rectangle(..., outline="#1C1C1A", width=20)` and has no fill.
- **Due cell**: row 2, column 3 (x 528–696, y 478–646), filled solid `#0F6B7A`, with no outline.

Export these files:

- `apple-touch-icon.png` at 180px.
- `icon-192.png`.
- `icon-512.png`.
- `icon-maskable-512.png`: the whole mark scaled by 0.72 around the center on the same background.

The icon has no gradient, gloss, shadow, text or rounded corners.

## 8. Do not

- **No gradients** anywhere, including the icon.
- **No glows or colored shadows.** No `box-shadow` at all, no `backdrop-filter`, no blur, no glass, no blobs or orbs, and no decorative shapes.
- **No pills.** No radius above 12px.
- **No cards for individual assignments.** No colored side stripes, and no nested cards.
- **No emoji or sparkles.** The only icons are the three in the tab bar.
- **No stat tiles or big-number dashboards.** Counts go inline in headers.
- **No hero sections or greetings.** No exclamation marks, and no hype words such as "supercharge" or "all in one place".
- **No more than one status per row.** No pulsing dots and no badge clusters.
- **No bounce, spring, hover-zoom, auto-motion or marquees.** No animation longer than 200ms.
- **No webfonts or letter-spacing changes.** No all-caps headers, and no text larger than 34px.
- **No purple or indigo, and only one accent.**
- **Red is only for** the under-24h countdown, open late windows and destructive actions. Past Canvas items are never red and never "Overdue".
- **No strikethrough or fading** on done items.
- **Never use** `black-translucent`, `100vh`, `user-scalable=no` or inputs smaller than 16px.
- **No spinners or empty lists while cached data exists.**
- **Never persist the course filter.** Never write plaintext data to disk, and never publish a plaintext `.ics` to Pages.
- **No truncated titles,** except in the desktop month grid.
