"""BitNet inference via llama-cli subprocess."""

import os
import subprocess

MODEL = os.environ.get("BITNET_MODEL", "models/BitNet-b1.58-2B-4T/ggml-model-i2_s.gguf")
CLI = "./build/bin/llama-cli"
THREADS = os.environ.get("BITNET_THREADS", str(os.cpu_count() or 4))
SYSTEM_PROMPT = os.environ.get("BITNET_SYSTEM", "You are a helpful assistant.")
PROMPT_CACHE = "models/bitnet-system.cache"

STOP_SEQUENCES = ["<|im_end|>", "<|im_start|>"]


def build_prompt(messages):
    """Build ChatML-formatted prompt from message dicts."""
    prompt = f"<|im_start|>system\n{SYSTEM_PROMPT}<|im_end|>\n"
    for msg in messages:
        prompt += f"<|im_start|>{msg['role']}\n{msg['content']}<|im_end|>\n"
    prompt += "<|im_start|>assistant\n"
    return prompt


def warm_cache():
    """Pre-cache the system prompt for faster subsequent requests."""
    if os.path.exists(PROMPT_CACHE):
        return
    print("Warming prompt cache...")
    cmd = [
        CLI, "-m", MODEL,
        "-p", f"<|im_start|>system\n{SYSTEM_PROMPT}<|im_end|>\n<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n",
        "-n", "1", "-t", THREADS,
        "--prompt-cache", PROMPT_CACHE,
        "--no-display-prompt",
    ]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("Cache ready.")


def generate_stream(messages, max_tokens=512):
    """Yield text chunks as they're generated."""
    prompt = build_prompt(messages)
    cmd = [
        CLI, "-m", MODEL, "-p", prompt,
        "-n", str(max_tokens), "-t", THREADS,
        "--no-display-prompt", "--temp", "0.7",
        "--repeat-penalty", "1.1",
        "--prompt-cache", PROMPT_CACHE,
    ]

    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            bufsize=0,
        )
    except OSError as e:
        raise RuntimeError(f"Failed to start llama-cli: {e}")

    buffer = ""
    max_stop_len = max(len(s) for s in STOP_SEQUENCES)
    produced_output = False

    for raw_byte in iter(lambda: proc.stdout.read(1), b""):
        char = raw_byte.decode("utf-8", errors="replace")
        buffer += char

        stopped = False
        for stop in STOP_SEQUENCES:
            if stop in buffer:
                text = buffer[:buffer.index(stop)]
                if text:
                    produced_output = True
                    yield text
                stopped = True
                break

        if stopped:
            proc.kill()
            proc.wait()
            return

        if len(buffer) > max_stop_len:
            safe = buffer[:-max_stop_len]
            buffer = buffer[-max_stop_len:]
            produced_output = True
            yield safe
    else:
        for stop in STOP_SEQUENCES:
            idx = buffer.find(stop)
            if idx != -1:
                buffer = buffer[:idx]
                break
        if buffer:
            produced_output = True
            yield buffer

    exit_code = proc.wait()
    if exit_code != 0 and not produced_output:
        stderr_out = proc.stderr.read().decode("utf-8", errors="replace")[-200:]
        raise RuntimeError(f"llama-cli exited with code {exit_code}: {stderr_out}")
