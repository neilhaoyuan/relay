/** Versioned Codex app-server JSON-RPC adapter, verified against the 0.160.0 generated protocol. */
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface RpcRequest { id: string | number; method: string; params: Record<string, unknown> }
export class CodexSession extends EventEmitter {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private closed = false;
  constructor(private child: ChildProcessWithoutNullStreams) {
    super();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      this.buffer += data;
      if (this.buffer.length > 8 * 1024 * 1024) { this.finish(new Error("Codex protocol message exceeded 8 MiB")); return; }
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); } catch { this.finish(new Error("Invalid JSON from Codex app-server")); }
      }
    });
    child.stderr.on("data", (data: Buffer) => this.emit("diagnostic", data.toString().slice(0, 4000)));
    child.stdin.on("error", error => this.finish(error));
    child.on("error", error => this.finish(error));
    child.on("close", code => this.finish(new Error(`Codex app-server exited (${code ?? "signal"})`)));
  }
  private receive(message: any): void {
    if (message.method && message.id !== undefined) this.emit("request", message as RpcRequest);
    else if (message.method) this.emit("notification", message.method, message.params ?? {});
    else if (message.id !== undefined) {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      clearTimeout(waiting.timer); this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message ?? "Codex RPC failed")); else waiting.resolve(message.result);
    }
  }
  private send(message: unknown): void {
    if (this.closed || this.child.stdin.destroyed) throw new Error("Codex connection closed");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 45_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "relay", title: "Relay", version: "0.1.0" } });
    this.send({ method: "initialized", params: {} });
  }
  respond(id: string | number, result: unknown): void { this.send({ id, result }); }
  unsupported(id: string | number, method: string): void { this.send({ id, error: { code: -32601, message: `Relay does not support ${method}` } }); }
  private finish(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.emit("closed", error);
  }
  dispose(): void {
    this.child.stdin.end();
    this.finish(new Error("Codex connection closed"));
    const timer = setTimeout(() => this.child.kill(), 1000); timer.unref();
  }
}
