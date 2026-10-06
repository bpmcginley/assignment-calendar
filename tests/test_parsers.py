"""Run with:  python -m unittest discover tests"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import build  # noqa: E402
import canvas  # noqa: E402
import gradescope  # noqa: E402

# Shaped like the real UMass Canvas feed: assignments due at 11:59 PM come through as all-day dates.
CANVAS_ICS = (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"
    "BEGIN:VEVENT\r\nUID:event-assignment-111\r\nDTSTART;VALUE=DATE;VALUE=DATE:20261009\r\n"
    "SUMMARY:Problem Set 6 [MATH 233 (170001) FA26]\r\n"
    "URL;VALUE=URI:https://umamherst.instructure.com/calendar?include_contexts=c\r\n"
    " ourse_39039&month=10&year=2026#assignment_111\r\nEND:VEVENT\r\n"
    "BEGIN:VEVENT\r\nUID:event-assignment-112\r\nDTSTART:20261013T153000Z\r\n"
    "SUMMARY:\U0001F916 AI Track\\, Project 2 [COMPSCI 230 (37999) FA26]\r\nEND:VEVENT\r\n"
    "BEGIN:VEVENT\r\nUID:event-calendar-event-222\r\nDTSTART;VALUE=DATE:20261015\r\n"
    "SUMMARY:No class\\, holiday [ENGLWRIT 112]\r\nEND:VEVENT\r\n"
    "END:VCALENDAR\r\n"
)

GS_ACCOUNT = """
<div id="account-show">
  <h2 class="pageHeading">Student Courses</h2>
  <div class="courseList">
    <div class="courseList--term">Fall 2026</div>
    <div class="courseList--coursesForTerm">
      <a class="courseBox" href="/courses/1001"><h3 class="courseBox--shortname">MATH 233</h3>
        <div class="courseBox--name">Multivariate Calculus</div></a>
      <a class="courseBox" href="/courses/1002"><h3 class="courseBox--shortname">CS 230</h3></a>
    </div>
    <div class="courseList--term">Spring 2026</div>
    <div class="courseList--coursesForTerm">
      <a class="courseBox" href="/courses/900"><h3 class="courseBox--shortname">COMPSCI 187</h3></a>
    </div>
  </div>
</div>
"""

GS_COURSE = """
<table id="assignments-student-table"><thead><tr role="row"><th>Name</th><th>Status</th><th>Dates</th></tr></thead>
<tbody>
<tr role="row">
  <th class="table--primaryLink" scope="row"><a href="/courses/1001/assignments/55/submissions/9">Problem Set 5</a></th>
  <td class="submissionStatus"><div class="submissionStatus--score">18.0 / 20.0</div></td>
  <td><time class="submissionTimeChart--releaseDate" datetime="2026-09-25 09:00:00 -0400">Sep 25</time>
    <time class="submissionTimeChart--dueDate" datetime="2026-10-02 17:00:00 -0400">Due: Oct 02</time></td>
</tr>
<tr role="row">
  <th class="table--primaryLink" scope="row"><button class="js-submitAssignment" data-assignment-id="56">Problem Set 6</button></th>
  <td class="submissionStatus"><div class="submissionStatus--text">No Submission</div></td>
  <td><time class="submissionTimeChart--releaseDate" datetime="2026-10-02 09:00:00 -0400">Oct 02</time>
    <time class="submissionTimeChart--dueDate" datetime="2026-10-09 23:59:00 -0400">Due: Oct 09</time>
    <time class="submissionTimeChart--dueDate" datetime="2026-10-11 23:59:00 -0400">Late Due: Oct 11</time></td>
