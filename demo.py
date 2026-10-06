"""Made-up sample data for `python app.py --demo`, dated relative to today."""
from datetime import datetime, timedelta, timezone


def _at(days, hour=23, minute=59):
    local = (datetime.now().astimezone() + timedelta(days=days)).replace(
        hour=hour, minute=minute, second=0, microsecond=0)
    return local.astimezone(timezone.utc).isoformat()


SAMPLE = [
    # (source, course, title, days from today, hour, status)
    ("gradescope", "DEMO 101", "Project 2: Malloc Lab", 3, 23, None),
    ("gradescope", "DEMO 101", "Homework 4", -2, 23, "Submitted"),
    ("gradescope", "DEMO 101", "Homework 5", 9, 23, None),
    ("gradescope", "DEMO 103", "Problem Set 6", 1, 17, None),
    ("gradescope", "DEMO 103", "Problem Set 5", -4, 17, "18.0 / 20.0"),
    ("gradescope", "DEMO 103", "Problem Set 7", 8, 17, None),
    ("canvas", "DEMO 103", "Problem Set 6", 1, 17, None),  # same assignment linked from Canvas
    ("canvas", "DEMO 102", "Quiz 5 (Probability)", 0, 21, None),
    ("canvas", "DEMO 102", "Reading Response: Chapter 7", 5, 9, None),
    ("canvas", "DEMO 102", "Midterm Exam Review Sheet", 12, 23, None),
    ("canvas", "DEMO 104", "Essay 2 Draft", 2, 13, None),
    ("canvas", "DEMO 104", "Peer Review Comments", 6, 23, None),
    ("canvas", "DEMO 104", "Essay 2 Final", 16, 23, None),
    ("canvas", "DEMO 102", "Discussion Post 4", -1, 23, None),
    ("gradescope", "DEMO 102", "Written HW 6", 4, 23, None),
    ("gradescope", "DEMO 102", "Written HW 7", 11, 23, None),
    ("canvas", "DEMO 103", "Midterm 2", 20, 19, None),
]


def items():
    out = []
    for n, (source, course, title, days, hour, status) in enumerate(SAMPLE):
        out.append({
            "id": f"{source}:demo{n}",
            "source": source,
            "kind": "assignment",
            "title": title,
            "course": course,
            "due": _at(days, hour),
            "late_due": None,
            "all_day": False,
            "url": "https://www.gradescope.com" if source == "gradescope" else "https://canvas.instructure.com",
            "status": status,
            "done": bool(status),
        })
    return out
