/** Browser workspace controller: IDE files, container controls, agent history, and manual experiments. */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { Workspace, AgentRun, RunEvent, FileEntry, FileDocument, ChangeProposal, SystemStatus } from "@relay/contracts";
import { api, socketUrl } from "./api";
import { CodeEditor } from "./editor";
import { Layout, commandPalette } from "./layout";
import { TaskBoard } from "./tasks";
import { ChangeReview } from "./review";
import "./style.css";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
type State = { workspaces: Workspace[]; runs: AgentRun[]; system: SystemStatus };
let state: State, selectedId = "", selectedRunId = "", currentFile = "";
let authenticated = false, eventSocket: WebSocket | undefined, terminalSocket: WebSocket | undefined;
type View = "tasks" | "experiments" | "review" | "code";
let view: View = "tasks";
let terminalWorkspace = "", refreshTimer: number | undefined, refreshing = false;
const documents = new Map<string, FileDocument & { saved: string }>();
const runEvents = new Map<string, RunEvent[]>();
const layout = new Layout();
const board = new TaskBoard({
  select: run => void action(async () => { await chooseWorkspace(run.workspaceId); if (selectedId !== run.workspaceId) return; selectedRunId = run.id; setView("tasks"); renderState(); await catchUp(run.id); }),
  review: ids => { setView("review"); void reviews.open(ids); },
  code: id => void action(() => showCode(id)),
  discard: id => void action(() => discardWorkspace(id)),
});
const reviews = new ChangeReview({
  code: (id, path) => void action(async () => { await showCode(id); if (selectedId === id && path) await openFile(path); }),
  error: message => toast(message),
  apply: async proposal => {
    if (dirty() && [proposal.workspaceId, proposal.parentId].includes(selectedId)) throw new Error("Save or discard editor changes before applying this review.");
    if (!confirm("Apply this entire reviewed diff to the primary workspace? This changes its files without committing or pushing.")) return;
    const applied = await api<ChangeProposal>(`/changes/${proposal.id}/apply`, "POST", {});
    proposal.appliedAt = applied.appliedAt; await refresh(); toast("Changes applied to the primary workspace");
  },
});
const finished = new Set(["completed", "failed", "cancelled", "interrupted"]);
const workspacePath = (id = selectedId) => `/workspaces/${id}`;
const selected = () => state?.workspaces.find(workspace => workspace.id === selectedId);
const busy = () => state?.runs.some(run => run.workspaceId === selectedId && !finished.has(run.state));
const dirty = () => [...documents.values()].some(document => document.content !== document.saved);
let toastTimer: number | undefined;
function toast(message: string): void { $("toast").textContent = message; $("toast").hidden = false; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { $("toast").hidden = true; }, 7000); }
async function action(work: () => Promise<void>): Promise<void> { try { await work(); } catch (error) { toast((error as Error).message); } }
function on(id: string, work: () => Promise<void> | void): void {
  $(id).addEventListener("click", () => { void action(async () => { const button = $<HTMLButtonElement>(id); button.disabled = true; try { await work(); } finally { button.disabled = false; renderControls(); } }); });
}

const editor = new CodeEditor($("editor"), content => {
  const document = documents.get(currentFile); if (!document) return;
  document.content = content; renderTabs();
}, () => void action(saveFile));
const terminal = new Terminal({ theme: { background: "#1e1e1e", foreground: "#cccccc", cursor: "#aeafad" }, fontSize: 12, fontFamily: "'Cascadia Code', Consolas, monospace", cursorBlink: true, scrollback: 4000 });
const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open($("terminal"));
function resizeTerminal(): void {
  if ($("terminal").clientWidth < 10 || $("terminal").clientHeight < 10) return;
  fit.fit(); if (terminalSocket?.readyState === WebSocket.OPEN) terminalSocket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
}
new ResizeObserver(resizeTerminal).observe($("terminal"));
terminal.onData(data => { if (terminalSocket?.readyState === WebSocket.OPEN) terminalSocket.send(JSON.stringify({ type: "input", data })); });

