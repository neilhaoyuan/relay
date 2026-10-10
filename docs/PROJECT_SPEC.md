# AgentRelay project spec

> Historical terminal prototype specification. For the current VM workspace platform, see [ARCHITECTURE.md](ARCHITECTURE.md), [FILE_MAP.md](FILE_MAP.md), and [VM_SETUP.md](VM_SETUP.md). The original specification is retained below.

## Purpose

AgentRelay is a self-hosted control plane for Codex CLI sessions. A server owns each Codex process through a pseudoterminal (PTY). Browser and future local CLI clients connect to that server. Disconnecting a client does not stop the process.

The first supported host is Linux. Codex is the primary workload; Bash is a debug fallback.

## MVP boundary

One Codex process, one server, a browser terminal, keyboard input, terminal resize, automatic browser reconnection, and bounded in-memory scrollback. The server listens on localhost. The process remains alive across browser disconnects and ends when the server ends or Codex exits. No database, account system, session list, Git integration, or Codex screen parser is part of this release.

The server sends a `scrollback` snapshot to each new WebSocket connection, then streams `output`. Clients send `input` and `resize`. The server sends `exit` when the process ends. Messages are JSON, and the PTY remains the source of truth.

## Later architecture

```text
Browser / local CLI
        ↕ HTTP + WebSocket
AgentRelay server
        ├── SessionManager → node-pty → Codex CLI
        ├── Git monitor → Git CLI
        └── Event store → SQLite
```

`SessionManager` will own multiple sessions, each with an ID, name, working directory, state, PTY, creation and activity times, and bounded scrollback. A future Codex adapter may infer waiting or approval states from output, but uncertain parsing must never block raw terminal access. A structured event store can record state and Git changes. Local `relay attach` should connect to the same server session rather than start another Codex process.

## Sequence

1. Prove Codex can launch in `node-pty` and render in xterm.js.
2. Verify browser disconnect, reconnect, replay, and continued interaction.
3. Add multiple sessions and a session list.
4. Add a mobile-friendly React dashboard if the simple terminal UI becomes limiting.
5. Add Git status and diffs, then isolated Codex state detection and approval UI.
6. Add local CLI attachment.
7. Add authentication before LAN or remote access, then event persistence, notifications, and multiple machines.

## Safety and operational limits

The server remains bound to localhost. Remote access can use Tailscale Serve with an explicitly configured HTTPS origin and tailnet access rules; Relay has no account-level authentication of its own. A browser disconnect does not keep a session alive if the server itself stops. In-memory scrollback is limited to recent output and cannot perfectly reconstruct an interactive screen after complex full-screen redraws; preserving terminal state is future work.
