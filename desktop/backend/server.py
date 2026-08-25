import argparse
import gc
import json
import logging
import math
import shutil
import threading
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from core import (
    Database,
    apply_pronunciation_dictionary,
    new_id,
    normalize_inference_steps,
    normalize_voice_design_description,
    parse_multispeaker_script,
    split_long_text,
)
from omnivoice import OmniVoice, OmniVoiceGenerationConfig, VoiceClonePrompt
from omnivoice.utils.audio import load_waveform
from omnivoice.utils.common import get_best_device


LOGGER = logging.getLogger("omni-speak")
SAMPLE_RATE = 24000
ALLOWED_AUDIO = {".wav", ".mp3", ".m4a"}


class ProjectInput(BaseModel):
    id: str | None = None
    name: str = "Untitled Project"
    script: str = ""
    settings: dict = Field(default_factory=dict)


class DesignVoiceInput(BaseModel):
    name: str
    description: str
    preview_text: str = "Welcome to Omni Speak. This is a preview of my voice."
    performance_mode: bool = False


class SpeechJobInput(BaseModel):
    project_id: str = "project_inbox"
    text: str
    speaker_map: dict[str, str]
    config: dict = Field(default_factory=dict)


class Engine:
    def __init__(self, data_dir, checkpoint):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.voices_dir = self.data_dir / "voices"
        self.audio_dir = self.data_dir / "audio"
        self.segment_dir = self.data_dir / "segments"
        for directory in (self.voices_dir, self.audio_dir, self.segment_dir):
            directory.mkdir(parents=True, exist_ok=True)
        self.db = Database(self.data_dir / "omni-speak.sqlite3")
        self.checkpoint = checkpoint
        self.device = get_best_device()
        self.model = None
        self.model_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.worker = None

    def load(self):
        LOGGER.info("Loading %s on %s", self.checkpoint, self.device)
        self.model = OmniVoice.from_pretrained(
            self.checkpoint,
            device_map=self.device,
            dtype=torch.float16,
            load_asr=False,
            asr_model_name="openai/whisper-large-v3-turbo",
        )
        self.worker = threading.Thread(target=self.run_worker, name="speech-worker", daemon=True)
        self.worker.start()
        LOGGER.info("Omni Speak engine ready")

    def release_asr(self):
        if not self.model or getattr(self.model, "_asr_pipe", None) is None:
            return
        pipe = self.model._asr_pipe
        self.model._asr_pipe = None
        del pipe
        gc.collect()
        if self.device == "mps" and torch.backends.mps.is_available():
            torch.mps.empty_cache()
        LOGGER.info("Released Whisper ASR from memory")

    def run_worker(self):
        while not self.stop_event.is_set():
            job = self.db.next_job()
            if not job:
                self.stop_event.wait(0.5)
                continue
            try:
                self.process_job(job)
            except Exception as error:
                LOGGER.exception("Job %s failed", job["id"])
                self.db.update_job(job["id"], status="failed", error=str(error))

    def voice_args(self, voice_id):
        voice = self.db.get_voice(voice_id)
        if not voice:
            raise ValueError(f"Saved voice not found: {voice_id}")
        if voice.get("prompt_path"):
            return {"voice_clone_prompt": VoiceClonePrompt.load(voice["prompt_path"])}
        return {"instruct": voice.get("instruct")}

    def process_job(self, job):
        job_id = job["id"]
        config = job.get("config") or {}
        speaker_map = job.get("speaker_map") or {}
        self.db.update_job(job_id, status="running", error=None)
        segments = self.db.get_job(job_id)["segments"]
        completed_audio = []
        total = max(1, len(segments))

        for index, segment in enumerate(segments):
            current = self.db.get_job(job_id, include_segments=False)
            if current["status"] == "cancel_requested":
                self.db.update_job(job_id, status="cancelled")
                return
            output_path = Path(segment["output_path"]) if segment.get("output_path") else self.segment_dir / f"{segment['id']}.wav"
            if segment["status"] == "completed" and output_path.exists():
                waveform, _ = sf.read(output_path, dtype="float32")
                completed_audio.append(waveform)
                continue

            voice_id = speaker_map.get(segment["speaker"])
            if not voice_id:
                raise ValueError(f"No saved voice selected for {segment['speaker']}")
            text = apply_pronunciation_dictionary(segment["text"], config.get("pronunciation_dictionary"))
            generation_config = OmniVoiceGenerationConfig(
                num_step=normalize_inference_steps(config.get("inference_steps")),
                guidance_scale=float(config.get("guidance_scale", 2.0)),
                denoise=bool(config.get("denoise", True)),
                preprocess_prompt=True,
                postprocess_output=bool(config.get("remove_silence", True)),
            )
            self.db.update_segment(segment["id"], status="running")
            with self.model_lock:
                generated = self.model.generate(
                    text=text,
                    language=None if config.get("language", "auto") == "auto" else config.get("language"),
                    generation_config=generation_config,
                    speed=float(config.get("speed", 1.0)),
                    normalize_text=bool(config.get("normalize_text", False)),
                    **self.voice_args(voice_id),
                )[0]
            generated = self.apply_audio_effects(generated, config)
            sf.write(output_path, generated, SAMPLE_RATE)
            completed_audio.append(generated)
            self.db.update_segment(segment["id"], status="completed", output_path=str(output_path), error=None)
            self.db.update_job(job_id, progress=round((index + 1) / total * 100, 1))

        pause_ms = int(config.get("speaker_pause_ms", 220))
        pause = np.zeros(int(SAMPLE_RATE * pause_ms / 1000), dtype=np.float32)
        timeline = []
        merged = []
        cursor_ms = 0
        for index, (segment, waveform) in enumerate(zip(segments, completed_audio)):
            duration_ms = round(len(waveform) / SAMPLE_RATE * 1000)
            timeline.append((segment["id"], cursor_ms, cursor_ms + duration_ms))
            merged.append(waveform)
            cursor_ms += duration_ms
            if index < len(completed_audio) - 1:
                merged.append(pause)
                cursor_ms += pause_ms
        final_audio = np.concatenate(merged) if merged else np.zeros(1, dtype=np.float32)
        output_path = self.audio_dir / f"{job_id}.wav"
        sf.write(output_path, final_audio, SAMPLE_RATE)
        for segment_id, start_ms, end_ms in timeline:
            self.db.update_segment(segment_id, start_ms=start_ms, end_ms=end_ms)
        self.db.update_job(
            job_id,
            status="completed",
            progress=100,
            output_path=str(output_path),
            duration_ms=round(len(final_audio) / SAMPLE_RATE * 1000),
            error=None,
        )

    def apply_audio_effects(self, waveform, config):
        result = np.asarray(waveform, dtype=np.float32)
        volume_db = float(config.get("volume_db", 0))
        if volume_db:
            result = result * (10 ** (volume_db / 20))
        pitch = float(config.get("pitch_semitones", 0))
        if pitch:
            import librosa

            result = librosa.effects.pitch_shift(result, sr=SAMPLE_RATE, n_steps=pitch)
        if config.get("sound_effect") == "echo":
            delay = int(SAMPLE_RATE * 0.18)
            echoed = np.pad(result, (0, delay))
            echoed[delay:] += result * 0.24
            result = echoed
        return np.clip(result, -1, 1)

    def analyze_audio(self, path):
        waveform, sample_rate = load_waveform(str(path))
        mono = waveform.mean(axis=0)
        duration = len(mono) / sample_rate
        rms = float(np.sqrt(np.mean(mono**2)))
        peak = float(np.max(np.abs(mono)))
        frame_size = max(1, int(sample_rate * 0.05))
        frames = [mono[index:index + frame_size] for index in range(0, len(mono), frame_size)]
        frame_rms = np.array([np.sqrt(np.mean(frame**2)) for frame in frames if len(frame)])
        noise_floor = float(np.percentile(frame_rms, 20)) if len(frame_rms) else 0
        snr_db = 20 * math.log10(max(rms, 1e-8) / max(noise_floor, 1e-8))
        silence_ratio = float(np.mean(frame_rms < 0.01)) if len(frame_rms) else 1
        warnings = []
        if duration < 3:
            warnings.append("Reference audio must be at least 3 seconds")
        elif duration < 10:
            warnings.append("10 seconds is recommended for a stable clone")
        if duration > 300:
            warnings.append("Reference audio must be 5 minutes or shorter")
        if snr_db < 15:
            warnings.append("Background noise is high")
        if peak > 0.995:
            warnings.append("Audio is clipping")
        if silence_ratio > 0.45:
            warnings.append("Too much silence in the reference")
        return {
            "duration_seconds": round(duration, 2),
            "sample_rate": sample_rate,
            "rms": round(rms, 5),
            "peak": round(peak, 5),
            "snr_db": round(snr_db, 1),
            "silence_ratio": round(silence_ratio, 3),
            "warnings": warnings,
            "valid": duration >= 3 and duration <= 300,
        }


