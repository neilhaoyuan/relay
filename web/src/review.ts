/** File-by-file patch review and two-attempt comparison; application always uses the server's conflict guards. */
import type { ChangeProposal } from "@relay/contracts";
import { api } from "./api";
import { html, terminalStates, type WorkspaceState } from "./tasks";
type PatchFile = { path: string; deleted: boolean; binary: boolean; lines: string[] };
const el = (id: string) => document.getElementById(id)!;

function filesIn(patch: string): PatchFile[] {
  return patch.split(/(?=^diff --git )/m).filter(part => part.startsWith("diff --git ")).map(part => {
    const lines = part.split("\n"), before = lines.find(line => line.startsWith("--- "))?.slice(4), after = lines.find(line => line.startsWith("+++ "))?.slice(4);
    let path = (after && after !== "/dev/null" ? after : before)?.replace(/\t.*$/, "");
    if (path?.startsWith('"')) { try { path = JSON.parse(path); } catch { /* Keep a readable raw label for unusual Git quoting. */ } }
    path = path?.replace(/^[ab]\//, "") ?? lines[0].replace(/^diff --git a\//, "").split(" b/")[0];
    return { path, deleted: after === "/dev/null" || lines.some(line => line.startsWith("deleted file mode")), binary: lines.some(line => line === "GIT binary patch" || line.startsWith("Binary files ")), lines };
  });
}

function diffTable(file: PatchFile): string {
  if (file.binary) return '<p class="diff-note">Binary file changed. Download the patch or inspect the file in its environment.</p>';
  const rows: string[] = []; let old = 0, current = 0, inHunk = false;
  let removed: Array<[number, string]> = [], added: Array<[number, string]> = [];
  const row = (a?: [number, string], b?: [number, string], changed = false) => `<tr><td class="line-number">${a?.[0] ?? ""}</td><td class="${changed && a ? "diff-remove" : ""}"><pre>${html(a?.[1] ?? "")}</pre></td><td class="line-number">${b?.[0] ?? ""}</td><td class="${changed && b ? "diff-add" : ""}"><pre>${html(b?.[1] ?? "")}</pre></td></tr>`;
  const flush = () => { for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push(row(removed[i], added[i], true)); removed = []; added = []; };
  let truncated = false;
  for (const line of file.lines) {
    if (rows.length + removed.length + added.length >= 2000) { truncated = true; break; }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { flush(); old = Number(hunk[1]); current = Number(hunk[2]); inHunk = true; rows.push(`<tr class="diff-hunk"><td colspan="4">${html(line)}</td></tr>`); }
    else if (inHunk && line.startsWith("-")) removed.push([old++, line.slice(1)]);
    else if (inHunk && line.startsWith("+")) added.push([current++, line.slice(1)]);
    else if (inHunk && line.startsWith(" ")) { flush(); rows.push(row([old++, line.slice(1)], [current++, line.slice(1)])); }
    else if (inHunk && line.startsWith("\\")) { flush(); rows.push(`<tr class="diff-hunk"><td colspan="4">${html(line)}</td></tr>`); }
  }
  flush();
  return (rows.length ? `<div class="diff-scroll"><table class="split-diff"><colgroup><col style="width:34px"><col><col style="width:34px"><col></colgroup><thead><tr><th colspan="2">Snapshot</th><th colspan="2">Result</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>` : `<pre class="diff-note">${html(file.lines.slice(0, 20).join("\n"))}</pre>`) + (truncated ? '<p class="diff-note">Preview limited to 2,000 lines. Download the complete patch below.</p>' : "");
}

export class ChangeReview {
  private state?: WorkspaceState;
  private generation = 0;
  private proposals = new Map<string, ChangeProposal>();
  private selectedFiles = new Map<string, number>();
  private applying = new Set<string>();
  private loads = new Map<string, number>();
  constructor(private actions: { apply: (proposal: ChangeProposal) => Promise<void>; code: (id: string, path?: string) => void; error: (message: string) => void }) {
    el("load-review").onclick = () => { const id = (el("review-target") as HTMLSelectElement).value; if (id) void this.open([id]); };
    el("review-panels").addEventListener("click", event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-review-action]"); if (!button) return;
      const id = button.closest<HTMLElement>("[data-review-workspace]")!.dataset.reviewWorkspace!;
      const proposal = this.proposals.get(id);
      const action = button.dataset.reviewAction;
      if (action === "refresh") { void this.reload(id); return; }
      if (!proposal) return;
      if (action === "file") { this.selectedFiles.set(id, Number(button.dataset.index)); this.render(id, proposal); }
      if (action === "code") { const file = filesIn(proposal.patch)[this.selectedFiles.get(id) ?? 0]; this.actions.code(id, file && !file.deleted && !file.binary ? file.path : undefined); }
      if (action === "download") {
        const url = URL.createObjectURL(new Blob([proposal.patch], { type: "text/plain" })), link = document.createElement("a");
        link.href = url; link.download = `relay-${id}.patch`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      if (action === "apply") {
        if (this.applying.has(id)) return;
        this.applying.add(id); button.disabled = true;
        void this.actions.apply(proposal).catch(error => { this.actions.error((error as Error).message); const message = this.card(id)?.querySelector<HTMLElement>(".review-error"); if (message) message.textContent = (error as Error).message; }).finally(() => { this.applying.delete(id); this.updateButtons(); });
      }
    });
  }
  update(state: WorkspaceState): void {
    this.state = state;
    const select = el("review-target") as HTMLSelectElement, current = select.value;
    select.innerHTML = '<option value="">Select an experiment…</option>' + state.workspaces.filter(w => w.parentId && w.state !== "discarded" && !w.appliedAt).map(w => `<option value="${w.id}">${html(w.name)}</option>`).join("");
    select.value = state.workspaces.some(w => w.id === current && !w.appliedAt && w.state !== "discarded") ? current : "";
    this.updateButtons();
  }
  async open(ids: string[]): Promise<void> {
    const generation = ++this.generation; this.proposals.clear(); this.selectedFiles.clear();
    const panels = el("review-panels"); panels.classList.toggle("comparing", ids.length > 1);
    panels.innerHTML = ids.slice(0, 2).map(id => `<article class="review-card" data-review-workspace="${html(id)}"><p class="diff-note">Loading review…</p></article>`).join("");
    if (ids.length === 1) (el("review-target") as HTMLSelectElement).value = ids[0];
    await Promise.all(ids.slice(0, 2).map(id => this.load(id, generation)));
  }
  private card(id: string): HTMLElement | undefined { return Array.from(el("review-panels").querySelectorAll<HTMLElement>("[data-review-workspace]")).find(card => card.dataset.reviewWorkspace === id); }
  private async reload(id: string): Promise<void> { await this.load(id, this.generation); }
  private async load(id: string, generation: number): Promise<void> {
    const card = this.card(id); if (!card) return;
    const load = (this.loads.get(id) ?? 0) + 1; this.loads.set(id, load);
    card.innerHTML = '<p class="diff-note">Capturing changes…</p>';
    try {
      const proposal = await api<ChangeProposal>(`/workspaces/${id}/review`, "POST", {});
      if (generation !== this.generation || this.loads.get(id) !== load) return;
      this.proposals.set(id, proposal); this.render(id, proposal);
    } catch (error) {
      if (generation !== this.generation || this.loads.get(id) !== load || !this.card(id)) return;
      this.card(id)!.innerHTML = `<h2>${html(this.state?.workspaces.find(w => w.id === id)?.name ?? "Experiment")}</h2><p class="review-error">${html((error as Error).message)}</p><button data-review-action="refresh">Retry review</button>`;
    }
  }
  private render(id: string, proposal: ChangeProposal): void {
    const card = this.card(id); if (!card) return;
    const workspace = this.state?.workspaces.find(w => w.id === id), parent = this.state?.workspaces.find(w => w.id === proposal.parentId);
    const files = filesIn(proposal.patch), index = Math.min(this.selectedFiles.get(id) ?? 0, Math.max(0, files.length - 1)); this.selectedFiles.set(id, index);
    card.innerHTML = `<header class="review-card-heading"><div><h2>${html(workspace?.name ?? "Experiment")}</h2><p>Apply to ${html(parent?.name ?? "primary workspace")}</p></div><button data-review-action="refresh">Refresh diff</button></header><pre class="review-summary">${html(proposal.summary || "No changes")}</pre><div class="review-file-list" aria-label="Changed files">${files.map((file, i) => `<button data-review-action="file" data-index="${i}" aria-pressed="${i === index}" class="${i === index ? "selected" : ""}">${html(file.path)}${file.binary ? " · binary" : file.deleted ? " · deleted" : ""}</button>`).join("")}</div><div class="review-diff">${files[index] ? diffTable(files[index]) : '<p class="diff-note">This copy matches its starting snapshot.</p>'}</div><p class="review-error" role="alert"></p><footer class="review-actions"><button data-review-action="code">Open code</button><button data-review-action="download" ${!proposal.patch ? "disabled" : ""}>Download patch</button><button data-review-action="apply" class="primary">Apply to primary</button></footer><p class="review-footnote">Applies this entire diff. Does not commit or push. Both the source and primary are checked for changes.</p>`;
    this.updateButtons();
  }
  private updateButtons(): void {
    if (!this.state) return;
    for (const [id, proposal] of this.proposals) {
      const workspace = this.state.workspaces.find(w => w.id === id), parent = this.state.workspaces.find(w => w.id === proposal.parentId);
      const busy = this.state.runs.some(run => [id, proposal.parentId].includes(run.workspaceId) && !terminalStates.has(run.state));
      const button = this.card(id)?.querySelector<HTMLButtonElement>('[data-review-action="apply"]');
      if (button) { button.disabled = this.applying.has(id) || !proposal.patch || busy || !!proposal.appliedAt || !!workspace?.appliedAt || workspace?.state === "discarded" || !parent; button.textContent = workspace?.appliedAt || proposal.appliedAt ? "Applied" : this.applying.has(id) ? "Applying…" : busy ? "Wait for tasks to finish" : "Apply to primary"; }
    }
  }
}
