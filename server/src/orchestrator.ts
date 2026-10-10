/** Shared application service: resource admission, runs, experiments, recovery, and promotion. */
import { randomUUID } from "node:crypto";
import type { Workspace, AgentRun, ChangeProposal, RunState } from "@relay/contracts";
import { Store } from "./store.js";
import { Files, conflict } from "./files.js";
import type { ContainerRuntime } from "./runtime.js";
import { CodexSession, type RpcRequest } from "./codex.js";
import type { Config } from "./config.js";

const terminal = new Set<RunState>(["completed", "failed", "cancelled", "interrupted"]);
const now = () => new Date().toISOString();
export class Orchestrator {
  private chain: Promise<unknown> = Promise.resolve();
  private active = new Map<string, { session: CodexSession; timer: NodeJS.Timeout; requests: Map<string, RpcRequest> }>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private recovered = false;
  private closing = false;
  constructor(readonly store: Store, readonly files: Files, readonly runtime: ContainerRuntime, readonly config: Config) {}
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work); this.chain = result.catch(() => {}); return result;
  }
  workspaces(): Workspace[] { return this.store.list<Workspace>("workspace"); }
  runs(): AgentRun[] { return this.store.list<AgentRun>("run"); }
  busy(id: string): boolean { return this.runs().some(run => run.workspaceId === id && !terminal.has(run.state)); }
  private live(id: string): Workspace {
    const workspace = this.store.workspace(id);
    if (workspace.state === "discarded") throw conflict("Workspace has been discarded");
    return workspace;
  }
  private save(workspace: Workspace): Workspace { this.store.put("workspace", workspace.id, workspace); return workspace; }
  private state(run: AgentRun, state: RunState, error: string | null = null): void {
    run.state = state; run.error = error;
    if (terminal.has(state)) run.finishedAt = now();
    this.store.put("run", run.id, run);
    this.store.event(run.id, "run/state", { state, error });
  }
  private workspace(name: string, repository = ""): Workspace {
    return { id: randomUUID(), name, repository, kind: "primary", parentId: null, groupId: null, state: "stopped", createdAt: now(), baseFingerprint: null, baselineRevision: null, threadId: null, appliedAt: null };
  }
  async import(name: string, repository: string): Promise<Workspace> {
    return this.exclusive(async () => {
      const workspace = this.workspace(name, repository);
      // Record intent before touching the filesystem so failed imports remain recoverable.
      this.store.put("operation", workspace.id, { type: "import", workspaceId: workspace.id, state: "pending" });
      try {
        await this.files.import(workspace.id, repository);
        this.save(workspace);
        this.store.put("operation", workspace.id, { state: "completed" });
        return workspace;
      } catch (error) { this.store.put("operation", workspace.id, { type: "import", workspaceId: workspace.id, state: "failed", error: String(error) }); throw error; }
    });
  }
  async start(id: string): Promise<Workspace> { return this.exclusive(() => this.startUnlocked(id)); }
  private async startUnlocked(id: string): Promise<Workspace> {
    const workspace = this.live(id), containers = await this.runtime.list();
    if (this.runs().some(run => run.workspaceId === id && run.state === "stopping")) throw conflict("Waiting for Docker to confirm the previous task stopped");
    const active = containers.filter(item => ["running", "paused", "restarting"].includes(item.state));
    if (!active.some(item => item.workspaceId === id)) {
      const memoryCapacity = Math.max(0, this.config.hostMemoryMb - 1536);
      if (active.length >= this.config.maxEnvironments || (active.length + 1) * this.config.memoryMb > memoryCapacity || (active.length + 1) * this.config.cpus > this.config.hostCpus) {
        throw conflict("Environment capacity reached. Stop an idle environment to free resources.");
      }
    }
    await this.runtime.start(id);
    return this.save({ ...this.store.workspace(id), state: "running" });
  }
  async stop(id: string): Promise<Workspace> {
    return this.exclusive(async () => {
      const workspace = this.live(id);
      await this.runtime.stop(id);
      for (const run of this.runs().filter(run => run.workspaceId === id && !terminal.has(run.state))) this.state(run, "cancelled");
      this.disposeWorkspace(id);
      return this.save({ ...this.store.workspace(id), state: "stopped" });
    });
  }
  private disposeWorkspace(id: string): void {
    for (const [runId, value] of this.active) if (this.store.run(runId).workspaceId === id) { clearTimeout(value.timer); this.active.delete(runId); value.session.dispose(); }
  }
  async copies(sourceId: string, tasks: Array<{ name: string; prompt?: string }>): Promise<Workspace[]> {
    return this.exclusive(async () => {
      const source = this.live(sourceId);
      if (source.kind !== "primary") throw conflict("Create experiments and parallel tasks from a primary workspace");
      if (this.busy(sourceId)) throw conflict("Wait for the source agent to finish before taking a snapshot");
      const groupId = tasks.some(task => task.prompt) ? randomUUID() : null;
      const copies = tasks.map(task => ({ ...this.workspace(task.name, source.repository), kind: task.prompt ? "agent" as const : "experiment" as const, parentId: source.id, groupId }));
      for (const copy of copies) this.store.put("operation", copy.id, { type: "snapshot", workspaceId: copy.id, state: "pending" });
      try {
        const result = await this.runtime.freeze(sourceId, () => this.files.snapshot(sourceId, copies.map(copy => copy.id)));
        copies.forEach((copy, index) => {
          copy.baseFingerprint = result.fingerprint; copy.baselineRevision = result.revisions[index]; this.save(copy);
          this.store.put("operation", copy.id, { state: "completed" });
          if (tasks[index].prompt) this.enqueue(copy.id, tasks[index].prompt!, tasks[index].name);
        });
        return copies;
      } catch (error) {
        for (const copy of copies) {
          this.store.put("operation", copy.id, { type: "snapshot", workspaceId: copy.id, state: "failed", error: String(error) });
          if (!this.store.get("workspace", copy.id)) await this.files.discard(copy.id).catch(() => {});
        }
        throw error;
      }
    });
  }
  enqueue(id: string, prompt: string, title?: string): AgentRun {
    this.live(id);
    if (this.busy(id)) throw conflict("This workspace already has an active or queued task");
    const run: AgentRun = { id: randomUUID(), title, workspaceId: id, prompt, state: "queued", createdAt: now(), startedAt: null, finishedAt: null, error: null, threadId: null, turnId: null };
    this.store.put("run", run.id, run); this.store.event(run.id, "run/queued", { prompt }); return run;
  }
  async cancel(runId: string): Promise<AgentRun> {
    return this.exclusive(async () => {
      const run = this.store.run(runId);
      if (terminal.has(run.state)) return run;
      const wasQueued = run.state === "queued";
      // Stop the entire execution environment to terminate shell descendants as well as Codex.
      if (!wasQueued) await this.runtime.stop(run.workspaceId);
      this.state(run, "cancelled"); this.disposeWorkspace(run.workspaceId);
      if (!wasQueued) this.save({ ...this.store.workspace(run.workspaceId), state: "stopped" });
      return run;
    });
  }
  approvals(runId: string): RpcRequest[] { return [...(this.active.get(runId)?.requests.values() ?? [])]; }
  async approve(runId: string, requestId: string, accepted: boolean): Promise<void> {
    const active = this.active.get(runId), request = active?.requests.get(requestId);
    if (!active || !request) throw conflict("Approval is no longer pending");
    active.session.respond(request.id, { decision: accepted ? "accept" : "decline" });
    active.requests.delete(requestId);
    this.store.event(runId, "approval/resolved", { requestId, accepted });
    if (!active.requests.size) this.state(this.store.run(runId), "running");
  }
  async propose(id: string): Promise<ChangeProposal> {
    return this.exclusive(async () => {
      const workspace = this.live(id);
      if (!workspace.parentId || !workspace.baselineRevision || !workspace.baseFingerprint) throw conflict("Only experiments and parallel agents have changes to promote");
      if (workspace.appliedAt) throw conflict("This workspace's changes were already applied");
      if (this.busy(id)) throw conflict("Finish or cancel the task before reviewing its changes");
      const changes = await this.runtime.freeze(id, () => this.files.changes(id, workspace.baselineRevision!));
      const proposal: ChangeProposal = { id: randomUUID(), workspaceId: id, parentId: workspace.parentId, baseFingerprint: workspace.baseFingerprint, resultFingerprint: changes.fingerprint, patch: changes.patch, summary: changes.summary, createdAt: now(), appliedAt: null };
      this.store.put("proposal", proposal.id, proposal); return proposal;
    });
  }
  async apply(proposalId: string): Promise<ChangeProposal> {
    return this.exclusive(async () => {
      const proposal = this.store.proposal(proposalId), workspace = this.live(proposal.workspaceId);
      this.live(proposal.parentId);
      if (proposal.appliedAt || workspace.appliedAt) throw conflict("Changes were already applied");
      if (!proposal.patch) throw conflict("There are no changes to apply");
      if (this.busy(proposal.parentId) || this.busy(proposal.workspaceId)) throw conflict("Finish active tasks before applying changes");
      await this.runtime.freeze(proposal.parentId, () => this.runtime.freeze(proposal.workspaceId, async () => {
        const current = this.files.fingerprint(await this.files.sourceFiles(this.files.root(proposal.parentId)));
        const result = this.files.fingerprint(await this.files.sourceFiles(this.files.root(proposal.workspaceId)));
        if (current !== proposal.baseFingerprint) throw conflict("The primary workspace changed after this snapshot. Resolve the differences manually.");
        if (result !== proposal.resultFingerprint) throw conflict("The experiment changed after review. Generate a fresh review.");
        this.store.put("operation", proposal.id, { type: "apply", state: "pending", proposalId });
        await this.files.apply(proposal.parentId, proposal.patch);
        proposal.appliedAt = now(); this.store.put("proposal", proposal.id, proposal);
        this.save({ ...workspace, appliedAt: proposal.appliedAt });
        this.store.put("operation", proposal.id, { type: "apply", state: "completed", proposalId });
      }));
      return proposal;
    });
  }
  async discard(id: string): Promise<void> {
    await this.exclusive(async () => {
      const workspace = this.store.workspace(id);
      if (workspace.state === "discarded") return;
      if (workspace.kind === "primary") throw conflict("Primary workspaces cannot be deleted through this action");
      if (this.busy(id)) throw conflict("Cancel the task before discarding its workspace");
      this.store.put("operation", id, { type: "discard", workspaceId: id, state: "pending" });
      await this.runtime.remove(id);
      await this.files.discard(id);
      this.save({ ...workspace, state: "discarded" });
      this.store.put("operation", id, { type: "discard", state: "completed" });
    });
  }
  begin(): void {
    for (const run of this.runs().filter(run => !terminal.has(run.state) && run.state !== "queued")) this.state(run, "stopping", "Verifying process state after Relay restarted.");
    this.timer = setInterval(() => void this.tick(), 2000); void this.tick();
  }
  private async recover(): Promise<void> {
    await this.runtime.list();
    for (const run of this.runs().filter(run => !terminal.has(run.state) && run.state !== "queued")) {
      await this.runtime.stop(run.workspaceId);
      this.state(run, "interrupted", "Backend restarted. Files and conversation history were retained; send a new prompt to continue.");
    }
    for (const operation of this.store.list<{ type?: string; workspaceId?: string; state: string; proposalId?: string }>("operation")) {
      if (operation.state !== "pending" && operation.state !== "failed") continue;
      if ((operation.type === "import" || operation.type === "snapshot") && operation.workspaceId && !this.store.get("workspace", operation.workspaceId)) {
        await this.runtime.remove(operation.workspaceId); await this.files.discard(operation.workspaceId);
        this.store.put("operation", operation.workspaceId, { ...operation, state: "cleaned" });
      }
      if (operation.type === "discard" && operation.workspaceId) {
        await this.runtime.remove(operation.workspaceId); await this.files.discard(operation.workspaceId);
        this.save({ ...this.store.workspace(operation.workspaceId), state: "discarded" });
        this.store.put("operation", operation.workspaceId, { ...operation, state: "completed" });
      }
      // An interrupted promotion is never replayed automatically; preserve its audit record.
      if (operation.type === "apply" && operation.proposalId) this.store.put("operation", operation.proposalId, { ...operation, state: "needs-review" });
    }
    // Stops and cleanup above changed Docker state; never restart from a stale paused entry.
    for (const container of await this.runtime.list()) {
      if (!this.store.get("workspace", container.workspaceId)) await this.runtime.remove(container.workspaceId);
      else if (container.state === "paused") await this.runtime.start(container.workspaceId);
    }
    this.recovered = true;
  }
  async tick(): Promise<void> {
    if (this.ticking || this.closing) return;
    this.ticking = true;
    try {
      await this.exclusive(async () => {
        if (!this.recovered) await this.recover();
        for (const run of this.runs().filter(run => run.state === "stopping")) {
          await this.runtime.stop(run.workspaceId);
          this.state(run, "failed", run.error);
          this.save({ ...this.store.workspace(run.workspaceId), state: "stopped" });
        }
        const containers = await this.runtime.list();
        for (const workspace of this.workspaces().filter(workspace => workspace.state !== "discarded")) {
          const state = containers.some(item => item.workspaceId === workspace.id && item.state === "running") ? "running" : "stopped";
          if (workspace.state !== state) this.save({ ...workspace, state });
        }
        for (const run of this.runs().filter(run => run.state === "queued")) {
          if (this.runs().filter(item => !terminal.has(item.state) && item.state !== "queued").length >= this.config.maxAgents) break;
          try { await this.startUnlocked(run.workspaceId); }
          catch (error) { if ((error as { status?: number }).status === 409) break; this.state(run, "failed", (error as Error).message); continue; }
          run.startedAt = now(); this.state(run, "starting");
          this.execute(run);
        }
      });
    } catch {
      // Docker may be offline. Keep queued work and retry reconciliation when it returns.
      for (const workspace of this.workspaces().filter(item => item.state === "running")) this.save({ ...workspace, state: "unknown" });
    } finally { this.ticking = false; }
  }
  private execute(run: AgentRun): void {
    const session = new CodexSession(this.runtime.agent(run.workspaceId));
    const timer = setTimeout(() => void this.fail(run.id, "Task exceeded its configured time limit"), this.config.timeoutMs);
    this.active.set(run.id, { session, timer, requests: new Map() });
    let eventBytes = 0;
    session.on("notification", (method: string, params: any) => {
      if (!this.active.has(run.id) || terminal.has(this.store.run(run.id).state)) return;
      if (method.startsWith("item/") || method.startsWith("turn/") || method === "error") {
        eventBytes += JSON.stringify(params).length;
        if (eventBytes > 16 * 1024 * 1024) { void this.fail(run.id, "Task event output exceeded 16 MiB"); return; }
        this.store.event(run.id, method, params);
      }
      if (method === "turn/started" && params.turn?.id) { const value = this.store.run(run.id); value.turnId = params.turn.id; this.store.put("run", run.id, value); }
      if (method === "turn/completed") {
        const status = params.turn?.status;
        void this.finishRun(run.id, status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed", params.turn?.error?.message ?? null);
      }
    });
    session.on("request", (request: RpcRequest) => {
      const active = this.active.get(run.id);
      if (!active) return;
      if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method)) {
        active.requests.set(String(request.id), request);
        this.store.event(run.id, "approval/request", request); this.state(this.store.run(run.id), "waiting");
      } else {
        session.unsupported(request.id, request.method);
        this.store.event(run.id, "adapter/unsupported", { method: request.method });
      }
    });
    session.on("closed", (error: Error) => { if (this.active.has(run.id)) void this.fail(run.id, error.message); });
    void (async () => {
      await session.initialize();
      const workspace = this.store.workspace(run.workspaceId);
      const params = { cwd: "/workspace", approvalPolicy: "on-request", sandbox: "danger-full-access" };
      const result = await session.request(workspace.threadId ? "thread/resume" : "thread/start", workspace.threadId ? { ...params, threadId: workspace.threadId } : params);
      if (!this.active.has(run.id)) return;
      workspace.threadId = result.thread.id;
      this.save(workspace);
      const value = this.store.run(run.id); value.threadId = result.thread.id; this.state(value, "running");
      const turn = await session.request("turn/start", { threadId: result.thread.id, input: [{ type: "text", text: run.prompt, text_elements: [] }] });
      if (this.active.has(run.id)) { const current = this.store.run(run.id); current.turnId = turn.turn.id; this.store.put("run", run.id, current); }
    })().catch(error => { if (this.active.has(run.id)) void this.fail(run.id, (error as Error).message); });
  }
  private async finishRun(id: string, state: RunState, error: string | null): Promise<void> {
    await this.exclusive(async () => {
      const run = this.store.run(id);
      if (terminal.has(run.state)) return;
      const workspace = this.store.workspace(run.workspaceId);
      // Parallel workers release their container slot automatically; their files remain reviewable.
      if (workspace.kind === "agent") {
        try { await this.runtime.stop(workspace.id); this.save({ ...workspace, state: "stopped" }); }
        catch { this.state(run, "stopping", "Agent finished, but Docker has not confirmed environment termination."); this.disposeWorkspace(workspace.id); return; }
      }
      this.state(run, state, error); this.disposeWorkspace(run.workspaceId);
    });
  }
  private async fail(id: string, message: string): Promise<void> {
    await this.exclusive(async () => {
      const run = this.store.run(id);
      if (terminal.has(run.state)) return;
      try {
        await this.runtime.stop(run.workspaceId); this.save({ ...this.store.workspace(run.workspaceId), state: "stopped" });
        this.state(run, "failed", message);
      } catch {
        this.save({ ...this.store.workspace(run.workspaceId), state: "unknown" });
        this.state(run, "stopping", message + ". Waiting for Docker to confirm termination.");
      }
      this.disposeWorkspace(run.workspaceId);
    });
  }
  async shutdown(): Promise<void> {
    this.closing = true; clearInterval(this.timer);
    await this.exclusive(async () => {
      for (const [id] of this.active) {
        const run = this.store.run(id);
        try { await this.runtime.stop(run.workspaceId); this.state(run, "interrupted", "Relay stopped. Send a new prompt to resume the saved conversation."); }
        catch { this.state(run, "stopping", "Relay stopped before Docker could confirm termination. Startup reconciliation will retry."); }
        this.disposeWorkspace(run.workspaceId);
      }
    });
  }
}
