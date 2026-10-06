/** Workspace file access, consistent source snapshots, and Git-backed change proposals. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, lstat, readFile, writeFile, rename, rm, chmod } from "node:fs/promises";
import { resolve, join, dirname, sep } from "node:path";
import type { FileEntry, FileDocument } from "@relay/contracts";
import { command } from "./process.js";

export const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const excluded = new Set([".git", ".codex", ".ssh", "node_modules", "dist", "build", "coverage", ".next", ".relay-data", ".relay-backup"]);
export function eligible(path: string): boolean {
  return !path.split("/").some(part => excluded.has(part) || (part === ".env" || part.startsWith(".env.")) && !part.endsWith(".example"));
}

/** No absolute paths, hidden Git internals, traversal, or symlink following. */
export async function safePath(root: string, relative: string, allowMissing = false): Promise<string> {
  if (!relative || relative.includes("\\") || relative.includes(":") || relative.includes("\0") || relative.startsWith("/") || relative.split("/").some(part => !part || part === "." || part === "..") || !eligible(relative)) {
    throw Object.assign(new Error("Invalid or excluded workspace path"), { status: 400 });
  }
  const base = resolve(root), target = resolve(base, relative);
  if (!target.startsWith(base + sep)) throw new Error("Path escapes workspace");
  const parts = relative.split("/");
  let current = base;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("Symlink paths are not supported");
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error("Parent path is not a directory");
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

export class Files {
  constructor(readonly dataDir: string) {}
  root(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid workspace identifier");
    return join(this.dataDir, "workspaces", id, "source");
  }
  home(id: string): string { this.root(id); return join(this.dataDir, "codex"); }
  async git(root: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv; maxBytes?: number } = {}): Promise<string> {
    return command("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", "-c", "core.quotePath=false", ...args], {
      cwd: root, timeoutMs: 120_000, ...options,
      env: { GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Relay", GIT_AUTHOR_EMAIL: "relay@localhost", GIT_COMMITTER_NAME: "Relay", GIT_COMMITTER_EMAIL: "relay@localhost", ...options.env },
    });
  }
  async init(root: string): Promise<void> {
    await mkdir(root, { recursive: true });
    await this.git(root, ["init", "-b", "main"]);
    await this.git(root, ["add", "--all"]);
    await this.git(root, ["commit", "--allow-empty", "-m", "Relay source baseline"]);
  }
  async import(id: string, repository: string): Promise<void> {
    const root = this.root(id);
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    await mkdir(this.home(id), { recursive: true, mode: 0o700 });
    if (repository) {
      const https = /^https:\/\//.test(repository);
      const ssh = /^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/.test(repository);
      if (!https && !ssh) throw new Error("Use an HTTPS or git@host:owner/repository.git URL");
      if (https) {
        const url = new URL(repository);
        if (url.username || url.password) throw new Error("Keep repository credentials in server-side Git configuration");
      }
      await this.git(dirname(root), ["clone", "--", repository, root]);
    } else {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "README.md"), "# New workspace\n\nStart building with Relay.\n");
      await this.init(root);
    }
  }
  async list(id: string, path = ""): Promise<FileEntry[]> {
    const root = this.root(id), directory = path ? await safePath(root, path) : root;
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter(item => !item.isSymbolicLink() && eligible(path ? `${path}/${item.name}` : item.name))
      .map(item => ({ name: item.name, path: path ? `${path}/${item.name}` : item.name, kind: item.isDirectory() ? "directory" as const : "file" as const }))
      .sort((a,b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1);
  }
  async read(id: string, path: string): Promise<FileDocument> {
    const target = await safePath(this.root(id), path), info = await lstat(target);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error("The editor supports text files up to 1 MiB");
    const data = await readFile(target);
    if (data.includes(0)) throw new Error("Binary files cannot be opened in the text editor");
    return { path, content: data.toString("utf8"), version: digest(data) };
  }
  async save(id: string, path: string, content: string, version: string | null): Promise<FileDocument> {
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("File exceeds 1 MiB");
    const target = await safePath(this.root(id), path, true);
    let current: Buffer | null = null;
    try { current = await readFile(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if ((current ? digest(current) : null) !== version) throw conflict("This file changed since you opened it. Reload before saving.");
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.relay-${randomUUID()}`;
    try {
      await writeFile(temporary, content, current ? { mode: (await lstat(target)).mode } : undefined);
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
    return { path, content, version: digest(content) };
  }
  async sourceFiles(root: string): Promise<Array<{ path: string; data: Buffer; mode: number }>> {
    const names = new Set((await this.git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean));
    if (names.size > 20_000) throw new Error("Snapshot exceeds 20,000 files");
    const files = []; let bytes = 0;
    for (const path of [...names].sort()) {
      if (!eligible(path)) continue;
      let target: string;
      try { target = await safePath(root, path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const info = await lstat(target);
      if (!info.isFile()) throw new Error("Snapshots of submodules and special files are not supported yet");
      bytes += info.size;
      if (bytes > 128 * 1024 * 1024) throw new Error("Source snapshot exceeds 128 MiB; exclude generated files using .gitignore");
      files.push({ path, data: await readFile(target), mode: info.mode & 0o111 ? 0o755 : 0o644 });
    }
    return files;
  }
  fingerprint(files: Array<{ path: string; data: Buffer; mode: number }>): string {
    return digest(files.map(file => `${file.path}\0${file.mode}\0${digest(file.data)}\n`).join(""));
  }
  async snapshot(sourceId: string, ids: string[]): Promise<{ fingerprint: string; revisions: string[] }> {
    const files = await this.sourceFiles(this.root(sourceId));
    const revisions: string[] = [];
    for (const id of ids) {
      const root = this.root(id);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await mkdir(this.home(id), { recursive: true, mode: 0o700 });
      for (const file of files) {
        const target = join(root, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.data, { mode: file.mode });
        await chmod(target, file.mode);
      }
      await this.init(root);
      revisions.push((await this.git(root, ["rev-parse", "HEAD"])).trim());
    }
    return { fingerprint: this.fingerprint(files), revisions };
  }
  async changes(id: string, baseline: string): Promise<{ patch: string; summary: string; fingerprint: string }> {
    const root = this.root(id), files = await this.sourceFiles(root);
    const index = join(dirname(root), `index-${randomUUID()}`), env = { GIT_INDEX_FILE: index };
    try {
      await this.git(root, ["read-tree", "--empty"], { env });
      if (files.length) await this.git(root, ["add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: files.map(file => file.path).join("\0") + "\0" });
      const tree = (await this.git(root, ["write-tree"], { env })).trim();
      const patch = await this.git(root, ["diff", "--binary", "--no-ext-diff", "--no-textconv", baseline, tree, "--"], { maxBytes: 8 * 1024 * 1024 });
      const summary = await this.git(root, ["diff", "--stat", "--no-ext-diff", baseline, tree, "--"]);
      return { patch, summary, fingerprint: this.fingerprint(files) };
    } finally { await rm(index, { force: true }); }
  }
  async apply(id: string, patch: string): Promise<void> {
    const root = this.root(id);
    await this.git(root, ["apply", "--check", "--whitespace=nowarn", "-"], { input: patch });
    await this.git(root, ["apply", "--whitespace=nowarn", "-"], { input: patch });
  }
  async discard(id: string): Promise<void> {
    // ID validation and this fixed root prevent deleting caller-supplied host paths.
    await rm(dirname(this.root(id)), { recursive: true, force: true });
  }
}
