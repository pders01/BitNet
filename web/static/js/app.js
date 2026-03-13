/**
 * BitNet Chat — Frontend
 */

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

// --- State ---

let activeConvId = null;
let generating = false;
let renameTarget = null;
let deleteTarget = null;

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
    a.className = conv.id === activeConvId ? "active flex items-center gap-1" : "flex items-center gap-1";
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

function appendMessage(role, content) {
  var wrapper = document.createElement("div");
  wrapper.className = role === "user" ? "chat chat-end" : "chat chat-start";

  var header = document.createElement("div");
  header.className = "chat-header text-xs opacity-50 mb-0.5";
  header.textContent = role === "user" ? "You" : "BitNet";

  var bubble = document.createElement("div");
  if (role === "user") {
    bubble.className = "chat-bubble bg-base-content text-base-100 text-sm whitespace-pre-wrap";
  } else {
    bubble.className = "chat-bubble bg-base-200 text-base-content text-sm whitespace-pre-wrap";
  }
  bubble.textContent = content;

  wrapper.appendChild(header);
  wrapper.appendChild(bubble);
  msgInner.appendChild(wrapper);
  return bubble;
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

  var assistantBubble = appendMessage("assistant", "");
  assistantBubble.classList.add("streaming");
  var fullContent = "";
  var hadError = false;

  try {
    var res = await fetch("/api/conversations/" + activeConvId + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
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

// --- Icons ---

var ICON_PENCIL = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>';
var ICON_TRASH = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>';

// --- Escape HTML ---

function escapeHtml(s) {
  var div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// --- Init ---

loadConversations();
