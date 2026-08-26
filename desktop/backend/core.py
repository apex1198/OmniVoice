import json
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path


SPEAKER_PATTERN = re.compile(r"@\[\s*(Speaker\s+[1-4])\s*\]", re.IGNORECASE)
SENTENCE_PATTERN = re.compile(r"(?<=[.!?。！？])\s+")
PARAGRAPH_PATTERN = re.compile(r"\n\s*\n+")
JSON_COLUMNS = {"settings_json", "metadata_json", "speaker_map_json", "config_json"}
VOICE_DESIGN_ENGLISH_ITEMS = {
    "american accent", "australian accent", "british accent", "canadian accent",
    "child", "chinese accent", "elderly", "female", "high pitch",
    "indian accent", "japanese accent", "korean accent", "low pitch", "male",
    "middle-aged", "moderate pitch", "portuguese accent", "russian accent",
    "teenager", "very high pitch", "very low pitch", "whisper", "young adult",
}
VOICE_DESIGN_CHINESE_ITEMS = {
    "东北话", "中年", "中音调", "云南话", "低音调", "儿童", "四川话", "女",
    "宁夏话", "少年", "极低音调", "极高音调", "桂林话", "河南话", "济南话",
    "甘肃话", "男", "石家庄话", "老年", "耳语", "贵州话", "陕西话", "青岛话",
    "青年", "高音调",
}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def canonical_speaker(value):
    number = re.search(r"([1-4])", value)
    return f"Speaker {number.group(1)}" if number else "Speaker 1"


def normalize_inference_steps(value, default=32):
    try:
        steps = int(value or default)
    except (TypeError, ValueError):
        steps = default
    return max(1, min(steps, 100))


def normalize_voice_design_description(value):
    description = str(value or "").strip()
    if not description:
        raise ValueError("Voice description is required")
    if "," in description and "，" in description:
        raise ValueError("Use either English or Chinese voice attributes, not both")

    is_chinese = "，" in description or any("\u4e00" <= char <= "\u9fff" for char in description)
    separator = "，" if is_chinese else ","
    items = [item.strip() if is_chinese else item.strip().lower() for item in description.split(separator)]
    items = [item for item in items if item]
    supported = VOICE_DESIGN_CHINESE_ITEMS if is_chinese else VOICE_DESIGN_ENGLISH_ITEMS
    unsupported = [item for item in items if item not in supported]
    if unsupported:
        raise ValueError(f"Unsupported Voice Design attributes: {', '.join(unsupported)}")
    return separator.join(items) if is_chinese else ", ".join(items)


def parse_multispeaker_script(text):
    text = (text or "").strip()
    if not text:
        return []
    matches = list(SPEAKER_PATTERN.finditer(text))
    if not matches:
        return [{"speaker": "Speaker 1", "text": text}]

    segments = []
    prefix = text[: matches[0].start()].strip()
    if prefix:
        segments.append({"speaker": "Speaker 1", "text": prefix})
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        content = text[start:end].strip()
        if content:
            segments.append({"speaker": canonical_speaker(match.group(1)), "text": content})
    return segments


def split_long_text(text, max_chars=450):
    return [item["text"] for item in smart_text_chunks(text, max_chars)]


def _split_paragraph(paragraph, max_chars):
    sentences = SENTENCE_PATTERN.split(re.sub(r"\s+", " ", paragraph).strip())
    chunks, current = [], ""
    for sentence in sentences:
        if len(sentence) > max_chars:
            words = sentence.split()
            if len(words) <= 1:
                if current:
                    chunks.append(current)
                    current = ""
                chunks.extend(sentence[index:index + max_chars] for index in range(0, len(sentence), max_chars))
                continue
            for word in words:
                candidate = f"{current} {word}".strip()
                if len(candidate) > max_chars and current:
                    chunks.append(current)
                    current = word
                else:
                    current = candidate
            continue
        candidate = f"{current} {sentence}".strip()
        if len(candidate) > max_chars and current:
            chunks.append(current)
            current = sentence
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks


def smart_text_chunks(text, max_chars=450):
    """Split long-form text without crossing paragraph or sentence boundaries."""
    source = (text or "").strip()
    if not source:
        return []
    paragraphs = [item.strip() for item in PARAGRAPH_PATTERN.split(source) if item.strip()]
    result = []
    for paragraph_index, paragraph in enumerate(paragraphs):
        chunks = _split_paragraph(paragraph, max_chars)
        for chunk_index, chunk in enumerate(chunks):
            is_last_chunk = chunk_index == len(chunks) - 1
            boundary = "paragraph" if is_last_chunk and paragraph_index < len(paragraphs) - 1 else "sentence"
            result.append({"text": chunk, "boundary": boundary})
    if result:
        result[-1]["boundary"] = "end"
    return result


