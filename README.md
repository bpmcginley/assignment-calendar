# Assignment Calendar

Canvas and Gradescope due dates in one place, installable on an iPhone from Safari.

## How it works

```
GitHub Actions (every ~30 min)                       Your iPhone / laptop
  build.py                                             https://bpmcginley.github.io/assignment-calendar/
    Canvas calendar feed  ─┐                             downloads data.enc.json
    Gradescope (login)    ─┼─ merge ─ encrypt ─▶ Pages ─▶ decrypts it on the device with your passphrase
                           ┘
```

- GitHub runs `build.py` on a schedule. It reads your Canvas feed and Gradescope courses, merges assignments that
  appear on both, and publishes the result to GitHub Pages.
- GitHub Pages sites are public, so the data file is encrypted (AES-256-GCM, key from your passphrase via
  PBKDF2). Anyone can load the page, but without the passphrase they see nothing. The code repo holds no personal data.
- Your Canvas link, Gradescope login and passphrase are stored as **GitHub Actions secrets**. They're encrypted, and
  nobody can read them back (not even you); they can only be replaced.

## Install on iPhone

1. Open the site in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open it from the Home Screen and enter your passphrase once.

The Home Screen app keeps its own storage, separate from Safari, so you enter the passphrase there even if you
already did in Safari.

## Secrets (repo → Settings → Secrets and variables → Actions)

| Secret | Value |
| --- | --- |
| `CANVAS_ICS_URL` | Canvas → Calendar → **Calendar Feed** link |
| `GRADESCOPE_EMAIL` | your Gradescope login email |
| `GRADESCOPE_PASSWORD` | your Gradescope password (if you use "School Credentials", set one via *Forgot password*) |
| `DATA_PASSPHRASE` | a passphrase you make up, e.g. four random words. You'll type it once per device |
| `VAPID_PRIVATE_KEY` | key for sending reminders (see Reminders) |

Or from a terminal in this folder (each command prompts for the value, so nothing lands in your shell history):

```bash
gh secret set GRADESCOPE_EMAIL
```

## Reminders

The scheduled job also sends push notifications to the installed app:

- about 6 hours before each deadline that isn't done (deadlines at the same time are combined), and
- a summary at 10 AM Eastern of what's due by midnight.

They go out on the first scheduled run after the moment, so they can be up to ~30 minutes late.
Gradescope submissions count as done, and so do items you tick off in the app once they've synced.

## Syncing done marks

In the app: Settings → Sync done marks → **Connect this device**. It links to GitHub with a token form pre-filled
(name, no expiry, only *Actions: Read and write*); choose **Only select repositories → assignment-calendar**,
generate, and paste the token into the app. The token stays on that device and can only start the update job.
Each change starts one update run with the marks encrypted as its input, so they reach the server in ~2 minutes.
Devices that aren't connected still receive marks from the server; they just can't send their own.

Setup (once): add the `VAPID_PRIVATE_KEY` secret (the private key for sending pushes; `notify.py` has
`generate_vapid_private_key()`), then in the app open Settings → Reminders → **Turn on reminders**, and add the
setup code it shows to `push-subscriptions.json`:

```json
{"devices": [{"name": "iPhone", "code": "<setup code>"}]}
```

The code is the phone's push subscription encrypted with your passphrase, so it's safe in a public repo.
To test delivery: Actions → Update calendar → Run workflow → tick "Also send a test notification".

## Refreshing

Data updates about every 30 minutes. For an immediate update: GitHub → **Actions** → **Update calendar** →
**Run workflow**, or `gh workflow run update.yml`.

If Canvas or Gradescope fails during an update, the app keeps showing that source's last good data and says so.

## Options (`settings.json`)

Not secret, so this file is committed and used by the scheduled job too.

- `hide_titles_containing`: hide assignments whose title contains any of these, e.g. `["No-AI Track"]`.
- `course_aliases`: rename courses, e.g. `{"Math 235H": "MATH 235"}`.
- `days_back`: how many days of past items to keep (default 14).
- `gradescope_latest_term_only`: only read the newest Gradescope term (default `true`).

## Run it on this computer

```bash
python serve.py
```

This builds using `config.json` for your logins (copy `config.example.json` first) and opens http://localhost:8765.
`python serve.py --demo` uses sample data (passphrase `demo-passphrase`).

Tests: `python -m unittest discover tests`

## Files

- `build.py`: fetch, merge, clean up course names and titles, encrypt.
- `notify.py`: decides which reminders are due and sends them.
- `canvas.py`: reads the Canvas calendar feed. Canvas exports 11:59 PM deadlines as all-day dates; this restores the time.
- `gradescope.py`: logs in and reads your current term's courses and assignments.
- `site/`: the web app (static HTML/CSS/JS, works offline, installable).
- `.github/workflows/update.yml`: the schedule, build and deploy.
- `docs/`: data format and design spec.
