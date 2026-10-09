/** Browser workspace controller: IDE files, container controls, agent history, and manual experiments. */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { Workspace, AgentRun, RunEvent, FileEntry, FileDocument, ChangeProposal, SystemStatus } from "@relay/contracts";
import { api, socketUrl } from "./api";
import { CodeEditor } from "./editor";
import "./style.css";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
type State = { workspaces: Workspace[]; runs: AgentRun[]; system: SystemStatus };
let state: State, selectedId = "", selectedRunId = "", currentFile = "";
let authenticated = false, eventSocket: WebSocket | undefined, terminalSocket: WebSocket | undefined;
let terminalWorkspace = "", refreshTimer: number | undefined, refreshing = false;
const documents = new Map<string, FileDocument & { saved: string }>();
const runEvents = new Map<string, RunEvent[]>();
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
const terminal = new Terminal({ theme: { background: "#13171d", foreground: "#c5d2df", cursor: "#a2e5cb" }, fontSize: 12, fontFamily: "'Cascadia Code', Consolas, monospace", cursorBlink: true, scrollback: 4000 });
const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open($("terminal"));
function resizeTerminal(): void {
  if ($("terminal").clientWidth < 10 || $("terminal").clientHeight < 10) return;
  fit.fit(); if (terminalSocket?.readyState === WebSocket.OPEN) terminalSocket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
}
new ResizeObserver(resizeTerminal).observe($("terminal"));
terminal.onData(data => { if (terminalSocket?.readyState === WebSocket.OPEN) terminalSocket.send(JSON.stringify({ type: "input", data })); });

function renderControls(): void {
  const workspace = selected(); if (!workspace) return;
  $("workspace-name").textContent = workspace.name;
  $("workspace-kind").textContent = workspace.kind === "primary" ? "PRIMARY WORKSPACE" : workspace.kind === "agent" ? "PARALLEL AGENT" : "EXPERIMENT";
  $("environment-state").textContent = workspace.state; $("environment-state").className = `badge ${workspace.state}`;
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
}
function renderState(): void {
  const workspaces = state.workspaces.filter(workspace => workspace.state !== "discarded");
  $("workspaces").innerHTML = workspaces.length ? workspaces.map(workspace => `<button class="workspace-item ${workspace.id === selectedId ? "selected" : ""} ${workspace.kind !== "primary" ? "child" : ""}" data-workspace="${workspace.id}" title="${escape(workspace.name)}"><span class="workspace-glyph">${workspace.kind === "primary" ? "▣" : workspace.kind === "experiment" ? "◇" : "⑂"}</span><span><strong>${escape(workspace.name)}</strong><small>${workspace.kind} · ${workspace.state}${workspace.appliedAt ? " · applied" : ""}</small></span></button>`).join("") : '<p class="small muted" style="padding:10px">Your projects will appear here.</p>';
  $("system-status").innerHTML = `<span class="status-dot"></span>${state.system.docker ? "Docker connected" : "Docker unavailable"}<br><span class="muted">${state.system.hostCpus} CPUs · ${(state.system.hostMemoryMb / 1024).toFixed(1)} GB RAM<br>${state.runs.filter(run => !finished.has(run.state) && run.state !== "queued").length} / ${state.system.maxAgents} active agents</span>`;
  $("welcome").hidden = !!selectedId; $("workspace-view").hidden = !selectedId;
  if (!selectedId) return;
  renderControls();
  const runs = state.runs.filter(run => run.workspaceId === selectedId).reverse();
  const history = $<HTMLSelectElement>("run-history");
  history.innerHTML = runs.length ? runs.map(run => `<option value="${run.id}">${escape(run.prompt.slice(0,48))} · ${run.state}</option>`).join("") : '<option value="">No tasks yet</option>';
  if (!runs.some(run => run.id === selectedRunId)) selectedRunId = runs[0]?.id ?? "";
  history.value = selectedRunId; renderControls();
}
async function refresh(): Promise<void> {
  if (!authenticated || refreshing) return;
  refreshing = true;
  try {
    state = await api<State>("/state");
    if (selectedId && !state.workspaces.some(workspace => workspace.id === selectedId && workspace.state !== "discarded")) selectedId = "";
    renderState(); if (selectedRunId) await catchUp(selectedRunId);
    $("footer-status").textContent = `Relay / ${state.workspaces.filter(workspace => workspace.state !== "discarded").length} workspaces`;
  } finally { refreshing = false; }
}
function scheduleRefresh(): void { if (refreshTimer !== undefined) return; refreshTimer = window.setTimeout(() => { refreshTimer = undefined; void action(refresh); }, 300); }
function connectEvents(): void {
  if (!authenticated) return;
  const socket = new WebSocket(socketUrl("/ws/events")); eventSocket = socket;
  socket.onopen = () => { $("connection").textContent = "● Connected"; scheduleRefresh(); };
  socket.onmessage = scheduleRefresh;
  socket.onclose = () => { if (!authenticated) return; $("connection").textContent = "Reconnecting…"; window.setTimeout(connectEvents, 2000); };
}

