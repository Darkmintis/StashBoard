// Stash Board webview. Renders host state only - no optimistic UI.
// Failed drops snap back when the next state message arrives.

// @ts-ignore -- provided by VS Code in the webview context
const vscode = acquireVsCodeApi();
let state = null;

function post(msg) {
  vscode.postMessage(msg);
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.type !== "state") return;
  state = msg;
  render();
});

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

  const sub = document.getElementById("subtitle");
  const newBtn = document.getElementById("newStash");
  const stashChanges = document.getElementById("stashChanges");
  const addStash = document.getElementById("addStash");

  if (!state.view) {
    sub.textContent = "";
    newBtn.disabled = true;
    stashChanges.disabled = true;
    addStash.disabled = true;
    clearBoard();
    return;
  }

  const staged = state.view.changes.filter((c) => c.state === "staged");
  const changed = state.view.changes.filter((c) => c.state !== "staged");
  const stashes = state.view.stashes ?? [];

  document.getElementById("count-staged").textContent = String(staged.length);
  document.getElementById("count-changes").textContent = String(changed.length);
  document.getElementById("count-stashes").textContent = String(stashes.length);

  const totalChanges = staged.length + changed.length;
  sub.textContent =
    totalChanges === 0 && stashes.length === 0
      ? "No changes yet"
      : `${totalChanges} working - ${stashes.length} stash${stashes.length === 1 ? "" : "es"}`;
  const canCreate = !state.busy && totalChanges > 0;
  newBtn.disabled = !canCreate;
  stashChanges.disabled = !canCreate;
  addStash.disabled = !!state.busy;

  renderCards("#col-staged .cards", staged);
  renderCards("#col-changes .cards", changed);
  renderStashes(stashes);
}

function clearBoard() {
  for (const id of ["count-staged", "count-changes", "count-stashes"]) {
    document.getElementById(id).textContent = "0";
  }
  for (const sel of ["#col-staged .cards", "#col-changes .cards", "#col-stashes .cards"]) {
    const box = document.querySelector(sel);
    box.replaceChildren();
    el(box, "div", "empty", "Open a git workspace to use Stash Board.");
  }
}

function changeCard(box, f, kind) {
  const card = el(box, "div", "card");
  card.draggable = true;
  card.dataset.kind = kind;
  card.dataset.path = f.path;
  card.dataset.state = f.state;
  card.title = f.path;
  el(card, "span", `dot ${f.state}`);
  el(card, "span", "name", f.path);
  card.addEventListener("dragstart", onDragStart);
  card.addEventListener("dragend", onDragEnd);
}

function renderCards(selector, files) {
  const box = document.querySelector(selector);
  box.replaceChildren();
  if (files.length === 0) {
    const col = box.closest(".column")?.dataset.column;
    const hint =
      col === "staged"
        ? "Drop a change here to stage it."
        : "Working-tree edits land here.";
    el(box, "div", "empty", hint);
    return;
  }
  for (const f of files) changeCard(box, f, "change");
}

function renderStashes(stashes) {
  const box = document.querySelector("#col-stashes .cards");
  box.replaceChildren();

  const dropNew = el(box, "div", "new-stash");
  dropNew.dataset.newStash = "1";
  dropNew.textContent = "+ New stash - drop a file here";
  makeDropTarget(dropNew);

  if (stashes.length === 0) {
    el(box, "div", "empty", "No stashes yet. Drag a file onto + New, or click + New stash.");
    return;
  }

  for (const s of stashes) {
    const card = el(box, "div", "card stash-card");
    card.dataset.stashId = s.id;

    const head = el(card, "div", "stash-head");
    el(head, "span", "dot tracked");
    el(head, "span", "name", `${s.name} (${s.files.length})`);
    const del = el(head, "button", "icon-btn danger", "x");
    del.type = "button";
    del.title = "Delete stash";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "delete", stashId: s.id });
    });

    const actions = el(card, "div", "stash-actions");
    actionBtn(actions, "Restore", () => post({ type: "restoreStash", stashId: s.id }));
    actionBtn(actions, "Stage", () => post({ type: "stageStash", stashId: s.id }));
    actionBtn(actions, "Rename", () => post({ type: "rename", stashId: s.id }));
    actionBtn(actions, "Delete", () => post({ type: "delete", stashId: s.id }), true);

    const files = el(card, "div", "stash-files");
    if (s.files.length === 0) {
      el(files, "div", "empty", "Empty stash");
    }
    for (const f of s.files) {
      const file = el(files, "div", "card");
      file.draggable = true;
      file.dataset.kind = "stashfile";
      file.dataset.path = f.path;
      file.dataset.stashId = s.id;
      file.title = `Open diff: ${f.path}`;
      el(file, "span", `dot ${f.layer}`);
      el(file, "span", "name", f.path);
      file.addEventListener("dragstart", onDragStart);
      file.addEventListener("dragend", onDragEnd);
      file.addEventListener("click", () => {
        post({ type: "openFile", stashId: s.id, path: f.path });
      });
    }
    makeDropTarget(card);
  }
}

function actionBtn(parent, label, onClick, danger) {
  const btn = el(parent, "button", danger ? "link danger" : "link", label);
  btn.type = "button";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
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

/** Return the host message for a drop, or null when invalid. */
function dropAction(target) {
  if (!dragData) return null;
  const stashCard = target.closest(".stash-card");
  const newZone = target.closest("[data-new-stash]");
  const column = target.closest(".column");
  const targetColumn = column?.dataset.column;

  if (dragData.kind === "change" && targetColumn === "staged") {
    if (dragData.state === "staged") return null;
    return { type: "stage", path: dragData.path };
  }

  if (dragData.kind === "change" && targetColumn === "changes") {
    if (dragData.state !== "staged") return null;
    return { type: "unstage", path: dragData.path };
  }

  if (dragData.kind === "change" && (newZone || (targetColumn === "stashes" && !stashCard))) {
    return { type: "create", paths: [dragData.path] };
  }

  if (dragData.kind === "change" && stashCard) {
    return { type: "add", stashId: stashCard.dataset.stashId, path: dragData.path };
  }

  if (dragData.kind === "stashfile" && targetColumn === "changes") {
    return { type: "restore", stashId: dragData.stashId, path: dragData.path, staged: false };
  }

  if (dragData.kind === "stashfile" && targetColumn === "staged") {
    return { type: "restore", stashId: dragData.stashId, path: dragData.path, staged: true };
  }

  if (dragData.kind === "stashfile" && stashCard) {
    const toId = stashCard.dataset.stashId;
    if (toId === dragData.stashId) return null;
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
document.getElementById("newStash").addEventListener("click", () => post({ type: "createAll" }));
document.getElementById("stashChanges").addEventListener("click", () => post({ type: "createAll" }));
document.getElementById("addStash").addEventListener("click", () => post({ type: "createAll" }));
post({ type: "init" });