function renderControls(): void {
  const workspace = selected(); if (!workspace) { for (const id of ["send-prompt", "task-open-code", "task-review", "codex-login", "connect-terminal"]) $<HTMLButtonElement>(id).disabled = true; return; }
  $("workspace-name").textContent = workspace.name;
  $("window-title").textContent = workspace.name;
  $("explorer-name").textContent = workspace.name.toUpperCase();
  document.title = `${workspace.name} — Relay`;
  $("workspace-kind").textContent = workspace.kind === "primary" ? "PRIMARY WORKSPACE" : workspace.kind === "agent" ? "PARALLEL AGENT" : "EXPERIMENT";
  $("environment-toggle").textContent = workspace.state === "running" ? "Stop environment" : "Start environment";
  $<HTMLButtonElement>("environment-toggle").disabled = !state.system.docker || (!state.system.imageReady && workspace.state !== "running");
  for (const id of ["experiment-button", "parallel-button"]) { $(id).hidden = workspace.kind !== "primary"; $<HTMLButtonElement>(id).disabled = !!busy() || !state.system.docker; }
  $("review-button").hidden = workspace.kind === "primary"; $<HTMLButtonElement>("review-button").disabled = !!busy() || !!workspace.appliedAt;
  $("discard-button").hidden = workspace.kind === "primary"; $<HTMLButtonElement>("discard-button").disabled = !!busy();
  $<HTMLButtonElement>("send-prompt").disabled = !!busy() || !state.system.docker || !state.system.imageReady;
  $<HTMLButtonElement>("connect-terminal").disabled = workspace.state !== "running";
  $<HTMLButtonElement>("codex-login").disabled = workspace.state !== "running";
  $("runtime-notice").hidden = state.system.docker && state.system.imageReady;
  $("runtime-notice").textContent = state.system.message;
  const run = state.runs.find(run => run.id === selectedRunId);
  $("agent-state").textContent = run?.state ?? "Ready"; $("agent-state").className = `badge ${run?.state ?? ""}`;
  $("cancel-run").hidden = !run || finished.has(run.state);
  if (workspace.state !== "running" && terminalSocket) detachTerminal();
  $("terminal-message").textContent = workspace.state === "running" ? "Connect to open a shell. Log into Codex once before your first task." : "Start the environment to use its terminal.";
  $("terminal-message").hidden = terminalSocket?.readyState === WebSocket.OPEN;
  $("task-open-code").textContent = `Open code · ${workspace.name}`;
  $<HTMLButtonElement>("task-open-code").disabled = workspace.state === "discarded";
  $<HTMLButtonElement>("task-review").disabled = workspace.kind === "primary" || !!busy() || !!workspace.appliedAt || workspace.state === "discarded";
  $("prompt").setAttribute("placeholder", run ? "Continue this conversation…" : "Describe a task…");
  $("send-prompt").textContent = run ? "Continue" : "Run task";
  if (workspace.state === "discarded") for (const id of ["environment-toggle", "send-prompt", "review-button", "discard-button"]) $<HTMLButtonElement>(id).disabled = true;
}
function renderState(): void {
  const workspaces = state.workspaces.filter(workspace => workspace.state !== "discarded");
  $("workspaces").innerHTML = workspaces.length ? workspaces.map(workspace => `<button class="workspace-item ${workspace.id === selectedId ? "selected" : ""} ${workspace.kind !== "primary" ? "child" : ""}" data-workspace="${workspace.id}" title="${escape(workspace.name)}"><span class="workspace-glyph">${workspace.kind === "primary" ? "▣" : workspace.kind === "experiment" ? "◇" : "⑂"}</span><span><strong>${escape(workspace.name)}</strong><small>${workspace.kind === "primary" ? "Primary" : workspace.kind === "agent" ? "Agent" : "Experiment"}${workspace.appliedAt ? " · Applied" : ""}</small></span></button>`).join("") : '<p class="small muted" style="padding:10px">Your projects will appear here.</p>';
  $("welcome").hidden = view !== "code" || !!selectedId; $("workspace-view").hidden = view !== "code" || !selectedId;
  $("workspace-header").hidden = !selectedId;
  for (const id of ["new-file", "refresh-files"]) $<HTMLButtonElement>(id).disabled = !selectedId || selected()?.state === "discarded";
  board.update(state, selectedRunId); reviews.update(state);
  board.activity(state.runs.find(run => run.id === selectedRunId), runEvents.get(selectedRunId) ?? []);
  renderControls();
  if (!selectedId) return;
  const runs = state.runs.filter(run => run.workspaceId === selectedId).reverse();
  const history = $<HTMLSelectElement>("run-history");
  history.innerHTML = runs.length ? runs.map(run => `<option value="${run.id}">${escape((run.title ?? run.prompt).slice(0,48))} · ${run.state}</option>`).join("") : '<option value="">No tasks yet</option>';
  if (!runs.some(run => run.id === selectedRunId)) selectedRunId = runs[0]?.id ?? "";
  history.value = selectedRunId; renderControls(); board.update(state, selectedRunId);
}
async function refresh(): Promise<void> {
  if (!authenticated || refreshing) return;
  refreshing = true;
  try {
    state = await api<State>("/state");
    if (selectedId && !state.workspaces.some(workspace => workspace.id === selectedId)) selectedId = "";
    renderState(); if (selectedRunId) await catchUp(selectedRunId);
  } finally { refreshing = false; }
}
function scheduleRefresh(): void { if (refreshTimer !== undefined) return; refreshTimer = window.setTimeout(() => { refreshTimer = undefined; void action(refresh); }, 300); }
function connectEvents(): void {
  if (!authenticated) return;
  const socket = new WebSocket(socketUrl("/ws/events")); eventSocket = socket;
  socket.onopen = scheduleRefresh;
  socket.onmessage = scheduleRefresh;
  socket.onclose = () => { if (!authenticated) return; window.setTimeout(connectEvents, 2000); };
}

