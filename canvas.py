"""Canvas source: reads the personal calendar feed (.ics) that Canvas gives every student.

Find it in Canvas -> Calendar -> "Calendar Feed" (bottom right). No password needed.
"""
import re
from datetime import datetime, timezone, timedelta

from zoneinfo import ZoneInfo

import requests

SCHOOL_TZ = ZoneInfo("America/New_York")  # UMass Amherst; Canvas deadlines are set in this zone

COURSE_IN_SUMMARY = re.compile(r"^(.*?)\s*\[([^\[\]]+)\]\s*$")


def _unfold(text):
    """ICS lines longer than 75 chars are folded onto continuation lines starting with a space."""
    return re.sub(r"\r?\n[ \t]", "", text).splitlines()


def _unescape(value):
    return (value.replace("\\n", "\n").replace("\\N", "\n")
            .replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\"))


def _parse_dt(params, value):
    """Return (aware UTC datetime, all_day)."""
    value = value.strip()
    if "VALUE=DATE" in params and "DATE-TIME" not in params or re.fullmatch(r"\d{8}", value):
        d = datetime.strptime(value[:8], "%Y%m%d")
        # All-day items: treat as due at 11:59pm local on that day; store as naive-noon UTC so
        # the date never shifts when displayed in US time zones.
        return d.replace(hour=12, tzinfo=timezone.utc), True
    if value.endswith("Z"):
        return datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc), False
    # Floating or TZID time: interpret as the computer's local time zone.
    local = datetime.strptime(value[:15], "%Y%m%dT%H%M%S")
    return local.astimezone().astimezone(timezone.utc), False


def parse_ics(text):
    items = []
    event = None
    for line in _unfold(text):
        if line == "BEGIN:VEVENT":
            event = {}
            continue
        if line == "END:VEVENT":
            if event is not None:
                item = _event_to_item(event)
                if item:
                    items.append(item)
            event = None
            continue
        if event is None or ":" not in line:
            continue
        key, value = line.split(":", 1)
        name, _, params = key.partition(";")
        event[name.upper()] = (params, value)
    return items


def _event_to_item(event):
    if "DTSTART" not in event or "SUMMARY" not in event:
        return None
    due, all_day = _parse_dt(*event["DTSTART"])
    summary = _unescape(event["SUMMARY"][1]).strip()
    course = None
    m = COURSE_IN_SUMMARY.match(summary)
    if m:
        summary, course = m.group(1).strip(), m.group(2).strip()
    uid = event.get("UID", ("", summary + due.isoformat()))[1]
    url = _assignment_url(event.get("URL", ("", ""))[1].strip()) or None
    kind = "assignment" if "assignment" in uid else "event"
    if all_day and kind == "assignment":
        # Canvas exports assignments due at 11:59 PM as all-day dates; restore the real deadline.
        day = due.date()
        due = datetime(day.year, day.month, day.day, 23, 59, tzinfo=SCHOOL_TZ).astimezone(timezone.utc)
        all_day = False
    return {
        "id": "canvas:" + uid,
        "source": "canvas",
        "kind": kind,
        "title": summary,
        "course": course or "Canvas",
        "due": due.isoformat(),
        "all_day": all_day,
        "url": url,
        "status": None,
        "late_due": None,
        "done": False,
    }


def _assignment_url(url):
    """Canvas feed links point at the calendar (…/calendar?include_contexts=course_39039…#assignment_874676).
    Turn them into the assignment page itself: …/courses/39039/assignments/874676."""
    m = re.match(r"(https?://[^/]+)/calendar\?.*include_contexts=course_(\d+).*#assignment_(\d+)", url)
    return f"{m.group(1)}/courses/{m.group(2)}/assignments/{m.group(3)}" if m else url


def fetch(ics_url, timeout=20):
    resp = requests.get(ics_url, timeout=timeout)
    resp.raise_for_status()
    return parse_ics(resp.text)


def keep_recent(items, days_back=14):
    cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)
    return [i for i in items if datetime.fromisoformat(i["due"]) >= cutoff]
