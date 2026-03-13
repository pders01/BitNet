#!/usr/bin/env python3
"""Flask routes for BitNet chat."""

import json
from flask import Flask, request, jsonify, Response, render_template
from web.db import (
    init_db, create_conversation, list_conversations, get_conversation,
    update_conversation, delete_conversation, add_message, get_messages, auto_title,
)
from web.llm import (
    generate_stream, warm_cache, estimate_prompt_tokens,
    MODEL, THREADS, CONTEXT_WINDOW,
)

app = Flask(__name__, template_folder="templates", static_folder="static")


@app.route("/")
def index():
    return render_template("index.html")


# --- Conversation CRUD ---

@app.route("/api/conversations", methods=["GET"])
def api_list_conversations():
    return jsonify(list_conversations())


@app.route("/api/conversations", methods=["POST"])
def api_create_conversation():
    title = (request.json or {}).get("title", "New chat")
    conv_id = create_conversation(title)
    return jsonify(get_conversation(conv_id)), 201


@app.route("/api/conversations/<int:conv_id>", methods=["GET"])
def api_get_conversation(conv_id):
    conv = get_conversation(conv_id)
    if not conv:
        return jsonify({"error": "Not found"}), 404
    conv["messages"] = get_messages(conv_id)
    return jsonify(conv)


@app.route("/api/conversations/<int:conv_id>", methods=["PATCH"])
def api_update_conversation(conv_id):
    title = (request.json or {}).get("title")
    if not title:
        return jsonify({"error": "Title required"}), 400
    update_conversation(conv_id, title)
    return jsonify(get_conversation(conv_id))


@app.route("/api/conversations/<int:conv_id>", methods=["DELETE"])
def api_delete_conversation(conv_id):
    delete_conversation(conv_id)
    return "", 204


# --- Chat ---

# Max messages to send to the model (keeps context within 4096 tokens).
# System prompt + last N messages. Each message ~50-100 tokens avg.
MAX_CONTEXT_MESSAGES = 20


def trim_context(messages):
    """Keep the last MAX_CONTEXT_MESSAGES to stay within context window."""
    if len(messages) <= MAX_CONTEXT_MESSAGES:
        return messages
    return messages[-MAX_CONTEXT_MESSAGES:]


@app.route("/api/context-info", methods=["POST"])
def api_context_info():
    """Return estimated token usage for a set of messages."""
    data = request.json or {}
    messages = data.get("messages", [])
    system_prompt = data.get("system_prompt")
    prompt_tokens = estimate_prompt_tokens(messages, system_prompt=system_prompt)
    return jsonify({
        "prompt_tokens": prompt_tokens,
        "context_window": CONTEXT_WINDOW,
    })


@app.route("/api/conversations/<int:conv_id>/chat", methods=["POST"])
def api_chat(conv_id):
    conv = get_conversation(conv_id)
    if not conv:
        return jsonify({"error": "Not found"}), 404

    data = request.json or {}
    user_content = data.get("content", "").strip()
    if not user_content:
        return jsonify({"error": "Empty message"}), 400

    temperature = float(data.get("temperature", 0.7))
    system_prompt = data.get("system_prompt") or None

    add_message(conv_id, "user", user_content)
    auto_title(conv_id)

    messages = get_messages(conv_id)
    msg_dicts = [{"role": m["role"], "content": m["content"]} for m in messages]
    msg_dicts = trim_context(msg_dicts)

    prompt_tokens = estimate_prompt_tokens(msg_dicts, system_prompt=system_prompt)

    def event_stream():
        # Send token estimate at start
        yield f"data: {json.dumps({'token_usage': {'prompt_tokens': prompt_tokens, 'context_window': CONTEXT_WINDOW}})}\n\n"

        full_response = []
        try:
            for chunk in generate_stream(
                msg_dicts,
                temperature=temperature,
                system_prompt=system_prompt,
            ):
                full_response.append(chunk)
                yield f"data: {json.dumps({'content': chunk})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
            return

        content = "".join(full_response).strip()
        if content:
            add_message(conv_id, "assistant", content)
        yield f"data: {json.dumps({'done': True, 'conversation': get_conversation(conv_id)})}\n\n"

    return Response(event_stream(), mimetype="text/event-stream")


def main():
    init_db()
    print(f"Model: {MODEL}")
    print(f"Threads: {THREADS}")
    warm_cache()
    print("Open http://localhost:5001")
    app.run(host="127.0.0.1", port=5001, debug=False)


if __name__ == "__main__":
    main()
