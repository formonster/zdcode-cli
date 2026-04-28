from __future__ import annotations

import asyncio
import base64
import copy
import importlib.util
import io
import json
import mimetypes
import os
import re
import shlex
import sqlite3
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def json_loads(value: Any, default: Any) -> Any:
    if not value:
        return copy.deepcopy(default)
    if isinstance(value, (dict, list)):
        return copy.deepcopy(value)
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return copy.deepcopy(default)


def import_available(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def estimate_tokens(value: str) -> int:
    text = value or ""
    return max(0, (len(text) + 3) // 4)


DB_PATH = Path(os.environ.get("ZDCODE_PLATFORM_DB", Path.home() / ".zdcode" / "platform" / "zdcode-platform.db")).expanduser().resolve()
DASHBOARD_DIR = Path(os.environ.get("ZDCODE_DASHBOARD_DIR", Path(__file__).resolve().parents[1] / "dashboard")).resolve()
OPENCLAW_CONFIG_PATH = Path(os.environ.get("ZDCODE_OPENCLAW_CONFIG", Path.home() / ".openclaw" / "openclaw.json")).expanduser().resolve()
CHANNELS_CONNECTIONS_PATH = Path(os.environ.get("ZDCODE_CHANNELS_CONNECTIONS", Path.home() / ".zdcode" / "channels" / "connections.json")).expanduser().resolve()
DEFAULT_MODEL_KEY = "volcengine/ark-code-latest"
MEMORY_ENABLED = False
DEFAULT_TASK_MAX_TURNS = 30
DEFAULT_GLOBAL_SYSTEM_PROMPT = """# Role
You are operating inside a local multi-agent coding runtime.

# System
- All non-tool output is shown to the user.
- Prefer verifying with tools before making claims about files, code, commands, or environment state.
- Do not claim work was completed unless the tools or code changes actually completed it.
- State uncertainty plainly when you are not sure.
- Treat compressed history as partial context rather than a full transcript.
- Report blocked actions, failed verification, and incomplete work explicitly.

# Doing tasks
- Keep work tightly scoped to the user request.
- Avoid speculative abstractions, unrelated refactors, and unnecessary file creation.
- Diagnose failures before switching tactics.
- Delegate only when a specialist materially improves the result.
- Keep answers concise and operational.

# Actions with care
- Be careful with destructive, irreversible, or high-blast-radius actions.
- If a risky action is blocked or requires approval, explain that clearly and continue with safer alternatives when possible.
"""
SKILL_ROOTS = [
    Path.home() / ".codex" / "skills",
    Path.home() / ".agents" / "skills",
    Path.home() / ".codex" / "plugins" / "cache",
]


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS agent_profiles (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    avatar_url TEXT NOT NULL DEFAULT '',
                    persona_prompt TEXT NOT NULL DEFAULT '',
                    skills_prompt TEXT NOT NULL DEFAULT '',
                    agent_identity_prompt TEXT NOT NULL DEFAULT '',
                    agent_responsibility_prompt TEXT NOT NULL DEFAULT '',
                    agent_non_goals_prompt TEXT NOT NULL DEFAULT '',
                    selected_skills TEXT NOT NULL DEFAULT '[]',
                    default_model TEXT NOT NULL DEFAULT 'gpt-5.4',
                    workspace_binding TEXT NOT NULL,
                    tool_profile TEXT NOT NULL,
                    memory_policy TEXT NOT NULL,
                    channel_config TEXT NOT NULL DEFAULT '{}',
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS task_sessions (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    max_turns INTEGER NOT NULL DEFAULT 30,
                    compressed_context TEXT NOT NULL DEFAULT '',
                    compression_count INTEGER NOT NULL DEFAULT 0,
                    source_kind TEXT NOT NULL DEFAULT 'manual',
                    source_provider TEXT NOT NULL DEFAULT '',
                    source_connection_id TEXT NOT NULL DEFAULT '',
                    source_conversation_id TEXT NOT NULL DEFAULT '',
                    entry_agent_id TEXT NOT NULL,
                    entry_agent_name TEXT,
                    enabled_agent_ids TEXT NOT NULL,
                    participating_agents TEXT NOT NULL DEFAULT '[]',
                    active_agent_id TEXT,
                    active_agent_name TEXT,
                    status TEXT NOT NULL,
                    last_run_id TEXT,
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS agent_runs (
                    id TEXT PRIMARY KEY,
                    task_session_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    agent_name TEXT NOT NULL,
                    parent_run_id TEXT,
                    role TEXT NOT NULL,
                    model TEXT NOT NULL,
                    status TEXT NOT NULL,
                    final_output TEXT NOT NULL DEFAULT '',
                    final_output_preview TEXT NOT NULL DEFAULT '',
                    metadata TEXT NOT NULL DEFAULT '{}',
                    started_at TEXT NOT NULL,
                    completed_at TEXT,
                    FOREIGN KEY(task_session_id) REFERENCES task_sessions(id)
                );

                CREATE TABLE IF NOT EXISTS approvals (
                    id TEXT PRIMARY KEY,
                    task_session_id TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    call_id TEXT NOT NULL,
                    tool_name TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    body TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    reason TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS memory_scopes (
                    scope_id TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    summary TEXT NOT NULL DEFAULT '',
                    episode_count INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS memory_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scope_id TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    episode TEXT NOT NULL,
                    metadata TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS timeline_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_session_id TEXT NOT NULL,
                    run_id TEXT,
                    agent_id TEXT,
                    agent_name TEXT,
                    event_type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    body TEXT NOT NULL DEFAULT '',
                    payload TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS channel_conversations (
                    id TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    connection_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL,
                    current_task_id TEXT,
                    current_agent_id TEXT,
                    enabled_agent_ids TEXT NOT NULL DEFAULT '[]',
                    max_turns INTEGER NOT NULL DEFAULT 30,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_conversations_unique
                    ON channel_conversations(provider, connection_id, conversation_id);

                CREATE TABLE IF NOT EXISTS channel_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    provider TEXT NOT NULL,
                    connection_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    sender_id TEXT NOT NULL DEFAULT '',
                    task_session_id TEXT,
                    direction TEXT NOT NULL,
                    text TEXT NOT NULL DEFAULT '',
                    raw_payload TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_messages_unique
                    ON channel_messages(provider, connection_id, message_id, direction);

                CREATE TABLE IF NOT EXISTS agent_channel_bindings (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    agent_name TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    connection_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL,
                    enabled_agent_ids TEXT NOT NULL DEFAULT '[]',
                    max_turns INTEGER NOT NULL DEFAULT 30,
                    push_enabled INTEGER NOT NULL DEFAULT 1,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_channel_bindings_unique
                    ON agent_channel_bindings(agent_id, provider, connection_id, conversation_id);

                CREATE TABLE IF NOT EXISTS channel_outbox (
                    id TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    connection_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL,
                    task_session_id TEXT,
                    agent_id TEXT NOT NULL DEFAULT '',
                    stage TEXT NOT NULL DEFAULT 'final',
                    text TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    delivered_at TEXT
                );

                CREATE TABLE IF NOT EXISTS model_registry (
                    model_key TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    alias TEXT NOT NULL DEFAULT '',
                    base_url TEXT NOT NULL DEFAULT '',
                    api_type TEXT NOT NULL DEFAULT '',
                    auth_mode TEXT NOT NULL DEFAULT '',
                    context_window INTEGER NOT NULL DEFAULT 0,
                    max_tokens INTEGER NOT NULL DEFAULT 0,
                    supports_text INTEGER NOT NULL DEFAULT 1,
                    supports_image INTEGER NOT NULL DEFAULT 0,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    is_primary INTEGER NOT NULL DEFAULT 0,
                    source TEXT NOT NULL DEFAULT 'manual',
                    raw_config TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )
            columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(task_sessions)").fetchall()}
            if "max_turns" not in columns:
                self._conn.execute("ALTER TABLE task_sessions ADD COLUMN max_turns INTEGER NOT NULL DEFAULT 30")
            if "source_kind" not in columns:
                self._conn.execute("ALTER TABLE task_sessions ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual'")
            if "source_provider" not in columns:
                self._conn.execute("ALTER TABLE task_sessions ADD COLUMN source_provider TEXT NOT NULL DEFAULT ''")
            if "source_connection_id" not in columns:
                self._conn.execute("ALTER TABLE task_sessions ADD COLUMN source_connection_id TEXT NOT NULL DEFAULT ''")
            if "source_conversation_id" not in columns:
                self._conn.execute("ALTER TABLE task_sessions ADD COLUMN source_conversation_id TEXT NOT NULL DEFAULT ''")
            if "compressed_context" not in columns:
                self._conn.execute("ALTER TABLE task_sessions ADD COLUMN compressed_context TEXT NOT NULL DEFAULT ''")
            if "compression_count" not in columns:
                self._conn.execute("ALTER TABLE task_sessions ADD COLUMN compression_count INTEGER NOT NULL DEFAULT 0")
            agent_columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(agent_profiles)").fetchall()}
            if "avatar_url" not in agent_columns:
                self._conn.execute("ALTER TABLE agent_profiles ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''")
            if "selected_skills" not in agent_columns:
                self._conn.execute("ALTER TABLE agent_profiles ADD COLUMN selected_skills TEXT NOT NULL DEFAULT '[]'")
            if "channel_config" not in agent_columns:
                self._conn.execute("ALTER TABLE agent_profiles ADD COLUMN channel_config TEXT NOT NULL DEFAULT '{}'")
            if "agent_identity_prompt" not in agent_columns:
                self._conn.execute("ALTER TABLE agent_profiles ADD COLUMN agent_identity_prompt TEXT NOT NULL DEFAULT ''")
            if "agent_responsibility_prompt" not in agent_columns:
                self._conn.execute("ALTER TABLE agent_profiles ADD COLUMN agent_responsibility_prompt TEXT NOT NULL DEFAULT ''")
            if "agent_non_goals_prompt" not in agent_columns:
                self._conn.execute("ALTER TABLE agent_profiles ADD COLUMN agent_non_goals_prompt TEXT NOT NULL DEFAULT ''")
            self._conn.commit()

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> None:
        with self._lock:
            self._conn.execute(sql, params)
            self._conn.commit()

    def executemany(self, sql: str, params: list[tuple[Any, ...]]) -> None:
        with self._lock:
            self._conn.executemany(sql, params)
            self._conn.commit()

    def fetchone(self, sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    def fetchall(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [dict(row) for row in rows]


db = Database(DB_PATH)


class AgentCreatePayload(BaseModel):
    name: str
    description: str = ""
    avatar_url: str = ""
    persona_prompt: str = ""
    skills_prompt: str = ""
    agent_identity_prompt: str = ""
    agent_responsibility_prompt: str = ""
    agent_non_goals_prompt: str = ""
    selected_skills: list[str] = Field(default_factory=list)
    default_model: str = DEFAULT_MODEL_KEY
    workspace_binding: str
    tool_profile: dict[str, Any] = Field(default_factory=lambda: {"shell": True, "filesystem": True, "browser": False})
    memory_policy: dict[str, Any] = Field(default_factory=lambda: {"provider": "mem0", "scope": ""})
    channel_config: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


class AgentPatchPayload(BaseModel):
    name: str | None = None
    description: str | None = None
    avatar_url: str | None = None
    persona_prompt: str | None = None
    skills_prompt: str | None = None
    agent_identity_prompt: str | None = None
    agent_responsibility_prompt: str | None = None
    agent_non_goals_prompt: str | None = None
    selected_skills: list[str] | None = None
    default_model: str | None = None
    workspace_binding: str | None = None
    tool_profile: dict[str, Any] | None = None
    memory_policy: dict[str, Any] | None = None
    channel_config: dict[str, Any] | None = None
    enabled: bool | None = None


class TaskCreatePayload(BaseModel):
    title: str
    prompt: str
    entry_agent_id: str
    enabled_agent_ids: list[str]
    max_turns: int = DEFAULT_TASK_MAX_TURNS
    source_kind: str = "manual"
    source_provider: str = ""
    source_connection_id: str = ""
    source_conversation_id: str = ""


class TaskMessagePayload(BaseModel):
    prompt: str


class AppSettingsPayload(BaseModel):
    global_system_prompt: str = ""


class ChannelInboundPayload(BaseModel):
    provider: str
    connection_id: str
    conversation_id: str
    message_id: str
    sender_id: str
    text: str
    received_at: str = ""
    raw: dict[str, Any] | list[Any] | str | None = None
    entry_agent_id: str | None = None
    enabled_agent_ids: list[str] = Field(default_factory=list)
    max_turns: int | None = None


class ChannelBindingCreatePayload(BaseModel):
    agent_id: str
    provider: str
    connection_id: str
    conversation_id: str
    enabled_agent_ids: list[str] = Field(default_factory=list)
    max_turns: int = DEFAULT_TASK_MAX_TURNS
    push_enabled: bool = True
    enabled: bool = True


class ChannelBindingPatchPayload(BaseModel):
    enabled_agent_ids: list[str] | None = None
    max_turns: int | None = None
    push_enabled: bool | None = None
    enabled: bool | None = None


class ApprovalDecisionPayload(BaseModel):
    reason: str = ""


class ChannelOutboxDecisionPayload(BaseModel):
    error: str = ""


class ChannelOutboxClaimPayload(BaseModel):
    pass


class ChannelConnectionCreatePayload(BaseModel):
    id: str
    name: str
    provider: str
    app_id: str = ""
    app_secret: str = ""
    domain: str = "feishu"
    webhook: str = ""
    enabled: bool = True


class ChannelConnectionPatchPayload(BaseModel):
    name: str | None = None
    app_id: str | None = None
    app_secret: str | None = None
    domain: str | None = None
    webhook: str | None = None
    enabled: bool | None = None


class ModelDefaultPayload(BaseModel):
    model_key: str


class ModelWritePayload(BaseModel):
    model_key: str
    provider: str
    model_id: str
    display_name: str = ""
    alias: str = ""
    base_url: str = ""
    api_type: str = "openai-completions"
    auth_mode: str = "api_key"
    context_window: int = 0
    max_tokens: int = 0
    supports_text: bool = True
    supports_image: bool = False
    enabled: bool = True
    is_primary: bool = False
    api_key: str = ""


class ModelPatchPayload(BaseModel):
    provider: str | None = None
    model_id: str | None = None
    display_name: str | None = None
    alias: str | None = None
    base_url: str | None = None
    api_type: str | None = None
    auth_mode: str | None = None
    context_window: int | None = None
    max_tokens: int | None = None
    supports_text: bool | None = None
    supports_image: bool | None = None
    enabled: bool | None = None
    is_primary: bool | None = None
    api_key: str | None = None


class MemoryProviderBase:
    provider_name = "local"

    def store_episode(self, scope: str, content: str, metadata: dict[str, Any]) -> None:
        raise NotImplementedError

    def retrieve(self, scope: str, query: str, limit: int) -> list[dict[str, Any]]:
        raise NotImplementedError

    def summarize(self, scope: str) -> str:
        raise NotImplementedError

    def rebuild(self, scope: str) -> dict[str, Any]:
        raise NotImplementedError

    def prune(self, scope: str) -> dict[str, Any]:
        raise NotImplementedError


class LocalMemoryProvider(MemoryProviderBase):
    def __init__(self, provider_name: str = "local") -> None:
        self.provider_name = provider_name

    def _update_scope(self, scope: str) -> None:
        episodes = db.fetchall(
            "SELECT episode, created_at FROM memory_events WHERE scope_id = ? ORDER BY id DESC",
            (scope,),
        )
        summary_lines = []
        for item in episodes[:5]:
            summary_lines.append(f"- {item['created_at']}: {item['episode'][:180]}")
        summary = "\n".join(summary_lines)
        count = len(episodes)
        db.execute(
            """
            INSERT INTO memory_scopes(scope_id, provider, summary, episode_count, updated_at)
            VALUES(?, ?, ?, ?, ?)
            ON CONFLICT(scope_id) DO UPDATE SET
                provider = excluded.provider,
                summary = excluded.summary,
                episode_count = excluded.episode_count,
                updated_at = excluded.updated_at
            """,
            (scope, self.provider_name, summary, count, utcnow()),
        )

    def store_episode(self, scope: str, content: str, metadata: dict[str, Any]) -> None:
        db.execute(
            """
            INSERT INTO memory_events(scope_id, provider, episode, metadata, created_at)
            VALUES(?, ?, ?, ?, ?)
            """,
            (scope, self.provider_name, content, json_dumps(metadata), utcnow()),
        )
        self._update_scope(scope)

    def retrieve(self, scope: str, query: str, limit: int) -> list[dict[str, Any]]:
        rows = db.fetchall(
            "SELECT id, episode, metadata, created_at FROM memory_events WHERE scope_id = ? ORDER BY id DESC LIMIT ?",
            (scope, limit),
        )
        keywords = [part.lower() for part in re.split(r"\W+", query) if len(part) > 2]
        if not keywords:
            return rows
        scored = []
        for row in rows:
            haystack = row["episode"].lower()
            score = sum(1 for token in keywords if token in haystack)
            scored.append((score, row))
        scored.sort(key=lambda item: (-item[0], -item[1]["id"]))
        return [item[1] for item in scored[:limit]]

    def summarize(self, scope: str) -> str:
        row = db.fetchone("SELECT summary FROM memory_scopes WHERE scope_id = ?", (scope,))
        return row["summary"] if row else ""

    def rebuild(self, scope: str) -> dict[str, Any]:
        self._update_scope(scope)
        row = db.fetchone("SELECT * FROM memory_scopes WHERE scope_id = ?", (scope,))
        return normalize_memory_scope(row) if row else {"scope_id": scope, "provider": self.provider_name}

    def prune(self, scope: str) -> dict[str, Any]:
        rows = db.fetchall(
            "SELECT id FROM memory_events WHERE scope_id = ? ORDER BY id DESC",
            (scope,),
        )
        to_delete = [str(item["id"]) for item in rows[25:]]
        if to_delete:
            placeholders = ",".join("?" for _ in to_delete)
            db.execute(f"DELETE FROM memory_events WHERE id IN ({placeholders})", tuple(to_delete))
        self._update_scope(scope)
        return {"scope_id": scope, "deleted": len(to_delete)}


class MemoryService:
    def __init__(self) -> None:
        self.mem0_available = import_available("mem0")
        self.local = LocalMemoryProvider("mem0-fallback")

    def provider_for(self, policy: dict[str, Any] | None) -> MemoryProviderBase:
        provider = (policy or {}).get("provider", "mem0")
        if provider == "mem0" and self.mem0_available:
            return LocalMemoryProvider("mem0")
        return self.local


memory_service = MemoryService()


def get_setting(key: str, default: str | None = None) -> str | None:
    row = db.fetchone("SELECT value FROM app_settings WHERE key = ?", (key,))
    if not row:
        return default
    return row["value"]


def set_setting(key: str, value: str) -> None:
    db.execute(
        """
        INSERT INTO app_settings(key, value, updated_at)
        VALUES(?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """,
        (key, value, utcnow()),
    )


def current_settings() -> dict[str, Any]:
    return {
        "global_system_prompt": get_setting("global_system_prompt", DEFAULT_GLOBAL_SYSTEM_PROMPT) or "",
    }


def configured_default_model() -> str:
    stored = get_setting("default_model", DEFAULT_MODEL_KEY)
    return stored or DEFAULT_MODEL_KEY


def trim_prompt_block(value: str) -> str:
    return "\n".join(line.rstrip() for line in (value or "").strip().splitlines()).strip()


def default_agent_prompt_fields(name: str, description: str) -> dict[str, str]:
    normalized_name = trim_prompt_block(name) or "This agent"
    normalized_description = trim_prompt_block(description)
    responsibility = normalized_description or "Handle the assigned work carefully and stay within the user's request."
    return {
        "identity": f"You are {normalized_name}.",
        "responsibility": responsibility,
        "non_goals": "Do not invent facts, hide uncertainty, or make unrelated changes.",
    }


def agent_prompt_fields_from_legacy(name: str, description: str, persona_prompt: str, skills_prompt: str) -> dict[str, str]:
    defaults = default_agent_prompt_fields(name, description)
    persona = trim_prompt_block(persona_prompt)
    skills = trim_prompt_block(skills_prompt)
    if not persona and not skills:
        return defaults

    identity = defaults["identity"]
    responsibility_parts: list[str] = []
    non_goals = defaults["non_goals"]

    if persona:
        lowered = persona.lower()
        if lowered.startswith("you are ") or lowered.startswith("you’re ") or lowered.startswith("you are"):
            identity = persona
        else:
            responsibility_parts.append(persona)
    if skills:
        responsibility_parts.append(skills)
    responsibility = "\n".join(part for part in responsibility_parts if part).strip() or defaults["responsibility"]
    return {
        "identity": identity,
        "responsibility": responsibility,
        "non_goals": non_goals,
    }


def normalize_agent_prompt_fields(row: dict[str, Any]) -> dict[str, str]:
    identity = trim_prompt_block(row.get("agent_identity_prompt") or "")
    responsibility = trim_prompt_block(row.get("agent_responsibility_prompt") or "")
    non_goals = trim_prompt_block(row.get("agent_non_goals_prompt") or "")
    if identity or responsibility or non_goals:
        defaults = default_agent_prompt_fields(row.get("name", ""), row.get("description", ""))
        return {
            "identity": identity or defaults["identity"],
            "responsibility": responsibility or defaults["responsibility"],
            "non_goals": non_goals or defaults["non_goals"],
        }
    return agent_prompt_fields_from_legacy(
        row.get("name", ""),
        row.get("description", ""),
        row.get("persona_prompt", ""),
        row.get("skills_prompt", ""),
    )


def sanitize_model_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    row["enabled"] = bool(row["enabled"])
    row["is_primary"] = bool(row["is_primary"])
    row["supports_text"] = bool(row["supports_text"])
    row["supports_image"] = bool(row["supports_image"])
    row["raw_config"] = json_loads(row["raw_config"], {})
    row["is_default"] = row["model_key"] == configured_default_model()
    raw = row["raw_config"]
    row["provider_configured"] = bool(raw.get("baseUrl")) or row["provider"] in {"openai-codex", "openai"}
    row["api_key_present"] = bool(raw.get("api_key") or raw.get("apiKey")) or (
        row["provider"] in {"openai-codex", "openai"} and bool(os.environ.get("OPENAI_API_KEY"))
    )
    if "api_key" in raw:
        raw["api_key"] = "***"
    if "apiKey" in raw:
        raw["apiKey"] = "***"
    return row


def list_models_raw() -> list[dict[str, Any]]:
    rows = db.fetchall("SELECT * FROM model_registry WHERE enabled = 1 ORDER BY is_primary DESC, provider ASC, model_key ASC")
    for row in rows:
        row["enabled"] = bool(row["enabled"])
        row["is_primary"] = bool(row["is_primary"])
        row["supports_text"] = bool(row["supports_text"])
        row["supports_image"] = bool(row["supports_image"])
        row["raw_config"] = json_loads(row["raw_config"], {})
    return rows


def list_models() -> list[dict[str, Any]]:
    rows = list_models_raw()
    return [sanitize_model_row(item) for item in rows]


def get_model(model_key: str) -> dict[str, Any]:
    row = sanitize_model_row(db.fetchone("SELECT * FROM model_registry WHERE model_key = ?", (model_key,)))
    if not row:
        raise HTTPException(status_code=404, detail=f"Model not found: {model_key}")
    return row


def get_model_raw(model_key: str) -> dict[str, Any]:
    row = db.fetchone("SELECT * FROM model_registry WHERE model_key = ?", (model_key,))
    if not row:
        raise HTTPException(status_code=404, detail=f"Model not found: {model_key}")
    row["enabled"] = bool(row["enabled"])
    row["is_primary"] = bool(row["is_primary"])
    row["supports_text"] = bool(row["supports_text"])
    row["supports_image"] = bool(row["supports_image"])
    row["raw_config"] = json_loads(row["raw_config"], {})
    return row


def normalize_model_payload(payload: ModelWritePayload | ModelPatchPayload, existing: dict[str, Any] | None = None) -> dict[str, Any]:
    def text_value(field: str, default: str = "") -> str:
        value = getattr(payload, field, None)
        if value is None and existing is not None:
            value = existing.get(field)
        if value is None:
            value = default
        return str(value).strip()

    def int_value(field: str, default: int = 0) -> int:
        value = getattr(payload, field, None)
        if value is None and existing is not None:
            value = existing.get(field)
        if value is None:
            return default
        return max(0, int(value))

    def bool_value(field: str, default: bool) -> bool:
        value = getattr(payload, field, None)
        if value is None and existing is not None:
            value = existing.get(field)
        if value is None:
            return default
        return bool(value)

    model_key = text_value("model_key", existing.get("model_key", "") if existing else "")
    provider = text_value("provider")
    model_id = text_value("model_id")
    display_name = text_value("display_name", model_id)
    alias = text_value("alias")
    base_url = text_value("base_url")
    api_type = text_value("api_type", "openai-completions")
    auth_mode = text_value("auth_mode", "api_key")
    api_key = getattr(payload, "api_key", None)
    raw_config = json_loads(existing.get("raw_config") if existing else {}, {}) if existing else {}

    if not model_key:
        raise HTTPException(status_code=400, detail="model_key is required.")
    if "/" not in model_key:
        raise HTTPException(status_code=400, detail='model_key must use "provider/model" format.')
    if not provider:
        provider = model_key.split("/", 1)[0]
    if not model_id:
        model_id = model_key.split("/", 1)[1]
    if not display_name:
        display_name = model_id

    raw_config.update(
        {
            "provider": provider,
            "baseUrl": base_url,
            "api": api_type,
            "model": {
                **(raw_config.get("model") if isinstance(raw_config.get("model"), dict) else {}),
                "id": model_id,
                "name": display_name,
                "api": api_type,
                "contextWindow": int_value("context_window"),
                "maxTokens": int_value("max_tokens"),
                "input": [
                    *("text" for _ in [0] if bool_value("supports_text", True)),
                    *("image" for _ in [0] if bool_value("supports_image", False)),
                ],
            },
        }
    )
    if api_key is not None and api_key.strip() and api_key.strip() != "***":
        raw_config["apiKey"] = api_key.strip()

    return {
        "model_key": model_key,
        "provider": provider,
        "model_id": model_id,
        "display_name": display_name,
        "alias": alias,
        "base_url": base_url,
        "api_type": api_type,
        "auth_mode": auth_mode,
        "context_window": int_value("context_window"),
        "max_tokens": int_value("max_tokens"),
        "supports_text": bool_value("supports_text", True),
        "supports_image": bool_value("supports_image", False),
        "enabled": bool_value("enabled", True),
        "is_primary": bool_value("is_primary", False),
        "source": "manual",
        "raw_config": raw_config,
    }


def create_model(payload: ModelWritePayload) -> dict[str, Any]:
    record = normalize_model_payload(payload)
    if db.fetchone("SELECT model_key FROM model_registry WHERE model_key = ?", (record["model_key"],)):
        raise HTTPException(status_code=409, detail=f"Model already exists: {record['model_key']}")
    db.execute(
        """
        INSERT INTO model_registry(
            model_key, provider, model_id, display_name, alias, base_url, api_type, auth_mode,
            context_window, max_tokens, supports_text, supports_image, enabled, is_primary, source, raw_config, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            record["model_key"],
            record["provider"],
            record["model_id"],
            record["display_name"],
            record["alias"],
            record["base_url"],
            record["api_type"],
            record["auth_mode"],
            record["context_window"],
            record["max_tokens"],
            1 if record["supports_text"] else 0,
            1 if record["supports_image"] else 0,
            1 if record["enabled"] else 0,
            1 if record["is_primary"] else 0,
            record["source"],
            json_dumps(record["raw_config"]),
            utcnow(),
        ),
    )
    return get_model(record["model_key"])


def patch_model(model_key: str, payload: ModelPatchPayload) -> dict[str, Any]:
    existing = get_model_raw(model_key)
    record = normalize_model_payload(payload, existing)
    db.execute(
        """
        UPDATE model_registry SET
            provider = ?, model_id = ?, display_name = ?, alias = ?, base_url = ?, api_type = ?, auth_mode = ?,
            context_window = ?, max_tokens = ?, supports_text = ?, supports_image = ?, enabled = ?, is_primary = ?,
            source = ?, raw_config = ?, updated_at = ?
        WHERE model_key = ?
        """,
        (
            record["provider"],
            record["model_id"],
            record["display_name"],
            record["alias"],
            record["base_url"],
            record["api_type"],
            record["auth_mode"],
            record["context_window"],
            record["max_tokens"],
            1 if record["supports_text"] else 0,
            1 if record["supports_image"] else 0,
            1 if record["enabled"] else 0,
            1 if record["is_primary"] else 0,
            record["source"],
            json_dumps(record["raw_config"]),
            utcnow(),
            model_key,
        ),
    )
    return get_model(model_key)


def parse_openclaw_models() -> tuple[list[dict[str, Any]], str]:
    if not OPENCLAW_CONFIG_PATH.exists():
        return (
            [
                {
                    "model_key": DEFAULT_MODEL_KEY,
                    "provider": "volcengine",
                    "model_id": "ark-code-latest",
                    "display_name": "ark-code-latest",
                    "alias": "",
                    "base_url": "",
                    "api_type": "openai-completions",
                    "auth_mode": "api_key",
                    "context_window": 0,
                    "max_tokens": 0,
                    "supports_text": True,
                    "supports_image": False,
                    "enabled": True,
                    "is_primary": True,
                    "source": "fallback",
                    "raw_config": {},
                }
            ],
            DEFAULT_MODEL_KEY,
        )

    data = json.loads(OPENCLAW_CONFIG_PATH.read_text(encoding="utf-8"))
    providers = ((data.get("models") or {}).get("providers") or {})
    auth_profiles = ((data.get("auth") or {}).get("profiles") or {})
    defaults = (((data.get("agents") or {}).get("defaults") or {}).get("models") or {})
    preferred_default = DEFAULT_MODEL_KEY if DEFAULT_MODEL_KEY in defaults else (((data.get("agents") or {}).get("defaults") or {}).get("model") or {}).get("primary") or DEFAULT_MODEL_KEY

    auth_mode_by_provider: dict[str, str] = {}
    for item in auth_profiles.values():
        provider = item.get("provider")
        if provider and provider not in auth_mode_by_provider:
            auth_mode_by_provider[provider] = item.get("mode") or ""

    records: list[dict[str, Any]] = []
    keys = list(dict.fromkeys([preferred_default, *defaults.keys()]))
    for model_key in keys:
        if "/" not in model_key:
            continue
        provider_name, model_id = model_key.split("/", 1)
        provider_config = providers.get(provider_name, {})
        matched = next((item for item in provider_config.get("models", []) if item.get("id") == model_id), {})
        model_defaults = defaults.get(model_key, {})
        display_name = matched.get("name") or model_defaults.get("alias") or model_id
        records.append(
            {
                "model_key": model_key,
                "provider": provider_name,
                "model_id": model_id,
                "display_name": display_name,
                "alias": model_defaults.get("alias") or "",
                "base_url": provider_config.get("baseUrl") or "",
                "api_type": matched.get("api") or provider_config.get("api") or "",
                "auth_mode": auth_mode_by_provider.get(provider_name, "api_key" if provider_config.get("apiKey") else ""),
                "context_window": int(matched.get("contextWindow") or 0),
                "max_tokens": int(matched.get("maxTokens") or 0),
                "supports_text": "text" in (matched.get("input") or ["text"]),
                "supports_image": "image" in (matched.get("input") or []),
                "enabled": True,
                "is_primary": model_key == preferred_default,
                "source": "openclaw",
                "raw_config": {
                    "provider": provider_name,
                    "baseUrl": provider_config.get("baseUrl"),
                    "apiKey": provider_config.get("apiKey"),
                    "api": provider_config.get("api"),
                    "model": matched,
                },
            }
        )

    if not any(item["model_key"] == DEFAULT_MODEL_KEY for item in records):
        records.insert(
            0,
            {
                "model_key": DEFAULT_MODEL_KEY,
                "provider": "volcengine",
                "model_id": "ark-code-latest",
                "display_name": "ark-code-latest",
                "alias": "",
                "base_url": "",
                "api_type": "openai-completions",
                "auth_mode": "api_key",
                "context_window": 0,
                "max_tokens": 0,
                "supports_text": True,
                "supports_image": False,
                "enabled": True,
                "is_primary": True,
                "source": "fallback",
                "raw_config": {},
            },
        )

    return records, preferred_default


def sync_models_from_openclaw() -> dict[str, Any]:
    records, preferred_default = parse_openclaw_models()
    manual_keys = {
        item["model_key"]
        for item in db.fetchall("SELECT model_key FROM model_registry WHERE source = 'manual'")
    }
    records = [item for item in records if item["model_key"] not in manual_keys]
    db.execute("DELETE FROM model_registry WHERE source != 'manual'")
    db.executemany(
        """
        INSERT INTO model_registry(
            model_key, provider, model_id, display_name, alias, base_url, api_type, auth_mode,
            context_window, max_tokens, supports_text, supports_image, enabled, is_primary, source, raw_config, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                item["model_key"],
                item["provider"],
                item["model_id"],
                item["display_name"],
                item["alias"],
                item["base_url"],
                item["api_type"],
                item["auth_mode"],
                item["context_window"],
                item["max_tokens"],
                1 if item["supports_text"] else 0,
                1 if item["supports_image"] else 0,
                1 if item["enabled"] else 0,
                1 if item["is_primary"] else 0,
                item["source"],
                json_dumps(item["raw_config"]),
                utcnow(),
            )
            for item in records
        ],
    )
    current_default = configured_default_model()
    target_default = current_default if db.fetchone("SELECT model_key FROM model_registry WHERE model_key = ?", (current_default,)) else preferred_default
    if db.fetchone("SELECT model_key FROM model_registry WHERE model_key = ?", (DEFAULT_MODEL_KEY,)):
        target_default = DEFAULT_MODEL_KEY
    set_setting("default_model", target_default)
    return {
        "ok": True,
        "synced": len(records),
        "default_model": configured_default_model(),
        "source": str(OPENCLAW_CONFIG_PATH),
    }


sync_models_from_openclaw()


def normalize_agent(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    row["enabled"] = bool(row["enabled"])
    row["tool_profile"] = json_loads(row["tool_profile"], {})
    row["memory_policy"] = json_loads(row["memory_policy"], {})
    row["selected_skills"] = json_loads(row.get("selected_skills"), [])
    row["channel_config"] = {**default_channel_config(), **json_loads(row.get("channel_config"), {})}
    prompt_fields = normalize_agent_prompt_fields(row)
    row["agent_identity_prompt"] = prompt_fields["identity"]
    row["agent_responsibility_prompt"] = prompt_fields["responsibility"]
    row["agent_non_goals_prompt"] = prompt_fields["non_goals"]
    row["available_models"] = [item["model_key"] for item in list_models()]
    return row


def normalize_task(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    row["enabled_agent_ids"] = json_loads(row["enabled_agent_ids"], [])
    row["participating_agents"] = json_loads(row["participating_agents"], [])
    row["max_turns"] = int(row.get("max_turns") or DEFAULT_TASK_MAX_TURNS)
    row["compression_count"] = int(row.get("compression_count") or 0)
    row["compressed_context"] = row.get("compressed_context") or ""
    return row


def collect_task_file_changes(timeline: list[dict[str, Any]]) -> list[dict[str, Any]]:
    changes_by_path: dict[str, dict[str, Any]] = {}
    for event in timeline:
        if event.get("event_type") not in {"tool_call", "tool_result"}:
            continue
        payload = event.get("payload") or {}
        tool_name = payload.get("tool") or ""
        path = str(payload.get("path") or "").strip()
        if not path:
            continue
        operation = "updated"
        if tool_name == "apply_patch":
            raw_type = str(payload.get("type") or "").strip().lower()
            if raw_type == "add":
                operation = "created"
            elif raw_type == "delete":
                operation = "deleted"
            else:
                operation = "updated"
        elif tool_name == "write_local_file":
            operation = "updated"
        else:
            continue
        changes_by_path[path] = {
            "path": path,
            "operation": operation,
            "tool": tool_name,
        }
    return list(changes_by_path.values())


def normalize_run(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    row["metadata"] = json_loads(row["metadata"], {})
    return row


def normalize_timeline_event(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    row["payload"] = json_loads(row["payload"], {})
    return row


def normalize_memory_scope(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    return row


def normalize_channel_conversation(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    row["enabled_agent_ids"] = json_loads(row.get("enabled_agent_ids"), [])
    row["max_turns"] = int(row.get("max_turns") or DEFAULT_TASK_MAX_TURNS)
    return row


def normalize_channel_binding(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    row["enabled_agent_ids"] = json_loads(row.get("enabled_agent_ids"), [])
    row["max_turns"] = int(row.get("max_turns") or DEFAULT_TASK_MAX_TURNS)
    row["push_enabled"] = bool(row.get("push_enabled"))
    row["enabled"] = bool(row.get("enabled"))
    return row


def normalize_channel_outbox(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    row["attempts"] = int(row.get("attempts") or 0)
    return row


def extract_message_text_parts(value: Any) -> list[str]:
    parts: list[str] = []

    def visit(node: Any) -> None:
        if node is None:
            return
        if isinstance(node, str):
            text = node.strip()
            if text:
                parts.append(text)
            return
        if isinstance(node, list):
            for item in node:
                visit(item)
            return
        if isinstance(node, dict):
            message_type = str(node.get("type") or "").strip().lower()
            if message_type == "message":
                visit(node.get("content"))
                return
            if message_type == "function_call":
                name = str(node.get("name") or "").strip()
                arguments = str(node.get("arguments") or "").strip()
                if name:
                    parts.append(name)
                if arguments:
                    parts.append(arguments)
                return
            if message_type == "function_call_output":
                visit(node.get("output"))
                return
            for key, item in node.items():
                if key in {"id", "status", "provider_data", "annotations", "logprobs", "call_id"}:
                    continue
                if key in {"text", "output", "arguments", "content", "input"}:
                    visit(item)
            return

    visit(value)
    return parts


def session_history_summary(session_id: str, session_db_path: Path) -> dict[str, int]:
    if not session_id or not session_db_path.exists():
        return {
            "history_messages": 0,
            "history_chars": 0,
            "history_tokens": 0,
        }

    with sqlite3.connect(str(session_db_path)) as conn:
        rows = conn.execute(
            "SELECT message_data FROM agent_messages WHERE session_id = ? ORDER BY id ASC",
            (session_id,),
        ).fetchall()

    parts: list[str] = []
    for (message_data,) in rows:
        payload = json_loads(message_data, {})
        parts.extend(extract_message_text_parts(payload))

    history_text = "\n".join(part for part in parts if part)
    return {
        "history_messages": len(rows),
        "history_chars": len(history_text),
        "history_tokens": estimate_tokens(history_text) if history_text else 0,
    }


def build_turn_input_with_sticky_system_prompt(
    *,
    system_prompt: str,
    user_input: str,
    session_id: str,
    session_db_path: Path,
) -> tuple[str | list[dict[str, Any]], str, dict[str, int]]:
    history_summary = session_history_summary(session_id, session_db_path)
    prompt_text = trim_prompt_block(system_prompt)
    should_send_system = history_summary["history_messages"] == 0 and bool(prompt_text)
    if should_send_system:
        return (
            [
                {"role": "system", "content": prompt_text},
                {"role": "user", "content": user_input},
            ],
            prompt_text,
            history_summary,
        )
    return user_input, "", history_summary


def channels_store_default() -> dict[str, Any]:
    return {
        "version": 1,
        "connections": {},
    }


def read_channel_connections_store() -> dict[str, Any]:
    CHANNELS_CONNECTIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not CHANNELS_CONNECTIONS_PATH.exists():
        CHANNELS_CONNECTIONS_PATH.write_text(f"{json_dumps(channels_store_default())}\n", encoding="utf-8")
    try:
        parsed = json.loads(CHANNELS_CONNECTIONS_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"Invalid channel connections store: {exc}") from exc
    if not isinstance(parsed, dict) or parsed.get("version") != 1 or not isinstance(parsed.get("connections"), dict):
        raise HTTPException(status_code=500, detail="Invalid channel connections store shape.")
    return parsed


def write_channel_connections_store(store: dict[str, Any]) -> None:
    CHANNELS_CONNECTIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    CHANNELS_CONNECTIONS_PATH.write_text(f"{json_dumps(store)}\n", encoding="utf-8")


def normalize_channel_connection(record: dict[str, Any] | None) -> dict[str, Any] | None:
    if not record:
        return None
    return {
        "id": record.get("id") or "",
        "name": record.get("name") or "",
        "provider": record.get("provider") or "feishu",
        "enabled": bool(record.get("enabled", True)),
        "app_id": record.get("appId") or "",
        "app_secret": record.get("appSecret") or "",
        "domain": record.get("domain") or "feishu",
        "webhook": record.get("webhook") or "",
        "created_at": record.get("createdAt") or "",
        "updated_at": record.get("updatedAt") or "",
    }


def default_channel_config() -> dict[str, Any]:
    return {
        "provider": "feishu",
        "app_id": "",
        "app_secret": "",
        "domain": "feishu",
        "webhook": "",
        "chat_id": "",
        "push_enabled": True,
        "enabled": False,
    }


def list_agents() -> list[dict[str, Any]]:
    return [normalize_agent(item) for item in db.fetchall("SELECT * FROM agent_profiles ORDER BY created_at DESC")]


def get_agent(agent_id: str) -> dict[str, Any]:
    row = normalize_agent(db.fetchone("SELECT * FROM agent_profiles WHERE id = ?", (agent_id,)))
    if not row:
        raise HTTPException(status_code=404, detail=f"Agent not found: {agent_id}")
    return row


def create_agent(payload: AgentCreatePayload) -> dict[str, Any]:
    agent_id = str(uuid.uuid4())
    now = utcnow()
    scope = payload.memory_policy.get("scope") or agent_id
    memory_policy = dict(payload.memory_policy)
    memory_policy["scope"] = scope
    workspace = str(Path(payload.workspace_binding).expanduser().resolve())
    Path(workspace).mkdir(parents=True, exist_ok=True)
    model_key = payload.default_model or configured_default_model()
    if not db.fetchone("SELECT model_key FROM model_registry WHERE model_key = ?", (model_key,)):
        raise HTTPException(status_code=400, detail=f"Unknown model: {model_key}")
    prompt_fields = normalize_agent_prompt_fields(
        {
            "name": payload.name,
            "description": payload.description,
            "persona_prompt": payload.persona_prompt,
            "skills_prompt": payload.skills_prompt,
            "agent_identity_prompt": payload.agent_identity_prompt,
            "agent_responsibility_prompt": payload.agent_responsibility_prompt,
            "agent_non_goals_prompt": payload.agent_non_goals_prompt,
        }
    )
    db.execute(
        """
        INSERT INTO agent_profiles(
            id, name, description, avatar_url, persona_prompt, skills_prompt,
            agent_identity_prompt, agent_responsibility_prompt, agent_non_goals_prompt,
            selected_skills, default_model,
            workspace_binding, tool_profile, memory_policy, channel_config, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            agent_id,
            payload.name,
            payload.description,
            payload.avatar_url,
            payload.persona_prompt,
            payload.skills_prompt,
            prompt_fields["identity"],
            prompt_fields["responsibility"],
            prompt_fields["non_goals"],
            json_dumps(payload.selected_skills),
            model_key,
            workspace,
            json_dumps(payload.tool_profile),
            json_dumps(memory_policy),
            json_dumps({**default_channel_config(), **payload.channel_config}),
            1 if payload.enabled else 0,
            now,
            now,
        ),
    )
    memory_service.provider_for(memory_policy).rebuild(scope)
    created = get_agent(agent_id)
    sync_agent_channel_runtime(created)
    return get_agent(agent_id)


def patch_agent(agent_id: str, payload: AgentPatchPayload) -> dict[str, Any]:
    current = get_agent(agent_id)
    target_model = payload.default_model if payload.default_model is not None else current["default_model"]
    if target_model and not db.fetchone("SELECT model_key FROM model_registry WHERE model_key = ?", (target_model,)):
        raise HTTPException(status_code=400, detail=f"Unknown model: {target_model}")
    updated = {
        "name": payload.name if payload.name is not None else current["name"],
        "description": payload.description if payload.description is not None else current["description"],
        "avatar_url": payload.avatar_url if payload.avatar_url is not None else current.get("avatar_url", ""),
        "persona_prompt": payload.persona_prompt if payload.persona_prompt is not None else current["persona_prompt"],
        "skills_prompt": payload.skills_prompt if payload.skills_prompt is not None else current["skills_prompt"],
        "selected_skills": payload.selected_skills if payload.selected_skills is not None else current.get("selected_skills", []),
        "default_model": target_model,
        "workspace_binding": str(Path(payload.workspace_binding).expanduser().resolve()) if payload.workspace_binding is not None else current["workspace_binding"],
        "tool_profile": payload.tool_profile if payload.tool_profile is not None else current["tool_profile"],
        "memory_policy": {**current["memory_policy"], **(payload.memory_policy or {})},
        "channel_config": {**default_channel_config(), **current.get("channel_config", {}), **(payload.channel_config or {})},
        "enabled": current["enabled"] if payload.enabled is None else payload.enabled,
    }
    prompt_fields = normalize_agent_prompt_fields(
        {
            "name": updated["name"],
            "description": updated["description"],
            "persona_prompt": updated["persona_prompt"],
            "skills_prompt": updated["skills_prompt"],
            "agent_identity_prompt": payload.agent_identity_prompt if payload.agent_identity_prompt is not None else current.get("agent_identity_prompt", ""),
            "agent_responsibility_prompt": payload.agent_responsibility_prompt if payload.agent_responsibility_prompt is not None else current.get("agent_responsibility_prompt", ""),
            "agent_non_goals_prompt": payload.agent_non_goals_prompt if payload.agent_non_goals_prompt is not None else current.get("agent_non_goals_prompt", ""),
        }
    )
    updated["agent_identity_prompt"] = prompt_fields["identity"]
    updated["agent_responsibility_prompt"] = prompt_fields["responsibility"]
    updated["agent_non_goals_prompt"] = prompt_fields["non_goals"]
    db.execute(
        """
        UPDATE agent_profiles
        SET name = ?, description = ?, avatar_url = ?, persona_prompt = ?, skills_prompt = ?,
            agent_identity_prompt = ?, agent_responsibility_prompt = ?, agent_non_goals_prompt = ?,
            selected_skills = ?, default_model = ?,
            workspace_binding = ?, tool_profile = ?, memory_policy = ?, channel_config = ?, enabled = ?, updated_at = ?
        WHERE id = ?
        """,
        (
            updated["name"],
            updated["description"],
            updated["avatar_url"],
            updated["persona_prompt"],
            updated["skills_prompt"],
            updated["agent_identity_prompt"],
            updated["agent_responsibility_prompt"],
            updated["agent_non_goals_prompt"],
            json_dumps(updated["selected_skills"]),
            updated["default_model"],
            updated["workspace_binding"],
            json_dumps(updated["tool_profile"]),
            json_dumps(updated["memory_policy"]),
            json_dumps(updated["channel_config"]),
            1 if updated["enabled"] else 0,
            utcnow(),
            agent_id,
        ),
    )
    patched = get_agent(agent_id)
    sync_agent_channel_runtime(patched)
    return get_agent(agent_id)


def delete_agent(agent_id: str) -> dict[str, Any]:
    agent = get_agent(agent_id)
    active_task = db.fetchone(
        """
        SELECT id, status FROM task_sessions
        WHERE (entry_agent_id = ? OR enabled_agent_ids LIKE ?)
          AND status IN ('queued', 'running', 'waiting_approval')
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (agent_id, f'%{agent_id}%'),
    )
    if active_task:
        raise HTTPException(status_code=409, detail=f"Agent is still referenced by active task {active_task['id']}.")

    db.execute("DELETE FROM agent_channel_bindings WHERE agent_id = ?", (agent_id,))
    db.execute("DELETE FROM channel_conversations WHERE current_agent_id = ?", (agent_id,))
    db.execute("DELETE FROM agent_profiles WHERE id = ?", (agent_id,))
    return {"ok": True, "agent_id": agent_id, "name": agent["name"]}


def log_timeline(
    task_session_id: str,
    event_type: str,
    title: str,
    *,
    body: str = "",
    run_id: str | None = None,
    agent_id: str | None = None,
    agent_name: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    db.execute(
        """
        INSERT INTO timeline_events(task_session_id, run_id, agent_id, agent_name, event_type, title, body, payload, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_session_id,
            run_id,
            agent_id,
            agent_name,
            event_type,
            title,
            body,
            json_dumps(payload or {}),
            utcnow(),
        ),
    )


def list_skills() -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}
    for root in SKILL_ROOTS:
        if not root.exists():
            continue
        for skill_file in root.rglob("SKILL.md"):
            try:
                relative = skill_file.relative_to(root)
            except ValueError:
                relative = skill_file.name
            name = str(relative.parent).replace(os.sep, ":") if str(relative.parent) != "." else skill_file.parent.name
            try:
                content = skill_file.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            description = ""
            for line in content.splitlines():
                stripped = line.strip()
                if stripped.lower().startswith("description:"):
                    description = stripped.split(":", 1)[1].strip()
                    break
            key = name or skill_file.parent.name
            if key not in seen:
                seen[key] = {
                    "id": key,
                    "name": key,
                    "description": description,
                    "path": str(skill_file),
                }
    return sorted(seen.values(), key=lambda item: item["name"].lower())


def selected_skill_records(skill_ids: list[str], *, limit: int = 6) -> list[dict[str, str]]:
    if not skill_ids:
        return []

    skill_lookup = {item["id"]: item for item in list_skills()}
    records: list[dict[str, str]] = []
    for skill_id in skill_ids[:limit]:
        skill = skill_lookup.get(skill_id)
        if not skill:
            continue
        records.append(
            {
                "id": skill_id,
                "name": str(skill.get("name") or skill_id),
                "description": trim_prompt_block(skill.get("description") or ""),
                "path": str(skill.get("path") or ""),
            }
        )
    return records


def selected_skill_summaries(skill_ids: list[str], *, limit: int = 6) -> list[str]:
    summaries: list[str] = []
    for skill in selected_skill_records(skill_ids, limit=limit):
        description = skill.get("description") or ""
        if description:
            summaries.append(f"{skill['id']}: {description[:140]}")
        else:
            summaries.append(skill["id"])
    return summaries


def create_task(payload: TaskCreatePayload) -> dict[str, Any]:
    entry_agent = get_agent(payload.entry_agent_id)
    enabled_agent_ids = list(dict.fromkeys(payload.enabled_agent_ids or [payload.entry_agent_id]))
    if payload.entry_agent_id not in enabled_agent_ids:
        enabled_agent_ids.insert(0, payload.entry_agent_id)

    task_id = str(uuid.uuid4())
    now = utcnow()
    db.execute(
        """
        INSERT INTO task_sessions(
            id, title, prompt, max_turns, compressed_context, compression_count, source_kind, source_provider, source_connection_id, source_conversation_id,
            entry_agent_id, entry_agent_name, enabled_agent_ids,
            participating_agents, active_agent_id, active_agent_name, status,
            last_run_id, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id,
            payload.title,
            payload.prompt,
            max(1, int(payload.max_turns or DEFAULT_TASK_MAX_TURNS)),
            "",
            0,
            payload.source_kind or "manual",
            payload.source_provider or "",
            payload.source_connection_id or "",
            payload.source_conversation_id or "",
            payload.entry_agent_id,
            entry_agent["name"],
            json_dumps(enabled_agent_ids),
            json_dumps([]),
            payload.entry_agent_id,
            entry_agent["name"],
            "queued",
            None,
            "",
            now,
            now,
        ),
    )
    log_timeline(task_id, "task_created", f"Task created: {payload.title}", body=payload.prompt)
    return get_task(task_id)


def delete_task(task_id: str) -> dict[str, Any]:
    task = get_task(task_id)
    if task["status"] in {"queued", "running", "waiting_approval"}:
        raise HTTPException(status_code=409, detail="Active tasks must be terminated before deletion.")

    db.execute("DELETE FROM approvals WHERE task_session_id = ?", (task_id,))
    db.execute("DELETE FROM timeline_events WHERE task_session_id = ?", (task_id,))
    db.execute("DELETE FROM agent_runs WHERE task_session_id = ?", (task_id,))
    db.execute("DELETE FROM channel_messages WHERE task_session_id = ?", (task_id,))
    db.execute("UPDATE channel_conversations SET current_task_id = NULL, updated_at = ? WHERE current_task_id = ?", (utcnow(), task_id))
    db.execute("DELETE FROM task_sessions WHERE id = ?", (task_id,))
    return {"ok": True, "task_id": task_id, "title": task["title"]}


def default_entry_agent() -> dict[str, Any]:
    enabled = [item for item in list_agents() if item["enabled"]]
    if not enabled:
        raise HTTPException(status_code=400, detail="No enabled agents are configured.")
    return enabled[0]


def get_channel_conversation(provider: str, connection_id: str, conversation_id: str) -> dict[str, Any] | None:
    return normalize_channel_conversation(
        db.fetchone(
            "SELECT * FROM channel_conversations WHERE provider = ? AND connection_id = ? AND conversation_id = ?",
            (provider, connection_id, conversation_id),
        )
    )


def upsert_channel_conversation(
    *,
    provider: str,
    connection_id: str,
    conversation_id: str,
    current_task_id: str | None,
    current_agent_id: str | None,
    enabled_agent_ids: list[str],
    max_turns: int,
) -> dict[str, Any]:
    now = utcnow()
    existing = get_channel_conversation(provider, connection_id, conversation_id)
    if existing:
        db.execute(
            """
            UPDATE channel_conversations
            SET current_task_id = ?, current_agent_id = ?, enabled_agent_ids = ?, max_turns = ?, updated_at = ?
            WHERE provider = ? AND connection_id = ? AND conversation_id = ?
            """,
            (
                current_task_id,
                current_agent_id,
                json_dumps(enabled_agent_ids),
                max(1, int(max_turns or DEFAULT_TASK_MAX_TURNS)),
                now,
                provider,
                connection_id,
                conversation_id,
            ),
        )
    else:
        db.execute(
            """
            INSERT INTO channel_conversations(
                id, provider, connection_id, conversation_id, current_task_id, current_agent_id,
                enabled_agent_ids, max_turns, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                provider,
                connection_id,
                conversation_id,
                current_task_id,
                current_agent_id,
                json_dumps(enabled_agent_ids),
                max(1, int(max_turns or DEFAULT_TASK_MAX_TURNS)),
                now,
                now,
            ),
        )
    return get_channel_conversation(provider, connection_id, conversation_id) or {}


def record_channel_message(
    *,
    provider: str,
    connection_id: str,
    conversation_id: str,
    message_id: str,
    sender_id: str,
    task_session_id: str | None,
    direction: str,
    text: str,
    raw_payload: Any,
) -> None:
    db.execute(
        """
        INSERT INTO channel_messages(
            provider, connection_id, conversation_id, message_id, sender_id, task_session_id, direction, text, raw_payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            provider,
            connection_id,
            conversation_id,
            message_id,
            sender_id,
            task_session_id,
            direction,
            text,
            json_dumps(raw_payload if raw_payload is not None else {}),
            utcnow(),
        ),
    )


def list_channel_bindings() -> list[dict[str, Any]]:
    return [
        normalize_channel_binding(item)
        for item in db.fetchall("SELECT * FROM agent_channel_bindings ORDER BY created_at DESC")
    ]


def list_channel_connections() -> list[dict[str, Any]]:
    store = read_channel_connections_store()
    connections = [normalize_channel_connection({"id": key, **value}) for key, value in store["connections"].items()]
    return sorted([item for item in connections if item], key=lambda item: item["name"].lower())


def get_channel_connection(connection_id: str) -> dict[str, Any]:
    store = read_channel_connections_store()
    record = store["connections"].get(connection_id)
    connection = normalize_channel_connection({"id": connection_id, **record} if record else None)
    if not connection:
        raise HTTPException(status_code=404, detail=f"Channel connection not found: {connection_id}")
    return connection


def validate_channel_connection_payload(provider: str, app_id: str, app_secret: str, webhook: str) -> None:
    if provider != "feishu":
        raise HTTPException(status_code=400, detail=f"Unsupported provider: {provider}")
    if not app_id.strip() and not webhook.strip():
        raise HTTPException(status_code=400, detail="Channel connection requires app_id or webhook.")
    if app_id.strip() and not app_secret.strip():
        raise HTTPException(status_code=400, detail="Channel connection with app_id also requires app_secret.")


def connection_id_for_agent(agent_id: str, provider: str = "feishu") -> str:
    return f"agent-{provider}-{agent_id[:8]}"


def create_channel_connection(payload: ChannelConnectionCreatePayload) -> dict[str, Any]:
    store = read_channel_connections_store()
    if payload.id in store["connections"]:
        raise HTTPException(status_code=409, detail=f"Channel connection already exists: {payload.id}")
    validate_channel_connection_payload(payload.provider, payload.app_id, payload.app_secret, payload.webhook)
    now = utcnow()
    store["connections"][payload.id] = {
        "name": payload.name,
        "provider": payload.provider,
        "enabled": payload.enabled,
        "appId": payload.app_id,
        "appSecret": payload.app_secret,
        "domain": payload.domain or "feishu",
        "webhook": payload.webhook,
        "createdAt": now,
        "updatedAt": now,
    }
    write_channel_connections_store(store)
    return get_channel_connection(payload.id)


def patch_channel_connection(connection_id: str, payload: ChannelConnectionPatchPayload) -> dict[str, Any]:
    store = read_channel_connections_store()
    current = store["connections"].get(connection_id)
    if not current:
        raise HTTPException(status_code=404, detail=f"Channel connection not found: {connection_id}")
    updated = {
        **current,
        "name": payload.name if payload.name is not None else current.get("name", ""),
        "appId": payload.app_id if payload.app_id is not None else current.get("appId", ""),
        "appSecret": payload.app_secret if payload.app_secret is not None else current.get("appSecret", ""),
        "domain": payload.domain if payload.domain is not None else current.get("domain", "feishu"),
        "webhook": payload.webhook if payload.webhook is not None else current.get("webhook", ""),
        "enabled": current.get("enabled", True) if payload.enabled is None else payload.enabled,
        "updatedAt": utcnow(),
    }
    validate_channel_connection_payload(updated.get("provider", "feishu"), updated.get("appId", ""), updated.get("appSecret", ""), updated.get("webhook", ""))
    store["connections"][connection_id] = updated
    write_channel_connections_store(store)
    return get_channel_connection(connection_id)


def upsert_channel_connection_record(
    *,
    connection_id: str,
    name: str,
    provider: str,
    app_id: str,
    app_secret: str,
    domain: str,
    webhook: str,
    enabled: bool,
) -> dict[str, Any]:
    store = read_channel_connections_store()
    current = store["connections"].get(connection_id, {})
    store["connections"][connection_id] = {
        "name": name,
        "provider": provider,
        "enabled": enabled,
        "appId": app_id,
        "appSecret": app_secret,
        "domain": domain,
        "webhook": webhook,
        "createdAt": current.get("createdAt") or utcnow(),
        "updatedAt": utcnow(),
    }
    write_channel_connections_store(store)
    return get_channel_connection(connection_id)


def create_channel_binding(payload: ChannelBindingCreatePayload) -> dict[str, Any]:
    agent = get_agent(payload.agent_id)
    binding_id = str(uuid.uuid4())
    enabled_agent_ids = list(dict.fromkeys(payload.enabled_agent_ids or [agent["id"]]))
    if agent["id"] not in enabled_agent_ids:
        enabled_agent_ids.insert(0, agent["id"])
    now = utcnow()
    db.execute(
        """
        INSERT INTO agent_channel_bindings(
            id, agent_id, agent_name, provider, connection_id, conversation_id,
            enabled_agent_ids, max_turns, push_enabled, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            binding_id,
            agent["id"],
            agent["name"],
            payload.provider,
            payload.connection_id,
            payload.conversation_id,
            json_dumps(enabled_agent_ids),
            max(1, int(payload.max_turns or DEFAULT_TASK_MAX_TURNS)),
            1 if payload.push_enabled else 0,
            1 if payload.enabled else 0,
            now,
            now,
        ),
    )
    return normalize_channel_binding(db.fetchone("SELECT * FROM agent_channel_bindings WHERE id = ?", (binding_id,))) or {}


def patch_channel_binding(binding_id: str, payload: ChannelBindingPatchPayload) -> dict[str, Any]:
    current = normalize_channel_binding(db.fetchone("SELECT * FROM agent_channel_bindings WHERE id = ?", (binding_id,)))
    if not current:
        raise HTTPException(status_code=404, detail=f"Channel binding not found: {binding_id}")
    updated = {
        "enabled_agent_ids": payload.enabled_agent_ids if payload.enabled_agent_ids is not None else current["enabled_agent_ids"],
        "max_turns": max(1, int(payload.max_turns or current["max_turns"])),
        "push_enabled": current["push_enabled"] if payload.push_enabled is None else payload.push_enabled,
        "enabled": current["enabled"] if payload.enabled is None else payload.enabled,
    }
    db.execute(
        """
        UPDATE agent_channel_bindings
        SET enabled_agent_ids = ?, max_turns = ?, push_enabled = ?, enabled = ?, updated_at = ?
        WHERE id = ?
        """,
        (
            json_dumps(updated["enabled_agent_ids"]),
            updated["max_turns"],
            1 if updated["push_enabled"] else 0,
            1 if updated["enabled"] else 0,
            utcnow(),
            binding_id,
        ),
    )
    return normalize_channel_binding(db.fetchone("SELECT * FROM agent_channel_bindings WHERE id = ?", (binding_id,))) or {}


def resolve_channel_binding(provider: str, connection_id: str, conversation_id: str) -> dict[str, Any] | None:
    return normalize_channel_binding(
        db.fetchone(
            """
            SELECT * FROM agent_channel_bindings
            WHERE provider = ? AND connection_id = ? AND conversation_id = ? AND enabled = 1
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (provider, connection_id, conversation_id),
        )
    )


def queue_channel_outbox(
    *,
    provider: str,
    connection_id: str,
    conversation_id: str,
    task_session_id: str | None,
    agent_id: str,
    stage: str,
    text: str,
) -> dict[str, Any]:
    outbox_id = str(uuid.uuid4())
    now = utcnow()
    db.execute(
        """
        INSERT INTO channel_outbox(
            id, provider, connection_id, conversation_id, task_session_id, agent_id, stage, text, status, attempts, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            outbox_id,
            provider,
            connection_id,
            conversation_id,
            task_session_id,
            agent_id,
            stage,
            text,
            "pending",
            0,
            "",
            now,
            now,
        ),
    )
    return normalize_channel_outbox(db.fetchone("SELECT * FROM channel_outbox WHERE id = ?", (outbox_id,))) or {}


def list_pending_channel_outbox(connection_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    if connection_id:
        rows = db.fetchall(
            "SELECT * FROM channel_outbox WHERE status = 'pending' AND connection_id = ? ORDER BY created_at ASC LIMIT ?",
            (connection_id, max(1, min(limit, 200))),
        )
    else:
        rows = db.fetchall(
            "SELECT * FROM channel_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?",
            (max(1, min(limit, 200)),),
        )
    return [normalize_channel_outbox(item) for item in rows]


def claim_channel_outbox(outbox_id: str) -> dict[str, Any]:
    with db._lock:
        current = normalize_channel_outbox(db.fetchone("SELECT * FROM channel_outbox WHERE id = ?", (outbox_id,)))
        if not current:
            raise HTTPException(status_code=404, detail=f"Channel outbox item not found: {outbox_id}")
        if current["status"] != "pending":
            return {
                "ok": True,
                "claimed": False,
                "item": current,
            }

        cursor = db._conn.execute(
            """
            UPDATE channel_outbox
            SET status = 'sending', updated_at = ?
            WHERE id = ? AND status = 'pending'
            """,
            (utcnow(), outbox_id),
        )
        db._conn.commit()

        claimed = cursor.rowcount > 0
        item = normalize_channel_outbox(db.fetchone("SELECT * FROM channel_outbox WHERE id = ?", (outbox_id,))) or {}
        return {
            "ok": True,
            "claimed": claimed,
            "item": item,
        }


def mark_channel_outbox_delivered(outbox_id: str) -> dict[str, Any]:
    current = normalize_channel_outbox(db.fetchone("SELECT * FROM channel_outbox WHERE id = ?", (outbox_id,)))
    if not current:
        raise HTTPException(status_code=404, detail=f"Channel outbox item not found: {outbox_id}")
    if current["status"] == "delivered":
        return current
    db.execute(
        """
        UPDATE channel_outbox
        SET status = 'delivered', attempts = ?, last_error = '', delivered_at = ?, updated_at = ?
        WHERE id = ?
        """,
        (current["attempts"] + 1, utcnow(), utcnow(), outbox_id),
    )
    return normalize_channel_outbox(db.fetchone("SELECT * FROM channel_outbox WHERE id = ?", (outbox_id,))) or {}


def mark_channel_outbox_failed(outbox_id: str, error: str) -> dict[str, Any]:
    current = normalize_channel_outbox(db.fetchone("SELECT * FROM channel_outbox WHERE id = ?", (outbox_id,)))
    if not current:
        raise HTTPException(status_code=404, detail=f"Channel outbox item not found: {outbox_id}")
    next_status = "failed" if current["attempts"] + 1 >= 5 else "pending"
    db.execute(
        """
        UPDATE channel_outbox
        SET status = ?, attempts = ?, last_error = ?, updated_at = ?
        WHERE id = ?
        """,
        (next_status, current["attempts"] + 1, error[:1000], utcnow(), outbox_id),
    )
    return normalize_channel_outbox(db.fetchone("SELECT * FROM channel_outbox WHERE id = ?", (outbox_id,))) or {}


def queue_task_channel_push(task: dict[str, Any], *, stage: str, text: str) -> None:
    if task.get("source_kind") != "channel":
        return
    if not task.get("source_connection_id") or not task.get("source_conversation_id"):
        return
    binding = resolve_channel_binding(task.get("source_provider") or "", task.get("source_connection_id") or "", task.get("source_conversation_id") or "")
    if binding and not binding.get("push_enabled"):
        return
    queue_channel_outbox(
        provider=task.get("source_provider") or "",
        connection_id=task.get("source_connection_id") or "",
        conversation_id=task.get("source_conversation_id") or "",
        task_session_id=task["id"],
        agent_id=task.get("entry_agent_id") or "",
        stage=stage,
        text=text,
    )


def sync_agent_channel_runtime(agent: dict[str, Any]) -> None:
    channel = {**default_channel_config(), **(agent.get("channel_config") or {})}
    provider = (channel.get("provider") or "feishu").strip() or "feishu"
    connection_id = connection_id_for_agent(agent["id"], provider)
    app_id = str(channel.get("app_id") or "").strip()
    app_secret = str(channel.get("app_secret") or "").strip()
    domain = str(channel.get("domain") or "feishu").strip() or "feishu"
    webhook = str(channel.get("webhook") or "").strip()
    chat_id = str(channel.get("chat_id") or "").strip()
    push_enabled = bool(channel.get("push_enabled", True))
    channel_enabled = bool(channel.get("enabled")) and bool(app_id or webhook)

    upsert_channel_connection_record(
        connection_id=connection_id,
        name=f"{agent['name']} {provider}",
        provider=provider,
        app_id=app_id,
        app_secret=app_secret,
        domain=domain,
        webhook=webhook,
        enabled=channel_enabled,
    )

    existing_bindings = db.fetchall(
        "SELECT * FROM agent_channel_bindings WHERE agent_id = ? AND provider = ?",
        (agent["id"], provider),
    )
    existing_by_conversation = {
        item["conversation_id"]: normalize_channel_binding(item)
        for item in existing_bindings
    }

    if channel_enabled and chat_id:
        current_binding = existing_by_conversation.get(chat_id)
        if current_binding:
            db.execute(
                """
                UPDATE agent_channel_bindings
                SET agent_name = ?, connection_id = ?, enabled_agent_ids = ?, max_turns = ?, push_enabled = ?, enabled = 1, updated_at = ?
                WHERE id = ?
                """,
                (
                    agent["name"],
                    connection_id,
                    json_dumps(current_binding.get("enabled_agent_ids") or [agent["id"]]),
                    current_binding.get("max_turns") or DEFAULT_TASK_MAX_TURNS,
                    1 if push_enabled else 0,
                    utcnow(),
                    current_binding["id"],
                ),
            )
        else:
            create_channel_binding(
                ChannelBindingCreatePayload(
                    agent_id=agent["id"],
                    provider=provider,
                    connection_id=connection_id,
                    conversation_id=chat_id,
                    enabled_agent_ids=[agent["id"]],
                    max_turns=DEFAULT_TASK_MAX_TURNS,
                    push_enabled=push_enabled,
                    enabled=True,
                )
            )

    for item in existing_bindings:
        should_enable = bool(channel_enabled and chat_id and item["conversation_id"] == chat_id)
        db.execute(
            """
            UPDATE agent_channel_bindings
            SET agent_name = ?, connection_id = ?, push_enabled = ?, enabled = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                agent["name"],
                connection_id,
                1 if push_enabled else 0,
                1 if should_enable else 0,
                utcnow(),
                item["id"],
            ),
        )


def get_task(task_id: str) -> dict[str, Any]:
    task = normalize_task(db.fetchone("SELECT * FROM task_sessions WHERE id = ?", (task_id,)))
    if not task:
        raise HTTPException(status_code=404, detail=f"Task not found: {task_id}")
    runs = [normalize_run(item) for item in db.fetchall("SELECT * FROM agent_runs WHERE task_session_id = ? ORDER BY started_at ASC", (task_id,))]
    approvals = db.fetchall("SELECT * FROM approvals WHERE task_session_id = ? ORDER BY created_at ASC", (task_id,))
    timeline = [normalize_timeline_event(item) for item in db.fetchall("SELECT * FROM timeline_events WHERE task_session_id = ? ORDER BY id ASC", (task_id,))]
    task["runs"] = runs
    task["approvals"] = approvals
    task["timeline"] = timeline
    task["file_changes"] = collect_task_file_changes(timeline)
    latest_run = runs[-1] if runs else None
    task["context_summary"] = (latest_run or {}).get("metadata", {}).get("context_summary", {})
    return task


def context_summary_payload(
    *,
    final_system_prompt: str,
    user_input: str,
    compressed_context: str,
    memory_context: str,
    model_row: dict[str, Any],
    session_id: str = "",
    session_db_path: Path | None = None,
) -> dict[str, Any]:
    history_summary = session_history_summary(session_id, session_db_path) if session_id and session_db_path else {
        "history_messages": 0,
        "history_chars": 0,
        "history_tokens": 0,
    }
    estimated_total_tokens = estimate_tokens(final_system_prompt + "\n" + user_input) + int(history_summary["history_tokens"])
    context_window = int(model_row.get("context_window") or 0)
    usage_percent = 0.0
    if context_window > 0:
        usage_percent = min(estimated_total_tokens / context_window, 1.0)
    return {
        "history_messages": int(history_summary["history_messages"]),
        "history_chars": int(history_summary["history_chars"]),
        "history_tokens": int(history_summary["history_tokens"]),
        "system_chars": len(final_system_prompt),
        "user_chars": len(user_input),
        "compressed_chars": len(compressed_context),
        "memory_chars": len(memory_context),
        "estimated_total_tokens": estimated_total_tokens,
        "context_window": context_window,
        "context_usage_percent": usage_percent,
        "model_key": model_row.get("model_key") or "",
    }


def task_session_ids(task_id: str, enabled_agent_ids: list[str]) -> list[str]:
    session_ids = [f"task:{task_id}:orchestrator"]
    session_ids.extend(f"task:{task_id}:agent:{agent_id}" for agent_id in enabled_agent_ids)
    return list(dict.fromkeys(session_ids))


def reset_task_conversation_history(task: dict[str, Any]) -> None:
    session_db_path = DB_PATH.parent / "agent-conversations.sqlite"
    if not session_db_path.exists():
        return
    session_ids = task_session_ids(task["id"], task.get("enabled_agent_ids", []))
    placeholders = ",".join("?" for _ in session_ids)
    with sqlite3.connect(str(session_db_path)) as conn:
        conn.execute(f"DELETE FROM agent_messages WHERE session_id IN ({placeholders})", session_ids)
        conn.execute(f"DELETE FROM agent_sessions WHERE session_id IN ({placeholders})", session_ids)
        conn.commit()


def build_compressed_context(task: dict[str, Any]) -> str:
    timeline = task.get("timeline") or []
    prior_summary = trim_prompt_block(task.get("compressed_context") or "")
    user_updates: list[str] = []
    tool_findings: list[str] = []
    final_states: list[str] = []

    for event in timeline:
        event_type = event.get("event_type") or ""
        body = trim_prompt_block(event.get("body") or "")
        title = trim_prompt_block(event.get("title") or "")
        if event_type in {"user_message", "channel_message"} and body:
            user_updates.append(body)
        elif event_type == "tool_result" and body:
            tool_findings.append(f"{title}: {body}")
        elif event_type in {"task_completed", "task_failed", "task_cancelled", "approval_requested"}:
            if body or title:
                final_states.append(f"{title}: {body}".strip(": "))

    def trim_items(items: list[str], limit: int, item_chars: int = 240) -> list[str]:
        trimmed: list[str] = []
        for item in items[:limit]:
            text = item[:item_chars]
            if len(item) > item_chars:
                text += "..."
            trimmed.append(text)
        return trimmed

    sections: list[str] = [
        "# Compressed context",
        "This is a partial summary of earlier turns. It may omit details from the full transcript.",
        "",
        "## Original goal",
        trim_prompt_block(task.get("prompt") or ""),
    ]
    if prior_summary:
        sections.extend(["", "## Previous summary", prior_summary[:600] + ("..." if len(prior_summary) > 600 else "")])
    if user_updates:
        sections.extend(["", "## Later user updates", *[f"- {item}" for item in trim_items(user_updates[-3:], 3)]])
    if tool_findings:
        sections.extend(["", "## Important tool results", *[f"- {item}" for item in trim_items(tool_findings[-4:], 4)]])
    if final_states:
        sections.extend(["", "## Current state", *[f"- {item}" for item in trim_items(final_states[-3:], 3)]])
    result = "\n".join(part for part in sections if part is not None).strip()
    if len(result) > 2200:
        result = result[:2200].rstrip() + "..."
    return result


VISUAL_CONTENT_CLAIM_RE = re.compile(
    r"(我看到了|我能看到|从.*截图上.*看到|现在是.*页面|标题|按钮|右下角|蓝色.*按钮|登录页面|图库页面)"
)
STRONG_VERIFICATION_CLAIM_RE = re.compile(
    r"(验证(成功|完成|完了|通过)|测试(通过|成功|好了)|修复(好了|成功|完成)|修复逻辑验证|完全正确|已经解决|问题已解决|bug已修复|这就是修复后的效果)"
)
USER_CONFIRMATION_RE = re.compile(r"(可以了|好了|修复了|解决了|没问题了|通过了|成功了)")


def summarize_tool_payload(payload: dict[str, Any]) -> str:
    tool_name = str(payload.get("tool") or "")
    if tool_name == "shell":
        return str(payload.get("command") or "")
    if tool_name == "run_local_command":
        return str(payload.get("command") or "")
    if tool_name == "agent-browser":
        if payload.get("action") == "screenshot":
            return "screenshot"
        return str(payload.get("command") or "")
    return tool_name


def screenshot_semantic_notice() -> str:
    return (
        "Screenshot captured.\n"
        "This result only proves that an image file was generated.\n"
        "It does not provide semantic understanding of the page contents.\n"
        "Do not claim to have seen titles, buttons, layout, or page state from this artifact alone."
    )


def inspect_screenshot_artifact(image_path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {
        "path_exists": image_path.exists(),
        "semantic_visual_evidence": False,
    }
    if not image_path.exists():
        return result

    result["size_bytes"] = image_path.stat().st_size
    if not import_available("PIL"):
        result["analysis"] = "pillow_unavailable"
        return result

    try:
        from PIL import Image, ImageStat  # type: ignore

        with Image.open(io.BytesIO(image_path.read_bytes())) as image:
            rgb = image.convert("RGB")
            stat = ImageStat.Stat(rgb)
            means = stat.mean
            extrema = stat.extrema
            max_mean = max(means) if means else 0.0
            channel_ranges = [high - low for low, high in extrema] if extrema else [0]
            max_range = max(channel_ranges) if channel_ranges else 0
            near_black = max_mean < 5.0 and max_range < 8
            near_monochrome = max_range < 4
            result.update(
                {
                    "analysis": "ok",
                    "mean_rgb": [round(value, 2) for value in means],
                    "max_channel_range": round(float(max_range), 2),
                    "likely_near_black": near_black,
                    "likely_monochrome": near_monochrome,
                }
            )
    except Exception as exc:
        result["analysis"] = f"failed:{exc}"
    return result


def has_strong_visual_text_evidence(timeline: list[dict[str, Any]]) -> bool:
    for event in timeline:
        if event.get("event_type") != "tool_result":
            continue
        payload = event.get("payload") or {}
        if payload.get("tool") != "agent-browser":
            continue
        if payload.get("action") == "screenshot":
            continue
        command = str(payload.get("command") or "")
        result = payload.get("result")
        page_url = str(payload.get("page_url") or "")
        body = str(event.get("body") or "")

        if command.startswith(("snapshot", "eval", "find", "get")):
            serialized = json_dumps(result) if result is not None else body
            lowered = serialized.lower()
            if "about:blank" in lowered:
                continue
            if "(no interactive elements)" in lowered:
                continue
            return True
        if command.startswith("open") and page_url and not page_url.startswith("about:blank"):
            if "Title:" in body:
                return True
    return False


def has_verification_evidence(timeline: list[dict[str, Any]]) -> bool:
    verification_terms = (
        " test",
        "pytest",
        "vitest",
        "jest",
        "playwright",
        "cypress",
        "pnpm test",
        "npm test",
        "cargo test",
        "go test",
    )
    for event in timeline:
        if event.get("event_type") != "tool_result":
            continue
        payload = event.get("payload") or {}
        tool_name = str(payload.get("tool") or "")
        summary = summarize_tool_payload(payload).lower()
        if tool_name in {"shell", "run_local_command"} and any(term in f" {summary}" for term in verification_terms):
            if int(payload.get("returncode") or 0) == 0:
                return True
        if tool_name == "agent-browser":
            command = str(payload.get("command") or "")
            if command.startswith(("click", "fill", "press", "snapshot", "eval", "find")):
                return True
    return False


def has_user_confirmation(timeline: list[dict[str, Any]]) -> bool:
    for event in reversed(timeline[-8:]):
        if event.get("event_type") not in {"user_message", "channel_message"}:
            continue
        body = str(event.get("body") or "")
        if USER_CONFIRMATION_RE.search(body):
            return True
    return False


def audit_final_output(task_id: str, run_id: str, final_output: str) -> tuple[str, dict[str, Any]]:
    timeline = [
        normalize_timeline_event(item)
        for item in db.fetchall(
            "SELECT * FROM timeline_events WHERE task_session_id = ? AND run_id = ? ORDER BY id ASC",
            (task_id, run_id),
        )
    ]
    findings: list[str] = []
    visual_evidence = has_strong_visual_text_evidence(timeline)
    verification_evidence = has_verification_evidence(timeline) or has_user_confirmation(timeline)

    if VISUAL_CONTENT_CLAIM_RE.search(final_output) and not visual_evidence:
        findings.append(
            "The response claims visual page details, but this run has no textual browser evidence supporting those details."
        )
    if STRONG_VERIFICATION_CLAIM_RE.search(final_output) and not verification_evidence:
        findings.append(
            "The response claims verification or successful bug resolution, but this run has no recorded test/user-confirmed verification evidence."
        )

    audit_payload = {
        "findings": findings,
        "visual_evidence": visual_evidence,
        "verification_evidence": verification_evidence,
    }
    if not findings:
        return final_output, audit_payload

    supported_facts: list[str] = []
    for event in timeline:
        if event.get("event_type") != "tool_result":
            continue
        payload = event.get("payload") or {}
        tool_name = str(payload.get("tool") or "")
        if tool_name in {"shell", "run_local_command", "agent-browser"}:
            summary = summarize_tool_payload(payload).strip()
            if summary:
                supported_facts.append(summary)
        if len(supported_facts) >= 4:
            break

    lines = [
        "Runtime audit note: the draft response included claims that are not supported by recorded tool evidence.",
        "",
        "What is supported:",
    ]
    if supported_facts:
        lines.extend(f"- {item}" for item in supported_facts[:4])
    else:
        lines.append("- Tool activity was recorded, but not enough evidence exists to support the original claims.")
    lines.extend(
        [
            "",
            "What remains unverified:",
            *[f"- {item}" for item in findings],
            "",
            "Please treat any page-content description or fix-verification claim from this run as unverified.",
        ]
    )
    return "\n".join(lines), audit_payload


def update_task_status(task_id: str, *, status: str, active_agent_id: str | None = None, active_agent_name: str | None = None, participating_agents: list[str] | None = None, last_run_id: str | None = None, last_error: str | None = None) -> None:
    current = normalize_task(db.fetchone("SELECT * FROM task_sessions WHERE id = ?", (task_id,)))
    if not current:
        return
    db.execute(
        """
        UPDATE task_sessions
        SET status = ?, active_agent_id = ?, active_agent_name = ?, participating_agents = ?, last_run_id = ?, last_error = ?, updated_at = ?
        WHERE id = ?
        """,
        (
            status,
            active_agent_id if active_agent_id is not None else current.get("active_agent_id"),
            active_agent_name if active_agent_name is not None else current.get("active_agent_name"),
            json_dumps(participating_agents if participating_agents is not None else current.get("participating_agents", [])),
            last_run_id if last_run_id is not None else current.get("last_run_id"),
            last_error if last_error is not None else current.get("last_error", ""),
            utcnow(),
            task_id,
        ),
    )


def create_run(task_id: str, agent_id: str, agent_name: str, role: str, model: str, parent_run_id: str | None = None) -> str:
    run_id = str(uuid.uuid4())
    db.execute(
        """
        INSERT INTO agent_runs(
            id, task_session_id, agent_id, agent_name, parent_run_id, role, model, status, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (run_id, task_id, agent_id, agent_name, parent_run_id, role, model, "running", utcnow()),
    )
    return run_id


def complete_run(run_id: str, status: str, final_output: str = "", metadata: dict[str, Any] | None = None) -> None:
    preview = final_output.strip().replace("\n", " ")[:160]
    db.execute(
        """
        UPDATE agent_runs
        SET status = ?, final_output = ?, final_output_preview = ?, metadata = ?, completed_at = ?
        WHERE id = ?
        """,
        (status, final_output, preview, json_dumps(metadata or {}), utcnow(), run_id),
    )


class PendingRunBundle:
    def __init__(self, task_id: str, run_id: str, starting_agent: Any, state: Any, session: Any, run_config: Any) -> None:
        self.task_id = task_id
        self.run_id = run_id
        self.starting_agent = starting_agent
        self.state = state
        self.session = session
        self.run_config = run_config


PENDING_RUNS: dict[str, PendingRunBundle] = {}
RUNNING_EXECUTIONS: dict[str, asyncio.Task[Any]] = {}


def provider_status() -> dict[str, Any]:
    return {
        "python": os.environ.get("UV_PYTHON") or os.environ.get("PYTHONEXECUTABLE") or f"{os.sys.version_info.major}.{os.sys.version_info.minor}.{os.sys.version_info.micro}",
        "project": str(Path(__file__).resolve().parents[1]),
        "agentsAvailable": import_available("agents"),
        "mem0Available": memory_service.mem0_available,
        "memoryEnabled": MEMORY_ENABLED,
        "playwrightAvailable": import_available("playwright"),
        "openAIApiKey": bool(os.environ.get("OPENAI_API_KEY")),
        "defaultModel": configured_default_model(),
        "modelCount": len(list_models()),
    }


def schedule_task_execution(task_id: str, *, resume_run_id: str | None = None, input_text: str | None = None) -> asyncio.Task[Any]:
    task = asyncio.create_task(run_task_execution(task_id, resume_run_id=resume_run_id, input_text=input_text))
    RUNNING_EXECUTIONS[task_id] = task

    def _cleanup(_: asyncio.Task[Any]) -> None:
        current = RUNNING_EXECUTIONS.get(task_id)
        if current is task:
            RUNNING_EXECUTIONS.pop(task_id, None)

    task.add_done_callback(_cleanup)
    return task


def risk_from_command(command: str) -> str | None:
    risky_patterns = [
        r"\brm\s+-rf\b",
        r"\bgit\s+reset\s+--hard\b",
        r"\bchmod\b",
        r"\bchown\b",
        r"\bsudo\b",
        r"\bmkfs\b",
        r"\bdd\b",
        r"\bcurl\b.*\|\s*(sh|bash)",
    ]
    for pattern in risky_patterns:
        if re.search(pattern, command):
            return f"Risky shell command matched: {pattern}"
    return None


async def build_agents_runtime(task: dict[str, Any], run_id: str, current_input: str):
    if not import_available("agents"):
        raise RuntimeError("openai-agents is not available in the runtime environment.")

    from agents import Agent, ApplyPatchTool, ComputerProvider, ComputerTool, ModelSettings, MultiProvider, OpenAIProvider, Runner, RunConfig, SQLiteSession, ShellTool, ShellToolLocalSkill, apply_diff, function_tool, set_tracing_disabled
    from agents.models.multi_provider import MultiProviderMap
    from agents.editor import ApplyPatchOperation, ApplyPatchResult
    from agents.tool import ShellActionRequest, ShellCommandRequest
    from playwright.async_api import async_playwright

    entry_agent = get_agent(task["entry_agent_id"])
    enabled_agents = [get_agent(agent_id) for agent_id in task["enabled_agent_ids"]]
    participating_agents = [entry_agent["name"]]
    session_db_path = DB_PATH.parent / "agent-conversations.sqlite"
    orchestrator_session_id = f"task:{task['id']}:orchestrator"
    orchestrator_session = SQLiteSession(orchestrator_session_id, db_path=session_db_path)

    def allowed_roots_for(agent_profile: dict[str, Any]) -> list[Path]:
        roots = [Path(agent_profile["workspace_binding"]).expanduser().resolve(), Path.home().resolve()]
        deduped: list[Path] = []
        for root in roots:
            if root not in deduped:
                deduped.append(root)
        return deduped

    def resolve_local_path(agent_profile: dict[str, Any], raw_path: str, *, allow_missing: bool = True) -> Path:
        candidate = Path(raw_path).expanduser()
        if not candidate.is_absolute():
            candidate = Path(agent_profile["workspace_binding"]).expanduser().resolve() / candidate
        candidate = candidate.resolve(strict=False)
        for root in allowed_roots_for(agent_profile):
            try:
                candidate.relative_to(root)
                return candidate
            except ValueError:
                continue
        roots_text = ", ".join(str(item) for item in allowed_roots_for(agent_profile))
        raise RuntimeError(f"Path is outside allowed local roots: {candidate}. Allowed roots: {roots_text}")

    def log_tool_result(task_id: str, run_id: str, agent_profile: dict[str, Any], tool_name: str, title: str, body: str, payload: dict[str, Any] | None = None) -> None:
        log_timeline(
            task_id,
            "tool_result",
            title,
            body=body[:1000],
            run_id=run_id,
            agent_id=agent_profile["id"],
            agent_name=agent_profile["name"],
            payload={"tool": tool_name, **(payload or {})},
        )

    def resolve_model_provider(agent_profile: dict[str, Any]) -> tuple[Any, str, bool, dict[str, Any]]:
        model_key = agent_profile["default_model"] or configured_default_model()
        model_row = get_model_raw(model_key)
        provider_map = MultiProviderMap()

        for item in list_models_raw():
            raw = item["raw_config"]
            provider_name = item["provider"]
            if provider_map.has_prefix(provider_name):
                continue

            if provider_name in {"openai-codex", "openai"}:
                provider_map.add_provider(
                    provider_name,
                    OpenAIProvider(
                        api_key=os.environ.get("OPENAI_API_KEY"),
                        use_responses=False,
                    ),
                )
                continue

            api_key = raw.get("apiKey") or raw.get("api_key")
            base_url = raw.get("baseUrl") or item.get("base_url")
            if api_key and base_url:
                provider_map.add_provider(
                    provider_name,
                    OpenAIProvider(
                        api_key=api_key,
                        base_url=base_url,
                        use_responses=False,
                    ),
                )

        has_api_key = bool(model_row["raw_config"].get("apiKey") or model_row["raw_config"].get("api_key"))
        if model_row["provider"] not in {"openai-codex", "openai"} and not has_api_key:
            raise RuntimeError(f"API key is missing for model provider: {model_row['provider']}")
        if model_row["provider"] in {"openai-codex", "openai"} and not os.environ.get("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is missing.")

        hosted_tools_supported = model_row["provider"] in {"openai", "openai-codex"}
        set_tracing_disabled(disabled=model_row["provider"] != "openai")
        provider = MultiProvider(provider_map=provider_map, openai_use_responses=False)
        return provider, model_key, hosted_tools_supported, model_row

    def retrieve_memory(agent_profile: dict[str, Any]) -> str:
        if not MEMORY_ENABLED:
            return ""
        policy = agent_profile["memory_policy"]
        provider = memory_service.provider_for(policy)
        scope = policy.get("scope") or agent_profile["id"]
        items = provider.retrieve(scope, current_input, 3)
        if not items:
            return ""
        return "\n".join([f"- {item['episode'][:180]}" for item in items])

    def base_instructions(agent_profile: dict[str, Any], *, is_orchestrator: bool, task_state: dict[str, Any] | None = None) -> tuple[str, dict[str, Any]]:
        active_task = task_state or task
        memory_context = retrieve_memory(agent_profile)
        local_roots = allowed_roots_for(agent_profile)
        selected_skills = agent_profile.get("selected_skills", [])
        global_system_prompt = current_settings().get("global_system_prompt", "").strip()
        compressed_context = str(active_task.get("compressed_context") or "").strip()
        skill_records = selected_skill_records(selected_skills)
        skill_summaries = selected_skill_summaries(selected_skills)

        sections: list[str] = []
        if global_system_prompt:
            sections.append(global_system_prompt)

        agent_lines = [
            "# Agent prompt",
            f"## Identity\n{agent_profile['agent_identity_prompt']}",
            f"## Responsibility\n{agent_profile['agent_responsibility_prompt']}",
            f"## Non-goals\n{agent_profile['agent_non_goals_prompt']}",
        ]
        sections.append("\n\n".join(part for part in agent_lines if trim_prompt_block(part)))

        bootstrap_wakeup_prompt = (
            active_task.get("source_kind") == "channel" and current_input.strip() == CHANNEL_NEW_TASK_PROMPT
        )

        if skill_records:
            skill_lines = []
            for skill in skill_records:
                path = skill.get("path") or skill["id"]
                description = skill.get("description") or "No description provided."
                skill_lines.append(f"- {skill['id']}: {description} (file: {path})")
            sections.append(
                "# Selected skills\n"
                "The following selected skills are available on disk.\n"
                "If the current user request clearly matches one of them or explicitly names it, read that skill's `SKILL.md` from the listed file path before acting.\n"
                "When a selected skill mentions `references/`, `scripts/`, or `assets/`, resolve those paths relative to the skill directory, not the workspace.\n"
                "Do not auto-activate a skill from greetings, wake-up phrases, generic acknowledgements, or channel bootstrap prompts such as /new.\n\n"
                + "\n".join(skill_lines)
            )

        runtime_items = [
            f"Agent: {agent_profile['name']}",
            f"Mode: {'orchestrator' if is_orchestrator else 'specialist'}",
            f"Working directory: {agent_profile['workspace_binding']}",
            "Allowed local roots: " + ", ".join(str(root) for root in local_roots),
            f"Enabled specialist agents: {', '.join(profile['name'] for profile in enabled_agents if profile['id'] != agent_profile['id']) or 'none'}",
            f"Task source: {active_task.get('source_kind') or 'manual'}",
        ]
        if bootstrap_wakeup_prompt:
            runtime_items.append(
                "Bootstrap note: the current user input was generated from the channel /new command. Treat '醒醒，朋友~' as a plain wake-up greeting, not as a request to activate any mode or skill."
            )
        if is_orchestrator:
            runtime_items.append(
                "Execution rule: you own the user-facing result and should delegate only when a specialist materially improves the outcome."
            )
        else:
            runtime_items.append(
                "Execution rule: stay within your specialist scope and return concise results to the orchestrator."
            )
        runtime_items.append(
            "Tool rule: when asked to inspect files, run commands, or check the local machine, use the available tools before answering."
        )
        runtime_items.append(
            "Evidence rule: a screenshot file path or image artifact is not proof that you saw page contents. Only claim visual details when another tool returned textual page structure or content."
        )
        runtime_items.append(
            "Verification rule: build or compile success is not runtime verification. Do not say a bug is fixed, tested, or verified unless a relevant test, browser interaction, or user confirmation actually occurred."
        )
        runtime_items.append(
            "If evidence is incomplete, state exactly what was observed, what tool produced it, and what remains unverified."
        )
        runtime_items.append(
            f"Long-term memory: {'enabled' if MEMORY_ENABLED else 'disabled'}"
        )
        sections.append("# Runtime context\n" + "\n".join(f"- {item}" for item in runtime_items))

        if compressed_context:
            sections.append(compressed_context)
        if memory_context:
            sections.append("# Relevant memory\n" + "\n".join(f"- {line}" for line in memory_context.splitlines()))

        prompt_text = "\n\n".join([part for part in sections if trim_prompt_block(part)])
        prompt_parts = {
            "agent_name": agent_profile["name"],
            "description": agent_profile["description"],
            "agent_identity_prompt": agent_profile["agent_identity_prompt"],
            "agent_responsibility_prompt": agent_profile["agent_responsibility_prompt"],
            "agent_non_goals_prompt": agent_profile["agent_non_goals_prompt"],
            "selected_skills": selected_skills,
            "skill_records": skill_records,
            "skill_summaries": skill_summaries,
            "global_system_prompt": global_system_prompt,
            "compressed_context": compressed_context,
            "memory_context": memory_context,
            "memory_enabled": MEMORY_ENABLED,
            "local_roots": [str(root) for root in local_roots],
            "is_orchestrator": is_orchestrator,
            "final_system_prompt": prompt_text,
            "user_input": current_input,
        }
        return prompt_text, prompt_parts

    def auto_compress_if_needed(
        *,
        agent_profile: dict[str, Any],
        model_row: dict[str, Any],
        task_state: dict[str, Any],
        prompt_parts: dict[str, Any],
        input_text: str,
        run_id_for_log: str,
        session_id: str,
    ) -> tuple[dict[str, Any], dict[str, Any], bool]:
        _turn_input, system_prompt_for_turn, _history_summary = build_turn_input_with_sticky_system_prompt(
            system_prompt=prompt_parts["final_system_prompt"],
            user_input=input_text,
            session_id=session_id,
            session_db_path=session_db_path,
        )
        summary = context_summary_payload(
            final_system_prompt=system_prompt_for_turn,
            user_input=input_text,
            compressed_context=prompt_parts["compressed_context"],
            memory_context=prompt_parts["memory_context"],
            model_row=model_row,
            session_id=session_id,
            session_db_path=session_db_path,
        )
        context_window = int(summary.get("context_window") or 0)
        if context_window <= 0 or summary["estimated_total_tokens"] < context_window:
            return task_state, summary, False
        if not (task_state.get("timeline") or []):
            return task_state, summary, False

        compressed = build_compressed_context(task_state)
        if not compressed:
            return task_state, summary, False

        next_count = int(task_state.get("compression_count") or 0) + 1
        db.execute(
            "UPDATE task_sessions SET compressed_context = ?, compression_count = ?, updated_at = ? WHERE id = ?",
            (compressed, next_count, utcnow(), task_state["id"]),
        )
        reset_task_conversation_history(task_state)
        log_timeline(
            task_state["id"],
            "context_auto_compressed",
            "Context auto-compressed",
            run_id=run_id_for_log,
            agent_id=agent_profile["id"],
            agent_name=agent_profile["name"],
            body=compressed[:500],
            payload={
                "compression_count": next_count,
                "estimated_total_tokens": summary["estimated_total_tokens"],
                "context_window": context_window,
            },
        )
        refreshed_task = get_task(task_state["id"])
        refreshed_instructions, refreshed_prompt_parts = base_instructions(agent_profile, is_orchestrator=True, task_state=refreshed_task)
        refreshed_prompt_parts["final_system_prompt"] = refreshed_instructions
        _refreshed_turn_input, refreshed_system_prompt_for_turn, _refreshed_history = build_turn_input_with_sticky_system_prompt(
            system_prompt=refreshed_prompt_parts["final_system_prompt"],
            user_input=input_text,
            session_id=session_id,
            session_db_path=session_db_path,
        )
        refreshed_summary = context_summary_payload(
            final_system_prompt=refreshed_system_prompt_for_turn,
            user_input=input_text,
            compressed_context=refreshed_prompt_parts["compressed_context"],
            memory_context=refreshed_prompt_parts["memory_context"],
            model_row=model_row,
            session_id=session_id,
            session_db_path=session_db_path,
        )
        return refreshed_task, refreshed_summary, True

    class WorkspaceEditor:
        def __init__(self, root: Path, task_id: str, agent_id: str, agent_name: str, run_id: str) -> None:
            self.root = root.resolve()
            self.task_id = task_id
            self.agent_id = agent_id
            self.agent_name = agent_name
            self.run_id = run_id

        def _resolve(self, rel: str, ensure_parent: bool = False) -> Path:
            target = resolve_local_path(
                {
                    "workspace_binding": str(self.root),
                    "id": self.agent_id,
                    "name": self.agent_name,
                },
                rel,
            )
            if ensure_parent:
                target.parent.mkdir(parents=True, exist_ok=True)
            return target

        def create_file(self, operation: ApplyPatchOperation) -> ApplyPatchResult:
            target = self._resolve(operation.path, ensure_parent=True)
            content = apply_diff("", operation.diff or "", mode="create")
            target.write_text(content, encoding="utf-8")
            log_timeline(self.task_id, "tool_call", f"{self.agent_name} created file", body=operation.path, run_id=self.run_id, agent_id=self.agent_id, agent_name=self.agent_name, payload={"tool": "apply_patch", "type": operation.type, "path": operation.path})
            log_tool_result(self.task_id, self.run_id, {"id": self.agent_id, "name": self.agent_name}, "apply_patch", f"{self.agent_name} created file", f"Created {target}", {"type": operation.type, "path": str(target)})
            return ApplyPatchResult(output=f"Created {operation.path}")

        def update_file(self, operation: ApplyPatchOperation) -> ApplyPatchResult:
            target = self._resolve(operation.path)
            original = target.read_text(encoding="utf-8") if target.exists() else ""
            patched = apply_diff(original, operation.diff or "")
            target.write_text(patched, encoding="utf-8")
            log_timeline(self.task_id, "tool_call", f"{self.agent_name} updated file", body=operation.path, run_id=self.run_id, agent_id=self.agent_id, agent_name=self.agent_name, payload={"tool": "apply_patch", "type": operation.type, "path": operation.path})
            log_tool_result(self.task_id, self.run_id, {"id": self.agent_id, "name": self.agent_name}, "apply_patch", f"{self.agent_name} updated file", f"Updated {target}", {"type": operation.type, "path": str(target)})
            return ApplyPatchResult(output=f"Updated {operation.path}")

        def delete_file(self, operation: ApplyPatchOperation) -> ApplyPatchResult:
            target = self._resolve(operation.path)
            target.unlink(missing_ok=True)
            log_timeline(self.task_id, "tool_call", f"{self.agent_name} deleted file", body=operation.path, run_id=self.run_id, agent_id=self.agent_id, agent_name=self.agent_name, payload={"tool": "apply_patch", "type": operation.type, "path": operation.path})
            log_tool_result(self.task_id, self.run_id, {"id": self.agent_id, "name": self.agent_name}, "apply_patch", f"{self.agent_name} deleted file", f"Deleted {target}", {"type": operation.type, "path": str(target)})
            return ApplyPatchResult(output=f"Deleted {operation.path}")

    class LocalPlaywrightComputer:
        environment = "browser"

        def __init__(self, task_id: str, agent_id: str, agent_name: str, run_id: str) -> None:
            self.task_id = task_id
            self.agent_id = agent_id
            self.agent_name = agent_name
            self.run_id = run_id
            self._playwright = None
            self._browser = None
            self._page = None

        @property
        def dimensions(self) -> tuple[int, int]:
            return (1280, 800)

        async def open(self) -> "LocalPlaywrightComputer":
            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(headless=True)
            self._page = await self._browser.new_page(viewport={"width": 1280, "height": 800})
            await self._page.goto("about:blank")
            return self

        async def close(self) -> None:
            if self._browser is not None:
                await self._browser.close()
            if self._playwright is not None:
                await self._playwright.stop()

        async def screenshot(self) -> str:
            png = await self._page.screenshot(full_page=False)
            return base64.b64encode(png).decode("utf-8")

        async def click(self, x: int, y: int, button: str = "left", *, keys: list[str] | None = None) -> None:
            _ = keys
            await self._page.mouse.click(x, y, button=button)
            log_timeline(self.task_id, "tool_call", f"{self.agent_name} browser click", body=f"{x},{y}", run_id=self.run_id, agent_id=self.agent_id, agent_name=self.agent_name, payload={"tool": "computer", "action": "click", "x": x, "y": y})

        async def double_click(self, x: int, y: int, *, keys: list[str] | None = None) -> None:
            _ = keys
            await self._page.mouse.dblclick(x, y)

        async def scroll(self, x: int, y: int, scroll_x: int, scroll_y: int, *, keys: list[str] | None = None) -> None:
            _ = (x, y, keys)
            await self._page.evaluate(f"window.scrollBy({scroll_x}, {scroll_y})")

        async def type(self, text: str) -> None:
            await self._page.keyboard.type(text)

        async def wait(self) -> None:
            await asyncio.sleep(1)

        async def move(self, x: int, y: int, *, keys: list[str] | None = None) -> None:
            _ = keys
            await self._page.mouse.move(x, y)

        async def keypress(self, keys: list[str]) -> None:
            for key in keys:
                await self._page.keyboard.press(key)

        async def drag(self, path: list[tuple[int, int]], *, keys: list[str] | None = None) -> None:
            _ = keys
            if not path:
                return
            await self._page.mouse.move(*path[0])
            await self._page.mouse.down()
            for point in path[1:]:
                await self._page.mouse.move(*point)
            await self._page.mouse.up()

    def build_host_tools(agent_profile: dict[str, Any], run_id: str, *, hosted_tools_supported: bool):
        workspace = Path(agent_profile["workspace_binding"]).expanduser().resolve()
        tool_profile = agent_profile["tool_profile"]
        tools: list[Any] = []
        shell_skills: list[ShellToolLocalSkill] = []
        for skill in selected_skill_records(agent_profile.get("selected_skills", []), limit=12):
            skill_path = Path(skill.get("path") or "").expanduser().resolve()
            if not skill_path.exists():
                continue
            shell_skills.append(
                {
                    "name": skill["id"],
                    "description": skill.get("description") or "No description provided.",
                    "path": str(skill_path.parent),
                }
            )

        async def shell_executor(request: ShellCommandRequest) -> str:
            outputs = []
            for command in request.data.action.commands:
                log_timeline(task["id"], "tool_call", f"{agent_profile['name']} shell", body=command, run_id=run_id, agent_id=agent_profile["id"], agent_name=agent_profile["name"], payload={"tool": "shell", "command": command})
                completed = subprocess.run(
                    command,
                    cwd=str(workspace),
                    shell=True,
                    capture_output=True,
                    text=True,
                    timeout=(request.data.action.timeout_ms or 30_000) / 1000,
                )
                chunk = "\n".join(part for part in [completed.stdout.strip(), completed.stderr.strip()] if part).strip()
                result_text = chunk or f"Command exited with {completed.returncode}"
                log_tool_result(task["id"], run_id, agent_profile, "shell", f"{agent_profile['name']} shell result", result_text, {"command": command, "returncode": completed.returncode})
                outputs.append(result_text)
            return "\n\n".join(outputs)

        async def shell_needs_approval(ctx: Any, action: ShellActionRequest, call_id: str) -> bool:
            _ = (ctx, call_id)
            return any(risk_from_command(command) for command in action.commands)

        if hosted_tools_supported and tool_profile.get("shell", True):
            shell_environment: dict[str, Any] = {"type": "local"}
            if shell_skills:
                shell_environment["skills"] = shell_skills
            tools.append(
                ShellTool(
                    executor=shell_executor,
                    needs_approval=shell_needs_approval,
                    environment=shell_environment,
                )
            )

        if hosted_tools_supported and tool_profile.get("filesystem", True):
            editor = WorkspaceEditor(workspace, task["id"], agent_profile["id"], agent_profile["name"], run_id)

            async def patch_needs_approval(ctx: Any, operation: Any, call_id: str) -> bool:
                _ = (ctx, call_id)
                return operation.type == "delete_file"

            tools.append(ApplyPatchTool(editor=editor, needs_approval=patch_needs_approval))

        if tool_profile.get("browser", False):
            browser_session = f"task-{task['id'][:8]}-{run_id[:8]}"

            def run_agent_browser_cli(args: list[str], *, parse_json: bool = False) -> tuple[str, Any | None]:
                command = ["agent-browser", "--session", browser_session, *args]
                completed = subprocess.run(
                    command,
                    cwd=str(workspace),
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                stdout = completed.stdout.strip()
                stderr = completed.stderr.strip()
                if completed.returncode != 0:
                    raise RuntimeError(stderr or stdout or f"agent-browser exited with {completed.returncode}")
                payload = None
                if parse_json and stdout:
                    payload = json.loads(stdout)
                    if isinstance(payload, dict) and payload.get("success") is False:
                        raise RuntimeError(str(payload.get("error") or "agent-browser command failed"))
                return stdout or stderr or "(no output)", payload

            @function_tool
            async def agent_browser(command: str) -> str:
                """Run an existing agent-browser CLI command to navigate or inspect a web page. Pass only the subcommand and arguments, for example: `open https://example.com`, `snapshot -i`, `click @e1`, `fill @e2 \"hello\"`, `get title`, `wait 1000`."""

                trimmed = command.strip()
                if not trimmed:
                    raise RuntimeError("agent-browser command is required.")

                args = shlex.split(trimmed)
                command_name = args[0]
                wants_json = command_name in {"open", "get", "snapshot", "screenshot", "eval", "find", "console", "errors"} and "--json" not in args
                final_args = [*args, "--json"] if wants_json else args
                log_timeline(task["id"], "tool_call", f"{agent_profile['name']} agent-browser", body=trimmed, run_id=run_id, agent_id=agent_profile["id"], agent_name=agent_profile["name"], payload={"tool": "agent-browser", "command": trimmed, "session": browser_session})
                raw_output, parsed = run_agent_browser_cli(final_args, parse_json=wants_json or "--json" in args)

                payload: dict[str, Any] = {"command": trimmed, "session": browser_session}
                body = raw_output
                if isinstance(parsed, dict):
                    data = parsed.get("data")
                    if command_name == "open" and isinstance(data, dict):
                        title = str(data.get("title") or "(untitled)")
                        url = str(data.get("url") or "")
                        body = f"Opened {url or '(unknown url)'}\nTitle: {title}"
                        payload.update({"page_title": title, "page_url": url})
                    elif command_name == "get" and isinstance(data, dict):
                        body = json_dumps(data)
                        payload["result"] = data
                    elif command_name == "snapshot" and data is not None:
                        body = json_dumps(data)
                        payload["result"] = data

                log_tool_result(task["id"], run_id, agent_profile, "agent-browser", f"{agent_profile['name']} agent-browser", body, payload)
                return body

            @function_tool
            async def agent_browser_screenshot(label: str = "Browser screenshot", full_page: bool = False, annotate: bool = False) -> str:
                """Capture a screenshot using the existing agent-browser CLI and attach it to the timeline."""

                args = ["screenshot"]
                if full_page:
                    args.append("--full")
                if annotate:
                    args.append("--annotate")
                args.append("--json")
                log_timeline(task["id"], "tool_call", f"{agent_profile['name']} agent-browser screenshot", body=label, run_id=run_id, agent_id=agent_profile["id"], agent_name=agent_profile["name"], payload={"tool": "agent-browser", "action": "screenshot", "label": label, "full_page": full_page, "annotate": annotate, "session": browser_session})
                _raw_output, parsed = run_agent_browser_cli(args, parse_json=True)
                data = parsed.get("data") if isinstance(parsed, dict) else None
                image_path = Path(str((data or {}).get("path") or "")).expanduser()
                if not image_path.exists():
                    raise RuntimeError("agent-browser screenshot did not produce a file.")
                image_bytes = image_path.read_bytes()
                mime_type = mimetypes.guess_type(image_path.name)[0] or "image/png"
                image_url = f"data:{mime_type};base64,{base64.b64encode(image_bytes).decode('utf-8')}"
                inspection = inspect_screenshot_artifact(image_path)
                body = f"{label}\nSaved to: {image_path}\n\n{screenshot_semantic_notice()}"
                log_tool_result(
                    task["id"],
                    run_id,
                    agent_profile,
                    "agent-browser",
                    f"{agent_profile['name']} agent-browser screenshot",
                    body,
                    {
                        "action": "screenshot",
                        "label": label,
                        "full_page": full_page,
                        "annotate": annotate,
                        "session": browser_session,
                        "image_path": str(image_path),
                        "image_url": image_url,
                        "inspection": inspection,
                        "semantic_visual_evidence": False,
                    },
                )
                return body

            tools.extend([agent_browser, agent_browser_screenshot])

            if hosted_tools_supported and import_available("playwright"):
                async def create_computer(*, run_context: Any) -> LocalPlaywrightComputer:
                    _ = run_context
                    return await LocalPlaywrightComputer(task["id"], agent_profile["id"], agent_profile["name"], run_id).open()

                async def dispose_computer(*, run_context: Any, computer: LocalPlaywrightComputer) -> None:
                    _ = run_context
                    await computer.close()

                tools.append(ComputerTool(computer=ComputerProvider(create=create_computer, dispose=dispose_computer)))

        if not hosted_tools_supported:
            @function_tool
            async def list_local_files(path: str = ".") -> str:
                """List local files and folders under an absolute path or a path relative to the workspace."""

                target = resolve_local_path(agent_profile, path)
                log_timeline(task["id"], "tool_call", f"{agent_profile['name']} listed files", body=str(target), run_id=run_id, agent_id=agent_profile["id"], agent_name=agent_profile["name"], payload={"tool": "list_local_files", "path": str(target)})
                if not target.exists():
                    result_text = f"Path does not exist: {target}"
                elif target.is_file():
                    result_text = f"{target.name}\tFILE\t{target.stat().st_size} bytes"
                else:
                    rows = []
                    for child in sorted(target.iterdir(), key=lambda item: (item.is_file(), item.name.lower()))[:200]:
                        kind = "DIR" if child.is_dir() else "FILE"
                        rows.append(f"{child.name}\t{kind}\t{child.stat().st_size if child.exists() and child.is_file() else '-'}")
                    result_text = "\n".join(rows) or "(empty directory)"
                log_tool_result(task["id"], run_id, agent_profile, "list_local_files", f"{agent_profile['name']} listed files", result_text, {"path": str(target)})
                return result_text

            @function_tool
            async def read_local_file(path: str, start_line: int = 1, end_line: int = 200) -> str:
                """Read a local text file under an absolute path or a path relative to the workspace."""

                target = resolve_local_path(agent_profile, path)
                log_timeline(task["id"], "tool_call", f"{agent_profile['name']} read file", body=str(target), run_id=run_id, agent_id=agent_profile["id"], agent_name=agent_profile["name"], payload={"tool": "read_local_file", "path": str(target), "start_line": start_line, "end_line": end_line})
                if not target.exists():
                    raise RuntimeError(f"File does not exist: {target}")
                lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
                start = max(1, start_line)
                end = max(start, end_line)
                snippet = "\n".join(f"{index + 1}: {line}" for index, line in enumerate(lines[start - 1 : end], start=start - 1))
                result_text = snippet or "(empty file)"
                log_tool_result(task["id"], run_id, agent_profile, "read_local_file", f"{agent_profile['name']} read file", result_text, {"path": str(target), "start_line": start, "end_line": end})
                return result_text

            @function_tool
            async def write_local_file(path: str, content: str) -> str:
                """Write a local text file under an absolute path or a path relative to the workspace."""

                target = resolve_local_path(agent_profile, path)
                log_timeline(task["id"], "tool_call", f"{agent_profile['name']} wrote file", body=str(target), run_id=run_id, agent_id=agent_profile["id"], agent_name=agent_profile["name"], payload={"tool": "write_local_file", "path": str(target)})
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
                result_text = f"Wrote {len(content)} characters to {target}"
                log_tool_result(task["id"], run_id, agent_profile, "write_local_file", f"{agent_profile['name']} wrote file", result_text, {"path": str(target), "chars": len(content)})
                return result_text

            @function_tool
            async def run_local_command(command: str, timeout_seconds: int = 30) -> str:
                """Run a local shell command on the host machine. Prefer read-only commands for inspection tasks."""

                risk = risk_from_command(command)
                log_timeline(task["id"], "tool_call", f"{agent_profile['name']} local command", body=command, run_id=run_id, agent_id=agent_profile["id"], agent_name=agent_profile["name"], payload={"tool": "run_local_command", "command": command})
                if risk:
                    result_text = f"Blocked risky command: {risk}"
                    log_tool_result(task["id"], run_id, agent_profile, "run_local_command", f"{agent_profile['name']} local command blocked", result_text, {"command": command, "blocked": True})
                    return result_text
                completed = subprocess.run(
                    command,
                    cwd=str(workspace),
                    shell=True,
                    capture_output=True,
                    text=True,
                    timeout=max(1, timeout_seconds),
                )
                result_text = "\n".join(part for part in [completed.stdout.strip(), completed.stderr.strip()] if part).strip() or f"Command exited with {completed.returncode}"
                log_tool_result(task["id"], run_id, agent_profile, "run_local_command", f"{agent_profile['name']} local command result", result_text, {"command": command, "returncode": completed.returncode})
                return result_text

            tools.extend([list_local_files, read_local_file, write_local_file, run_local_command])

        return tools

    def child_tool_for(agent_profile: dict[str, Any]):
        tool_name = re.sub(r"[^a-zA-Z0-9_]+", "_", agent_profile["name"].lower()).strip("_") or f"agent_{agent_profile['id'][:8]}"

        @function_tool(name_override=tool_name)
        async def invoke_specialist(input: str) -> str:
            """Delegate a bounded specialist subtask to this agent."""

            child_run_id = create_run(task["id"], agent_profile["id"], agent_profile["name"], role="specialist", model=agent_profile["default_model"])
            log_timeline(task["id"], "agent_call", f"Delegated to {agent_profile['name']}", body=input, run_id=child_run_id, agent_id=agent_profile["id"], agent_name=agent_profile["name"])
            child_provider, child_model_key, _, child_model_row = resolve_model_provider(agent_profile)
            child_instructions, child_prompt_parts = base_instructions(agent_profile, is_orchestrator=False)
            child_session_id = f"task:{task['id']}:agent:{agent_profile['id']}"
            child_session = SQLiteSession(child_session_id, db_path=session_db_path)
            child_runner_input, child_system_prompt_for_turn, child_history_summary = build_turn_input_with_sticky_system_prompt(
                system_prompt=child_prompt_parts["final_system_prompt"],
                user_input=input,
                session_id=child_session_id,
                session_db_path=session_db_path,
            )
            child_prompt_payload = {
                **child_prompt_parts,
                "context_summary": context_summary_payload(
                    final_system_prompt=child_system_prompt_for_turn,
                    user_input=input,
                    compressed_context=child_prompt_parts["compressed_context"],
                    memory_context=child_prompt_parts["memory_context"],
                    model_row=child_model_row,
                    session_id=child_session_id,
                    session_db_path=session_db_path,
                ),
                "model_input": child_runner_input,
                "input_transport": "items" if isinstance(child_runner_input, list) else "text",
            }
            log_timeline(
                task["id"],
                "prompt_snapshot",
                f"Prompt sent to {agent_profile['name']}",
                body="Exact model payload for this turn.",
                run_id=child_run_id,
                agent_id=agent_profile["id"],
                agent_name=agent_profile["name"],
                payload=child_prompt_payload,
            )
            child_agent = Agent(
                name=agent_profile["name"],
                model=child_model_key,
                instructions="",
                tools=[],
                model_settings=ModelSettings(parallel_tool_calls=False),
            )
            result = await Runner.run(child_agent, child_runner_input, session=child_session, run_config=RunConfig(model_provider=child_provider))
            complete_run(child_run_id, "completed", str(result.final_output))
            log_tool_result(task["id"], run_id, agent_profile, "specialist", f"{agent_profile['name']} specialist result", str(result.final_output), {"delegated_by_run_id": run_id})
            if MEMORY_ENABLED:
                provider = memory_service.provider_for(agent_profile["memory_policy"])
                provider.store_episode(agent_profile["memory_policy"].get("scope") or agent_profile["id"], str(result.final_output), {"task_id": task["id"], "agent_id": agent_profile["id"], "source": "specialist"})
            return str(result.final_output)

        invoke_specialist.description = agent_profile["description"] or f"Specialist agent {agent_profile['name']}"
        return invoke_specialist

    orchestrator_provider, orchestrator_model_key, hosted_tools_supported, orchestrator_model_row = resolve_model_provider(entry_agent)
    tools = build_host_tools(entry_agent, run_id, hosted_tools_supported=hosted_tools_supported)
    specialist_tools = [child_tool_for(profile) for profile in enabled_agents if profile["id"] != entry_agent["id"]]
    participating_agents.extend([profile["name"] for profile in enabled_agents if profile["id"] != entry_agent["id"]])
    orchestrator_instructions, prompt_parts = base_instructions(entry_agent, is_orchestrator=True)
    task, _, auto_compressed = auto_compress_if_needed(
        agent_profile=entry_agent,
        model_row=orchestrator_model_row,
        task_state=task,
        prompt_parts=prompt_parts,
        input_text=current_input,
        run_id_for_log=run_id,
        session_id=f"task:{task['id']}:orchestrator",
    )
    if auto_compressed:
        orchestrator_instructions, prompt_parts = base_instructions(entry_agent, is_orchestrator=True, task_state=task)
    orchestrator_runner_input, orchestrator_system_prompt_for_turn, orchestrator_history_summary = build_turn_input_with_sticky_system_prompt(
        system_prompt=prompt_parts["final_system_prompt"],
        user_input=current_input,
        session_id=orchestrator_session_id,
        session_db_path=session_db_path,
    )
    orchestrator = Agent(
        name=entry_agent["name"],
        model=orchestrator_model_key,
        instructions="",
        tools=[*tools, *specialist_tools],
        model_settings=ModelSettings(parallel_tool_calls=False),
    )
    prompt_payload = {
        **prompt_parts,
        "context_summary": context_summary_payload(
            final_system_prompt=orchestrator_system_prompt_for_turn,
            user_input=current_input,
            compressed_context=prompt_parts["compressed_context"],
            memory_context=prompt_parts["memory_context"],
            model_row=orchestrator_model_row,
            session_id=orchestrator_session_id,
            session_db_path=session_db_path,
        ),
        "model_input": orchestrator_runner_input,
        "input_transport": "items" if isinstance(orchestrator_runner_input, list) else "text",
    }
    prompt_payload["final_system_prompt"] = orchestrator_system_prompt_for_turn
    return orchestrator, orchestrator_session, participating_agents, RunConfig(model_provider=orchestrator_provider), prompt_payload, orchestrator_runner_input, orchestrator_history_summary


async def run_task_execution(task_id: str, *, resume_run_id: str | None = None, input_text: str | None = None) -> None:
    task = get_task(task_id)
    current_input = input_text or task["prompt"]
    update_task_status(task_id, status="running", active_agent_id=task["entry_agent_id"], active_agent_name=task["entry_agent_name"], participating_agents=task["participating_agents"])
    try:
        from agents import Runner
    except Exception:
        update_task_status(task_id, status="failed", last_error="Unable to import openai-agents.")
        log_timeline(task_id, "task_failed", "Task failed", body="Unable to import openai-agents.")
        return

    current_session = None
    current_starting_agent = None
    current_run_config = None
    run_id: str | None = None
    prompt_payload: dict[str, Any] = {}

    try:
        if resume_run_id:
            pending = PENDING_RUNS.get(resume_run_id)
            if not pending:
                raise RuntimeError(f"No pending RunState in memory for run: {resume_run_id}")
            decisions = db.fetchall("SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at ASC", (resume_run_id,))
            decision_by_call = {item["call_id"]: item for item in decisions}
            for interruption in pending.state.get_interruptions():
                decision = decision_by_call.get(interruption.call_id or "")
                if not decision or decision["status"] == "pending":
                    raise RuntimeError("All approvals must be resolved before resuming.")
                if decision["status"] == "approved":
                    pending.state.approve(interruption)
                else:
                    pending.state.reject(interruption, rejection_message=decision["reason"] or "Rejected from dashboard")

            log_timeline(task_id, "run_resumed", "Run resumed from approval state", run_id=resume_run_id)
            current_session = pending.session
            current_starting_agent = pending.starting_agent
            current_run_config = pending.run_config
            result = await Runner.run(
                pending.starting_agent,
                pending.state,
                session=pending.session,
                run_config=pending.run_config,
                max_turns=int(task.get("max_turns") or DEFAULT_TASK_MAX_TURNS),
            )
            run_id = resume_run_id
        else:
            entry_agent = get_agent(task["entry_agent_id"])
            run_id = create_run(task["id"], entry_agent["id"], entry_agent["name"], role="orchestrator", model=entry_agent["default_model"])
            orchestrator, session, participating_agents, run_config, prompt_payload, runner_input, history_summary = await build_agents_runtime(task, run_id, current_input)
            current_session = session
            current_starting_agent = orchestrator
            current_run_config = run_config
            update_task_status(task_id, status="running", active_agent_id=task["entry_agent_id"], active_agent_name=task["entry_agent_name"], participating_agents=participating_agents, last_run_id=run_id)
            log_timeline(task_id, "run_started", f"Orchestrator started: {task['entry_agent_name']}", run_id=run_id, agent_id=task["entry_agent_id"], agent_name=task["entry_agent_name"])
            log_timeline(
                task_id,
                "prompt_snapshot",
                f"Prompt sent to {task['entry_agent_name']}",
                run_id=run_id,
                agent_id=task["entry_agent_id"],
                agent_name=task["entry_agent_name"],
                body="Exact model payload for this turn.",
                payload=prompt_payload,
            )
            result = await Runner.run(
                orchestrator,
                runner_input,
                session=session,
                run_config=run_config,
                max_turns=int(task.get("max_turns") or DEFAULT_TASK_MAX_TURNS),
            )

        if result.interruptions:
            complete_run(run_id, "waiting_approval", str(result.final_output or ""), {"context_summary": prompt_payload.get("context_summary", {}) if not resume_run_id else {}})
            state = result.to_state()
            PENDING_RUNS[run_id] = PendingRunBundle(task_id, run_id, current_starting_agent, state, current_session, current_run_config)
            update_task_status(task_id, status="waiting_approval", last_run_id=run_id)
            db.execute("DELETE FROM approvals WHERE run_id = ?", (run_id,))
            for interruption in result.interruptions:
                approval_id = str(uuid.uuid4())
                db.execute(
                    """
                    INSERT INTO approvals(id, task_session_id, run_id, call_id, tool_name, title, body, status, reason, created_at, updated_at)
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        approval_id,
                        task_id,
                        run_id,
                        interruption.call_id or approval_id,
                        getattr(interruption, "tool_name", "") or "tool",
                        getattr(interruption, "title", "") or "Approval required",
                        getattr(interruption, "body", "") or "",
                        "pending",
                        "",
                        utcnow(),
                        utcnow(),
                    ),
                )
            log_timeline(task_id, "approval_requested", "Run paused for approval", run_id=run_id, body=f"{len(result.interruptions)} approval(s) pending")
            queue_task_channel_push(task, stage="approval", text=f"任务需要审批后才能继续，共有 {len(result.interruptions)} 个待审批动作。")
            return

        raw_final_output = str(result.final_output)
        final_output, audit_payload = audit_final_output(task_id, run_id, raw_final_output)
        if audit_payload.get("findings"):
            log_timeline(
                task_id,
                "response_audit_flagged",
                "Final response audit flagged unsupported claims",
                run_id=run_id,
                agent_id=task["entry_agent_id"],
                agent_name=task["entry_agent_name"],
                body="\n".join(audit_payload["findings"])[:500],
                payload={
                    "audit": audit_payload,
                    "raw_final_output_preview": raw_final_output[:500],
                },
            )
        PENDING_RUNS.pop(run_id, None)
        run_metadata = {"response_audit": audit_payload}
        if not resume_run_id:
            run_metadata["context_summary"] = prompt_payload.get("context_summary", {})
        complete_run(run_id, "completed", final_output, run_metadata)
        entry_agent = get_agent(task["entry_agent_id"])
        if MEMORY_ENABLED:
            provider = memory_service.provider_for(entry_agent["memory_policy"])
            provider.store_episode(
                entry_agent["memory_policy"].get("scope") or entry_agent["id"],
                final_output,
                {"task_id": task_id, "agent_id": entry_agent["id"], "source": "orchestrator"},
            )
        db.execute("DELETE FROM approvals WHERE run_id = ?", (run_id,))
        update_task_status(task_id, status="completed", last_run_id=run_id, last_error="")
        log_timeline(task_id, "task_completed", "Task completed", run_id=run_id, agent_id=entry_agent["id"], agent_name=entry_agent["name"], body=final_output[:400])
        queue_task_channel_push(task, stage="final", text=final_output or "任务已完成。")
    except asyncio.CancelledError:
        message = "Task execution was cancelled."
        run_id = run_id or resume_run_id or task.get("last_run_id")
        if run_id:
            PENDING_RUNS.pop(run_id, None)
            complete_run(run_id, "cancelled", message, {"cancelled": True})
        db.execute("DELETE FROM approvals WHERE task_session_id = ?", (task_id,))
        update_task_status(task_id, status="cancelled", last_run_id=run_id, last_error="")
        log_timeline(task_id, "task_cancelled", "Task cancelled", run_id=run_id, body=message)
        queue_task_channel_push(task, stage="error", text="任务已终止。")
        raise
    except Exception as exc:
        message = str(exc)
        run_id = run_id or resume_run_id or task.get("last_run_id")
        if run_id:
            PENDING_RUNS.pop(run_id, None)
        if run_id:
            complete_run(run_id, "failed", message, {"error": message})
        update_task_status(task_id, status="failed", last_run_id=run_id, last_error=message)
        log_timeline(task_id, "task_failed", "Task failed", run_id=run_id, body=message)
        queue_task_channel_push(task, stage="error", text=f"任务执行失败：{message}")


app = FastAPI(title="ZDCode Runtime", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

if DASHBOARD_DIR.exists():
    app.mount("/dashboard", StaticFiles(directory=str(DASHBOARD_DIR), html=True), name="dashboard")


@app.get("/")
async def root() -> RedirectResponse:
    return RedirectResponse(url="/dashboard/")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "status": "ok",
        "version": "0.1.0",
        "runtime": provider_status(),
        "database": {
            "path": str(DB_PATH),
            "exists": DB_PATH.exists(),
        },
    }


@app.get("/models")
async def models_index() -> list[dict[str, Any]]:
    return list_models()


@app.post("/models")
async def models_create(payload: ModelWritePayload) -> dict[str, Any]:
    return create_model(payload)


@app.get("/settings")
async def settings_show() -> dict[str, Any]:
    return current_settings()


@app.patch("/settings")
async def settings_update(payload: AppSettingsPayload) -> dict[str, Any]:
    set_setting("global_system_prompt", payload.global_system_prompt or "")
    return current_settings()


@app.get("/skills")
async def skills_index() -> list[dict[str, Any]]:
    return list_skills()


@app.get("/channel-connections")
async def channel_connections_index() -> list[dict[str, Any]]:
    return list_channel_connections()


@app.post("/channel-connections")
async def channel_connections_create(payload: ChannelConnectionCreatePayload) -> dict[str, Any]:
    return create_channel_connection(payload)


@app.get("/channel-connections/{connection_id}")
async def channel_connections_show(connection_id: str) -> dict[str, Any]:
    return get_channel_connection(connection_id)


@app.patch("/channel-connections/{connection_id}")
async def channel_connections_patch(connection_id: str, payload: ChannelConnectionPatchPayload) -> dict[str, Any]:
    return patch_channel_connection(connection_id, payload)


@app.get("/models/{model_key:path}")
async def models_show(model_key: str) -> dict[str, Any]:
    return get_model(model_key)


@app.patch("/models/{model_key:path}")
async def models_patch(model_key: str, payload: ModelPatchPayload) -> dict[str, Any]:
    return patch_model(model_key, payload)


@app.post("/models/sync")
async def models_sync() -> dict[str, Any]:
    return sync_models_from_openclaw()


@app.post("/models/default")
async def models_set_default(payload: ModelDefaultPayload) -> dict[str, Any]:
    get_model(payload.model_key)
    set_setting("default_model", payload.model_key)
    return {
        "ok": True,
        "default_model": configured_default_model(),
    }


@app.get("/agents")
async def agents_index() -> list[dict[str, Any]]:
    return list_agents()


@app.post("/agents")
async def agents_create(payload: AgentCreatePayload) -> dict[str, Any]:
    return create_agent(payload)


@app.get("/agents/{agent_id}")
async def agents_show(agent_id: str) -> dict[str, Any]:
    return get_agent(agent_id)


@app.patch("/agents/{agent_id}")
async def agents_update(agent_id: str, payload: AgentPatchPayload) -> dict[str, Any]:
    return patch_agent(agent_id, payload)


@app.delete("/agents/{agent_id}")
async def agents_delete(agent_id: str) -> dict[str, Any]:
    return delete_agent(agent_id)


@app.get("/tasks")
async def tasks_index() -> list[dict[str, Any]]:
    return [normalize_task(item) for item in db.fetchall("SELECT * FROM task_sessions ORDER BY created_at DESC")]


@app.post("/tasks")
async def tasks_create(payload: TaskCreatePayload) -> dict[str, Any]:
    task = create_task(payload)
    schedule_task_execution(task["id"])
    return task


@app.post("/tasks/{task_id}/messages")
async def tasks_message(task_id: str, payload: TaskMessagePayload) -> dict[str, Any]:
    task = get_task(task_id)
    if task["status"] == "running":
        raise HTTPException(status_code=409, detail="Task is currently running.")
    if task["status"] == "waiting_approval":
        raise HTTPException(status_code=409, detail="Task is waiting for approval.")

    prompt = payload.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is required.")

    db.execute(
        "UPDATE task_sessions SET updated_at = ? WHERE id = ?",
        (utcnow(), task_id),
    )
    log_timeline(task_id, "user_message", "User follow-up", body=prompt)
    schedule_task_execution(task_id, input_text=prompt)
    return get_task(task_id)


@app.post("/tasks/{task_id}/cancel")
async def tasks_cancel(task_id: str) -> dict[str, Any]:
    task = get_task(task_id)
    if task["status"] == "waiting_approval":
        run_id = task.get("last_run_id")
        if run_id:
            PENDING_RUNS.pop(run_id, None)
            complete_run(run_id, "cancelled", "Task cancelled while waiting for approval.", {"cancelled": True})
        db.execute("DELETE FROM approvals WHERE task_session_id = ?", (task_id,))
        update_task_status(task_id, status="cancelled", last_error="")
        log_timeline(task_id, "task_cancelled", "Task cancelled", run_id=run_id, body="Cancelled while waiting for approval.")
        return get_task(task_id)
    if task["status"] != "running":
        raise HTTPException(status_code=409, detail="Only running or approval-waiting tasks can be cancelled.")
    execution = RUNNING_EXECUTIONS.get(task_id)
    if not execution:
        raise HTTPException(status_code=409, detail="No running execution found for this task.")
    execution.cancel()
    return {"ok": True, "task_id": task_id, "status": "cancelling"}


@app.post("/tasks/{task_id}/compress-context")
async def tasks_compress_context(task_id: str) -> dict[str, Any]:
    task = get_task(task_id)
    if task["status"] in {"running", "waiting_approval"}:
        raise HTTPException(status_code=409, detail="Task must be idle before compressing context.")
    compressed = build_compressed_context(task)
    if not compressed:
        raise HTTPException(status_code=400, detail="No task context is available to compress.")
    db.execute(
        "UPDATE task_sessions SET compressed_context = ?, compression_count = ?, updated_at = ? WHERE id = ?",
        (compressed, int(task.get("compression_count") or 0) + 1, utcnow(), task_id),
    )
    reset_task_conversation_history(task)
    log_timeline(task_id, "context_compressed", "Context compressed", body=compressed[:500], payload={"compression_count": int(task.get("compression_count") or 0) + 1})
    return get_task(task_id)


@app.delete("/tasks/{task_id}")
async def tasks_delete(task_id: str) -> dict[str, Any]:
    return delete_task(task_id)


CHANNEL_NEW_TASK_PROMPT = "醒醒，朋友~"


def parse_channel_new_task(text: str) -> tuple[bool, str]:
    stripped = text.strip()
    if not stripped:
        return False, ""
    lowered = stripped.lower()
    if lowered == "/new":
        return True, CHANNEL_NEW_TASK_PROMPT
    if lowered.startswith("/new "):
        return True, stripped[5:].strip()
    return False, stripped


@app.post("/channels/messages")
async def channels_message(payload: ChannelInboundPayload) -> dict[str, Any]:
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required.")

    duplicate = db.fetchone(
        "SELECT id, task_session_id FROM channel_messages WHERE provider = ? AND connection_id = ? AND message_id = ? AND direction = 'inbound'",
        (payload.provider, payload.connection_id, payload.message_id),
    )
    if duplicate:
        bound_task = get_task(duplicate["task_session_id"]) if duplicate.get("task_session_id") else None
        return {
            "ok": True,
            "duplicate": True,
            "action": "ignored",
            "task_id": duplicate.get("task_session_id"),
            "task": bound_task,
        }

    force_new, normalized_prompt = parse_channel_new_task(text)

    conversation = get_channel_conversation(payload.provider, payload.connection_id, payload.conversation_id)
    binding = resolve_channel_binding(payload.provider, payload.connection_id, payload.conversation_id)

    entry_agent_id = payload.entry_agent_id or (conversation.get("current_agent_id") if conversation else None) or (binding.get("agent_id") if binding else None)
    entry_agent = get_agent(entry_agent_id) if entry_agent_id else default_entry_agent()

    configured_enabled = payload.enabled_agent_ids or (conversation.get("enabled_agent_ids", []) if conversation else []) or (binding.get("enabled_agent_ids", []) if binding else [])
    enabled_agent_ids = list(dict.fromkeys(configured_enabled))
    if not enabled_agent_ids:
        enabled_agent_ids = [entry_agent["id"]]
    if entry_agent["id"] not in enabled_agent_ids:
        enabled_agent_ids.insert(0, entry_agent["id"])
    max_turns = max(
        1,
        int(
            payload.max_turns
            or (conversation.get("max_turns") if conversation else None)
            or (binding.get("max_turns") if binding else None)
            or DEFAULT_TASK_MAX_TURNS
        ),
    )

    current_task = get_task(conversation["current_task_id"]) if conversation and conversation.get("current_task_id") else None
    if current_task and current_task["status"] in {"running", "waiting_approval"} and not force_new:
        record_channel_message(
            provider=payload.provider,
            connection_id=payload.connection_id,
            conversation_id=payload.conversation_id,
            message_id=payload.message_id,
            sender_id=payload.sender_id,
            task_session_id=current_task["id"],
            direction="inbound",
            text=text,
            raw_payload=payload.raw,
        )
        return {
            "ok": False,
            "duplicate": False,
            "action": "busy",
            "task_id": current_task["id"],
            "status": current_task["status"],
        }

    if force_new or not current_task:
        task = create_task(
            TaskCreatePayload(
                title=normalized_prompt[:48] or f"{payload.provider}:{payload.conversation_id}",
                prompt=normalized_prompt,
                entry_agent_id=entry_agent["id"],
                enabled_agent_ids=enabled_agent_ids,
                max_turns=max_turns,
                source_kind="channel",
                source_provider=payload.provider,
                source_connection_id=payload.connection_id,
                source_conversation_id=payload.conversation_id,
            )
        )
        record_channel_message(
            provider=payload.provider,
            connection_id=payload.connection_id,
            conversation_id=payload.conversation_id,
            message_id=payload.message_id,
            sender_id=payload.sender_id,
            task_session_id=task["id"],
            direction="inbound",
            text=text,
            raw_payload=payload.raw,
        )
        upsert_channel_conversation(
            provider=payload.provider,
            connection_id=payload.connection_id,
            conversation_id=payload.conversation_id,
            current_task_id=task["id"],
            current_agent_id=entry_agent["id"],
            enabled_agent_ids=enabled_agent_ids,
            max_turns=max_turns,
        )
        log_timeline(task["id"], "channel_message", f"{payload.provider} message received", body=text, payload={"conversation_id": payload.conversation_id, "message_id": payload.message_id, "force_new": force_new})
        schedule_task_execution(task["id"])
        return {
            "ok": True,
            "duplicate": False,
            "action": "created",
            "task_id": task["id"],
            "task": get_task(task["id"]),
        }

    db.execute("UPDATE task_sessions SET updated_at = ? WHERE id = ?", (utcnow(), current_task["id"]))
    log_timeline(
        current_task["id"],
        "channel_message",
        f"{payload.provider} follow-up",
        body=normalized_prompt,
        payload={"conversation_id": payload.conversation_id, "message_id": payload.message_id, "force_new": False},
    )
    record_channel_message(
        provider=payload.provider,
        connection_id=payload.connection_id,
        conversation_id=payload.conversation_id,
        message_id=payload.message_id,
        sender_id=payload.sender_id,
        task_session_id=current_task["id"],
        direction="inbound",
        text=text,
        raw_payload=payload.raw,
    )
    upsert_channel_conversation(
        provider=payload.provider,
        connection_id=payload.connection_id,
        conversation_id=payload.conversation_id,
        current_task_id=current_task["id"],
        current_agent_id=entry_agent["id"],
        enabled_agent_ids=enabled_agent_ids,
        max_turns=max_turns,
    )
    schedule_task_execution(current_task["id"], input_text=normalized_prompt)
    return {
        "ok": True,
        "duplicate": False,
        "action": "reused",
        "task_id": current_task["id"],
        "task": get_task(current_task["id"]),
    }


@app.get("/tasks/{task_id}")
async def tasks_show(task_id: str) -> dict[str, Any]:
    return get_task(task_id)


@app.get("/sessions")
async def sessions_index() -> list[dict[str, Any]]:
    return [normalize_task(item) for item in db.fetchall("SELECT * FROM task_sessions ORDER BY created_at DESC")]


@app.get("/sessions/{session_id}")
async def sessions_show(session_id: str) -> dict[str, Any]:
    return get_task(session_id)


@app.get("/approvals")
async def approvals_index(run_id: str | None = Query(default=None)) -> list[dict[str, Any]]:
    if run_id:
        return db.fetchall("SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at ASC", (run_id,))
    return db.fetchall("SELECT * FROM approvals ORDER BY created_at DESC")


@app.get("/channel-bindings")
async def channel_bindings_index() -> list[dict[str, Any]]:
    return list_channel_bindings()


@app.post("/channel-bindings")
async def channel_bindings_create(payload: ChannelBindingCreatePayload) -> dict[str, Any]:
    return create_channel_binding(payload)


@app.patch("/channel-bindings/{binding_id}")
async def channel_bindings_patch(binding_id: str, payload: ChannelBindingPatchPayload) -> dict[str, Any]:
    return patch_channel_binding(binding_id, payload)


@app.get("/channels/outbox")
async def channels_outbox_index(connection_id: str | None = Query(default=None), limit: int = Query(default=50)) -> list[dict[str, Any]]:
    return list_pending_channel_outbox(connection_id=connection_id, limit=limit)


@app.post("/channels/outbox/{outbox_id}/claim")
async def channels_outbox_claim(outbox_id: str, payload: ChannelOutboxClaimPayload) -> dict[str, Any]:
    _ = payload
    return claim_channel_outbox(outbox_id)


@app.post("/channels/outbox/{outbox_id}/delivered")
async def channels_outbox_delivered(outbox_id: str) -> dict[str, Any]:
    return mark_channel_outbox_delivered(outbox_id)


@app.post("/channels/outbox/{outbox_id}/failed")
async def channels_outbox_failed(outbox_id: str, payload: ChannelOutboxDecisionPayload) -> dict[str, Any]:
    return mark_channel_outbox_failed(outbox_id, payload.error or "delivery failed")


@app.post("/approvals/{approval_id}/approve")
async def approvals_approve(approval_id: str) -> dict[str, Any]:
    approval = db.fetchone("SELECT * FROM approvals WHERE id = ?", (approval_id,))
    if not approval:
        raise HTTPException(status_code=404, detail=f"Approval not found: {approval_id}")
    db.execute(
        "UPDATE approvals SET status = ?, updated_at = ? WHERE id = ?",
        ("approved", utcnow(), approval_id),
    )
    log_timeline(approval["task_session_id"], "approval_decision", "Approval granted", run_id=approval["run_id"], body=approval["title"], payload={"approval_id": approval_id, "status": "approved"})
    return db.fetchone("SELECT * FROM approvals WHERE id = ?", (approval_id,)) or {}


@app.post("/approvals/{approval_id}/reject")
async def approvals_reject(approval_id: str, payload: ApprovalDecisionPayload) -> dict[str, Any]:
    approval = db.fetchone("SELECT * FROM approvals WHERE id = ?", (approval_id,))
    if not approval:
        raise HTTPException(status_code=404, detail=f"Approval not found: {approval_id}")
    db.execute(
        "UPDATE approvals SET status = ?, reason = ?, updated_at = ? WHERE id = ?",
        ("rejected", payload.reason, utcnow(), approval_id),
        )
    log_timeline(approval["task_session_id"], "approval_decision", "Approval rejected", run_id=approval["run_id"], body=payload.reason or approval["title"], payload={"approval_id": approval_id, "status": "rejected"})
    return db.fetchone("SELECT * FROM approvals WHERE id = ?", (approval_id,)) or {}


@app.post("/runs/{run_id}/resume")
async def runs_resume(run_id: str) -> dict[str, Any]:
    bundle = PENDING_RUNS.get(run_id)
    if not bundle:
        raise HTTPException(status_code=404, detail=f"No pending run state for run: {run_id}")
    schedule_task_execution(bundle.task_id, resume_run_id=run_id)
    return {"ok": True, "run_id": run_id, "task_session_id": bundle.task_id}


@app.get("/traces")
async def traces_index() -> list[dict[str, Any]]:
    return [normalize_run(item) for item in db.fetchall("SELECT * FROM agent_runs ORDER BY started_at DESC")]


@app.get("/traces/{run_id}")
async def traces_show(run_id: str) -> dict[str, Any]:
    run = normalize_run(db.fetchone("SELECT * FROM agent_runs WHERE id = ?", (run_id,)))
    if not run:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
    run["timeline"] = [normalize_timeline_event(item) for item in db.fetchall("SELECT * FROM timeline_events WHERE run_id = ? ORDER BY id ASC", (run_id,))]
    run["approvals"] = db.fetchall("SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at ASC", (run_id,))
    return run


@app.get("/memory/scopes")
async def memory_scopes_index() -> list[dict[str, Any]]:
    return [normalize_memory_scope(item) for item in db.fetchall("SELECT * FROM memory_scopes ORDER BY updated_at DESC")]


@app.get("/memory/scopes/{scope_id}")
async def memory_scopes_show(scope_id: str) -> dict[str, Any]:
    scope = normalize_memory_scope(db.fetchone("SELECT * FROM memory_scopes WHERE scope_id = ?", (scope_id,)))
    if not scope:
        raise HTTPException(status_code=404, detail=f"Memory scope not found: {scope_id}")
    scope["episodes"] = db.fetchall("SELECT * FROM memory_events WHERE scope_id = ? ORDER BY id DESC LIMIT 25", (scope_id,))
    return scope


@app.post("/memory/scopes/{scope_id}/rebuild")
async def memory_scopes_rebuild(scope_id: str) -> dict[str, Any]:
    return memory_service.local.rebuild(scope_id)


@app.post("/memory/scopes/{scope_id}/prune")
async def memory_scopes_prune(scope_id: str) -> dict[str, Any]:
    return memory_service.local.prune(scope_id)


@app.get("/events/tasks/{task_id}")
async def events_task_stream(task_id: str) -> StreamingResponse:
    async def generate():
        last_id = 0
        while True:
            rows = db.fetchall(
                "SELECT * FROM timeline_events WHERE task_session_id = ? AND id > ? ORDER BY id ASC",
                (task_id, last_id),
            )
            if rows:
                for row in rows:
                    last_id = row["id"]
                    yield f"id: {row['id']}\nevent: {row['event_type']}\ndata: {json_dumps(row)}\n\n"
            else:
                yield ": keep-alive\n\n"
            await asyncio.sleep(1.0)

    return StreamingResponse(generate(), media_type="text/event-stream")


def main() -> None:
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="ZDCode local runtime")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4141)
    args = parser.parse_args()

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
