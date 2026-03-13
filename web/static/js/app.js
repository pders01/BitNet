/**
 * BitNet Chat — Frontend
 */

import { codeToHtml, bundledLanguages } from "https://esm.sh/shiki@3";

// --- Shiki highlighter ---

const SHIKI_LIGHT_THEME = "github-light";
const SHIKI_DARK_THEME = "github-dark";

function getShikiTheme() {
  var dt = document.documentElement.getAttribute("data-theme");
  return dt === "corporate" ? SHIKI_LIGHT_THEME : SHIKI_DARK_THEME;
}

/**
 * Parse markdown content and render code fences with Shiki.
 * Returns HTML string with highlighted code blocks and escaped text.
 */
async function renderMarkdown(text) {
  var parts = [];
  var regex = /```(\w*)\n([\s\S]*?)```/g;
  var lastIndex = 0;
  var match;

  while ((match = regex.exec(text)) !== null) {
    // Text before the code block
    if (match.index > lastIndex) {
      parts.push(escapeHtml(text.slice(lastIndex, match.index)));
    }

    var lang = match[1] || "text";
    var code = match[2].replace(/\n$/, "");

    // Only highlight if language is supported, otherwise fall back to text
    var effectiveLang = (lang in bundledLanguages) ? lang : "text";
    try {
      var html = await codeToHtml(code, {
        lang: effectiveLang,
        theme: getShikiTheme(),
      });
      parts.push('<div class="code-block relative my-2">' +
        '<div class="code-block-header flex items-center justify-between px-3 py-1 text-xs opacity-60">' +
          '<span>' + escapeHtml(lang || "text") + '</span>' +
          '<button class="copy-btn btn btn-ghost btn-xs" onclick="navigator.clipboard.writeText(this.closest(\'.code-block\').querySelector(\'code\').textContent)">Copy</button>' +
        '</div>' +
        html + '</div>');
    } catch (e) {
      parts.push('<pre class="my-2 p-3 bg-base-300 rounded-lg overflow-x-auto"><code>' + escapeHtml(code) + '</code></pre>');
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last code block
  if (lastIndex < text.length) {
    parts.push(escapeHtml(text.slice(lastIndex)));
  }

  return parts.join("");
}

// --- DOM refs ---

const msgInner = document.getElementById("msg-inner");
const emptyState = document.getElementById("empty-state");
const convList = document.getElementById("conv-list");
const convTitle = document.getElementById("conv-title");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const newChatBtn = document.getElementById("new-chat");
const renameModal = document.getElementById("rename-modal");
const renameInput = document.getElementById("rename-input");
const renameConfirmBtn = document.getElementById("rename-confirm");
const renameCancelBtn = document.getElementById("rename-cancel");
const deleteModal = document.getElementById("delete-modal");
const deleteConfirmBtn = document.getElementById("delete-confirm");
const deleteCancelBtn = document.getElementById("delete-cancel");
const messagesContainer = document.getElementById("messages");

const settingsToggle = document.getElementById("settings-toggle");
const settingsPanel = document.getElementById("settings-panel");
const tempSlider = document.getElementById("temp-slider");
const tempValue = document.getElementById("temp-value");
const systemPromptEl = document.getElementById("system-prompt");
const contextBar = document.getElementById("context-bar");
const contextLabel = document.getElementById("context-label");
const contextFill = document.getElementById("context-fill");

// --- State ---

let activeConvId = null;
let generating = false;
let renameTarget = null;
let deleteTarget = null;

// --- Presets ---

const PRESETS = {
  precise: {
    temperature: 0.3,
    system: "You are a precise, factual assistant. Think step by step before answering. Be concise and accurate. If you are unsure, say so.",
  },
  balanced: {
    temperature: 0.7,
    system: "You are a helpful assistant. Think step by step when solving problems.",
  },
  creative: {
    temperature: 1.0,
    system: "You are a creative writing assistant. Be imaginative, expressive, and original.",
  },
  coder: {
    temperature: 0.2,
    system: "You are a coding assistant. Write clean, correct code. Think step by step. Show only the code unless an explanation is requested. Be concise.",
  },
};

function getSettings() {
  return {
    temperature: parseFloat(tempSlider.value),
    system_prompt: systemPromptEl.value.trim() || null,
  };
}

function applyPreset(name) {
  var preset = PRESETS[name];
  if (!preset) return;
  tempSlider.value = preset.temperature;
  tempValue.textContent = preset.temperature.toFixed(1);
  systemPromptEl.value = preset.system;
  localStorage.setItem("bitnet-preset", name);
  localStorage.setItem("bitnet-temperature", preset.temperature);
  localStorage.setItem("bitnet-system-prompt", preset.system);
  updatePresetButtons(name);
}

function updatePresetButtons(activeName) {
  document.querySelectorAll(".preset-btn").forEach(function (btn) {
    if (btn.dataset.preset === activeName) {
      btn.classList.add("btn-primary");
    } else {
      btn.classList.remove("btn-primary");
    }
  });
}

// Settings panel toggle
settingsToggle.addEventListener("click", function () {
  settingsPanel.classList.toggle("hidden");
});

// Preset buttons
document.querySelectorAll(".preset-btn").forEach(function (btn) {
  btn.addEventListener("click", function () {
    applyPreset(btn.dataset.preset);
  });
});

// Temperature slider
tempSlider.addEventListener("input", function () {
  tempValue.textContent = parseFloat(tempSlider.value).toFixed(1);
  localStorage.setItem("bitnet-temperature", tempSlider.value);
  updatePresetButtons(null);  // deselect presets on manual change
});

// System prompt persistence
systemPromptEl.addEventListener("input", function () {
  localStorage.setItem("bitnet-system-prompt", systemPromptEl.value);
  updatePresetButtons(null);
});

// Restore saved settings
(function restoreSettings() {
  var savedPreset = localStorage.getItem("bitnet-preset");
  if (savedPreset && PRESETS[savedPreset]) {
    applyPreset(savedPreset);
  } else {
    var savedTemp = localStorage.getItem("bitnet-temperature");
    if (savedTemp) {
      tempSlider.value = savedTemp;
      tempValue.textContent = parseFloat(savedTemp).toFixed(1);
    }
    var savedSystem = localStorage.getItem("bitnet-system-prompt");
    if (savedSystem) systemPromptEl.value = savedSystem;
  }
})();

// --- API ---

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/api${path}`, opts);
  if (res.status === 204) return null;
  return res.json();
}

// --- Conversations ---

async function loadConversations() {
  const convs = await api("GET", "/conversations");
  renderConvList(convs);
}

function renderConvList(convs) {
  convList.innerHTML = "";

  for (const conv of convs) {
    const li = document.createElement("li");
    if (conv.id === activeConvId) li.classList.add("active");

    const a = document.createElement("a");
    a.className = conv.id === activeConvId ? "active flex items-center justify-between w-full" : "flex items-center justify-between w-full";
    a.dataset.id = conv.id;

    const titleSpan = document.createElement("span");
    titleSpan.className = "flex-1 truncate";
    titleSpan.textContent = conv.title;

    const actions = document.createElement("span");
    actions.className = "conv-actions";

    const renameBtn = document.createElement("button");
    renameBtn.className = "btn btn-ghost btn-xs btn-square";
    renameBtn.title = "Rename";
    renameBtn.innerHTML = ICON_PENCIL;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-ghost btn-xs btn-square";
    deleteBtn.title = "Delete";
    deleteBtn.innerHTML = ICON_TRASH;

    renameBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      openRenameModal(conv);
    });

    deleteBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      openDeleteModal(conv.id);
    });

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    a.appendChild(titleSpan);
    a.appendChild(actions);
    li.appendChild(a);

    a.addEventListener("click", function () {
      selectConversation(conv.id);
    });

    convList.appendChild(li);
  }
}

async function selectConversation(id) {
  activeConvId = id;
  const conv = await api("GET", "/conversations/" + id);
  if (!conv) return;

  convTitle.textContent = conv.title;
  msgInner.innerHTML = "";
  emptyState.classList.add("hidden");
  inputEl.disabled = false;
  sendBtn.disabled = false;

  for (const msg of conv.messages) {
    appendMessage(msg.role, msg.content);
  }
  scrollToBottom();
  loadConversations();
  inputEl.focus();
}

// --- Rename ---

function openRenameModal(conv) {
  renameTarget = conv;
  renameInput.value = conv.title;
  renameModal.showModal();
  setTimeout(function () {
    renameInput.focus();
    renameInput.select();
  }, 50);
}

renameConfirmBtn.addEventListener("click", async function () {
  if (!renameTarget) return;
  const title = renameInput.value.trim();
  if (title) {
    await api("PATCH", "/conversations/" + renameTarget.id, { title: title });
    if (activeConvId === renameTarget.id) convTitle.textContent = title;
    loadConversations();
  }
  renameModal.close();
});

renameCancelBtn.addEventListener("click", function () {
  renameModal.close();
});

renameInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    e.preventDefault();
    renameConfirmBtn.click();
  }
});

// --- Delete ---

function openDeleteModal(id) {
  deleteTarget = id;
  deleteModal.showModal();
}

deleteConfirmBtn.addEventListener("click", async function () {
  if (deleteTarget == null) return;
  await api("DELETE", "/conversations/" + deleteTarget);
  if (activeConvId === deleteTarget) {
    activeConvId = null;
    msgInner.innerHTML = "";
    emptyState.classList.remove("hidden");
    convTitle.textContent = "Select or start a conversation";
    inputEl.disabled = true;
    sendBtn.disabled = true;
  }
  loadConversations();
  deleteModal.close();
});

deleteCancelBtn.addEventListener("click", function () {
  deleteModal.close();
});

// --- Messages ---

function appendMessage(role, content, opts) {
  opts = opts || {};
  var wrapper = document.createElement("div");
  wrapper.className = role === "user" ? "chat chat-end" : "chat chat-start";

  var header = document.createElement("div");
  header.className = "chat-header text-xs opacity-50 mb-0.5";
  header.textContent = role === "user" ? "You" : "BitNet";

  var bubble = document.createElement("div");
  if (role === "user") {
    bubble.className = "chat-bubble bg-base-content text-base-100 text-sm whitespace-pre-wrap";
    bubble.textContent = content;
  } else {
    bubble.className = "chat-bubble bg-base-200 text-base-content text-sm whitespace-pre-wrap";
    if (opts.streaming) {
      // During streaming: plain text, will be finalized later
      bubble.textContent = content;
    } else {
      // Historical messages: render immediately (async)
      bubble.innerHTML = '<span class="opacity-30 text-xs">...</span>';
      renderMarkdown(content).then(function (html) {
        bubble.classList.remove("whitespace-pre-wrap");
        bubble.innerHTML = html;
      });
    }
  }

  wrapper.appendChild(header);
  wrapper.appendChild(bubble);
  msgInner.appendChild(wrapper);
  return bubble;
}

async function finalizeMessage(bubble, content) {
  var html = await renderMarkdown(content);
  bubble.classList.remove("whitespace-pre-wrap");
  bubble.innerHTML = html;
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// --- Send / Stream ---

async function send() {
  var text = inputEl.value.trim();
  if (!text || generating) return;

  // Auto-create conversation if none is active
  if (!activeConvId) {
    var conv = await api("POST", "/conversations", {});
    activeConvId = conv.id;
    convTitle.textContent = "New chat";
    emptyState.classList.add("hidden");
    msgInner.innerHTML = "";
    loadConversations();
  }

  generating = true;
  inputEl.value = "";
  inputEl.style.height = "auto";
  sendBtn.disabled = true;
  emptyState.classList.add("hidden");

  appendMessage("user", text);
  scrollToBottom();

  var assistantBubble = appendMessage("assistant", "", { streaming: true });
  assistantBubble.classList.add("streaming");
  var fullContent = "";
  var hadError = false;

  try {
    var settings = getSettings();
    var res = await fetch("/api/conversations/" + activeConvId + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: text,
        temperature: settings.temperature,
        system_prompt: settings.system_prompt,
      }),
    });

    if (!res.ok) {
      throw new Error("Server returned " + res.status);
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var sseBuffer = "";

    while (true) {
      var result = await reader.read();
      if (result.done) break;

      sseBuffer += decoder.decode(result.value, { stream: true });
      var lines = sseBuffer.split("\n");
      sseBuffer = lines.pop();

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf("data: ") !== 0) continue;
        var payload = line.slice(6);
        try {
          var data = JSON.parse(payload);
          if (data.error) {
            hadError = true;
            throw new Error(data.error);
          }
          if (data.token_usage) {
            updateContextBar(data.token_usage.prompt_tokens, data.token_usage.context_window);
          }
          if (data.content) {
            fullContent += data.content;
            assistantBubble.textContent = fullContent;
            scrollToBottom();
          }
          if (data.done && data.conversation) {
            convTitle.textContent = data.conversation.title;
          }
        } catch (parseErr) {
          if (hadError) throw parseErr;
        }
      }
    }
  } catch (e) {
    hadError = true;
    if (!fullContent) {
      showRetry(assistantBubble, text);
    }
  }

  assistantBubble.classList.remove("streaming");
  if (fullContent && !hadError) {
    await finalizeMessage(assistantBubble, fullContent);
  }
  generating = false;
  sendBtn.disabled = false;
  inputEl.focus();
  loadConversations();
}

function showRetry(bubble, originalText) {
  bubble.textContent = "";
  bubble.classList.remove("streaming");
  bubble.className = "chat-bubble bg-base-200 text-sm";

  var errorText = document.createElement("span");
  errorText.className = "text-error/70 text-xs";
  errorText.textContent = "Something went wrong.";

  var retryBtn = document.createElement("button");
  retryBtn.className = "btn btn-ghost btn-xs ml-2";
  retryBtn.textContent = "Retry";
  retryBtn.addEventListener("click", function () {
    var chatWrapper = bubble.parentElement;
    // Also remove the user message bubble before it
    var prevSibling = chatWrapper.previousElementSibling;
    if (prevSibling) prevSibling.remove();
    chatWrapper.remove();
    generating = false;
    inputEl.value = originalText;
    send();
  });

  bubble.appendChild(errorText);
  bubble.appendChild(retryBtn);
}

// --- Event listeners ---

newChatBtn.addEventListener("click", async function () {
  var conv = await api("POST", "/conversations", {});
  await selectConversation(conv.id);
  loadConversations();
});

sendBtn.addEventListener("click", send);

inputEl.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

inputEl.addEventListener("input", function () {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
});

// --- Context bar ---

function updateContextBar(promptTokens, contextWindow) {
  contextBar.classList.remove("hidden");
  var pct = Math.min(100, (promptTokens / contextWindow) * 100);
  contextLabel.textContent = promptTokens + " / " + contextWindow;
  contextFill.style.width = pct + "%";
  // Color warning at 75%, danger at 90%
  contextFill.classList.remove("bg-primary", "bg-warning", "bg-error");
  if (pct >= 90) {
    contextFill.classList.add("bg-error");
  } else if (pct >= 75) {
    contextFill.classList.add("bg-warning");
  } else {
    contextFill.classList.add("bg-primary");
  }
}

// --- Icons ---

var ICON_PENCIL = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>';
var ICON_TRASH = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>';

// --- Escape HTML ---

function escapeHtml(s) {
  var div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// --- Theme ---

const LIGHT_THEME = "corporate";
const DARK_THEME = "black";
const themeSelect = document.getElementById("theme-select");

function applyTheme(pref) {
  let theme;
  if (pref === "system") {
    theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? DARK_THEME : LIGHT_THEME;
  } else {
    theme = pref === "light" ? LIGHT_THEME : DARK_THEME;
  }
  document.documentElement.setAttribute("data-theme", theme);
}

themeSelect.value = localStorage.getItem("bitnet-theme") || "system";
applyTheme(themeSelect.value);

themeSelect.addEventListener("change", function () {
  localStorage.setItem("bitnet-theme", themeSelect.value);
  applyTheme(themeSelect.value);
});

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
  if (themeSelect.value === "system") applyTheme("system");
});

// --- Init ---

loadConversations();
