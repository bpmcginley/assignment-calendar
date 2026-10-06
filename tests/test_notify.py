"""Run with:  python -m unittest discover tests"""
import base64
import json
import secrets
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import build  # noqa: E402
import notify  # noqa: E402
from Crypto.Cipher import AES  # noqa: E402

ET = ZoneInfo("America/New_York")


def et(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=ET).astimezone(timezone.utc)


def item(id_, course, title, due, kind="assignment", done=False):
    return {"id": id_, "course": course, "title": title, "due": due.isoformat(), "kind": kind, "done": done}


PAYLOAD = {"items": [
    item("a", "COMPSCI 250", "Quiz 3", et(2026, 10, 6, 23, 59)),
    item("b", "COMPSCI 230", "Project 1 Questionnaires", et(2026, 10, 6, 23, 59)),
    item("c", "COMPSCI 230", "Topic 4 Worksheet", et(2026, 10, 9, 23, 59)),
    item("d", "COMPSCI 383", "Homework 2", et(2026, 10, 6, 17, 0), done=True),          # submitted
    item("e", "MATH 235H", "Problem Set 4", et(2026, 10, 7, 0, 0)),                      # midnight
    item("x", "COMPSCI 383", "MIDTERM 1", et(2026, 10, 13, 11, 30), kind="event"),
]}


class ReminderTests(unittest.TestCase):
    def test_six_hours_before_grouped_and_once(self):
        notes, state = notify.plan(PAYLOAD, {}, et(2026, 10, 6, 18, 7))
        rem = [n for n in notes if n["kind"] == "reminder"]
        # 11:59 PM pair grouped; midnight item separately; done item skipped; 5:00 PM item already past.
        self.assertEqual(len(rem), 2)
        self.assertEqual(rem[0]["title"], "2 due in 5 hr 52 min")
        self.assertIn("250 Quiz 3", rem[0]["body"])
        self.assertIn("11:59 PM tonight", rem[0]["body"])
        self.assertEqual(rem[1]["title"], "MATH 235H Problem Set 4")
        self.assertIn("midnight", rem[1]["body"])
        again, _ = notify.plan(PAYLOAD, state, et(2026, 10, 6, 18, 37))
        self.assertFalse([n for n in again if n["kind"] == "reminder"])

    def test_not_before_six_hours(self):
        notes, _ = notify.plan(PAYLOAD, {}, et(2026, 10, 6, 17, 37))
        self.assertFalse([n for n in notes if n["kind"] == "reminder"])

    def test_unknown_state_only_reminds_just_crossed(self):
        notes, _ = notify.plan(PAYLOAD, None, et(2026, 10, 6, 21, 0))   # 3h before: would repeat
        self.assertFalse([n for n in notes if n["kind"] == "reminder"])


class DigestTests(unittest.TestCase):
    def test_10am_lists_today_including_midnight(self):
        notes, state = notify.plan(PAYLOAD, {}, et(2026, 10, 6, 10, 7))
        d = [n for n in notes if n["kind"] == "digest"]
        self.assertEqual(len(d), 1)
        self.assertEqual(d[0]["title"], "3 due today")
        self.assertEqual(d[0]["body"].splitlines(), [
            "11:59 PM  250 Quiz 3", "11:59 PM  230 Project 1 Questionnaires", "midnight  MATH 235H Problem Set 4"])
        later, _ = notify.plan(PAYLOAD, state, et(2026, 10, 6, 10, 37))
        self.assertFalse([n for n in later if n["kind"] == "digest"])

    def test_not_before_10(self):
        notes, _ = notify.plan(PAYLOAD, {}, et(2026, 10, 6, 9, 37))
        self.assertFalse([n for n in notes if n["kind"] == "digest"])

    def test_nothing_due_names_next(self):
        notes, _ = notify.plan(PAYLOAD, {}, et(2026, 10, 8, 10, 7))
        d = [n for n in notes if n["kind"] == "digest"][0]
        self.assertEqual(d["title"], "Nothing due today")
        self.assertEqual(d["body"], "Next: 230 Topic 4 Worksheet, Fri 11:59 PM.")

    def test_exam_day_is_listed(self):
        notes, _ = notify.plan(PAYLOAD, {}, et(2026, 10, 13, 10, 7))
        self.assertIn("383 MIDTERM 1", [n for n in notes if n["kind"] == "digest"][0]["body"])

    def test_unknown_state_digest_only_early(self):
        self.assertTrue([n for n in notify.plan(PAYLOAD, None, et(2026, 10, 6, 10, 20))[0] if n["kind"] == "digest"])
        self.assertFalse([n for n in notify.plan(PAYLOAD, None, et(2026, 10, 6, 11, 20))[0] if n["kind"] == "digest"])


