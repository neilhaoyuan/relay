/** SQLite metadata and ordered event journal. Writes finish before events reach subscribers. */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Workspace, AgentRun, RunEvent, ChangeProposal } from "@relay/contracts";

export class Store extends EventEmitter {
  private db: DatabaseSync;
  readonly installationId: string;
  constructor(dataDir: string) {
    super();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, "relay.db"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,sequence);
      PRAGMA user_version=1;`);
    this.installationId = this.get<{ id: string }>("meta", "installation")?.id ?? randomUUID();
    this.put("meta", "installation", { id: this.installationId });
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM records WHERE kind=? AND id=?").get(kind, id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  list<T>(kind: string): T[] {
    return (this.db.prepare("SELECT value FROM records WHERE kind=? ORDER BY rowid").all(kind) as { value: string }[]).map(row => JSON.parse(row.value) as T);
  }
  put(kind: string, id: string, value: unknown): void {
    this.db.prepare("INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value").run(kind, id, JSON.stringify(value));
    this.emit("change");
  }
  workspace(id: string): Workspace {
    const value = this.get<Workspace>("workspace", id);
    if (!value) throw Object.assign(new Error("Workspace not found"), { status: 404 });
    return value;
  }
  run(id: string): AgentRun {
    const value = this.get<AgentRun>("run", id);
    if (!value) throw Object.assign(new Error("Run not found"), { status: 404 });
    return value;
  }
  proposal(id: string): ChangeProposal {
    const value = this.get<ChangeProposal>("proposal", id);
    if (!value) throw Object.assign(new Error("Proposal not found"), { status: 404 });
    return value;
  }
  event(runId: string, type: string, data: unknown): RunEvent {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare("INSERT INTO events(run_id,type,data,created_at) VALUES(?,?,?,?)").run(runId, type, JSON.stringify(data), createdAt);
    const event = { sequence: Number(result.lastInsertRowid), runId, type, data, createdAt };
    this.emit("event", event);
    return event;
  }
  events(runId: string, after = 0): RunEvent[] {
    return (this.db.prepare("SELECT sequence,run_id AS runId,type,data,created_at AS createdAt FROM events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT 500").all(runId, after) as unknown as Array<Omit<RunEvent,"data"> & {data: string}>).map(row => ({ ...row, data: JSON.parse(row.data) }));
  }
  close(): void { this.db.close(); }
}
