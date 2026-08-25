import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / "backend"))

from fastapi.testclient import TestClient
from server import Engine, create_app


class FakePrompt:
    def __init__(self, text):
        self.ref_text = text

    def save(self, path):
        Path(path).write_bytes(b"prompt")


class FakeModel:
    def __init__(self):
        self._asr_pipe = None
        self.last_generation_config = None

    def generate(self, **kwargs):
        self.last_generation_config = kwargs["generation_config"]
        return [np.zeros(2400, dtype=np.float32)]

    def create_voice_clone_prompt(self, ref_audio, ref_text):
        return FakePrompt(ref_text)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.engine = Engine(self.directory.name, "test-model")
        self.engine.model = FakeModel()
        self.client = TestClient(create_app(self.engine))

    def tearDown(self):
        self.client.close()
        self.directory.cleanup()

    def test_health_projects_and_voices(self):
        health = self.client.get("/api/health").json()
        self.assertEqual(health["app"], "Omni Speak")
        self.assertTrue(health["ready"])
        self.assertFalse(health["asr_loaded"])
        self.assertEqual(len(self.client.get("/api/projects").json()), 1)
        self.assertEqual(len(self.client.get("/api/voices").json()), 4)

    def test_creates_queued_multispeaker_job(self):
        voices = self.client.get("/api/voices").json()
        payload = {
            "project_id": "project_inbox",
            "text": "@[Speaker 1] Hello. @[Speaker 2] Welcome.",
            "speaker_map": {
                "Speaker 1": voices[0]["id"],
                "Speaker 2": voices[1]["id"],
            },
            "config": {"chunk_chars": 100},
        }
        job = self.client.post("/api/jobs", json=payload).json()
        self.assertEqual(job["status"], "pending")
        self.assertEqual(len(job["segments"]), 2)

    def test_rejects_missing_speaker_voice(self):
        response = self.client.post("/api/jobs", json={
            "project_id": "project_inbox",
            "text": "@[Speaker 4] Missing voice",
            "speaker_map": {},
        })
        self.assertEqual(response.status_code, 400)

    def test_rejects_unsupported_voice_design_before_generation(self):
        response = self.client.post("/api/voices/design", json={
            "name": "Invalid design",
            "description": "female, warm, Vietnamese accent",
            "preview_text": "Test preview.",
        })
        self.assertEqual(response.status_code, 400)
        self.assertIn("warm", response.json()["detail"])

    def test_performance_voice_design_uses_eight_steps(self):
        response = self.client.post("/api/voices/design", json={
            "name": "Fast design",
            "description": "female, young adult, moderate pitch",
            "preview_text": "Fast preview.",
            "performance_mode": True,
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.engine.model.last_generation_config.num_step, 8)
        self.assertFalse(self.engine.model.last_generation_config.postprocess_output)

if __name__ == "__main__":
    unittest.main()
