// Stash Board webview. Renders the three-column board server state; drops are
// sent to the extension host, and outcomes render only when state returns
// (no optimistic UI). A failed drop shows the error banner and the board
// re-renders from scratch, naturally snapping the card back.

// @ts-ignore -- provided by VS Code in the webview context
const vscode = acquireVsCodeApi();
let state = null;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function post(msg) {
  vscode.postMessage(msg);
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.type !== "state") return;
  state = msg;
  render();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function el(parent, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

function render() {
  document.getElementById("busy").classList.toggle("hidden", !state.busy);
  const errBox = document.getElementById("error");
  if (state.error) {
    errBox.textContent = state.error;
    errBox.classList.remove("hidden");
  } else {
    errBox.classList.add("hidden");
  }
  if (!state.view) return;

  const staged = state.view.changes.filter((c) => c.state === "staged");
  const changed = state.view.changes.filter((c) => c.state !== "staged");
  renderCards("#col-staged .cards", staged);
  renderCards("#col-changes .cards", changed);
  renderStashes();
}

function changeCard(box, f, kind) {
  const card = el(box, "div", "card");
  card.draggable = true;
  card.dataset.kind = kind;
  card.dataset.path = f.path;
  card.dataset.state = f.state;
  el(card, "span", `dot ${f.state}`);
  el(card, "span", "name", f.path);
  card.addEventListener("dragstart", onDragStart);
  card.addEventListener("dragend", onDragEnd);
}

function renderCards(selector, files) {
  const box = document.querySelector(selector);
  box.replaceChildren();
  if (files.length === 0) {
    el(box, "div", "empty", "Nothing here — drop a file card.");
    return;
  }
  for (const f of files) changeCard(box, f, "change");
}

function renderStashes() {
  const box = document.querySelector("#col-stashes .cards");
  box.replaceChildren();
  const stashes = state.view.stashes ?? [];
  if (stashes.length === 0) {
    el(box, "div", "empty", "No stashes yet.");
    return;
  }
  for (const s of stashes) {
    const card = el(box, "div", "card stash-card");
    card.dataset.stashId = s.id;
    el(card, "span", "dot tracked");
    el(card, "span", "name stash-name", `${s.name} (${s.files.length})`);
    const files = el(card, "div", "stash-files");
    for (const f of s.files) {
      const file = el(files, "div", "card");
      file.draggable = true;
      file.dataset.kind = "stashfile";
      file.dataset.path = f.path;
      file.dataset.stashId = s.id;
      file.title = `Click to open: ${f.path}`;
      el(file, "span", `dot ${f.layer}`);
      el(file, "span", "name", f.path);
      file.addEventListener("dragstart", onDragStart);
      file.addEventListener("dragend", onDragEnd);
      file.addEventListener("click", () => {
        post({ type: "openFile", stashId: s.id, path: f.path });
      });
    }
    makeDropTarget(card, "stash");
  }
}

// ---------------------------------------------------------------------------
// Drag & drop
// ---------------------------------------------------------------------------

let dragData = null;

function onDragStart(e) {
  dragData = {
    kind: this.dataset.kind,
    path: this.dataset.path,
    state: this.dataset.state,
    stashId: this.dataset.stashId,
  };
  this.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", this.dataset.path);
}

function onDragEnd() {
  this.classList.remove("dragging");
  dragData = null;
  for (const node of document.querySelectorAll(".dragover")) {
    node.classList.remove("dragover");
  }
}

/**
 * Whether `target` accepts a drop of the dragged card, and with what action.
 * Returns an object describing the extension message, or null when invalid.
 */
function dropAction(target) {
  if (!dragData) return null;
  const stashCard = target.closest(".stash-card");
  const column = target.closest(".column");
  const targetColumn = column?.dataset.column;

  // Change card → STAGED column: stage it.
  if (dragData.kind === "change" && targetColumn === "staged") {
    if (dragData.state === "staged") return null; // already staged
    return { type: "stage", path: dragData.path };
  }

  // Change card → a stash: add to stash.
  if (dragData.kind === "change" && stashCard) {
    return { type: "add", stashId: stashCard.dataset.stashId, path: dragData.path };
  }

  // Stash file → CHANGES column: restore (to working tree).
  if (dragData.kind === "stashfile" && targetColumn === "changes") {
    return { type: "restore", stashId: dragData.stashId, path: dragData.path, staged: false };
  }

  // Stash file → STAGED column: restore into the index.
  if (dragData.kind === "stashfile" && targetColumn === "staged") {
    return { type: "restore", stashId: dragData.stashId, path: dragData.path, staged: true };
  }

  // Stash file → a different stash: move between stashes.
  if (dragData.kind === "stashfile" && stashCard) {
    const toId = stashCard.dataset.stashId;
    if (toId === dragData.stashId) return null; // same stash — no-op
    return {
      type: "move",
      fromStashId: dragData.stashId,
      toStashId: toId,
      path: dragData.path,
    };
  }

  return null;
}

function makeDropTarget(node) {
  node.addEventListener("dragover", (e) => {
    if (dropAction(node)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      node.classList.add("dragover");
    }
  });
  node.addEventListener("dragleave", () => node.classList.remove("dragover"));
  node.addEventListener("drop", (e) => {
    e.preventDefault();
    node.classList.remove("dragover");
    const action = dropAction(node);
    if (action) post(action);
  });
}

for (const col of document.querySelectorAll(".column")) {
  makeDropTarget(col);
}

document.getElementById("refresh").addEventListener("click", () => post({ type: "refresh" }));
post({ type: "init" });