async function chooseWorkspace(id: string): Promise<void> {
  if (id === selectedId) return;
  if (dirty() && !confirm("Discard unsaved editor changes before switching workspaces?")) return;
  detachTerminal(); selectedId = id; selectedRunId = ""; currentFile = ""; documents.clear();
  $("editor").hidden = true; $("editor-placeholder").hidden = false; $("agent-output").innerHTML = '<div class="agent-empty"><span class="agent-orbit">✳</span><h2>What are we building?</h2><p>Start the environment, log into Codex, and give it a task.</p></div>';
  $("approvals").replaceChildren(); renderTabs(); renderState();
  await loadTree(); if (selectedRunId) await catchUp(selectedRunId);
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
  editor.open(path, documents.get(path)!.content); renderTabs(); editor.focus();
}
function renderTabs(): void {
  $("file-tabs").innerHTML = [...documents.values()].map(document => `<button class="file-tab ${document.path === currentFile ? "active" : ""}" data-file="${escape(document.path)}" title="${escape(document.path)}">${escape(document.path.split("/").pop()!)}${document.content !== document.saved ? " •" : ""}</button>`).join("");
  const file = documents.get(currentFile);
  $<HTMLButtonElement>("save-file").disabled = !file || file.content === file.saved;
  $("file-status").textContent = file ? `${file.path}${file.content !== file.saved ? " · Unsaved" : " · Saved"}` : "No file open";
}
$("file-tabs").addEventListener("click", event => { const button = (event.target as HTMLElement).closest<HTMLElement>("[data-file]"); if (button) void action(() => openFile(button.dataset.file!)); });
async function saveFile(): Promise<void> {
  const file = documents.get(currentFile), id = selectedId; if (!file) return;
  const content = file.content;
  const saved = await api<FileDocument>(`${workspacePath(id)}/file`, "PUT", { path: file.path, content, version: file.version });
  if (id !== selectedId) return;
  file.saved = content; file.version = saved.version; renderTabs(); toast("File saved");
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
  modal("A new place to build", '<p>Import a Git repository or leave the URL empty to start fresh.</p><label>Workspace name<input name="name" placeholder="my-next-project" maxlength="80" required /></label><label>Repository URL<input name="repository" placeholder="https://github.com/you/project.git" maxlength="2048" /></label>', "Create workspace", async data => {
    const workspace = await api<Workspace>("/workspaces", "POST", { name: data.get("name"), repository: data.get("repository") }); await refresh(); await chooseWorkspace(workspace.id);
  });
}
on("new-workspace", importModal); on("welcome-new", importModal);
on("new-file", () => { const id = selectedId; modal("Create a file", '<label>File path<input name="path" placeholder="src/index.ts" required /></label>', "Create file", async data => { const path = String(data.get("path")); await api(`${workspacePath(id)}/file`, "PUT", { path, content: "", version: null }); if (id === selectedId) { await loadTree(); await openFile(path); } }); });
on("environment-toggle", async () => {
  const workspace = selected()!;
  if (workspace.state === "running" && busy() && !confirm("Stop this environment and cancel its active task?")) return;
  await api(`${workspacePath()}/${workspace.state === "running" ? "stop" : "start"}`, "POST", {}); await refresh();
});
on("experiment-button", () => {
  if (dirty()) { toast("Save your editor changes before taking a snapshot."); return; }
  const id = selectedId;
  modal("Try something different", '<p>Create a separate copy of your current files. Changes here won’t affect the primary workspace until you apply them.</p><label>Experiment name<input name="name" placeholder="Try a different approach" required maxlength="80" /></label>', "Create experiment", async data => {
    const copies = await api<Workspace[]>(`${workspacePath(id)}/experiment`, "POST", { name: data.get("name") }); await refresh(); await chooseWorkspace(copies[0].id);
  });
});
on("parallel-button", () => {
  if (dirty()) { toast("Save your editor changes before starting parallel tasks."); return; }
  const id = selectedId;
  modal("Two agents. Two approaches.", '<p>Both agents start from the same snapshot in separate environments. Tasks wait if your server is at capacity.</p><label>Agent A<textarea name="first" placeholder="Implement the first approach…" required maxlength="20000"></textarea></label><label>Agent B<textarea name="second" placeholder="Explore an alternative, or tackle another task…" required maxlength="20000"></textarea></label>', "Launch agents", async data => {
    const copies = await api<Workspace[]>(`${workspacePath(id)}/parallel`, "POST", { tasks: [{ name: "Agent A", prompt: data.get("first") }, { name: "Agent B", prompt: data.get("second") }] }); await refresh(); await chooseWorkspace(copies[0].id);
  });
});
on("discard-button", async () => { if (!confirm("Permanently discard this temporary workspace and its files? Task history will remain.")) return; const parentId = selected()!.parentId!; await api(workspacePath(), "DELETE"); documents.clear(); selectedId = ""; await refresh(); await chooseWorkspace(parentId); });
on("review-button", async () => {
  const proposal = await api<ChangeProposal>(`${workspacePath()}/review`, "POST", {});
  modal("Review this experiment", `<p>Applying these changes requires the primary workspace to match the original snapshot. No changes are committed or pushed automatically.</p><div class="review-summary">${escape(proposal.summary || "No changes")}</div><pre class="review-patch">${escape(proposal.patch || "This workspace matches its starting point.")}</pre>`, "Apply to primary", async () => { await api(`/changes/${proposal.id}/apply`, "POST", {}); await refresh(); toast("Changes applied to the primary workspace"); });
  $("modal").classList.add("review-modal"); $<HTMLButtonElement>("modal-submit").disabled = !proposal.patch;
});

