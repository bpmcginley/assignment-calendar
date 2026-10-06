"""Fetch Canvas + Gradescope, merge them, and write the data file the web app reads.

    python build.py                 # real data -> site/data.enc.json (or site/data.json if no passphrase is set)
    python build.py --demo          # sample data -> site/data.json + site/data.enc.json (passphrase "demo-passphrase")
    python build.py --previous URL  # reuse a source's last good data from URL if that source fails this time

Settings come from environment variables (used by GitHub Actions) or, locally, from config.json:
    CANVAS_ICS_URL, GRADESCOPE_EMAIL, GRADESCOPE_PASSWORD, DATA_PASSPHRASE
"""
import argparse
import base64
import json
import os
import re
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import hashlib

import requests
from Crypto.Cipher import AES  # pycryptodome (has wheels for Windows on ARM, unlike `cryptography`)

import canvas
import gradescope

ROOT = Path(__file__).parent
SITE = ROOT / "site"
PBKDF2_ITERATIONS = 600_000
DEMO_PASSPHRASE = "demo-passphrase"


# ---------- settings ----------

def load_settings():
    # settings.json: non-secret options, committed so GitHub Actions uses them too.
    # config.json: local secrets (never committed); overrides settings.json.
    cfg = {}
    for name in ("settings.json", "config.json"):
        path = ROOT / name
        if path.exists():
            cfg.update(json.loads(path.read_text(encoding="utf-8")))
    env = lambda name, key: (os.environ.get(name) or cfg.get(key) or "").strip()
    return {
        "canvas_ics_url": env("CANVAS_ICS_URL", "canvas_ics_url"),
        "gradescope_email": env("GRADESCOPE_EMAIL", "gradescope_email"),
        # Passwords may legitimately have leading/trailing spaces, so don't strip.
        "gradescope_password": os.environ.get("GRADESCOPE_PASSWORD") or cfg.get("gradescope_password") or "",
        "passphrase": os.environ.get("DATA_PASSPHRASE") or cfg.get("data_passphrase") or "",
        "days_back": int(cfg.get("days_back", 14)),
        "latest_term_only": bool(cfg.get("gradescope_latest_term_only", True)),
        "course_aliases": cfg.get("course_aliases", {}),
        # e.g. ["No-AI Track"] to drop the other track's copies of an assignment
        "hide_titles_containing": cfg.get("hide_titles_containing", []),
    }


# ---------- course names ----------

def clean_course(name, aliases=None):
    """'COMPSCI 230 (170646) FA26' -> 'COMPSCI 230'; 'CS 230 Fall 2026' -> 'COMPSCI 230'."""
    original = name.strip()
    if aliases and original in aliases:
        return aliases[original]
    s = re.sub(r"\(\s*\d+\s*\)", " ", original)  # Canvas course ids
    s = re.sub(r"\b(fall|spring|summer|winter)\s*'?\d{2,4}\b", " ", s, flags=re.I)
    s = re.sub(r"\b(FA|SP|SU|WI|F|S)\d{2}\b", " ", s)  # FA26, SP27
    s = re.sub(r"\b(SEC|SECTION|LEC|LAB|DIS)\s*\w+\b", " ", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip(" -:,")
    m = re.match(r"^(CS|CMPSCI|COMPSCI)\s*-?\s*(\d{3}[A-Z]?)\b", s, flags=re.I)
    if m:
        s = f"COMPSCI {m.group(2).upper()}"
    m = re.fullmatch(r"([A-Za-z]+)\s*(\d{3}[A-Za-z]?)", s)
    if m:  # 'Math 235H' -> 'MATH 235H'
        s = f"{m.group(1).upper()} {m.group(2).upper()}"
    result = s or original
    return aliases.get(result, result) if aliases else result


EMOJI = re.compile("[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U00002B00-\U00002BFF️‍⃣]+")


def clean_title(title):
    """Drop emoji instructors put in titles ('🛠️ No-AI Track, Project 1') and tidy whitespace."""
    return re.sub(r"\s+", " ", EMOJI.sub(" ", title)).strip(" -,:") or title


# ---------- merging ----------

def _norm(text):
    return re.sub(r"[^a-z0-9]", "", text.lower())


def merge(items):
    """Collapse an assignment that appears on both Canvas and Gradescope into one item."""
    by_key, merged = {}, []
    # Gradescope first: it knows submission status, so it becomes the primary copy.
    for item in sorted(items, key=lambda i: i["source"] != "gradescope"):
        key = (_norm(item["course"]), _norm(item["title"]), item["due"][:10])
        twin = by_key.get(key)
        if twin and twin["source"] != item["source"]:
            twin["also"] = {"source": item["source"], "url": item["url"], "course": item["course"]}
            continue
        by_key[key] = item
        merged.append(item)
    return sorted(merged, key=lambda i: (i["due"], i["course"], i["title"]))


# ---------- encryption (matches docs/data-contract.md and site/ WebCrypto code) ----------

def _key(passphrase, salt, iterations):
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), salt, iterations, dklen=32)


def encrypt(payload, passphrase, salt=None):
    # Reusing the previous salt (same passphrase) lets devices keep their derived key instead of
    # re-running PBKDF2 after every update. The IV is always fresh, which is what GCM requires.
    salt, iv = salt or secrets.token_bytes(16), secrets.token_bytes(12)
    cipher = AES.new(_key(passphrase, salt, PBKDF2_ITERATIONS), AES.MODE_GCM, nonce=iv)
    ct, tag = cipher.encrypt_and_digest(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    b64 = lambda b: base64.b64encode(b).decode("ascii")
    # WebCrypto's AES-GCM expects the 16-byte tag appended to the ciphertext.
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": PBKDF2_ITERATIONS,
            "salt": b64(salt), "iv": b64(iv), "ct": b64(ct + tag)}