class DeviceCodeTests(unittest.TestCase):
    def test_app_code_round_trip(self):
        # Encrypt a subscription the way site/store.js does: PBKDF2 key + AES-GCM, tag appended.
        sub = {"endpoint": "https://web.push.apple.com/abc", "keys": {"p256dh": "BPk", "auth": "xyz"}}
        salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
        key = build._key("pw", salt, 1000)
        ct, tag = AES.new(key, AES.MODE_GCM, nonce=iv).encrypt_and_digest(json.dumps(sub).encode())
        b = lambda x: base64.b64encode(x).decode()
        code = b(json.dumps({"v": 1, "salt": b(salt), "iter": 1000, "iv": b(iv), "ct": b(ct + tag)}).encode())
        self.assertEqual(notify.decode_device_code(code, "pw", build._key), sub)
        with self.assertRaises(Exception):
            notify.decode_device_code(code, "wrong", build._key)

    def test_public_key_shape(self):
        pub = notify.vapid_public_key(notify.generate_vapid_private_key())
        raw = base64.urlsafe_b64decode(pub + "=")
        self.assertEqual((len(raw), raw[0]), (65, 4))


def app_code(obj, passphrase="pw"):
    """Encrypt like site/store.js encryptForServer."""
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    ct, tag = AES.new(build._key(passphrase, salt, 1000), AES.MODE_GCM, nonce=iv).encrypt_and_digest(json.dumps(obj).encode())
    b = lambda x: base64.b64encode(x).decode()
    return b(json.dumps({"v": 1, "salt": b(salt), "iter": 1000, "iv": b(iv), "ct": b(ct + tag)}).encode())


class DoneMarksTests(unittest.TestCase):
    SETTINGS = {"passphrase": "pw"}

    def run_apply(self, code, previous=None):
        import os
        payload = {"items": [dict(i) for i in PAYLOAD["items"]]}
        os.environ["DONE_MARKS"] = code or ""
        try:
            build.apply_done_marks(payload, self.SETTINGS, previous)
        finally:
            os.environ.pop("DONE_MARKS", None)
        return payload

    def test_newer_marks_win_and_unknown_ids_are_dropped(self):
        prev = {"done_marks": {"updated_at": "2026-10-06T20:00:00Z", "done": {"a": True}}}
        p = self.run_apply(app_code({"v": 1, "updated_at": "2026-10-06T21:00:00.000Z", "done": {"b": True, "gone": True}}), prev)
        self.assertEqual(p["done_marks"]["done"], {"b": True})
        p = self.run_apply(app_code({"v": 1, "updated_at": "2026-10-06T19:00:00.000Z", "done": {"c": True}}), prev)
        self.assertEqual(p["done_marks"]["done"], {"a": True})          # older update ignored

    def test_unreadable_code_keeps_previous(self):
        prev = {"done_marks": {"updated_at": "2026-10-06T20:00:00Z", "done": {"a": True}}}
        p = self.run_apply(app_code({"v": 1, "updated_at": "2026-10-07T00:00:00Z", "done": {}}, passphrase="other"), prev)
        self.assertEqual(p["done_marks"]["done"], {"a": True})

    def test_reminders_skip_marked_items(self):
        import os
        payload = {"items": [dict(i) for i in PAYLOAD["items"]],
                   "done_marks": {"updated_at": "2026-10-06T20:00:00Z", "done": {"a": True}}}
        marks = payload["done_marks"]["done"]
        view = dict(payload, items=[dict(i, done=marks.get(i["id"], i.get("done", False))) for i in payload["items"]])
        notes, _ = notify.plan(view, {}, et(2026, 10, 6, 18, 7))
        first = [n for n in notes if n["kind"] == "reminder"][0]
        self.assertEqual(first["title"], "230 Project 1 Questionnaires")   # Quiz 3 (a) skipped, no longer grouped


if __name__ == "__main__":
    unittest.main()
