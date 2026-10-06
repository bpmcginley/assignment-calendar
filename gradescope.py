"""Gradescope source: logs in with your Gradescope email/password and reads your course pages.

Gradescope has no public API or calendar feed, so this reads the same pages you see in the
browser. If Gradescope changes its page layout, the parsing here may need a tweak.
"""
import re
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

BASE = "https://www.gradescope.com"
HEADERS = {"User-Agent": "Mozilla/5.0 (assignment-calendar personal script)"}


class GradescopeError(Exception):
    pass


def login(email, password):
    session = requests.Session()
    session.headers.update(HEADERS)
    home = session.get(BASE, timeout=20)
    home.raise_for_status()
    token_input = BeautifulSoup(home.text, "html.parser").select_one(
        'form[action="/login"] input[name="authenticity_token"]')
    if token_input is None:
        raise GradescopeError("Couldn't find Gradescope's login form (the site layout may have changed).")
    resp = session.post(f"{BASE}/login", data={
        "utf8": "✓",
        "session[email]": email,
        "session[password]": password,
        "session[remember_me]": 0,
        "commit": "Log In",
        "session[remember_me_sso]": 0,
        "authenticity_token": token_input["value"],
    }, timeout=20)
    # A successful login redirects away from /login to the account page.
    if not resp.history or resp.url.rstrip("/").endswith("/login"):
        raise GradescopeError(
            "Gradescope login failed. Check the email/password in config.json. If you normally sign in "
            "with your school account (SSO), set a Gradescope password first - see README.")
    return session


def parse_courses(html, latest_term_only=True):
    """Return [{id, name, term}] from the account page (gradescope.com/account)."""
    soup = BeautifulSoup(html, "html.parser")
    courses = []
    for term_div in soup.select("div.courseList--term"):
        term = term_div.get_text(" ", strip=True)
        container = term_div.find_next_sibling("div")
        if container is None:
            continue
        for box in container.select("a.courseBox[href]"):
            courses.append(_course_from_box(box, term))
    if not courses:  # layout fallback: any course link on the page
        courses = [_course_from_box(b, None) for b in soup.select("a.courseBox[href]")]
    courses = [c for c in courses if c["id"]]
    # Drop duplicates (a course can appear in both the instructor and student list).
    seen, unique = set(), []
    for c in courses:
        if c["id"] not in seen:
            seen.add(c["id"])
            unique.append(c)
    if latest_term_only and unique and unique[0]["term"]:
        # Gradescope lists the newest term first.
        unique = [c for c in unique if c["term"] == unique[0]["term"]]
    return unique


def _course_from_box(box, term):
    m = re.search(r"/courses/(\d+)", box["href"])
    short = box.select_one(".courseBox--shortname")
    full = box.select_one(".courseBox--name")
    name = (short or full or box).get_text(" ", strip=True)
    return {"id": m.group(1) if m else None, "name": name, "term": term}


def _parse_time(value):
    value = value.strip()
    for fmt in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S%z"):
        try:
            return datetime.strptime(value, fmt).astimezone(timezone.utc)
        except ValueError:
            pass
    try:
        dt = datetime.fromisoformat(value)
        return (dt if dt.tzinfo else dt.astimezone()).astimezone(timezone.utc)
    except ValueError:
        return None


def parse_assignments(html, course):
    soup = BeautifulSoup(html, "html.parser")
    table = soup.select_one("#assignments-student-table") or soup
    rows = table.select("tbody tr") or table.select("tr")
    items = []
    for row in rows:
        title_cell = row.find("th")
        if title_cell is None:
            continue
        link = title_cell.find("a", href=True)
        button = title_cell.find("button")
        title = (link or button or title_cell).get_text(" ", strip=True)
        if not title:
            continue

        assignment_id = None
        url = f"{BASE}/courses/{course['id']}"
        if link:
            url = BASE + link["href"] if link["href"].startswith("/") else link["href"]
            m = re.search(r"/assignments/(\d+)", link["href"])
            assignment_id = m.group(1) if m else None
        elif button is not None and button.get("data-assignment-id"):
            assignment_id = button["data-assignment-id"]
            url = f"{BASE}/courses/{course['id']}/assignments/{assignment_id}"

        due_times = [t for t in row.select("time") if "dueDate" in " ".join(t.get("class", []))]
        dues = [d for d in (_parse_time(t.get("datetime", "")) for t in due_times) if d]
        if not dues:
            continue  # no due date -> nothing to put on a calendar

        status_el = row.select_one(".submissionStatus--score") or row.select_one(".submissionStatus--text")
        status = status_el.get_text(" ", strip=True) if status_el else None

        items.append({
            "id": f"gradescope:{course['id']}:{assignment_id or title}",
            "source": "gradescope",
            "kind": "assignment",
            "title": title,
            "course": course["name"],
            "due": dues[0].isoformat(),
            "late_due": dues[1].isoformat() if len(dues) > 1 else None,
            "all_day": False,
            "url": url,
            "status": status,
            "done": bool(status and status.lower() != "no submission"),
        })
    return items


def fetch(email, password, latest_term_only=True):
    session = login(email, password)
    account = session.get(f"{BASE}/account", timeout=20)
    account.raise_for_status()
    courses = parse_courses(account.text, latest_term_only)
    items = []
    for course in courses:
        page = session.get(f"{BASE}/courses/{course['id']}", timeout=20)
        page.raise_for_status()
        items.extend(parse_assignments(page.text, course))
    return items
