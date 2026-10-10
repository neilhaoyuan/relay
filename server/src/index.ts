/** Private-network HTTP API, origin-checked event sockets, and static browser entry point. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { Store } from "./store.js";
import { Files } from "./files.js";
import { DockerRuntime } from "./runtime.js";
import { Orchestrator } from "./orchestrator.js";
import { Access } from "./auth.js";
import { Terminals } from "./terminal.js";
import type { RunEvent } from "@relay/contracts";

const access = new Access(config);
const store = new Store(config.dataDir), files = new Files(config.dataDir);
const runtime = new DockerRuntime(config, files, store.installationId);
const service = new Orchestrator(store, files, runtime, config);
const terminals = new Terminals(runtime);
const webRoot = resolve(fileURLToPath(new URL("../../web/dist/", import.meta.url)));
let system = await runtime.status();
const statusTimer = setInterval(() => { void runtime.status().then(value => { system = value; }); }, 15_000);

async function body(request: IncomingMessage): Promise<Record<string, any>> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw Object.assign(new Error("Expected application/json"), { status: 415 });
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { size += chunk.length; if (size > 2 * 1024 * 1024) throw Object.assign(new Error("Request exceeds 2 MiB"), { status: 413 }); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
  catch { throw Object.assign(new Error("Invalid JSON request"), { status: 400 }); }
}
function text(value: unknown, name: string, max = 200, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max) throw Object.assign(new Error(`Invalid ${name}`), { status: 400 });
  return value;
}
function json(response: ServerResponse, value: unknown, status = 200): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(value)); }
function workspace(id: string): void { if (store.workspace(id).state === "discarded") throw Object.assign(new Error("Workspace was discarded"), { status: 410 }); }

const server = createServer(async (request, response) => {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "same-origin");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'");
  try {
    if (!access.allowed(request)) throw Object.assign(new Error("Access requires localhost or the configured Tailscale Serve address"), { status: 403 });
    const url = new URL(request.url ?? "/", "http://relay.local"), path = url.pathname, method = request.method ?? "GET";
    if (path.startsWith("/api/")) {
      if (!["GET", "HEAD"].includes(method) && !access.origin(request)) throw Object.assign(new Error("Unrecognized request origin"), { status: 403 });
      if (path === "/api/session" && method === "GET") { json(response, { authenticated: true, access: "network" }); return; }
      if (path === "/api/state" && method === "GET") { json(response, { workspaces: service.workspaces(), runs: service.runs(), system }); return; }
      if (path === "/api/workspaces" && method === "POST") { const input = await body(request); json(response, await service.import(text(input.name, "name", 80), text(input.repository ?? "", "repository", 2048, true)), 201); return; }
      const match = path.match(/^\/api\/workspaces\/([a-f0-9-]{36})(?:\/([a-z-]+))?$/);
      if (match) {
        const [, id, action] = match; workspace(id);
        if (method === "POST" && action === "start") { json(response, await service.start(id)); return; }
        if (method === "POST" && action === "stop") { json(response, await service.stop(id)); return; }
        if (method === "DELETE" && !action) { await service.discard(id); json(response, { discarded: true }); return; }
        if (method === "GET" && action === "files") { json(response, await files.list(id, url.searchParams.get("path") ?? "")); return; }
        if (method === "GET" && action === "file") { json(response, await files.read(id, text(url.searchParams.get("path"), "path", 4096))); return; }
        if (method === "PUT" && action === "file") {
          const input = await body(request), path = text(input.path, "path", 4096), content = text(input.content, "content", 1024 * 1024, true);
          const version = input.version === null ? null : text(input.version, "version", 64);
          json(response, await service.exclusive(async () => {
            const current = store.workspace(id);
            if (current.state === "discarded") throw Object.assign(new Error("Workspace was discarded"), { status: 410 });
            if (current.state === "unknown") throw Object.assign(new Error("Wait for Docker to confirm the workspace state before saving"), { status: 409 });
            if (current.state === "running") return runtime.freeze(id, () => files.save(id, path, content, version));
            return files.save(id, path, content, version);
          })); return;
        }
        if (method === "POST" && action === "experiment") { const input = await body(request); json(response, await service.copies(id, [{ name: text(input.name, "name", 80) }]), 201); return; }
        if (method === "POST" && action === "parallel") {
          const input = await body(request);
          if (!Array.isArray(input.tasks) || input.tasks.length < 2 || input.tasks.length > 8) throw new Error("Provide between 2 and 8 tasks");
          const tasks = input.tasks.map(task => ({ name: text(task.name, "task name", 80), prompt: text(task.prompt, "prompt", 20_000) }));
          json(response, await service.copies(id, tasks), 201); return;
        }
        if (method === "POST" && action === "runs") { const input = await body(request); json(response, await service.exclusive(async () => service.enqueue(id, text(input.prompt, "prompt", 20_000))), 201); return; }
        if (method === "POST" && action === "tasks") {
          const input = await body(request), prompt = text(input.prompt, "prompt", 20_000), name = text(input.name, "task name", 80);
          if (typeof input.isolated !== "boolean") throw new Error("Choose an execution environment");
          if (input.isolated) {
            const [copy] = await service.copies(id, [{ name, prompt }]);
            json(response, { workspace: copy, run: service.runs().find(run => run.workspaceId === copy.id) }, 201);
          } else {
            const run = await service.exclusive(async () => service.enqueue(id, prompt, name));
            json(response, { workspace: store.workspace(id), run }, 201);
          }
          return;
        }
        if (method === "POST" && action === "review") { json(response, await service.propose(id)); return; }
      }
      const run = path.match(/^\/api\/runs\/([a-f0-9-]{36})\/(cancel|events|approvals)$/);
      if (run) {
        const [, id, action] = run; store.run(id);
        if (method === "POST" && action === "cancel") { json(response, await service.cancel(id)); return; }
        if (method === "GET" && action === "events") { const after = Number(url.searchParams.get("after") ?? 0); if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid event cursor"); json(response, store.events(id, after)); return; }
        if (method === "GET" && action === "approvals") { json(response, service.approvals(id)); return; }
        if (method === "POST" && action === "approvals") {
          const input = await body(request); if (typeof input.accepted !== "boolean") throw new Error("Invalid approval decision");
          await service.approve(id, text(input.requestId, "request id", 100), input.accepted); json(response, { resolved: true }); return;
        }
      }
      const apply = path.match(/^\/api\/changes\/([a-f0-9-]{36})\/apply$/);
      if (apply && method === "POST") { json(response, await service.apply(apply[1])); return; }
      throw Object.assign(new Error("API route not found"), { status: 404 });
    }
    if (method !== "GET" && method !== "HEAD") throw Object.assign(new Error("Method not allowed"), { status: 405 });
    const filePath = resolve(webRoot, `.${decodeURIComponent(path === "/" ? "/index.html" : path)}`);
    if (!filePath.startsWith(webRoot + sep)) throw Object.assign(new Error("Not found"), { status: 404 });
    const info = await stat(filePath); if (!info.isFile()) throw Object.assign(new Error("Not found"), { status: 404 });
    response.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" } as Record<string,string>)[extname(filePath)] ?? "application/octet-stream");
    response.setHeader("cache-control", "no-cache"); response.end(method === "HEAD" ? undefined : await readFile(filePath));
  } catch (error) {
    const value = error as Error & { status?: number; code?: string };
    json(response, { error: value.message }, value.status ?? (value.code === "ENOENT" ? 404 : 400));
  }
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
server.on("upgrade", (request, socket, head) => {
  if (!access.allowed(request) || !access.origin(request)) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
  const url = new URL(request.url ?? "/", "http://relay.local");
  if (!["/ws/events", "/ws/terminal"].includes(url.pathname)) { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
  sockets.handleUpgrade(request, socket, head, client => {
    if (url.pathname === "/ws/terminal") {
      try {
        const id = url.searchParams.get("workspaceId") ?? "";
        if (store.workspace(id).state !== "running") throw new Error("Start the workspace first");
        terminals.attach(id, client);
      } catch (error) { client.send(JSON.stringify({ type: "error", error: (error as Error).message })); client.close(1008); }
      return;
    }
    const send = (value: unknown) => { if (client.bufferedAmount > 1024 * 1024) client.close(1013, "Reconnect to catch up"); else if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value)); };
    // Sockets signal invalidation; the client catches up from the durable HTTP event cursor.
    const event = (value: RunEvent) => send({ type: "event", runId: value.runId });
    const change = () => send({ type: "change" });
    store.on("event", event); store.on("change", change);
    send({ type: "connected" });
    client.on("close", () => { store.off("event", event); store.off("change", change); });
  });
});

server.on("error", error => {
  console.error(`Relay could not listen: ${error.message}`);
  clearInterval(statusTimer); store.close(); process.exitCode = 1;
});
server.listen(config.port, config.host, () => {
  service.begin();
  console.log(`Relay: http://${config.host}:${config.port}`);
  console.log(`Access: localhost${config.origin ? ` and ${config.origin}` : "; configure RELAY_PUBLIC_ORIGIN for Tailscale Serve"}`);
  console.log(`Docker: ${system.message}`);
});
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return; shuttingDown = true;
  clearInterval(statusTimer); server.close();
  for (const client of sockets.clients) client.close(1001, "Relay stopping");
  terminals.close(); await service.shutdown(); store.close();
}
process.on("SIGINT", () => void shutdown()); process.on("SIGTERM", () => void shutdown());