</tr>
<tr role="row"><th scope="row"><button>Practice (no due date)</button></th><td></td><td></td></tr>
</tbody></table>
"""


class CanvasTests(unittest.TestCase):
    def setUp(self):
        self.items = canvas.parse_ics(CANVAS_ICS)

    def test_all_day_assignment_is_due_1159pm_eastern(self):
        a = self.items[0]
        self.assertEqual(a["title"], "Problem Set 6")
        self.assertFalse(a["all_day"])
        self.assertEqual(a["due"], "2026-10-10T03:59:00+00:00")  # 11:59 PM EDT on Oct 9

    def test_link_points_at_assignment_not_calendar(self):
        self.assertEqual(self.items[0]["url"], "https://umamherst.instructure.com/courses/39039/assignments/111")

    def test_timed_assignment_and_event(self):
        self.assertEqual(self.items[1]["due"], "2026-10-13T15:30:00+00:00")
        e = self.items[2]
        self.assertEqual((e["kind"], e["all_day"], e["title"]), ("event", True, "No class, holiday"))


class GradescopeTests(unittest.TestCase):
    def test_latest_term_courses(self):
        courses = gradescope.parse_courses(GS_ACCOUNT)
        self.assertEqual([c["id"] for c in courses], ["1001", "1002"])
        self.assertEqual(len(gradescope.parse_courses(GS_ACCOUNT, latest_term_only=False)), 3)

    def test_assignments(self):
        items = gradescope.parse_assignments(GS_COURSE, {"id": "1001", "name": "MATH 233"})
        self.assertEqual([i["title"] for i in items], ["Problem Set 5", "Problem Set 6"])
        done, todo = items
        self.assertTrue(done["done"])
        self.assertEqual(done["status"], "18.0 / 20.0")
        self.assertFalse(todo["done"])
        self.assertEqual(todo["due"], "2026-10-10T03:59:00+00:00")
        self.assertEqual(todo["late_due"], "2026-10-12T03:59:00+00:00")
        self.assertEqual(todo["url"], "https://www.gradescope.com/courses/1001/assignments/56")


class BuildTests(unittest.TestCase):
    def test_course_names(self):
        for raw, want in [("COMPSCI 230 (170646) FA26", "COMPSCI 230"), ("CS 230 Fall 2026", "COMPSCI 230"),
                          ("CMPSCI 383 SEC 01", "COMPSCI 383"), ("MATH 233", "MATH 233")]:
            self.assertEqual(build.clean_course(raw), want)
        self.assertEqual(build.clean_course("Intro Stats", {"Intro Stats": "STAT 240"}), "STAT 240")

    def test_titles_lose_emoji(self):
        self.assertEqual(build.clean_title("\U0001F6E0️ No-AI Track, Project 1"), "No-AI Track, Project 1")
        self.assertEqual(build.clean_title("Homework 4"), "Homework 4")

    def test_same_assignment_on_both_platforms_is_merged(self):
        cv = canvas.parse_ics(CANVAS_ICS)
        gs = gradescope.parse_assignments(GS_COURSE, {"id": "1001", "name": "MATH 233"})
        for i in cv:
            i["course"] = build.clean_course(i["course"])
        merged = build.merge(cv + gs)
        ps6 = [i for i in merged if i["title"] == "Problem Set 6"]
        self.assertEqual(len(ps6), 1)
        self.assertEqual((ps6[0]["source"], ps6[0]["also"]["source"]), ("gradescope", "canvas"))

    def test_same_title_in_different_courses_is_not_merged(self):
        a = {"source": "canvas", "course": "COMPSCI 230", "title": "Homework 1", "due": "2026-10-10T03:59:00+00:00", "url": None}
        b = dict(a, source="gradescope", course="COMPSCI 250")
        self.assertEqual(len(build.merge([a, b])), 2)

    def test_encryption_round_trip(self):
        payload = {"items": [{"title": "x"}], "generated_at": "now"}
        blob = build.encrypt(payload, "pass phrase")
        self.assertEqual(build.decrypt(blob, "pass phrase"), payload)
        with self.assertRaises(ValueError):
            build.decrypt(blob, "wrong")


class FailureTests(unittest.TestCase):
    def test_failed_source_keeps_last_data_and_hides_secret(self):
        secret_url = "https://example.invalid/feeds/calendars/user_SECRET.ics"
        settings = {"canvas_ics_url": secret_url, "gradescope_email": "", "gradescope_password": "",
                    "passphrase": "", "days_back": 14, "latest_term_only": True,
                    "course_aliases": {}, "hide_titles_containing": []}
        previous = {"generated_at": "2026-10-06T10:00:00+00:00",
                    "source_status": {"canvas": {"ok": True, "last_success": "2026-10-06T10:00:00+00:00"}},
                    "items": [{"id": "canvas:x", "source": "canvas", "kind": "assignment", "title": "Old HW",
                               "course": "COMPSCI 230", "due": "2099-01-01T00:00:00+00:00", "url": None}]}
        original = canvas.fetch
        canvas.fetch = lambda url: (_ for _ in ()).throw(RuntimeError(f"404 for url: {url}"))
        try:
            payload = build.collect(settings, previous)
        finally:
            canvas.fetch = original
        self.assertEqual([i["title"] for i in payload["items"]], ["Old HW"])
        st = payload["source_status"]["canvas"]
        self.assertFalse(st["ok"])
        self.assertEqual(st["last_success"], "2026-10-06T10:00:00+00:00")
        self.assertNotIn("SECRET", json_dump(payload))


def json_dump(obj):
    import json
    return json.dumps(obj)


if __name__ == "__main__":
    unittest.main()
