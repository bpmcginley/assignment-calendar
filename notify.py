"""Push reminders, sent from the scheduled GitHub job.

- A reminder about 6 hours before each deadline (assignments still not done; deadlines that share a time
  are combined into one notification).
- A 10 AM summary of what's due by midnight.

GitHub runs the job about every 30 minutes, so a notification goes out on the first run after its moment.
What has been sent is remembered in `notify_state` inside the encrypted payload, so nothing repeats.

Devices are listed in push-subscriptions.json as codes the app produces: the browser's push subscription,
encrypted with the same passphrase as the data (safe to commit to a public repo).
"""
import base64
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from Crypto.Cipher import AES
from Crypto.PublicKey import ECC

REMIND_BEFORE = timedelta(hours=6)
DIGEST_HOUR = 10
DIGEST_LATEST_HOUR = 15        # don't send a "due today" summary in the late afternoon
EXAM = re.compile(r"\b(exam|midterm|final)\b", re.I)
CONTACT = "mailto:229344244+bpmcginley@users.noreply.github.com"   # VAPID "sub": the sender's contact (GitHub no-reply address)


# ---------- keys and subscriptions ----------

def _b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _unb64url(s):
    s = s.strip()
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def generate_vapid_private_key():
    return _b64url(ECC.generate(curve="P-256").d.to_bytes(32))


def vapid_public_key(private_b64url):
    """The applicationServerKey the app subscribes with (uncompressed P-256 point, base64url)."""
    key = ECC.construct(curve="P-256", d=int.from_bytes(_unb64url(private_b64url), "big"))
    q = key.pointQ
    return _b64url(b"\x04" + int(q.x).to_bytes(32, "big") + int(q.y).to_bytes(32, "big"))


def device_id(endpoint):
    """Short, non-reversible id the app uses to see that the server knows this device."""
    return hashlib.sha256(endpoint.encode("utf-8")).hexdigest()[:16]


def decrypt_code(code, passphrase, kdf):
    """Codes from the app (store.js encryptForServer): base64 of {"v":1,"salt","iter","iv","ct"},
    ct = AES-GCM(JSON) with a PBKDF2 key from the passphrase. Raises if the passphrase doesn't match."""
    blob = json.loads(base64.b64decode(re.sub(r"\s+", "", code)))
    key = kdf(passphrase, base64.b64decode(blob["salt"]), blob["iter"])
    raw = base64.b64decode(blob["ct"])
    cipher = AES.new(key, AES.MODE_GCM, nonce=base64.b64decode(blob["iv"]))
    return json.loads(cipher.decrypt_and_verify(raw[:-16], raw[-16:]))


def decode_device_code(code, passphrase, kdf):
    sub = decrypt_code(code, passphrase, kdf)
    if not sub.get("endpoint") or not (sub.get("keys") or {}).get("p256dh"):
        raise ValueError("not a push subscription")
    return sub


def load_devices(path, passphrase, kdf):
    """[(name, subscription)], plus problems to report. Missing file = no devices."""
    try:
        with open(path, encoding="utf-8") as f:
            listed = json.load(f).get("devices", [])
    except FileNotFoundError:
        return [], []
    devices, problems = [], []
    for d in listed:
        name = d.get("name") or "Device"
        try:
            devices.append((name, decode_device_code(d["code"], passphrase, kdf)))
        except Exception:
            problems.append(f"{name}: its code couldn't be read (made with a different passphrase?).")
    return devices, problems


# ---------- deciding what to send (pure; tested in tests/) ----------

