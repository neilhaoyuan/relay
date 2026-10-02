import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

type ServerMessage =
  | { type: "scrollback" | "output"; data: string }
  | { type: "exit"; exitCode: number; signal?: number };

const terminalElement = document.getElementById("terminal");
const statusElement = document.getElementById("status");
if (!terminalElement || !statusElement) throw new Error("Terminal page is incomplete");

const terminal = new Terminal({ cursorBlink: true, scrollback: 5000 });
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(terminalElement);
fitAddon.fit();

let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let stopped = false;
const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;

function setStatus(value: string | undefined): void {
  statusElement!.hidden = value === undefined;
  statusElement!.textContent = value ?? "";
}
function sendResize(): void {
  fitAddon.fit();
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
  }
}
function connect(): void {
  if (stopped) return;
  const next = new WebSocket(url);
  socket = next;
  next.addEventListener("open", () => {
    setStatus(undefined);
    sendResize();
    terminal.focus();
  });
  next.addEventListener("message", (event: MessageEvent<string>) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(event.data) as ServerMessage;
    } catch {
      return;
    }
    if (message.type === "scrollback" && typeof message.data === "string") {
      terminal.reset();
      terminal.write(message.data);
    } else if (message.type === "output" && typeof message.data === "string") {
      terminal.write(message.data);
    } else if (message.type === "exit") {
      stopped = true;
      setStatus(`process exited (${message.exitCode})`);
    }
  });
  next.addEventListener("close", () => {
    if (socket !== next || stopped) return;
    setStatus("reconnecting…");
    reconnectTimer = window.setTimeout(connect, 1500);
  });
}

terminal.onData((data) => {
  if (socket?.readyState === WebSocket.OPEN && !stopped) {
    socket.send(JSON.stringify({ type: "input", data }));
  }
});
const observer = new ResizeObserver(sendResize);
observer.observe(terminalElement);
window.addEventListener("beforeunload", () => {
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  observer.disconnect();
  socket?.close();
});
connect();