async function chooseWorkspace(id: string): Promise<void> {
  if (id === selectedId) return;
  if (dirty() && !confirm("Discard unsaved editor changes before switching workspaces?")) return;
  detachTerminal(); selectedId = id; selectedRunId = ""; currentFile = ""; documents.clear(); editor.clear();
  delete $("agent-output").dataset.renderKey;
  $("editor").hidden = true; $("editor-placeholder").hidden = false; $("agent-output").innerHTML = '<div class="agent-empty"><h2>No active task</h2><p>Start an environment and sign into Codex to run a task.</p></div>';
  $("approvals").replaceChildren(); renderTabs(); renderState();
  if (selected()?.state !== "discarded") await loadTree(); else $("file-tree").textContent = "This workspace was discarded. Task history is retained.";
  if (selectedRunId) await catchUp(selectedRunId);
  if (selected()?.state === "running") await connectTerminal();
}
$("workspaces").addEventListener("click", event => { const button = (event.target as HTMLElement).closest<HTMLElement>("[data-workspace]"); if (button) void action(() => chooseWorkspace(button.dataset.workspace!)); });

async function loadTree(): Promise<void> { const id = selectedId; const entries = await api<FileEntry[]>(`${workspacePath(id)}/files`); if (id !== selectedId) return; $("file-tree").replaceChildren(tree(entries, id)); }
function tree(entries: FileEntry[], id: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    if (entry.kind === "directory") {
      const details = document.createElement("details"), summary = document.createElement("summary"), children = document.createElement("div");
      summary.className = "tree-row"; summary.textContent = entry.name; details.append(summary, children);
      details.addEventListener("toggle", () => { if (details.open && !children.childNodes.length) void action(async () => { const items = await api<FileEntry[]>(`${workspacePath(id)}/files?path=${encodeURIComponent(entry.path)}`); children.replaceChildren(tree(items, id)); }); });
      fragment.append(details);
    } else {
      const button = document.createElement("button"); button.className = "tree-row"; button.title = entry.path;
      button.dataset.path = entry.path;
      button.innerHTML = `<span>⌑</span><span>${escape(entry.name)}</span>`;
      button.addEventListener("click", () => { if (id === selectedId) void action(() => openFile(entry.path)); }); fragment.append(button);
    }
  }
  return fragment;
}
async function openFile(path: string, reload = false): Promise<void> {
  const id = selectedId;
  if (!documents.has(path) || reload) {
    const file = await api<FileDocument>(`${workspacePath(id)}/file?path=${encodeURIComponent(path)}`);
    if (id !== selectedId) return; documents.set(path, { ...file, saved: file.content });
  }
  currentFile = path; $("editor").hidden = false; $("editor-placeholder").hidden = true;
  editor.open(path, documents.get(path)!.content); renderTabs(); editor.focus(); layout.closeMobileSidebar();
}
function renderTabs(): void {
  $("file-tabs").innerHTML = [...documents.values()].map(document => `<div class="file-tab ${document.path === currentFile ? "active" : ""}" draggable="true" data-file="${escape(document.path)}" title="${escape(document.path)}"><button role="tab" aria-selected="${document.path === currentFile}" tabindex="${document.path === currentFile ? 0 : -1}"><span class="file-symbol">${escape(document.path.split(".").pop()?.slice(0,3) ?? "")}</span>${escape(document.path.split("/").pop()!)}${document.content !== document.saved ? " •" : ""}</button><button class="tab-close" data-close="true" aria-label="Close ${escape(document.path)}">×</button></div>`).join("");
  document.querySelectorAll<HTMLElement>("[data-path]").forEach(row => row.classList.toggle("active", row.dataset.path === currentFile));
  const file = documents.get(currentFile);
  $<HTMLButtonElement>("save-file").disabled = !file || file.content === file.saved;
  $("file-status").textContent = file ? `${file.path}${file.content !== file.saved ? " · Unsaved" : " · Saved"}` : "No file open";
}
async function closeFile(path: string): Promise<void> {
  const file = documents.get(path); if (!file) return;
  if (file.content !== file.saved && !confirm(`Discard unsaved changes to ${path}?`)) return;
  const paths = [...documents.keys()], index = paths.indexOf(path);
  documents.delete(path); editor.forget(path);
  if (currentFile === path) {
    currentFile = "";
    const next = [...documents.keys()][Math.min(index, documents.size - 1)];
    if (next) await openFile(next);
    else { $("editor").hidden = true; $("editor-placeholder").hidden = false; }
  }
  renderTabs();
}
$("file-tabs").addEventListener("click", event => {
  const target = event.target as HTMLElement, tab = target.closest<HTMLElement>("[data-file]");
  if (tab) void action(() => target.closest("[data-close]") ? closeFile(tab.dataset.file!) : openFile(tab.dataset.file!));
});
$("file-tabs").addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "Delete"].includes(event.key)) return;
  const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-file]"); if (!tab) return;
  event.preventDefault();
  if (event.key === "Delete") { void action(() => closeFile(tab.dataset.file!)); return; }
  const paths = [...documents.keys()], index = paths.indexOf(tab.dataset.file!);
  const next = paths[(index + (event.key === "ArrowRight" ? 1 : -1) + paths.length) % paths.length];
  void action(async () => { await openFile(next); $("file-tabs").querySelector<HTMLElement>('[aria-selected="true"]')?.focus(); });
});
let draggedTab = "";
$("file-tabs").addEventListener("dragstart", event => {
  draggedTab = (event.target as HTMLElement).closest<HTMLElement>("[data-file]")?.dataset.file ?? "";
  if (event.dataTransfer) { event.dataTransfer.setData("text/plain", draggedTab); event.dataTransfer.effectAllowed = "move"; }
});
$("file-tabs").addEventListener("dragover", event => {
  if (!draggedTab) return; event.preventDefault();
  $("file-tabs").querySelectorAll(".drop-target").forEach(tab => tab.classList.remove("drop-target"));
  (event.target as HTMLElement).closest("[data-file]")?.classList.add("drop-target");
});
$("file-tabs").addEventListener("drop", event => {
  if (!draggedTab) return; event.preventDefault();
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-file]")?.dataset.file;
  if (target !== draggedTab && documents.has(draggedTab)) {
    const entries = [...documents.entries()], moving = entries.find(([path]) => path === draggedTab)!;
    const rest = entries.filter(([path]) => path !== draggedTab), index = rest.findIndex(([path]) => path === target);
    rest.splice(index < 0 ? rest.length : index, 0, moving); documents.clear(); rest.forEach(([path, value]) => documents.set(path, value));
  }
  draggedTab = ""; renderTabs();
});
$("file-tabs").addEventListener("dragend", () => { draggedTab = ""; $("file-tabs").querySelectorAll(".drop-target").forEach(tab => tab.classList.remove("drop-target")); });
async function saveFile(): Promise<void> {
  const file = documents.get(currentFile), id = selectedId; if (!file) return;
  const content = file.content;
  const saved = await api<FileDocument>(`${workspacePath(id)}/file`, "PUT", { path: file.path, content, version: file.version });
  if (id !== selectedId) return;
  file.saved = content; file.version = saved.version; renderTabs();
}
on("save-file", saveFile); on("refresh-files", loadTree);
on("reload-file", async () => { if (!currentFile) return; const file = documents.get(currentFile)!; if (file.content !== file.saved && !confirm("Discard your unsaved edits and reload this file?")) return; await openFile(currentFile, true); });

