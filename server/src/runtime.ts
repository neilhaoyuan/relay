/** The only Docker lifecycle adapter. Agent containers never receive the Docker socket. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { command } from "./process.js";
import type { Config } from "./config.js";
import type { Files } from "./files.js";
import type { SystemStatus } from "@relay/contracts";

export interface ContainerInfo { name: string; workspaceId: string; state: string }
export interface ContainerRuntime {
  status(): Promise<SystemStatus>;
  list(): Promise<ContainerInfo[]>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  freeze<T>(id: string, work: () => Promise<T>): Promise<T>;
  agent(id: string): ChildProcessWithoutNullStreams;
  terminalArgs(id: string): string[];
}

export class DockerRuntime implements ContainerRuntime {
  constructor(readonly config: Config, readonly files: Files, readonly installationId: string) {}
  name(id: string): string { this.files.root(id); return `relay-${this.installationId.slice(0,8)}-${id}`; }
  async status(): Promise<SystemStatus> {
    const base = { docker: false, imageReady: false, message: "", maxAgents: this.config.maxAgents, maxEnvironments: this.config.maxEnvironments, cpusPerEnvironment: this.config.cpus, memoryMbPerEnvironment: this.config.memoryMb, hostMemoryMb: this.config.hostMemoryMb, hostCpus: this.config.hostCpus };
    try { await command("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 5000 }); }
    catch { return { ...base, message: "Docker is unavailable. Start Docker or connect this server to your Linux VM's Docker engine." }; }
    try { await command("docker", ["image", "inspect", this.config.image], { timeoutMs: 5000 }); return { ...base, docker: true, imageReady: true, message: "Ready" }; }
    catch { return { ...base, docker: true, message: `Build ${this.config.image} using infrastructure/Dockerfile.workspace` }; }
  }
  async list(): Promise<ContainerInfo[]> {
    const output = await command("docker", ["ps", "--all", "--filter", `label=relay.installation=${this.installationId}`, "--format", '{{.Names}}|{{.Label "relay.workspace"}}|{{.State}}'], { timeoutMs: 10_000 });
    return output.trim().split(/\r?\n/).filter(Boolean).map(line => { const [name, workspaceId, state] = line.split("|"); return { name, workspaceId, state }; });
  }
  async start(id: string): Promise<void> {
    const existing = (await this.list()).find(item => item.workspaceId === id);
    if (existing?.state === "running") return;
    if (existing?.state === "paused") { await command("docker", ["unpause", this.name(id)]); return; }
    if (existing) { await command("docker", ["start", this.name(id)]); return; }
    await mkdir(this.files.home(id), { recursive: true, mode: 0o700 });
    const user = process.getuid ? `${process.getuid()}:${process.getgid!()}` : "1000:1000";
    await command("docker", ["run", "--detach", "--init", "--pull=never", "--name", this.name(id),
      "--label", `relay.installation=${this.installationId}`, "--label", `relay.workspace=${id}`,
      "--user", user, "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=256",
      "--cpus", String(this.config.cpus), "--memory", `${this.config.memoryMb}m`, "--memory-swap", `${this.config.memoryMb}m`,
      "--log-opt", "max-size=10m", "--log-opt", "max-file=2",
      "--mount", `type=bind,src=${this.files.root(id)},dst=/workspace`,
      "--mount", `type=bind,src=${this.files.home(id)},dst=/codex`,
      "--env", "CODEX_HOME=/codex", "--env", "HOME=/codex", "--workdir", "/workspace",
      this.config.image, "sleep", "infinity"], { timeoutMs: 60_000 });
  }
  async stop(id: string): Promise<void> {
    const item = (await this.list()).find(item => item.workspaceId === id);
    if (!item || !["running", "paused", "restarting"].includes(item.state)) return;
    if (item.state === "paused") await command("docker", ["unpause", this.name(id)]);
    await command("docker", ["stop", "--time", "3", this.name(id)], { timeoutMs: 20_000 });
  }
  async remove(id: string): Promise<void> {
    if ((await this.list()).some(item => item.workspaceId === id)) await command("docker", ["rm", "--force", this.name(id)]);
  }
  async freeze<T>(id: string, work: () => Promise<T>): Promise<T> {
    const running = (await this.list()).find(item => item.workspaceId === id)?.state === "running";
    if (running) await command("docker", ["pause", this.name(id)]);
    try { return await work(); } finally { if (running) await command("docker", ["unpause", this.name(id)]); }
  }
  agent(id: string): ChildProcessWithoutNullStreams {
    return spawn("docker", ["exec", "-i", "--workdir", "/workspace", this.name(id), "codex", "app-server", "--listen", "stdio://", "--disable", "multi_agent", "--disable", "multi_agent_v2"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  }
  terminalArgs(id: string): string[] { return ["exec", "-it", "--workdir", "/workspace", this.name(id), "bash"]; }
}
