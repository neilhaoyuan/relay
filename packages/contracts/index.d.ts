/** Shared wire types. This package has no runtime code or infrastructure dependencies. */
export type EnvironmentState = "stopped" | "running" | "unknown" | "discarded";
export interface Workspace {
  id: string;
  name: string;
  kind: "primary" | "experiment" | "agent";
  parentId: string | null;
  groupId: string | null;
  repository: string;
  state: EnvironmentState;
  createdAt: string;
  baseFingerprint: string | null;
  baselineRevision: string | null;
  threadId: string | null;
  appliedAt: string | null;
}
export type RunState = "queued" | "starting" | "running" | "waiting" | "stopping" | "completed" | "failed" | "cancelled" | "interrupted";
export interface AgentRun {
  id: string;
  workspaceId: string;
  prompt: string;
  state: RunState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  threadId: string | null;
  turnId: string | null;
}
export interface RunEvent {
  sequence: number;
  runId: string;
  type: string;
  data: unknown;
  createdAt: string;
}
export interface FileEntry { name: string; path: string; kind: "file" | "directory" }
export interface FileDocument { path: string; content: string; version: string }
export interface ChangeProposal {
  id: string;
  workspaceId: string;
  parentId: string;
  baseFingerprint: string;
  resultFingerprint: string;
  patch: string;
  summary: string;
  createdAt: string;
  appliedAt: string | null;
}
export interface SystemStatus {
  docker: boolean;
  imageReady: boolean;
  message: string;
  maxAgents: number;
  maxEnvironments: number;
  cpusPerEnvironment: number;
  memoryMbPerEnvironment: number;
  hostMemoryMb: number;
  hostCpus: number;
}