type ModalSubmit = (data: FormData) => Promise<void>;
let modalSubmit: ModalSubmit = async () => {};
function modal(title: string, content: string, submitLabel: string, submit: ModalSubmit): void {
  $("modal-title").textContent = title; $("modal-body").innerHTML = content; $("modal-submit").textContent = submitLabel;
  $("modal-error").textContent = ""; $<HTMLButtonElement>("modal-submit").disabled = false;
  $("modal").classList.remove("review-modal"); modalSubmit = submit; $<HTMLDialogElement>("modal").showModal();
}
$("modal-form").addEventListener("submit", event => {
  event.preventDefault(); const button = $<HTMLButtonElement>("modal-submit"); button.disabled = true;
  void modalSubmit(new FormData($<HTMLFormElement>("modal-form"))).then(() => { $<HTMLDialogElement>("modal").close(); }).catch(error => { $("modal-error").textContent = (error as Error).message; }).finally(() => { button.disabled = false; });
});
on("close-modal", () => $<HTMLDialogElement>("modal").close()); on("cancel-modal", () => $<HTMLDialogElement>("modal").close());
function importModal(): void {
  modal("New workspace", '<p>Import a Git repository or leave the URL empty to start fresh.</p><label>Workspace name<input name="name" placeholder="my-project" maxlength="80" required /></label><label>Repository URL<input name="repository" placeholder="https://github.com/you/project.git" maxlength="2048" /></label>', "Create workspace", async data => {
    const workspace = await api<Workspace>("/workspaces", "POST", { name: data.get("name"), repository: data.get("repository") }); await refresh(); await chooseWorkspace(workspace.id);
  });
}
on("new-workspace", importModal); on("welcome-new", importModal);
// Keep the existing + control reachable when the sidebar is hidden on small screens.
const compactNavigation = matchMedia("(max-width: 900px)");
const workspaceButtonHome = $("new-workspace").parentElement!;
function placeWorkspaceButton(): void {
  (compactNavigation.matches ? document.querySelector<HTMLElement>(".topbar")! : workspaceButtonHome).append($("new-workspace"));
}
compactNavigation.addEventListener("change", placeWorkspaceButton); placeWorkspaceButton();
function newTask(): void {
  const projects = state.workspaces.filter(w => w.kind === "primary" && w.state !== "discarded");
  if (!projects.length) { importModal(); return; }
  if (dirty()) { toast("Save your editor changes before creating a task."); return; }
  const parent = selected()?.parentId ?? selectedId;
  modal("New task", `<label>Project<select name="project">${projects.map(w => `<option value="${w.id}" ${w.id === parent ? "selected" : ""}>${escape(w.name)}</option>`).join("")}</select></label><label>Task name<input name="name" placeholder="Add pagination" maxlength="80" required /></label><label>Instructions<textarea name="prompt" placeholder="Describe the change and how to verify it." maxlength="20000" required></textarea></label><label>Execution environment<select name="environment"><option value="isolated">Isolated copy — review before applying</option><option value="current">Primary workspace — edit its files directly</option></select></label><p>${state.system.docker ? "The task queues until execution capacity is available." : "Docker is offline. Isolated copies need Docker; primary workspace tasks can queue until it returns."}</p>`, "Create task", async data => {
    const result = await api<{ workspace: Workspace; run: AgentRun }>(`/workspaces/${data.get("project")}/tasks`, "POST", { name: data.get("name"), prompt: data.get("prompt"), isolated: data.get("environment") === "isolated" });
    await refresh(); await chooseWorkspace(result.workspace.id); selectedRunId = result.run.id; setView("tasks"); renderState(); await catchUp(result.run.id);
  });
}
on("new-task", newTask);
async function fromPrimary(button: string): Promise<void> {
  const primary = state.workspaces.find(w => w.id === (selected()?.parentId ?? selectedId) && w.kind === "primary") ?? state.workspaces.find(w => w.kind === "primary");
  if (!primary) { importModal(); return; }
  await chooseWorkspace(primary.id); if (selectedId !== primary.id) return;
  if ($<HTMLButtonElement>(button).disabled) { toast("Start Docker and finish the primary task before creating a snapshot."); return; }
  $(button).click();
}
on("hub-experiment", () => fromPrimary("experiment-button")); on("hub-parallel", () => fromPrimary("parallel-button"));
on("new-file", () => { const id = selectedId; modal("Create a file", '<label>File path<input name="path" placeholder="src/index.ts" required /></label>', "Create file", async data => { const path = String(data.get("path")); await api(`${workspacePath(id)}/file`, "PUT", { path, content: "", version: null }); if (id === selectedId) { await loadTree(); await openFile(path); } }); });
on("environment-toggle", async () => {
  const workspace = selected()!;
  if (workspace.state === "running" && busy() && !confirm("Stop this environment and cancel its active task?")) return;
  await api(`${workspacePath()}/${workspace.state === "running" ? "stop" : "start"}`, "POST", {}); await refresh();
});
on("experiment-button", () => {
  if (dirty()) { toast("Save your editor changes before taking a snapshot."); return; }
  const id = selectedId;
  modal("New experiment", '<p>Create a separate copy of your current files. Changes here won’t affect the primary workspace until you apply them.</p><label>Experiment name<input name="name" placeholder="Try a different approach" required maxlength="80" /></label>', "Create experiment", async data => {
    const copies = await api<Workspace[]>(`${workspacePath(id)}/experiment`, "POST", { name: data.get("name") }); await refresh(); await chooseWorkspace(copies[0].id); setView("experiments");
  });
});
on("parallel-button", () => {
  if (dirty()) { toast("Save your editor changes before starting parallel tasks."); return; }
  const id = selectedId;
  modal("Parallel tasks", '<p>Both agents start from the same snapshot in separate environments. Tasks wait if your server is at capacity.</p><label>Agent A<textarea name="first" placeholder="Implement the first approach…" required maxlength="20000"></textarea></label><label>Agent B<textarea name="second" placeholder="Explore an alternative, or tackle another task…" required maxlength="20000"></textarea></label>', "Launch agents", async data => {
    const copies = await api<Workspace[]>(`${workspacePath(id)}/parallel`, "POST", { tasks: [{ name: "Agent A", prompt: data.get("first") }, { name: "Agent B", prompt: data.get("second") }] }); await refresh(); await chooseWorkspace(copies[0].id);
  });
});
async function discardWorkspace(id: string): Promise<void> {
  if (id === selectedId && dirty()) { toast("Save or discard editor changes before removing this workspace."); return; }
  if (!confirm("Permanently discard this temporary workspace and its files? Task history will remain.")) return;
  const parentId = state.workspaces.find(w => w.id === id)!.parentId!;
  await api(workspacePath(id), "DELETE");
  if (id === selectedId) { documents.clear(); selectedId = ""; await refresh(); await chooseWorkspace(parentId); } else await refresh();
}
on("discard-button", () => discardWorkspace(selectedId));
for (const id of ["review-button", "task-review"]) on(id, async () => { setView("review"); await reviews.open([selectedId]); });
on("task-open-code", () => showCode(selectedId));
async function showCode(id: string): Promise<void> { await chooseWorkspace(id); if (selectedId === id) setView("code"); }
function setView(next: View): void {
  view = next; $("app").classList.toggle("task-mode", next !== "code");
  for (const name of ["tasks", "experiments", "review"] as const) $(`${name}-view`).hidden = name !== next;
  document.querySelectorAll<HTMLElement>("[data-view]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.view === next)));
  $("sidebar-heading").textContent = next === "code" ? "EXPLORER" : "WORKSPACES";
  (next === "code" ? $("studio") : $("task-conversation")).append($("agent-pane"));
  if (state) renderState();
  requestAnimationFrame(resizeTerminal);
}
document.querySelectorAll<HTMLElement>("[data-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.view as View)));

function detachTerminal(): void { terminalSocket?.close(); terminalSocket = undefined; terminalWorkspace = ""; terminal.reset(); }
async function connectTerminal(): Promise<void> {
  layout.revealTerminal();
  if (terminalSocket?.readyState === WebSocket.OPEN && terminalWorkspace === selectedId) return;
  detachTerminal(); const id = selectedId; terminalWorkspace = id;
  const socket = new WebSocket(socketUrl(`/ws/terminal?workspaceId=${id}`)); terminalSocket = socket;
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => { $("terminal-message").hidden = true; resizeTerminal(); terminal.focus(); resolve(); };
    socket.onerror = () => reject(new Error("Could not connect to the workspace terminal"));
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (terminalSocket !== socket) return;
      if (message.type === "scrollback") { terminal.reset(); terminal.write(message.data); }
      if (message.type === "output") terminal.write(message.data);
      if (message.type === "error") toast(message.error);
      if (message.type === "exit") terminal.writeln(`\r\nShell exited (${message.exitCode}). Reconnect to open another shell.`);
    };
    socket.onclose = () => { if (terminalSocket === socket) { terminalSocket = undefined; terminalWorkspace = ""; } };
  });
}
on("connect-terminal", connectTerminal);
on("codex-login", async () => { setView("code"); await connectTerminal(); terminalSocket!.send(JSON.stringify({ type: "input", data: "codex login --device-auth\r" })); terminal.focus(); });