def natural_pause_ms(segment, next_segment, setting="auto"):
    if next_segment is None:
        return 0
    if setting not in (None, "", "auto"):
        return max(0, min(int(setting), 3000))

    speaker_changed = segment["speaker"] != next_segment["speaker"]
    boundary = segment.get("boundary", "sentence")
    text = segment.get("text", "").rstrip()
    if speaker_changed:
        if boundary == "paragraph":
            return 900
        if text.endswith(("?", "!", "？", "！")):
            return 720
        return 650
    if boundary == "paragraph":
        return 520
    if text.endswith(("?", "!", "？", "！")):
        return 320
    return 180


def apply_pronunciation_dictionary(text, entries):
    output = text
    for entry in entries or []:
        source = str(entry.get("source", "")).strip()
        target = str(entry.get("target", "")).strip()
        if source and target:
            output = re.sub(re.escape(source), target, output, flags=re.IGNORECASE)
    return output


def decode_row(row):
    if row is None:
        return None
    result = dict(row)
    for column in JSON_COLUMNS:
        if column in result:
            try:
                result[column.removesuffix("_json")] = json.loads(result[column] or "{}")
            except json.JSONDecodeError:
                result[column.removesuffix("_json")] = {}
            del result[column]
    return result


class Database:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def connect(self):
        connection = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def initialize(self):
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    script TEXT NOT NULL DEFAULT '',
                    settings_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS voices (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    prompt_path TEXT,
                    source_audio_path TEXT,
                    transcript TEXT,
                    instruct TEXT,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    type TEXT NOT NULL DEFAULT 'speech',
                    status TEXT NOT NULL,
                    text TEXT NOT NULL,
                    speaker_map_json TEXT NOT NULL DEFAULT '{}',
                    config_json TEXT NOT NULL DEFAULT '{}',
                    progress REAL NOT NULL DEFAULT 0,
                    error TEXT,
                    output_path TEXT,
                    duration_ms INTEGER,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(project_id) REFERENCES projects(id)
                );
                CREATE TABLE IF NOT EXISTS segments (
                    id TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    speaker TEXT NOT NULL,
                    text TEXT NOT NULL,
                    status TEXT NOT NULL,
                    output_path TEXT,
                    start_ms INTEGER,
                    end_ms INTEGER,
                    error TEXT,
                    boundary TEXT NOT NULL DEFAULT 'sentence',
                    pause_after_ms INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
                CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_segments_job ON segments(job_id, position);
                """
            )
            columns = {row["name"] for row in db.execute("PRAGMA table_info(segments)")}
            if "boundary" not in columns:
                db.execute("ALTER TABLE segments ADD COLUMN boundary TEXT NOT NULL DEFAULT 'sentence'")
            if "pause_after_ms" not in columns:
                db.execute("ALTER TABLE segments ADD COLUMN pause_after_ms INTEGER NOT NULL DEFAULT 0")
            now = now_iso()
            db.execute(
                "INSERT OR IGNORE INTO projects(id,name,script,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                ("project_inbox", "Inbox", "", "{}", now, now),
            )
            presets = [
                ("voice_warm_narrator", "Warm Narrator", "male, middle-aged, moderate pitch"),
                ("voice_bright_storyteller", "Bright Storyteller", "female, young adult, high pitch"),
                ("voice_calm_guide", "Calm Guide", "female, middle-aged, low pitch, whisper"),
                ("voice_deep_host", "Deep Host", "male, young adult, very low pitch"),
            ]
            for voice_id, name, instruct in presets:
                db.execute(
                    "INSERT OR IGNORE INTO voices(id,name,kind,instruct,metadata_json,created_at) VALUES(?,?,?,?,?,?)",
                    (voice_id, name, "preset", instruct, json.dumps({"builtin": True}), now),
                )

    def list_projects(self):
        with self.connect() as db:
            return [decode_row(row) for row in db.execute("SELECT * FROM projects ORDER BY updated_at DESC")]

    def get_project(self, project_id):
        with self.connect() as db:
            return decode_row(db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone())

    def save_project(self, project):
        project_id = project.get("id") or new_id("project")
        now = now_iso()
        existing = self.get_project(project_id)
        with self.connect() as db:
            db.execute(
                """INSERT INTO projects(id,name,script,settings_json,created_at,updated_at)
                   VALUES(?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET name=excluded.name,script=excluded.script,
                   settings_json=excluded.settings_json,updated_at=excluded.updated_at""",
                (
                    project_id,
                    project.get("name") or "Untitled Project",
                    project.get("script") or "",
                    json.dumps(project.get("settings") or {}),
                    existing["created_at"] if existing else now,
                    now,
                ),
            )
        return self.get_project(project_id)

    def list_voices(self):
        with self.connect() as db:
            return [decode_row(row) for row in db.execute("SELECT * FROM voices ORDER BY created_at DESC")]

    def get_voice(self, voice_id):
        with self.connect() as db:
            return decode_row(db.execute("SELECT * FROM voices WHERE id=?", (voice_id,)).fetchone())

    def save_voice(self, voice):
        with self.connect() as db:
            db.execute(
                """INSERT INTO voices(id,name,kind,prompt_path,source_audio_path,transcript,instruct,metadata_json,created_at)
                   VALUES(?,?,?,?,?,?,?,?,?)""",
                (
                    voice["id"], voice["name"], voice["kind"], voice.get("prompt_path"),
                    voice.get("source_audio_path"), voice.get("transcript"), voice.get("instruct"),
                    json.dumps(voice.get("metadata") or {}), voice.get("created_at") or now_iso(),
                ),
            )
        return self.get_voice(voice["id"])

    def update_voice(self, voice_id, **values):
        allowed = {
            "name", "prompt_path", "source_audio_path", "transcript",
            "instruct", "metadata_json",
        }
        updates = {key: value for key, value in values.items() if key in allowed}
        if not updates:
            return self.get_voice(voice_id)
        columns = ",".join(f"{key}=?" for key in updates)
        with self.connect() as db:
            db.execute(f"UPDATE voices SET {columns} WHERE id=?", [*updates.values(), voice_id])
        return self.get_voice(voice_id)

    def delete_voice(self, voice_id):
        with self.connect() as db:
            row = db.execute("SELECT metadata_json FROM voices WHERE id=?", (voice_id,)).fetchone()
            if not row:
                return False
            metadata = json.loads(row["metadata_json"] or "{}")
            if metadata.get("builtin"):
                raise ValueError("Built-in voices cannot be deleted")
            db.execute("DELETE FROM voices WHERE id=?", (voice_id,))
            return True

    def create_job(self, payload, segment_items):
        job_id = new_id("job")
        now = now_iso()
        with self.connect() as db:
            db.execute(
                """INSERT INTO jobs(id,project_id,type,status,text,speaker_map_json,config_json,progress,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (job_id, payload["project_id"], payload.get("type", "speech"), "pending", payload["text"],
                 json.dumps(payload.get("speaker_map") or {}), json.dumps(payload.get("config") or {}), 0, now, now),
            )
            for index, item in enumerate(segment_items):
                db.execute(
                    """INSERT INTO segments(id,job_id,position,speaker,text,status,boundary,pause_after_ms)
                       VALUES(?,?,?,?,?,?,?,?)""",
                    (new_id("segment"), job_id, index, item["speaker"], item["text"], "pending",
                     item.get("boundary", "sentence"), int(item.get("pause_after_ms", 0))),
                )
        return self.get_job(job_id)

    def get_job(self, job_id, include_segments=True):
        with self.connect() as db:
            result = decode_row(db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())
            if result and include_segments:
                result["segments"] = [dict(row) for row in db.execute("SELECT * FROM segments WHERE job_id=? ORDER BY position", (job_id,))]
            return result

    def list_jobs(self, project_id=None, limit=100):
        query = "SELECT * FROM jobs"
        params = []
        if project_id:
            query += " WHERE project_id=?"
            params.append(project_id)
        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        with self.connect() as db:
            return [decode_row(row) for row in db.execute(query, params)]

    def next_job(self):
        with self.connect() as db:
            row = db.execute("SELECT id FROM jobs WHERE status='pending' ORDER BY created_at LIMIT 1").fetchone()
            return self.get_job(row["id"]) if row else None

    def recover_interrupted_jobs(self):
        with self.connect() as db:
            running_ids = [
                row["id"] for row in db.execute("SELECT id FROM jobs WHERE status='running'")
            ]
            if running_ids:
                placeholders = ",".join("?" for _ in running_ids)
                db.execute(
                    f"UPDATE segments SET status='pending',error=NULL WHERE job_id IN ({placeholders}) AND status='running'",
                    running_ids,
                )
                db.execute(
                    f"UPDATE jobs SET status='pending',error=NULL,updated_at=? WHERE id IN ({placeholders})",
                    [now_iso(), *running_ids],
                )
            db.execute(
                "UPDATE jobs SET status='cancelled',updated_at=? WHERE status='cancel_requested'",
                (now_iso(),),
            )

    def update_job(self, job_id, **values):
        if not values:
            return self.get_job(job_id)
        values["updated_at"] = now_iso()
        columns = ",".join(f"{key}=?" for key in values)
        with self.connect() as db:
            db.execute(f"UPDATE jobs SET {columns} WHERE id=?", [*values.values(), job_id])
        return self.get_job(job_id)

    def update_segment(self, segment_id, **values):
        columns = ",".join(f"{key}=?" for key in values)
        with self.connect() as db:
            db.execute(f"UPDATE segments SET {columns} WHERE id=?", [*values.values(), segment_id])

    def cancel_job(self, job_id):
        return self.update_job(job_id, status="cancel_requested")

    def retry_job(self, job_id):
        with self.connect() as db:
            db.execute("UPDATE segments SET status='pending',error=NULL WHERE job_id=? AND status!='completed'", (job_id,))
            db.execute("UPDATE jobs SET status='pending',error=NULL,progress=0,updated_at=? WHERE id=?", (now_iso(), job_id))
        return self.get_job(job_id)
