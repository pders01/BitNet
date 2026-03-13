"""BitNet inference via llama-cli subprocess."""

import os
import subprocess
from concurrent.futures import ThreadPoolExecutor

MODEL = os.environ.get("BITNET_MODEL", "models/BitNet-b1.58-2B-4T/ggml-model-i2_s.gguf")
CLI = "./build/bin/llama-cli"
THREADS = os.environ.get("BITNET_THREADS", str(os.cpu_count() or 4))
DEFAULT_SYSTEM_PROMPT = os.environ.get("BITNET_SYSTEM", "You are a helpful assistant.")
PROMPT_CACHE = "models/bitnet-system.cache"
CONTEXT_WINDOW = 4096

STOP_SEQUENCES = ["<|im_end|>", "<|im_start|>", "<|im_sep|>", "<|endoftext|>"]

# Rough token estimation: ~3.5 chars per token for this tokenizer.
CHARS_PER_TOKEN = 3.5
# ChatML overhead per message: <|im_start|>role\n...<|im_end|>\n ≈ 10 tokens
CHATML_OVERHEAD = 10


def estimate_tokens(text):
    """Rough token count from character length."""
    return int(len(text) / CHARS_PER_TOKEN)


def estimate_prompt_tokens(messages, system_prompt=None):
    """Estimate total tokens for a ChatML prompt."""
    sp = system_prompt or DEFAULT_SYSTEM_PROMPT
    total = estimate_tokens(sp) + CHATML_OVERHEAD  # system message
    for msg in messages:
        total += estimate_tokens(msg["content"]) + CHATML_OVERHEAD
    total += 3  # <|im_start|>assistant\n
    return total


def build_prompt(messages, system_prompt=None):
    """Build ChatML-formatted prompt from message dicts."""
    sp = system_prompt or DEFAULT_SYSTEM_PROMPT
    prompt = f"<|im_start|>system\n{sp}<|im_end|>\n"
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


def generate_stream(messages, max_tokens=512, temperature=0.7,
                     repeat_penalty=1.1, system_prompt=None,
                     use_cache=True):
    """Yield text chunks as they're generated."""
    prompt = build_prompt(messages, system_prompt=system_prompt)
    cmd = [
        CLI, "-m", MODEL, "-p", prompt,
        "-n", str(max_tokens), "-t", THREADS,
        "--no-display-prompt", "--temp", str(temperature),
        "--repeat-penalty", str(repeat_penalty),
        "-r", "<|im_end|>",
        "-r", "<|im_start|>",
        "-r", "<|im_sep|>",
    ]
    if use_cache:
        cmd += ["--prompt-cache", PROMPT_CACHE]

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
    decoder = __import__("codecs").getincrementaldecoder("utf-8")("replace")

    for raw_byte in iter(lambda: proc.stdout.read(1), b""):
        char = decoder.decode(raw_byte, False)
        if not char:
            continue  # incomplete multi-byte sequence, keep reading
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


def generate(messages, max_tokens=512, temperature=0.7,
             repeat_penalty=1.1, system_prompt=None, use_cache=True):
    """Non-streaming generation — returns complete text."""
    chunks = list(generate_stream(
        messages, max_tokens=max_tokens, temperature=temperature,
        repeat_penalty=repeat_penalty, system_prompt=system_prompt,
        use_cache=use_cache,
    ))
    return "".join(chunks).strip()


# --- Strategies ---

VERIFY_PROMPT = (
    "Check the above answer for factual errors or weak reasoning. "
    "Now write an improved, corrected version of the answer. "
    "Output ONLY the improved answer, nothing else."
)


def strategy_verify(messages, initial_answer, temperature=0.7, system_prompt=None):
    """Second-pass verification: ask the model to review its own answer."""
    verify_messages = messages + [
        {"role": "assistant", "content": initial_answer},
        {"role": "user", "content": VERIFY_PROMPT},
    ]
    return generate_stream(
        verify_messages, temperature=max(temperature - 0.2, 0.1),
        system_prompt=system_prompt,
    )


def strategy_best_of_n(messages, n=3, temperature=0.7, system_prompt=None):
    """Generate N responses and return the longest (proxy for most thorough)."""
    def _gen():
        return generate(
            messages, temperature=temperature,
            system_prompt=system_prompt,
            use_cache=False,  # parallel runs can't share the cache file
        )

    with ThreadPoolExecutor(max_workers=n) as pool:
        futures = [pool.submit(_gen) for _ in range(n)]
        results = [f.result() for f in futures]

    # Pick the longest non-empty response as a quality heuristic
    results = [r for r in results if r]
    if not results:
        return ""
    return max(results, key=len)


DECOMPOSE_PROMPT = (
    "Break this question into 2-3 simpler sub-questions that would help "
    "answer it. List only the sub-questions, one per line, no numbering."
)


def strategy_decompose(messages, temperature=0.7, system_prompt=None):
    """Decompose → answer sub-questions → synthesize."""
    # Step 1: Get sub-questions
    user_question = messages[-1]["content"]
    decompose_messages = messages[:-1] + [
        {"role": "user", "content": f"{user_question}\n\n{DECOMPOSE_PROMPT}"},
    ]
    sub_questions_text = generate(
        decompose_messages, temperature=0.3, max_tokens=256,
        system_prompt=system_prompt,
    )

    sub_questions = [q.strip().lstrip("- ") for q in sub_questions_text.strip().split("\n") if q.strip()]
    if not sub_questions:
        # Fallback: just answer directly
        return generate_stream(messages, temperature=temperature, system_prompt=system_prompt)

    # Step 2: Answer each sub-question
    sub_answers = []
    for sq in sub_questions[:3]:  # cap at 3
        answer = generate(
            messages[:-1] + [{"role": "user", "content": sq}],
            temperature=temperature, max_tokens=256,
            system_prompt=system_prompt,
        )
        sub_answers.append(f"Q: {sq}\nA: {answer}")

    # Step 3: Synthesize
    context = "\n\n".join(sub_answers)
    synthesis_messages = messages[:-1] + [
        {"role": "user", "content": (
            f"I researched these sub-topics:\n\n{context}\n\n"
            f"Using these findings, write a comprehensive answer to: {user_question}\n"
            f"Write a clean, well-structured response. Do not repeat the Q&A format above."
        )},
    ]
    return generate_stream(
        synthesis_messages, temperature=temperature,
        system_prompt=system_prompt,
    )
