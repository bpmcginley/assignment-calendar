# Data contract between the fetcher (Python) and the web app (site/)

The site is fully static: no server API. A GitHub Actions job runs `build.py` about every 30 minutes,
fetches Canvas + Gradescope, and publishes `site/` to GitHub Pages together with one data file.

## Data files (both live next to index.html)

- `data.enc.json`: used when deployed. The assignment data is encrypted because GitHub Pages is public.
  ```json
  {"v": 1, "kdf": "PBKDF2-SHA256", "iter": 600000,
   "salt": "<base64, 16 bytes>", "iv": "<base64, 12 bytes>", "ct": "<base64 AES-256-GCM ciphertext+tag>"}
  ```
  Key = PBKDF2(passphrase UTF-8, salt, iter, SHA-256, 256 bits). `ct` decrypts (WebCrypto AES-GCM, tag appended,
  exactly what `crypto.subtle.decrypt` expects) to the UTF-8 JSON payload below.
- `data.json`: the plaintext payload, used only for local preview/demo. Never deployed.

The app should try `data.enc.json` first; if it 404s, fall back to `data.json`.
For local testing: `site/data.json` (demo data) and `site/data.enc.json` encrypted with passphrase `demo-passphrase`.

## Payload

```json
{
  "generated_at": "2026-10-06T16:30:00+00:00",
  "demo": false,
  "sources": ["canvas", "gradescope"],
  "errors": ["Gradescope couldn't be updated: login failed. Showing its last saved data."],
  "source_status": {
    "canvas":     {"ok": true,  "last_success": "2026-10-06T16:30:00+00:00", "error": null},
    "gradescope": {"ok": false, "last_success": "2026-10-06T14:10:00+00:00", "error": "login failed"}
  },
  "items": [ Item, ... ],
  "push_public_key": "<base64url VAPID public key; absent until VAPID_PRIVATE_KEY is set>",
  "reminders": {"devices": [{"id": "<sha256(endpoint)[:16]>", "name": "iPhone", "ok": true,
                             "error": null, "last_sent": "<ISO>"}], "problems": []},
  "notify_state": {"sent": {"<item id>|<due>": "<ISO>"}, "digest_day": "2026-10-06"}
}
```

`notify_state` is the sender's memory between runs (which reminders already went out); the app ignores it.

`items` is sorted by `due` ascending and covers roughly 14 days back through the end of term.

### Item

| field | type | notes |
| --- | --- | --- |
| `id` | string | stable, e.g. `canvas:event-assignment-123` or `gradescope:1001:56` |
| `source` | `"canvas"` \| `"gradescope"` | where the primary link points |
| `kind` | `"assignment"` \| `"event"` | Canvas calendar events (exams, holidays) are `event` |
| `title` | string | |
| `course` | string | short code, e.g. `COMPSCI 230` |
| `due` | ISO-8601 UTC string | the deadline |
| `all_day` | bool | true = a calendar date with no time; show on the UTC date of `due` |
| `late_due` | ISO string \| null | Gradescope late deadline |
| `url` | string \| null | link to the assignment |
| `status` | string \| null | Gradescope status text: "No Submission", "Submitted", "18.0 / 20.0" |
| `done` | bool | true when Gradescope shows a submission. The user can override per device |
| `also` | `{source, url, course}` \| absent | same assignment found on the other platform |

Real-world scale: 3-5 courses, 50-120 items per semester. Titles can be long ("Lab 04: Pointers and Memory - Part 2").