def decrypt(blob, passphrase):
    d = lambda s: base64.b64decode(s)
    raw = d(blob["ct"])
    cipher = AES.new(_key(passphrase, d(blob["salt"]), blob["iter"]), AES.MODE_GCM, nonce=d(blob["iv"]))
    return json.loads(cipher.decrypt_and_verify(raw[:-16], raw[-16:]))


def load_previous(url, passphrase):
    """Last published payload, used when a source fails so its items don't vanish."""
    if not url:
        return None
    try:
        resp = requests.get(url, timeout=20)
        if resp.status_code != 200:
            return None
        blob = resp.json()
        if "ct" not in blob:
            return blob
        payload = decrypt(blob, passphrase)  # raises if the passphrase changed -> new salt below
        payload["_salt"] = base64.b64decode(blob["salt"])
        return payload
    except Exception as e:
        print(f"note: couldn't load previous data ({e})", file=sys.stderr)
        return None


# ---------- collecting ----------

def _recent(items, days_back):
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)
    return [i for i in items if datetime.fromisoformat(i["due"]) >= cutoff]


def collect(settings, previous=None):
    items, errors, sources = [], [], []
    fetchers = []
    if settings["canvas_ics_url"]:
        fetchers.append(("canvas", "Canvas", lambda: canvas.fetch(settings["canvas_ics_url"])))
    if settings["gradescope_email"] and settings["gradescope_password"]:
        fetchers.append(("gradescope", "Gradescope", lambda: gradescope.fetch(
            settings["gradescope_email"], settings["gradescope_password"], settings["latest_term_only"])))

    if os.environ.get("GITHUB_ACTIONS"):
        # On GitHub every source is expected; an empty secret should be visible, not silently skipped.
        if not settings["canvas_ics_url"]:
            errors.append("Canvas isn't connected: the CANVAS_ICS_URL secret is empty.")
            print("Canvas: NOT CONFIGURED (CANVAS_ICS_URL is empty)", file=sys.stderr)
        if not (settings["gradescope_email"] and settings["gradescope_password"]):
            errors.append("Gradescope isn't connected: GRADESCOPE_EMAIL or GRADESCOPE_PASSWORD is empty.")
            print("Gradescope: NOT CONFIGURED", file=sys.stderr)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    prev_status = (previous or {}).get("source_status", {})
    status = {}
    for key, label, fetch in fetchers:
        sources.append(key)
        try:
            got = fetch()
            for i in got:
                i["course"] = clean_course(i["course"], settings["course_aliases"])
                i["title"] = clean_title(i["title"])
            hide = [h.lower() for h in settings["hide_titles_containing"]]
            got = [i for i in got if not any(h in i["title"].lower() for h in hide)]
            items += got
            status[key] = {"ok": True, "last_success": now, "error": None}
            print(f"{label}: {len(got)} items")
        except Exception as e:
            reason = _safe_error(e, settings)
            old = [i for i in (previous or {}).get("items", []) if i["source"] == key]
            last_ok = (prev_status.get(key) or {}).get("last_success") or (previous or {}).get("generated_at")
            msg = f"{label} couldn't be updated: {reason}"
            if old:
                msg += " Showing its last saved data."
                for i in old:
                    i.pop("also", None)
                items += old
            errors.append(msg)
            status[key] = {"ok": False, "last_success": last_ok, "error": reason}
            print(f"{label}: FAILED - {reason}", file=sys.stderr)

    return {
        "generated_at": now,
        "demo": False,
        "sources": sources,
        "source_status": status,
        "errors": errors,
        "items": merge(_recent(items, settings["days_back"])),
    }


def _safe_error(exc, settings):
    """Short error text with secrets removed (the Canvas feed URL contains a private token)."""
    text = str(exc).strip() or type(exc).__name__
    for secret in (settings["canvas_ics_url"], settings["gradescope_password"], settings["passphrase"]):
        if secret:
            text = text.replace(secret, "[hidden]")
    text = re.sub(r"https?://\S*/feeds/\S+", "[feed link]", text)
    return text[:200]


def write(path, obj):
    path.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {path} ({path.stat().st_size // 1024} KB)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--previous", default="")
    ap.add_argument("--out", default=str(SITE))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    if args.demo:
        import demo
        payload = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "demo": True,
                   "sources": ["canvas", "gradescope"], "errors": [], "items": merge(demo.items())}
        payload["source_status"] = {k: {"ok": True, "last_success": payload["generated_at"], "error": None}
                                    for k in payload["sources"]}
        write(out / "data.json", payload)
        write(out / "data.enc.json", encrypt(payload, DEMO_PASSPHRASE))
        return 0

    settings = load_settings()
    if not settings["canvas_ics_url"] and not settings["gradescope_email"]:
        print("No sources configured (set CANVAS_ICS_URL / GRADESCOPE_EMAIL + GRADESCOPE_PASSWORD).", file=sys.stderr)
        return 1
    previous = load_previous(args.previous, settings["passphrase"]) if args.previous else None
    payload = collect(settings, previous)
    if payload["sources"] and len(payload["errors"]) == len(payload["sources"]) and not payload["items"]:
        # Everything failed and there's nothing to show: fail so the last good deploy stays up.
        print("All sources failed; not publishing.", file=sys.stderr)
        return 1

    if settings["passphrase"]:
        salt = (previous or {}).get("_salt")
        write(out / "data.enc.json", encrypt(payload, settings["passphrase"], salt))
        (out / "data.json").unlink(missing_ok=True)  # never publish plaintext next to the encrypted file
    else:
        write(out / "data.json", payload)
        (out / "data.enc.json").unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
