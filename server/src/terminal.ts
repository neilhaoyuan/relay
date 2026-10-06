/** Server-owned Docker PTYs with bounded scrollback. Browser disconnects only detach clients. */
import * as pty from "node-pty";
import { WebSocket } from "ws";
import type { ContainerRuntime } from "./runtime.js";

export class Terminals {
  private sessions = new Map<string, { process: pty.IPty; output: string; clients: Set<WebSocket> }>();
  constructor(private runtime: ContainerRuntime) {}
  attach(id: string, socket: WebSocket): void {
    let session = this.sessions.get(id);
    if (!session) {
      const process = pty.spawn("docker", this.runtime.terminalArgs(id), { name: "xterm-256color", cols: 100, rows: 24 });
      session = { process, output: "", clients: new Set() };
      const current = session;
      this.sessions.set(id, current);
      process.onData(data => {
        current.output = (current.output + data).slice(-100_000);
        for (const client of current.clients) this.send(client, { type: "output", data });
      });
      process.onExit(({ exitCode }) => {
        for (const client of current.clients) { this.send(client, { type: "exit", exitCode }); client.close(1000); }
        this.sessions.delete(id);
      });
    }
    session.clients.add(socket); this.send(socket, { type: "scrollback", data: session.output });
    const current = session;
    socket.on("message", raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === "input" && typeof message.data === "string" && message.data.length <= 16_384) current.process.write(message.data);
        if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols >= 2 && message.cols <= 500 && message.rows >= 2 && message.rows <= 200) current.process.resize(message.cols, message.rows);
      } catch { socket.close(1008, "Invalid terminal message"); }
    });
    socket.on("close", () => current.clients.delete(socket));
  }
  private send(socket: WebSocket, value: unknown): void {
    if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, "Reconnect to catch up"); return; }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  }
  close(): void { for (const session of this.sessions.values()) session.process.kill(); this.sessions.clear(); }
}