$("prompt-form").addEventListener("submit", event => {
  event.preventDefault(); void action(async () => {
    const input = $<HTMLTextAreaElement>("prompt"), prompt = input.value.trim(); if (!prompt || busy()) return;
    $<HTMLButtonElement>("send-prompt").disabled = true;
    try { const run = await api<AgentRun>(`${workspacePath()}/runs`, "POST", { prompt }); input.value = ""; selectedRunId = run.id; await refresh(); }
    finally { renderControls(); }
  });
});
$("run-history").addEventListener("change", event => { selectedRunId = (event.target as HTMLSelectElement).value; renderControls(); void action(() => catchUp(selectedRunId)); });
on("cancel-run", async () => { if (!confirm("Cancel this task? Its environment and terminal will stop; files will remain.")) return; await api(`/runs/${selectedRunId}/cancel`, "POST", {}); await refresh(); });

async function catchUp(id: string): Promise<void> {
  if (!id) return;
  const events = runEvents.get(id) ?? []; runEvents.set(id, events);
  for (;;) {
    const batch = await api<RunEvent[]>(`/runs/${id}/events?after=${events.at(-1)?.sequence ?? 0}`);
    for (const event of batch) if (event.sequence > (events.at(-1)?.sequence ?? 0)) events.push(event);
    if (batch.length < 500) break;
  }
  if (id !== selectedRunId) return;
  renderRun(id, events);
  board.activity(state.runs.find(run => run.id === id), events);
  const approvals = await api<Array<{ id: string | number; method: string; params: Record<string, unknown> }>>(`/runs/${id}/approvals`);
  if (id !== selectedRunId) return;
  $("approvals").innerHTML = approvals.map(request => `<div class="approval"><strong>Approval requested</strong><p>${escape(String(request.params.command ?? request.params.reason ?? "Allow the proposed file changes?"))}</p><button data-approval="${escape(String(request.id))}" data-accepted="true">Allow</button><button data-approval="${escape(String(request.id))}" data-accepted="false">Decline</button></div>`).join("");
}
function renderRun(id: string, events: RunEvent[]): void {
  const run = state.runs.find(run => run.id === id); if (!run) return;
  const output = $("agent-output"), nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 80;
  const renderKey = `${id}:${events.at(-1)?.sequence ?? 0}:${run.state}:${run.error ?? ""}`;
  if (output.dataset.renderKey === renderKey) return;
  output.dataset.renderKey = renderKey;
  const expanded = new Set(Array.from(output.querySelectorAll<HTMLDetailsElement>("details[open]")).map(item => item.dataset.item));
  const items = new Map<string, { type: string; text: string; title: string }>();
  for (const event of events) {
    const data = event.data as any;
    if (event.type === "item/agentMessage/delta") {
      const key = data.itemId ?? "message", item = items.get(key) ?? { type: "message", text: "", title: "" }; item.text += data.delta ?? ""; items.set(key, item);
    } else if (event.type === "item/commandExecution/outputDelta") {
      const key = data.itemId ?? "command", item = items.get(key) ?? { type: "tool", text: "", title: "Command" }; item.text += data.delta ?? ""; items.set(key, item);
    } else if ((event.type === "item/started" || event.type === "item/completed") && data.item) {
      const item = data.item;
      if (item.type === "agentMessage") items.set(item.id, { type: "message", text: item.text ?? items.get(item.id)?.text ?? "", title: "" });
      else if (item.type === "commandExecution") items.set(item.id, { type: "tool", title: `${item.command ?? "Command"} · ${item.status ?? "running"}${item.exitCode != null ? ` (${item.exitCode})` : ""}`, text: item.aggregatedOutput ?? items.get(item.id)?.text ?? "" });
      else if (item.type === "fileChange") items.set(item.id, { type: "tool", title: `File changes · ${item.status ?? "pending"}`, text: JSON.stringify(item.changes ?? [], null, 2) });
    } else if (event.type === "adapter/unsupported") items.set(String(event.sequence), { type: "tool", title: "Unsupported Codex request", text: data.method });
  }
  output.innerHTML = `<div class="message user"><span class="message-label">YOU</span>${escape(run.prompt)}</div>` + [...items].map(([key,item]) => item.type === "message" ? `<div class="message"><span class="message-label">CODEX</span>${escape(item.text)}</div>` : `<details class="tool-event" data-item="${escape(key)}" ${expanded.has(key) ? "open" : ""}><summary>${escape(item.title)}</summary><pre>${escape(item.text.slice(-20000))}</pre></details>`).join("") + (run.error ? `<div class="run-error">${escape(run.error)}</div>` : "") + (!items.size && !finished.has(run.state) ? `<p class="small muted">${run.state === "queued" ? "Queued — waiting for available execution capacity." : "Codex is working…"}</p>` : "");
  if (nearBottom) output.scrollTop = output.scrollHeight;
}
$("approvals").addEventListener("click", event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-approval]"); if (button) void action(async () => { button.disabled = true; await api(`/runs/${selectedRunId}/approvals`, "POST", { requestId: button.dataset.approval, accepted: button.dataset.accepted === "true" }); await refresh(); }); });

