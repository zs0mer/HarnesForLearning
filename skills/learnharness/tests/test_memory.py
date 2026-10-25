"""Standard-library reader tests; run with python -B -m unittest discover."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from _data import DataError
from memory import read_memory
from sessions import selected_record, render_markdown


class MemoryReaderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "data"
        self.root.mkdir()

    def pair(self, guide="A complete guide\n<script>untrusted</script>\n"):
        folder = self.root / "memory"
        folder.mkdir(exist_ok=True)
        metadata = {"version": 1, "revision": 2,
                    "teachingGuideSha256": hashlib.sha256(guide.encode()).hexdigest()}
        overview = '# Knowledge overview\n<!-- learner-memory ' + json.dumps(metadata) + ' -->\n\nFull assessment: 3.2\n'
        (folder / "teaching-guide.md").write_bytes(guide.encode())
        (folder / "knowledge-overview.md").write_bytes(overview.encode())
        return guide, overview

    def snapshot(self):
        return {str(path.relative_to(self.root)): (path.read_bytes(), path.stat().st_mtime_ns, path.stat().st_mode)
                for path in self.root.rglob("*") if path.is_file()}

    def run_reader(self, *args):
        return subprocess.run([sys.executable, "-B", str(SCRIPTS / "memory.py"),
                               "--data-dir", str(self.root), *args], capture_output=True, text=True,
                              env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, check=False)

    def test_missing_memory_is_explicit_and_creates_nothing(self):
        self.assertFalse(read_memory(self.root)["present"])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_complete_pair_is_lossless_and_read_only_including_crlf(self):
        guide, overview = self.pair("Unicode 😀\r\n" + "Long guide\n" * 10000)
        before = self.snapshot()
        value = read_memory(self.root)
        self.assertEqual(value["documents"], {"teaching-guide.md": guide, "knowledge-overview.md": overview})
        result = self.run_reader("--format", "json", "read")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["documents"], value["documents"])
        self.assertEqual(self.snapshot(), before)

    def test_markdown_escapes_html_and_reports_data_directory(self):
        self.pair()
        result = self.run_reader("read")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("&lt;script&gt;", result.stdout)
        self.assertIn(str(self.root), result.stdout)

    def test_partial_pair_mismatch_and_unknown_format_are_errors(self):
        self.pair()
        overview = self.root / "memory/knowledge-overview.md"
        original = overview.read_text()
        overview.unlink()
        with self.assertRaisesRegex(DataError, "Incomplete"):
            read_memory(self.root)
        overview.write_text(original.replace('"version": 1', '"version": 2'))
        with self.assertRaisesRegex(DataError, "Unsupported"):
            read_memory(self.root)
        overview.write_text(original)
        (self.root / "memory/teaching-guide.md").write_text("changed")
        with self.assertRaisesRegex(DataError, "Mismatched"):
            read_memory(self.root)

    def test_pending_transaction_is_not_read_or_recovered(self):
        self.pair()
        (self.root / "memory/.learner-memory.transaction.json").write_text("not even JSON")
        before = self.snapshot()
        with self.assertRaisesRegex(DataError, "pending transaction"):
            read_memory(self.root)
        self.assertEqual(self.snapshot(), before)

    def test_symlink_escape_and_invalid_utf8_are_refused(self):
        self.pair()
        guide = self.root / "memory/teaching-guide.md"
        guide.unlink()
        external = Path(self.temporary.name) / "private"
        external.write_text("never return")
        guide.symlink_to(external)
        with self.assertRaisesRegex(DataError, "outside"):
            read_memory(self.root)
        guide.unlink()
        guide.write_bytes(b"\xff")
        with self.assertRaisesRegex(DataError, "Cannot read"):
            read_memory(self.root)


class SelectiveSessionTests(unittest.TestCase):
    def record(self):
        def call(identity):
            return {"role": "assistant", "id": identity, "content": [
                {"type": "toolCall", "id": "repeated", "name": "quiz", "arguments": {"question": "Why?", "correctAnswer": "Teacher key"}}]}
        def answer(identity):
            return {"role": "toolResult", "id": identity, "toolCallId": "repeated", "toolName": "quiz", "content": [],
                    "details": {"thinking": "Learner trace", "readingThinking": "Reading trace", "confidence": 0, "correct": False}}
        return {"id": "c1", "title": "Lesson", "createdAt": "today", "updatedAt": "today", "messages": [
            {"role": "user", "id": "intro", "content": "Unselected"}, call("a1"), answer("r1"), call("a2"), answer("r2")]}

    def test_exact_ids_preserve_original_indexes_and_full_answer_details(self):
        record = self.record()
        before = json.dumps(record)
        value = selected_record(record, message_ids=["r1"])
        self.assertEqual([message["id"] for message in value["record"]["messages"]], ["a1", "r1"])
        self.assertEqual(value["source_message_indexes"], [1, 2])
        self.assertEqual(value["record"]["messages"][1]["details"], record["messages"][2]["details"])
        self.assertIn("messages[2] · id=r1", render_markdown(value))
        self.assertTrue(any(item["source"] == "messages[0]" for item in value["omissions"]))
        self.assertEqual(json.dumps(record), before)

    def test_unknown_ids_do_not_silently_return_partial_evidence(self):
        with self.assertRaisesRegex(DataError, "Unknown message IDs"):
            selected_record(self.record(), message_ids=["r1", "unknown"])

    def test_practice_marker_includes_its_occurrence_family(self):
        record = self.record()
        record["messages"].insert(2, {"role": "custom", "id": "thinking", "customType": "practice-thinking",
                                      "content": "Attempt", "details": {"problemCallId": "repeated", "text": "Attempt"}})
        value = selected_record(record, message_ids=["thinking"])
        self.assertEqual([message["id"] for message in value["record"]["messages"]], ["a1", "thinking", "r1"])

    def test_repeated_cli_flags_and_json_format(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "chats").mkdir()
            (root / "chats/c1.json").write_text(json.dumps(self.record()))
            result = subprocess.run([sys.executable, "-B", str(SCRIPTS / "sessions.py"), "--data-dir", temporary,
                                     "--format", "json", "read", "c1", "--message-id", "r1", "--message-id", "r2"],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["source_message_indexes"], [1, 2, 3, 4])

    def test_practice_conclusion_and_result_are_included(self):
        record = self.record()
        record["messages"] = [
            {"role": "assistant", "id": "pose", "content": [{"type": "toolCall", "name": "problem", "id": "p", "arguments": {}}]},
            {"role": "custom", "id": "trace", "customType": "practice-thinking", "content": "Attempt", "details": {"problemCallId": "p"}},
            {"role": "assistant", "id": "verdict", "content": [{"type": "toolCall", "name": "conclude", "id": "c", "arguments": {"verdict": "Work credited"}}]},
            {"role": "toolResult", "id": "ack", "toolName": "conclude", "toolCallId": "c", "content": []}]
        value = selected_record(record, message_ids=["trace"])
        self.assertEqual([message["id"] for message in value["record"]["messages"]], ["pose", "trace", "verdict", "ack"])


if __name__ == "__main__":
    unittest.main()