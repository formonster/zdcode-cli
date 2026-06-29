from __future__ import annotations

import os
import re
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Optional

import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from funasr import AutoModel


HOST = os.getenv("FUNASR_HOST", "127.0.0.1")
PORT = int(os.getenv("FUNASR_PORT", "8766"))
DEFAULT_MODEL = os.getenv("FUNASR_MODEL", "paraformer-zh")
DEFAULT_VAD_MODEL = os.getenv("FUNASR_VAD_MODEL", "fsmn-vad")
DEFAULT_PUNC_MODEL = os.getenv("FUNASR_PUNC_MODEL", "ct-punc")
DEFAULT_DEVICE = os.getenv("FUNASR_DEVICE", "cpu")
ALLOW_REQUEST_MODEL = os.getenv("FUNASR_ALLOW_REQUEST_MODEL", "0") == "1"


app = FastAPI(title="ZDCode ASR FunASR server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "default_model": DEFAULT_MODEL,
        "vad_model": DEFAULT_VAD_MODEL,
        "punc_model": DEFAULT_PUNC_MODEL,
        "device": DEFAULT_DEVICE,
        "allow_request_model": ALLOW_REQUEST_MODEL,
    }


@app.post("/v1/audio/transcriptions", response_model=None)
async def transcribe(
    file: Annotated[UploadFile, File()],
    model: Annotated[str, Form()] = DEFAULT_MODEL,
    language: Annotated[Optional[str], Form()] = None,
    task: Annotated[str, Form()] = "transcribe",
    response_format: Annotated[str, Form()] = "json",
) -> Any:
    del language, task

    model_name = model if ALLOW_REQUEST_MODEL and model else DEFAULT_MODEL
    suffix = Path(file.filename or "").suffix or ".webm"
    with tempfile.TemporaryDirectory(prefix="zdcode-funasr-upload-") as tmp_dir:
        input_path = Path(tmp_dir) / f"input{suffix}"
        wav_path = Path(tmp_dir) / "input.16k.wav"
        input_path.write_bytes(await file.read())

        converted_path = convert_to_wav(input_path, wav_path)
        duration = probe_duration(converted_path)
        result = get_model(model_name).generate(
            input=str(converted_path),
            batch_size_s=60,
        )

    normalized_segments = normalize_segments(result, duration)
    text = " ".join(segment["text"] for segment in normalized_segments).strip()
    if not text:
        text = extract_text(result)

    if response_format == "text":
        return PlainTextResponse(text)

    return {
        "text": text,
        "language": "zh",
        "language_probability": 1,
        "duration": duration,
        "segments": normalized_segments,
    }


def convert_to_wav(input_path: Path, wav_path: Path) -> Path:
    command = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-ar",
        "16000",
        "-ac",
        "1",
        str(wav_path),
    ]
    try:
        subprocess.run(command, check=True)
        return wav_path
    except (FileNotFoundError, subprocess.CalledProcessError):
        return input_path


def probe_duration(path: Path) -> float:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    try:
        completed = subprocess.run(command, check=True, capture_output=True, text=True)
        return max(0.0, float(completed.stdout.strip() or 0))
    except (FileNotFoundError, subprocess.CalledProcessError, ValueError):
        return 0.0


def normalize_segments(result: Any, duration: float) -> list[dict[str, Any]]:
    items = result if isinstance(result, list) else [result]
    segments: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue

        sentence_info = item.get("sentence_info")
        if isinstance(sentence_info, list):
            for sentence in sentence_info:
                text = normalize_text(str(sentence.get("text") or "").strip())
                if not text:
                    continue
                segments.append(
                    {
                        "id": len(segments),
                        "start": milliseconds_to_seconds(sentence.get("start")),
                        "end": milliseconds_to_seconds(sentence.get("end")),
                        "text": text,
                    }
                )

        if segments:
            continue

        text = normalize_text(str(item.get("text") or "").strip())
        if text:
            timestamp = item.get("timestamp")
            if isinstance(timestamp, list) and timestamp:
                for split_segment in split_text_by_timestamp(text, timestamp, duration):
                    split_segment["id"] = len(segments)
                    segments.append(split_segment)
            else:
                for split_segment in split_text_evenly(text, 0.0, duration):
                    split_segment["id"] = len(segments)
                    segments.append(split_segment)

    return segments


def extract_text(result: Any) -> str:
    items = result if isinstance(result, list) else [result]
    texts = []
    for item in items:
        if isinstance(item, dict) and str(item.get("text") or "").strip():
            texts.append(normalize_text(str(item["text"]).strip()))
    return " ".join(texts).strip()


def normalize_text(text: str) -> str:
    text = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", text)
    return re.sub(r"\s+", " ", text).strip()


def split_text_by_timestamp(text: str, timestamps: list[Any], duration: float) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    current_text: list[str] = []
    current_start: float | None = None
    current_end: float | None = None
    timestamp_index = 0

    for char in text:
        if not char.strip():
            current_text.append(char)
            continue

        char_start = current_end
        char_end = current_end
        if not is_punctuation(char) and timestamp_index < len(timestamps):
            timestamp = timestamps[timestamp_index]
            timestamp_index += 1
            if isinstance(timestamp, list) and len(timestamp) >= 2:
                char_start = milliseconds_to_seconds(timestamp[0])
                char_end = milliseconds_to_seconds(timestamp[1])

        if current_start is None and char_start is not None:
            current_start = char_start
        if char_end is not None:
            current_end = char_end
        current_text.append(char)

        if is_sentence_boundary(char) or len("".join(current_text)) >= 80:
            append_split_segment(segments, current_text, current_start, current_end, duration)
            current_text = []
            current_start = None
            current_end = None

    append_split_segment(segments, current_text, current_start, current_end, duration)
    return segments


def append_split_segment(
    segments: list[dict[str, Any]],
    current_text: list[str],
    start: float | None,
    end: float | None,
    duration: float,
) -> None:
    text = normalize_text("".join(current_text))
    if not text:
        return
    safe_start = start if start is not None else (segments[-1]["end"] if segments else 0.0)
    safe_end = end if end is not None and end >= safe_start else min(duration, safe_start + 0.1)
    segments.append({"start": safe_start, "end": safe_end, "text": text})


def split_text_evenly(text: str, start: float, end: float) -> list[dict[str, Any]]:
    parts = [part for part in re.split(r"(?<=[。！？!?；;])", text) if part.strip()]
    if not parts:
        parts = [text]
    duration = max(0.1, end - start)
    total_chars = sum(len(part) for part in parts) or 1
    cursor = start
    segments = []
    for part in parts:
        part_duration = duration * (len(part) / total_chars)
        segments.append({"start": cursor, "end": cursor + part_duration, "text": normalize_text(part)})
        cursor += part_duration
    return segments


def is_punctuation(char: str) -> bool:
    return char in "，。！？；：、,.!?;:"


def is_sentence_boundary(char: str) -> bool:
    return char in "。！？!?；;"


def milliseconds_to_seconds(value: Any) -> float:
    try:
        return max(0.0, float(value) / 1000)
    except (TypeError, ValueError):
        return 0.0


@lru_cache(maxsize=2)
def get_model(model_name: str) -> AutoModel:
    return AutoModel(
        model=model_name,
        vad_model=DEFAULT_VAD_MODEL or None,
        punc_model=DEFAULT_PUNC_MODEL or None,
        device=DEFAULT_DEVICE,
        disable_update=True,
    )


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