function detachTerminal(): void { terminalSocket?.close(); terminalSocket = undefined; terminalWorkspace = ""; terminal.reset(); }
async function connectTerminal(): Promise<void> {
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
on("codex-login", async () => { await connectTerminal(); terminalSocket!.send(JSON.stringify({ type: "input", data: "codex login --device-auth\r" })); terminal.focus(); });

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
  const expanded = new Set([...output.querySelectorAll<HTMLDetailsElement>("details[open]")].map(item => item.dataset.item));
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
  authenticated = true; $("login").hidden = true; $("app").hidden = false;
  await refresh(); connectEvents();
  const first = state.workspaces.find(workspace => workspace.kind === "primary" && workspace.state !== "discarded"); if (first) await chooseWorkspace(first.id);
}
$("login-form").addEventListener("submit", event => {
  event.preventDefault(); void (async () => { try { await api("/session", "POST", { token: $<HTMLInputElement>("login-token").value }); $<HTMLInputElement>("login-token").value = ""; await enter(); } catch (error) { $("login-error").textContent = (error as Error).message; } })();
});
on("logout", async () => { if (dirty() && !confirm("Sign out and discard unsaved editor changes?")) return; await api("/session", "DELETE"); authenticated = false; eventSocket?.close(); detachTerminal(); location.reload(); });
window.addEventListener("beforeunload", event => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
window.setInterval(() => { if (authenticated) scheduleRefresh(); }, 5000);
void api<{ authenticated: boolean }>("/session").then(async session => { if (session.authenticated) await enter(); else $("login").hidden = false; }).catch(error => { $("login").hidden = false; $("login-error").textContent = (error as Error).message; });
