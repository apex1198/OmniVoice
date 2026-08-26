import tempfile
import unittest
from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).parents[1] / "backend"))

from core import (
    Database,
    apply_pronunciation_dictionary,
    normalize_inference_steps,
    normalize_voice_design_description,
    natural_pause_ms,
    parse_multispeaker_script,
    smart_text_chunks,
    split_long_text,
)


class MultiSpeakerTests(unittest.TestCase):
    def test_parses_four_speakers(self):
        script = "@[Speaker 1] Hello. @[Speaker 2] Hi. @[Speaker 3] Welcome. @[Speaker 4] Thanks."
        self.assertEqual([item["speaker"] for item in parse_multispeaker_script(script)], [
            "Speaker 1", "Speaker 2", "Speaker 3", "Speaker 4"
        ])

    def test_unprefixed_text_defaults_to_speaker_one(self):
        self.assertEqual(parse_multispeaker_script("Hello world"), [{"speaker": "Speaker 1", "text": "Hello world"}])

    def test_prefix_text_is_preserved(self):
        parsed = parse_multispeaker_script("Intro. @[Speaker 2] Reply.")
        self.assertEqual(parsed[0]["speaker"], "Speaker 1")
        self.assertEqual(parsed[1]["speaker"], "Speaker 2")


class LongFormTests(unittest.TestCase):
    def test_chunks_without_losing_text(self):
        text = "First sentence. Second sentence is longer. Third sentence ends here."
        chunks = split_long_text(text, max_chars=35)
        self.assertGreater(len(chunks), 1)
        self.assertEqual(" ".join(chunks), text)

    def test_chunks_text_without_spaces(self):
        text = "你" * 1000
        chunks = split_long_text(text, max_chars=120)
        self.assertTrue(all(len(chunk) <= 120 for chunk in chunks))
        self.assertEqual("".join(chunks), text)

    def test_smart_chunks_preserve_paragraph_boundaries(self):
        chunks = smart_text_chunks("First paragraph.\n\nSecond paragraph. Another sentence.", max_chars=30)
        self.assertEqual(chunks[0]["boundary"], "paragraph")
        self.assertEqual(chunks[-1]["boundary"], "end")
        self.assertEqual([item["text"] for item in chunks], [
            "First paragraph.", "Second paragraph.", "Another sentence.",
        ])

    def test_natural_pause_is_longer_for_speaker_change_and_paragraph(self):
        first = {"speaker": "Speaker 1", "text": "Are you ready?", "boundary": "sentence"}
        same = {"speaker": "Speaker 1", "text": "Yes."}
        other = {"speaker": "Speaker 2", "text": "Yes."}
        self.assertEqual(natural_pause_ms(first, same), 320)
        self.assertEqual(natural_pause_ms(first, other), 720)
        first["boundary"] = "paragraph"
        self.assertEqual(natural_pause_ms(first, other), 900)
        self.assertEqual(natural_pause_ms(first, other, 400), 400)

    def test_pronunciation_dictionary(self):
        result = apply_pronunciation_dictionary("OpenAI uses TTS", [
            {"source": "OpenAI", "target": "Open A I"},
            {"source": "TTS", "target": "text to speech"},
        ])
        self.assertEqual(result, "Open A I uses text to speech")

    def test_normalizes_invalid_inference_steps(self):
        self.assertEqual(normalize_inference_steps(0), 32)
        self.assertEqual(normalize_inference_steps(""), 32)
        self.assertEqual(normalize_inference_steps("invalid"), 32)
        self.assertEqual(normalize_inference_steps(500), 100)

    def test_validates_voice_design_description(self):
        self.assertEqual(
            normalize_voice_design_description("Female, young adult, moderate pitch"),
            "female, young adult, moderate pitch",
        )
        with self.assertRaisesRegex(ValueError, "warm"):
            normalize_voice_design_description("female, warm, low pitch")


class DatabaseTests(unittest.TestCase):
    def test_project_voice_and_job_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Database(Path(directory) / "test.sqlite3")
            project = db.save_project({"name": "Demo", "script": "Hello", "settings": {"speed": 1}})
            voices = db.list_voices()
            job = db.create_job({
                "project_id": project["id"],
                "text": "Hello",
                "speaker_map": {"Speaker 1": voices[0]["id"]},
                "config": {},
            }, [{"speaker": "Speaker 1", "text": "Hello"}])
            self.assertEqual(job["status"], "pending")
            self.assertEqual(len(job["segments"]), 1)

    def test_recovers_jobs_after_engine_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Database(Path(directory) / "test.sqlite3")
            project = db.save_project({"name": "Recovery"})
            voice_id = db.list_voices()[0]["id"]
            payload = {
                "project_id": project["id"],
                "text": "Resume this render.",
                "speaker_map": {"Speaker 1": voice_id},
                "config": {},
            }
            running = db.create_job(payload, [{"speaker": "Speaker 1", "text": payload["text"]}])
            db.update_job(running["id"], status="running")
            cancelled = db.create_job(payload, [{"speaker": "Speaker 1", "text": payload["text"]}])
            db.cancel_job(cancelled["id"])

            db.recover_interrupted_jobs()

            self.assertEqual(db.get_job(running["id"])["status"], "pending")
            self.assertEqual(db.get_job(cancelled["id"])["status"], "cancelled")


if __name__ == "__main__":
    unittest.main()
