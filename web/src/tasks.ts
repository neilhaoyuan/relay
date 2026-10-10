/** Task board and experiment groups, driven only by persisted runs and real agent events. */
import type { AgentRun, Workspace, RunEvent, SystemStatus } from "@relay/contracts";
export type WorkspaceState = { workspaces: Workspace[]; runs: AgentRun[]; system: SystemStatus };
export const html = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const terminalStates = new Set(["completed", "failed", "cancelled", "interrupted"]);
const el = (id: string) => document.getElementById(id)!;
const labels: Record<string, string> = { queued: "Queued", starting: "Starting", running: "Running", waiting: "Needs approval", stopping: "Stopping", completed: "Completed", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted" };
const date = (value: string) => new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export class TaskBoard {
  private state?: WorkspaceState;
  private selected = "";
  private compared = new Set<string>();
  constructor(private actions: { select: (run: AgentRun) => void; review: (ids: string[]) => void; code: (id: string) => void; discard: (id: string) => void }) {
    for (const id of ["task-search", "task-filter", "task-project"]) el(id).addEventListener(id === "task-search" ? "input" : "change", () => this.render());
    el("task-list").addEventListener("click", event => {
      const id = (event.target as HTMLElement).closest<HTMLElement>("[data-run]")?.dataset.run;
      const run = this.state?.runs.find(run => run.id === id); if (run) this.actions.select(run);
    });
    el("experiment-list").addEventListener("click", event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-experiment-action]"); if (!button) return;
      const id = button.dataset.workspace!;
      if (button.dataset.experimentAction === "review") this.actions.review([id]);
      if (button.dataset.experimentAction === "code") this.actions.code(id);
      if (button.dataset.experimentAction === "discard") this.actions.discard(id);
      if (button.dataset.experimentAction === "task") { const run = this.state?.runs.filter(run => run.workspaceId === id).at(-1); if (run) this.actions.select(run); }
    });
    el("experiment-list").addEventListener("change", event => {
      const input = event.target as HTMLInputElement; if (!input.dataset.compare) return;
      if (input.checked && this.compared.size < 2) this.compared.add(input.dataset.compare); else this.compared.delete(input.dataset.compare);
      this.renderExperiments();
    });
    el("compare-experiments").onclick = () => this.actions.review([...this.compared]);
  }
  update(state: WorkspaceState, selectedRun: string): void {
    this.state = state; this.selected = selectedRun;
    const select = el("task-project") as HTMLSelectElement, current = select.value;
    const options = '<option value="all">All projects</option>' + state.workspaces.filter(w => w.kind === "primary" && w.state !== "discarded").map(w => `<option value="${w.id}">${html(w.name)}</option>`).join("");
    if (select.innerHTML !== options) { select.innerHTML = options; select.value = state.workspaces.some(w => w.id === current) ? current : "all"; }
    this.render(); this.renderExperiments();
  }
  activity(run: AgentRun | undefined, events: RunEvent[]): void {
    if (!run) { el("task-detail-title").textContent = "New task"; el("task-detail-status").textContent = "Use New task to choose a project and execution environment."; return; }
    el("task-detail-title").textContent = run.title ?? run.prompt;
    const commands = new Map<string, { command: string; status: string; exitCode?: number }>();
    for (const event of events) {
      const data = event.data as { item?: { id: string; type: string; command: string; status: string; exitCode?: number } };
      if ((event.type === "item/started" || event.type === "item/completed") && data.item?.type === "commandExecution") commands.set(data.item.id, data.item);
    }
    const running = [...commands.values()].find(command => command.status === "inProgress");
    const exited = [...commands.values()].filter(command => command.exitCode != null), failed = exited.filter(command => command.exitCode !== 0);
    el("task-detail-status").textContent = `${labels[run.state]} · ${date(run.createdAt)}${!terminalStates.has(run.state) && running ? ` · Executing: ${running.command}` : exited.length ? ` · ${exited.length} command${exited.length === 1 ? "" : "s"} exited, ${failed.length} with nonzero exit codes` : ""}`;
  }
  private render(): void {
    if (!this.state) return;
    const { workspaces, runs } = this.state;
    const query = (el("task-search") as HTMLInputElement).value.toLowerCase(), filter = (el("task-filter") as HTMLSelectElement).value, project = (el("task-project") as HTMLSelectElement).value;
    const active = runs.filter(run => !terminalStates.has(run.state) && run.state !== "queued").length;
    el("task-summary").innerHTML = `<span><strong>${active}</strong> Active</span><span><strong>${runs.filter(r => r.state === "queued").length}</strong> Queued</span><span><strong>${runs.filter(r => r.state === "waiting").length}</strong> Need approval</span><span><strong>${workspaces.filter(w => w.parentId && !w.appliedAt && w.state !== "discarded").length}</strong> Unapplied copies</span>`;
    const visible = runs.filter(run => {
      const w = workspaces.find(w => w.id === run.workspaceId);
      return (project === "all" || (w?.parentId ?? w?.id) === project)
        && `${run.title ?? ""} ${run.prompt} ${w?.name ?? ""}`.toLowerCase().includes(query)
        && (filter === "all" || filter === "active" && !terminalStates.has(run.state) && run.state !== "queued" || filter === "failed" && ["failed", "interrupted"].includes(run.state) || run.state === filter);
    }).sort((a, b) => {
      const priority = (r: AgentRun) => r.state === "waiting" ? 0 : !terminalStates.has(r.state) ? 1 : 2;
      return priority(a) - priority(b) || b.createdAt.localeCompare(a.createdAt);
    });
    const content = visible.map(run => {
      const w = workspaces.find(w => w.id === run.workspaceId);
      return `<button class="task-card ${run.id === this.selected ? "selected" : ""}" data-run="${run.id}" aria-pressed="${run.id === this.selected}"><span class="task-card-top"><span class="run-badge ${run.state}">${labels[run.state]}</span><time>${html(date(run.createdAt))}</time></span><strong>${html(run.title ?? run.prompt)}</strong><span class="task-card-workspace">${html(w?.name ?? "Removed workspace")}${w?.state === "discarded" ? " · discarded" : w?.appliedAt ? " · applied" : ""}</span>${run.error ? `<span class="task-card-error">${html(run.error)}</span>` : ""}</button>`;
    }).join("") || `<div class="hub-empty"><h2>${runs.length ? "No matching tasks" : "No tasks yet"}</h2><p>${runs.length ? "Change the search or status filter." : "Create a workspace, then assign a task. Its activity and result will appear here."}</p></div>`;
    if (el("task-list").innerHTML !== content) el("task-list").innerHTML = content;
  }
  private renderExperiments(): void {
    if (!this.state) return;
    const children = this.state.workspaces.filter(w => w.parentId && w.state !== "discarded");
    const busy = (id: string) => this.state!.runs.some(r => r.workspaceId === id && !terminalStates.has(r.state));
    for (const id of this.compared) if (!children.some(w => w.id === id && !w.appliedAt && !busy(id))) this.compared.delete(id);
    const compare = el("compare-experiments") as HTMLButtonElement; compare.disabled = this.compared.size !== 2; compare.textContent = `Compare changes (${this.compared.size}/2)`;
    const groups = new Map<string, Workspace[]>();
    for (const w of children) { const key = w.groupId ?? w.id; groups.set(key, [...(groups.get(key) ?? []), w]); }
    const content = [...groups.values()].reverse().map(group => {
      const parent = this.state!.workspaces.find(w => w.id === group[0].parentId);
      return `<section class="experiment-group"><h2>${html(parent?.name ?? "Project")} <span>${group[0].groupId && group.length > 1 ? "Parallel attempts" : "Experiment"} · ${html(date(group[0].createdAt))}</span></h2><div class="experiment-cards">${group.map(w => {
        const run = this.state!.runs.filter(r => r.workspaceId === w.id).at(-1), unavailable = busy(w.id), reviewable = !unavailable && !w.appliedAt;
        return `<article class="experiment-card"><header><h3>${html(w.name)}</h3><span class="run-badge ${run?.state ?? ""}">${w.appliedAt ? "Applied" : run ? labels[run.state] : "No task"}</span></header><p>${html(run?.prompt ?? "Manual experiment. Open the code or assign a task in this workspace.")}</p><small>Independent source copy</small><div class="experiment-actions"><button data-experiment-action="task" data-workspace="${w.id}" ${!run ? "disabled" : ""}>View task</button><button data-experiment-action="review" data-workspace="${w.id}" ${!reviewable ? "disabled" : ""}>Review</button><button data-experiment-action="code" data-workspace="${w.id}">Code</button><button data-experiment-action="discard" data-workspace="${w.id}" ${unavailable ? "disabled" : ""}>Discard</button></div><label class="compare-choice"><input type="checkbox" data-compare="${w.id}" ${this.compared.has(w.id) ? "checked" : ""} ${!reviewable || this.compared.size >= 2 && !this.compared.has(w.id) ? "disabled" : ""} />Compare changes</label></article>`;
      }).join("")}</div></section>`;
    }).join("") || '<div class="hub-empty"><h2>No experiments yet</h2><p>Create an isolated task, a manual experiment, or parallel attempts from a primary workspace.</p></div>';
    if (el("experiment-list").innerHTML !== content) el("experiment-list").innerHTML = content;
  }
}