async function enter(): Promise<void> {
  authenticated = true;
  await refresh(); connectEvents();
  const first = state.workspaces.find(workspace => workspace.kind === "primary" && workspace.state !== "discarded"); if (first) await chooseWorkspace(first.id);
}
commandPalette([
  { label: "Task: New task", run: newTask },
  { label: "View: Tasks", run: () => setView("tasks") },
  { label: "View: Experiments", run: () => setView("experiments") },
  { label: "View: Review changes", run: () => setView("review") },
  { label: "View: Code IDE", run: () => setView("code") },
  { label: "Workspace: New / Clone repository", run: importModal },
  { label: "File: New file", run: () => { setView("code"); $("new-file").click(); }, enabled: () => !!selectedId && selected()?.state !== "discarded" },
  { label: "File: Save", run: () => void action(saveFile), enabled: () => !!currentFile },
  { label: "File: Close editor", run: () => void action(() => closeFile(currentFile)), enabled: () => !!currentFile },
  { label: "View: Toggle sidebar", run: () => layout.toggle("sidebar") },
  { label: "View: Toggle terminal", run: () => layout.toggle("terminal") },
  { label: "View: Toggle Codex panel", run: () => layout.toggle("agent") },
  { label: "View: Move Codex panel to other side", run: () => $("move-agent").click() },
  { label: "View: Reset layout", run: () => layout.reset() },
  { label: "Workspace: New experiment", run: () => $("experiment-button").click(), enabled: () => selected()?.kind === "primary" && !$<HTMLButtonElement>("experiment-button").disabled },
]);
window.addEventListener("beforeunload", event => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
window.setInterval(() => { if (authenticated) scheduleRefresh(); }, 5000);
setView("tasks");
void enter().catch(error => { $("connection-error").hidden = false; $("connection-error").textContent = (error as Error).message; });
