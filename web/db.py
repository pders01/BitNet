"""SQLite persistence for conversations and messages."""

import sqlite3
import os
from datetime import datetime, timezone

DB_PATH = os.environ.get("BITNET_DB", "web/chat.db")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL DEFAULT 'New chat',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
    """)
    conn.close()


def _now():
    return datetime.now(timezone.utc).isoformat()


# --- Conversations ---

def create_conversation(title="New chat"):
    conn = get_db()
    now = _now()
    cur = conn.execute(
        "INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)",
        (title, now, now),
    )
    conv_id = cur.lastrowid
    conn.commit()
    conn.close()
    return conv_id


def list_conversations():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_conversation(conv_id):
    conn = get_db()
    row = conn.execute(
        "SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?",
        (conv_id,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def update_conversation(conv_id, title):
    conn = get_db()
    conn.execute(
        "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
        (title, _now(), conv_id),
    )
    conn.commit()
    conn.close()


def delete_conversation(conv_id):
    conn = get_db()
    conn.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
    conn.commit()
    conn.close()


# --- Messages ---

def add_message(conv_id, role, content):
    conn = get_db()
    now = _now()
    conn.execute(
        "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
        (conv_id, role, content, now),
    )
    conn.execute(
        "UPDATE conversations SET updated_at = ? WHERE id = ?",
        (now, conv_id),
    )
    conn.commit()
    conn.close()


def get_messages(conv_id):
    conn = get_db()
    rows = conn.execute(
        "SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id",
        (conv_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def auto_title(conv_id):
    """Set conversation title from first user message if still default."""
    conn = get_db()
    conv = conn.execute("SELECT title FROM conversations WHERE id = ?", (conv_id,)).fetchone()
    if conv and conv["title"] == "New chat":
        first = conn.execute(
            "SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id LIMIT 1",
            (conv_id,),
        ).fetchone()
        if first:
            title = first["content"][:60].split("\n")[0]
            if len(first["content"]) > 60:
                title += "..."
            conn.execute(
                "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
                (title, _now(), conv_id),
            )
            conn.commit()
    conn.close()
