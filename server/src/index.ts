import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { delimiter, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import { WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.RELAY_PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("RELAY_PORT must be a port between 1 and 65535");
}
const target = process.env.RELAY_TARGET ?? "codex";
if (target !== "codex" && target !== "bash") {
  throw new Error("RELAY_TARGET must be codex or bash");
}

function codexCommand(): string {
  if (process.env.RELAY_CODEX) {
    const executable = resolve(process.env.RELAY_CODEX);
    if (!existsSync(executable)) throw new Error(`RELAY_CODEX does not exist: ${executable}`);
    return executable;
  }
  if (process.platform !== "win32") return "codex";

  // node-pty/ConPTY needs a native executable. npm puts codex.cmd on PATH,
  // while the executable is inside the globally installed platform package.
  const directories = (process.env.PATH ?? process.env.Path ?? "").split(delimiter);
  const direct = directories.map((directory) => join(directory, "codex.exe")).find(existsSync);
  if (direct) return direct;

  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const triple = architecture === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  for (const directory of directories) {
    if (!existsSync(join(directory, "codex.cmd"))) continue;
    const packageName = `codex-win32-${architecture}`;
    const packageRoots = [
      join(directory, "node_modules", "@openai", "codex", "node_modules", "@openai", packageName),
      join(directory, "node_modules", "@openai", packageName),
      join(directory, "node_modules", "@openai", "codex"),
    ];
    for (const packageRoot of packageRoots) {
      for (const subdirectory of ["bin", "codex"]) {
        const executable = join(packageRoot, "vendor", triple, subdirectory, "codex.exe");
        if (existsSync(executable)) return executable;
      }
    }
  }
  throw new Error(
    "Codex CLI was not found. In PowerShell run: npm.cmd install -g @openai/codex@latest; " +
    "then open a new terminal and run codex.cmd --version. " +
    "Alternatively set RELAY_CODEX to the full path of codex.exe."
  );
}

const command = target === "bash" ? (process.env.RELAY_SHELL ?? "bash") : codexCommand();
const cwd = resolve(process.env.RELAY_CWD ?? process.cwd());
const webRoot = resolve(fileURLToPath(new URL("../../web/dist/", import.meta.url)));
const maxScrollback = 100_000;

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };
type ServerMessage =
  | { type: "scrollback" | "output"; data: string }
  | { type: "exit"; exitCode: number; signal?: number };

const send = (socket: WebSocket, message: ServerMessage): void => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};

// The PTY belongs to the server, not to any WebSocket connection.
const session = pty.spawn(command, [], {
  name: "xterm-256color",
  cwd,
  cols: 120,
  rows: 30,
  env: process.env,
});
let scrollback = "";
let exit: { exitCode: number; signal?: number } | undefined;
const clients = new Set<WebSocket>();

session.onData((data) => {
  scrollback = (scrollback + data).slice(-maxScrollback);
  for (const client of clients) send(client, { type: "output", data });
});
session.onExit(({ exitCode, signal }) => {
  exit = { exitCode, signal };
  for (const client of clients) send(client, { type: "exit", ...exit });
  console.log(`${target} exited with code ${exitCode}`);
});

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return;
  }
  try {
    const pathname = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
    const path = resolve(webRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (path !== webRoot && !path.startsWith(webRoot + sep)) {
      response.writeHead(403).end();
      return;
    }
    const file = await stat(path);
    if (!file.isFile()) throw new Error("Not a file");
    const extension = path.slice(path.lastIndexOf("."));
    response.writeHead(200, {
      "content-type": contentTypes[extension] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    if (request.method === "HEAD") response.end();
    else response.end(await readFile(path));
  } catch {
    response.writeHead(404).end("Not found");
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on("upgrade", (request, socket, head) => {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (request.url !== "/ws" || !origin || !host || origin !== `http://${host}`) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
});
wss.on("connection", (socket) => {
  clients.add(socket);
  send(socket, { type: "scrollback", data: scrollback });
  if (exit) send(socket, { type: "exit", ...exit });

  socket.on("message", (raw) => {
    if (exit) return;
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    if (message.type === "input" && typeof message.data === "string" && message.data.length <= 16_384) {
      session.write(message.data);
    } else if (
      message.type === "resize" &&
      Number.isInteger(message.cols) && message.cols >= 2 && message.cols <= 500 &&
      Number.isInteger(message.rows) && message.rows >= 2 && message.rows <= 200
    ) {
      session.resize(message.cols, message.rows);
    }
  });
  socket.on("close", () => clients.delete(socket));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`AgentRelay: http://127.0.0.1:${port} (${target} in ${cwd})`);
});