def course_labels(codes):
    """Same rule as the app: courses in the main department show only their number."""
    dept = lambda c: (re.match(r"^(.*?)\s*\d", c) or [None, None])[1]
    counts = {}
    for c in codes:
        if dept(c):
            counts[dept(c)] = counts.get(dept(c), 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    main = ranked[0][0] if ranked and (len(ranked) == 1 or ranked[0][1] > ranked[1][1]) else None
    return {c: (c[len(dept(c)):].strip() if main and dept(c) == main else c) for c in codes}


def _due(item):
    return datetime.fromisoformat(item["due"])


def _clock(dt, tz):
    t = dt.astimezone(tz)
    if t.hour == 0 and t.minute == 0:
        return "midnight"
    return t.strftime("%I:%M %p").lstrip("0")


def _left(delta):
    mins = max(0, int(delta.total_seconds() // 60))
    h, m = divmod(mins, 60)
    return f"{h} hr {m} min" if h else f"{m} min"


def _open_assignments(items):
    return [i for i in items if i.get("kind") == "assignment" and not i.get("done")]


def plan(payload, state, now, tz_name="America/New_York"):
    """Return (notifications, new_state). `state` is None when the previous run's state is unknown."""
    tz = ZoneInfo(tz_name)
    known = state is not None
    state = {"sent": dict((state or {}).get("sent", {})), "digest_day": (state or {}).get("digest_day")}
    items = payload.get("items", [])
    labels = course_labels(sorted({i["course"] for i in items}))
    out = []

    # 6-hour reminders, grouped by identical deadline.
    due_soon = {}
    for it in _open_assignments(items):
        left = _due(it) - now
        if timedelta(0) < left <= REMIND_BEFORE:
            key = f"{it['id']}|{it['due']}"
            if key in state["sent"]:
                continue
            if not known and left <= REMIND_BEFORE - timedelta(hours=1):
                continue  # state lost: only remind for deadlines that just crossed the 6-hour mark
            due_soon.setdefault(it["due"], []).append((key, it))
    for due_iso, group in sorted(due_soon.items()):
        due = datetime.fromisoformat(due_iso)
        when = f"{_clock(due, tz)}{' tonight' if due.astimezone(tz).date() == now.astimezone(tz).date() else ''}"
        if len(group) == 1:
            it = group[0][1]
            title = f"{labels[it['course']]} {it['title']}"
            body = f"Due in {_left(due - now)}, {when}."
        else:
            title = f"{len(group)} due in {_left(due - now)}"
            body = "\n".join(f"{labels[it['course']]} {it['title']}" for _, it in group) + f"\nDue {when}."
        out.append({"title": title, "body": body, "tag": f"remind-{short_hash(due_iso)}", "kind": "reminder"})
        for key, _ in group:
            state["sent"][key] = now.isoformat(timespec="seconds")

    # 10 AM summary of what's due by midnight (deadlines at exactly 12:00 AM count as tonight).
    local = now.astimezone(tz)
    today = local.date().isoformat()
    in_window = local.hour >= DIGEST_HOUR and (local.hour < DIGEST_LATEST_HOUR if known else
                                              local.hour == DIGEST_HOUR and local.minute < 45)
    if in_window and state["digest_day"] != today:
        end = datetime.combine(local.date() + timedelta(days=1), datetime.min.time(), tz)
        todays = [i for i in items if not i.get("done") and now <= _due(i) <= end and
                  (i.get("kind") == "assignment" or EXAM.search(i.get("title", "")))]
        todays.sort(key=_due)
        if todays:
            title = f"{len(todays)} due today" if len(todays) > 1 else "1 due today"
            body = "\n".join(f"{_clock(_due(i), tz)}  {labels[i['course']]} {i['title']}" for i in todays)
        else:
            nxt = next((i for i in sorted(_open_assignments(items), key=_due) if _due(i) > end), None)
            title = "Nothing due today"
            body = (f"Next: {labels[nxt['course']]} {nxt['title']}, "
                    f"{_due(nxt).astimezone(tz).strftime('%a')} {_clock(_due(nxt), tz)}." if nxt else "Nothing coming up.")
        out.append({"title": title, "body": body, "tag": f"digest-{today}", "kind": "digest"})
        state["digest_day"] = today

    # Forget reminders for deadlines more than two days gone.
    cutoff = now - timedelta(days=2)
    state["sent"] = {k: v for k, v in state["sent"].items()
                     if datetime.fromisoformat(k.split("|", 1)[1]) > cutoff}
    return out, state


def short_hash(s):
    return hashlib.sha256(s.encode()).hexdigest()[:10]


# ---------- sending (GitHub Actions only: pywebpush needs `cryptography`) ----------

def send(devices, notifications, private_key):
    """Returns per-device results: [{"id", "name", "ok", "error"}]."""
    from pywebpush import WebPushException, webpush

    results = []
    for name, sub in devices:
        res = {"id": device_id(sub["endpoint"]), "name": name, "ok": True, "error": None}
        for n in notifications:
            try:
                webpush(subscription_info=sub, data=json.dumps({k: n[k] for k in ("title", "body", "tag")}),
                        vapid_private_key=private_key, vapid_claims={"sub": CONTACT},
                        ttl=6 * 3600, headers={"Urgency": "high"})
            except WebPushException as e:
                code = getattr(e.response, "status_code", None)
                res["ok"] = False
                res["error"] = ("Reminders for this device expired. Turn them on again in Settings."
                                if code in (404, 410) else f"Push service error {code or ''}".strip())
                break
        results.append(res)
    return results
