/** Bounded subprocess execution without shell interpolation. Used for Git and Docker CLI calls. */
import { spawn } from "node:child_process";

export function command(executable: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; maxBytes?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "", bytes = 0, failed = false;
    const fail = (reason: Error) => { if (failed) return; failed = true; child.kill(); clearTimeout(timer); reject(reason); };
    const timer = setTimeout(() => fail(new Error(`${executable} timed out`)), options.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > (options.maxBytes ?? 8 * 1024 * 1024)) fail(new Error(`${executable} output exceeded limit`)); else output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString()).slice(-8000); });
    child.on("error", fail);
    child.stdin.on("error", () => {});
    child.on("close", code => { clearTimeout(timer); if (failed) return; if (code === 0) resolve(output); else reject(new Error(error.trim() || `${executable} exited with code ${code}`)); });
    child.stdin.end(options.input);
  });
}