def create_app(engine):
    app = FastAPI(title="Omni Speak API", version="1.0.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.get("/api/health")
    def health():
        return {
            "app": "Omni Speak",
            "ready": engine.model is not None,
            "device": engine.device,
            "asr_loaded": bool(engine.model and getattr(engine.model, "_asr_pipe", None)),
        }

    @app.get("/api/projects")
    def list_projects():
        return engine.db.list_projects()

    @app.post("/api/projects")
    def save_project(payload: ProjectInput):
        return engine.db.save_project(payload.model_dump())

    @app.get("/api/projects/{project_id}")
    def get_project(project_id: str):
        project = engine.db.get_project(project_id)
        if not project:
            raise HTTPException(404, "Project not found")
        project["jobs"] = engine.db.list_jobs(project_id=project_id)
        return project

    @app.get("/api/voices")
    def list_voices():
        return engine.db.list_voices()

    @app.post("/api/voices/analyze")
    async def analyze_voice(file: UploadFile = File(...)):
        suffix = Path(file.filename or "").suffix.lower()
        if suffix not in ALLOWED_AUDIO:
            raise HTTPException(400, "Use WAV, MP3, or M4A audio")
        temporary = engine.voices_dir / f"analyze_{new_id('audio')}{suffix}"
        with temporary.open("wb") as target:
            shutil.copyfileobj(file.file, target)
        try:
            return engine.analyze_audio(temporary)
        finally:
            temporary.unlink(missing_ok=True)

    @app.post("/api/voices/clone")
    async def clone_voice(name: str = Form(...), transcript: str = Form(""), file: UploadFile = File(...)):
        suffix = Path(file.filename or "").suffix.lower()
        if suffix not in ALLOWED_AUDIO:
            raise HTTPException(400, "Use WAV, MP3, or M4A audio")
        voice_id = new_id("voice")
        source_path = engine.voices_dir / f"{voice_id}{suffix}"
        with source_path.open("wb") as target:
            shutil.copyfileobj(file.file, target)
        analysis = engine.analyze_audio(source_path)
        if not analysis["valid"]:
            source_path.unlink(missing_ok=True)
            raise HTTPException(400, "; ".join(analysis["warnings"]))
        prompt_path = engine.voices_dir / f"{voice_id}.pt"
        auto_transcribe = not transcript.strip()
        with engine.model_lock:
            try:
                prompt = engine.model.create_voice_clone_prompt(str(source_path), transcript.strip() or None)
                prompt.save(prompt_path)
            finally:
                if auto_transcribe:
                    engine.release_asr()
        return engine.db.save_voice({
            "id": voice_id,
            "name": name.strip(),
            "kind": "clone",
            "prompt_path": str(prompt_path),
            "source_audio_path": str(source_path),
            "transcript": prompt.ref_text,
            "metadata": analysis,
        })

    @app.post("/api/voices/design")
    def design_voice(payload: DesignVoiceInput):
        name = payload.name.strip()
        preview_text = payload.preview_text.strip()
        if not name:
            raise HTTPException(400, "Voice name is required")
        if not preview_text:
            raise HTTPException(400, "Preview text is required")
        try:
            description = normalize_voice_design_description(payload.description)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error

        voice_id = new_id("voice")
        preview_path = engine.voices_dir / f"{voice_id}.wav"
        prompt_path = engine.voices_dir / f"{voice_id}.pt"
        try:
            with engine.model_lock:
                generation_config = OmniVoiceGenerationConfig(
                    num_step=8 if payload.performance_mode else 32,
                    postprocess_output=not payload.performance_mode,
                )
                waveform = engine.model.generate(
                    text=preview_text,
                    instruct=description,
                    generation_config=generation_config,
                )[0]
                sf.write(preview_path, waveform, SAMPLE_RATE)
                prompt = engine.model.create_voice_clone_prompt(str(preview_path), preview_text)
                prompt.save(prompt_path)
        except ValueError as error:
            preview_path.unlink(missing_ok=True)
            prompt_path.unlink(missing_ok=True)
            raise HTTPException(400, str(error)) from error
        except Exception:
            preview_path.unlink(missing_ok=True)
            prompt_path.unlink(missing_ok=True)
            raise
        return engine.db.save_voice({
            "id": voice_id,
            "name": name,
            "kind": "design",
            "prompt_path": str(prompt_path),
            "source_audio_path": str(preview_path),
            "transcript": preview_text,
            "instruct": description,
            "metadata": {"description": description, "performance_mode": payload.performance_mode},
        })

    @app.delete("/api/voices/{voice_id}")
    def delete_voice(voice_id: str):
        voice = engine.db.get_voice(voice_id)
        if not voice:
            raise HTTPException(404, "Voice not found")
        try:
            engine.db.delete_voice(voice_id)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        for field in ("prompt_path", "source_audio_path"):
            if voice.get(field):
                Path(voice[field]).unlink(missing_ok=True)
        return {"ok": True}

    @app.get("/api/voices/{voice_id}/audio")
    def voice_audio(voice_id: str):
        voice = engine.db.get_voice(voice_id)
        if not voice or not voice.get("source_audio_path") or not Path(voice["source_audio_path"]).exists():
            raise HTTPException(404, "Voice preview not available")
        source = Path(voice["source_audio_path"])
        media = "audio/wav" if source.suffix.lower() == ".wav" else "audio/mpeg"
        return FileResponse(source, media_type=media)

    @app.get("/api/jobs")
    def list_jobs(project_id: str | None = None):
        return engine.db.list_jobs(project_id=project_id)

    @app.post("/api/jobs")
    def create_job(payload: SpeechJobInput):
        if not payload.text.strip():
            raise HTTPException(400, "Text is required")
        if not engine.db.get_project(payload.project_id):
            raise HTTPException(404, "Project not found")
        script_segments = parse_multispeaker_script(payload.text)
        used_speakers = {segment["speaker"] for segment in script_segments}
        for speaker in used_speakers:
            voice_id = payload.speaker_map.get(speaker)
            if not voice_id or not engine.db.get_voice(voice_id):
                raise HTTPException(400, f"Select a saved voice for {speaker}")
        chunks = []
        max_chars = int(payload.config.get("chunk_chars", 450))
        for segment in script_segments:
            chunks.extend({"speaker": segment["speaker"], "text": text} for text in split_long_text(segment["text"], max_chars))
        engine.db.save_project({
            "id": payload.project_id,
            "name": engine.db.get_project(payload.project_id)["name"],
            "script": payload.text,
            "settings": {"speaker_map": payload.speaker_map, **payload.config},
        })
        return engine.db.create_job(payload.model_dump(), chunks)

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str):
        job = engine.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        if job.get("output_path"):
            job["audio_url"] = f"/api/jobs/{job_id}/audio"
        return job

    @app.post("/api/jobs/{job_id}/cancel")
    def cancel_job(job_id: str):
        if not engine.db.get_job(job_id):
            raise HTTPException(404, "Job not found")
        return engine.db.cancel_job(job_id)

    @app.post("/api/jobs/{job_id}/retry")
    def retry_job(job_id: str):
        if not engine.db.get_job(job_id):
            raise HTTPException(404, "Job not found")
        return engine.db.retry_job(job_id)

    @app.get("/api/jobs/{job_id}/audio")
    def job_audio(job_id: str, format: str = "wav"):
        job = engine.db.get_job(job_id, include_segments=False)
        if not job or not job.get("output_path") or not Path(job["output_path"]).exists():
            raise HTTPException(404, "Audio not ready")
        source = Path(job["output_path"])
        if format == "wav":
            return FileResponse(source, media_type="audio/wav", filename=f"omni-speak-{job_id}.wav")
        if format == "flac":
            target = source.with_suffix(".flac")
            if not target.exists():
                waveform, sample_rate = sf.read(source, dtype="float32")
                sf.write(target, waveform, sample_rate, format="FLAC")
            return FileResponse(target, media_type="audio/flac", filename=f"omni-speak-{job_id}.flac")
        raise HTTPException(400, "Supported formats: wav, flac")

    @app.websocket("/api/jobs/{job_id}/events")
    async def job_events(websocket: WebSocket, job_id: str):
        await websocket.accept()
        try:
            while True:
                job = engine.db.get_job(job_id)
                if not job:
                    await websocket.send_json({"error": "Job not found"})
                    break
                if job.get("output_path"):
                    job["audio_url"] = f"/api/jobs/{job_id}/audio"
                await websocket.send_json(job)
                if job["status"] in {"completed", "failed", "cancelled"}:
                    break
                await __import__("asyncio").sleep(0.7)
        except WebSocketDisconnect:
            pass

    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--model", default="k2-fsa/OmniVoice")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s: %(message)s")
    engine = Engine(args.data_dir, args.model)
    engine.load()
    uvicorn.run(create_app(engine), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
