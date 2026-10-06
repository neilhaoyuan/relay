/** Owner login and signed browser sessions. Tokens never appear in URLs or server logs. */
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import type { Config } from "./config.js";

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export class Auth {
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(private token: string, private config: Config) {}
  static async create(config: Config): Promise<Auth> {
    const path = join(config.dataDir, "access-token");
    let token = process.env.RELAY_ACCESS_TOKEN;
    if (!token) {
      try { token = (await readFile(path, "utf8")).trim(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        token = randomBytes(32).toString("hex"); await writeFile(path, token + "\n", { mode: 0o600, flag: "wx" });
      }
    }
    if (token.length < 24) throw new Error("RELAY_ACCESS_TOKEN must contain at least 24 characters");
    return new Auth(token, config);
  }
  origin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    return !!origin && [this.config.origin, `http://127.0.0.1:${this.config.port}`, `http://localhost:${this.config.port}`].includes(origin);
  }
  private signature(value: string): string { return createHmac("sha256", this.token).update(value).digest("hex"); }
  authenticated(request: IncomingMessage): boolean {
    const cookie = request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("relay_session="))?.slice(14);
    if (!cookie) return false;
    const [expiration, signature] = cookie.split(".");
    return Number(expiration) > Date.now() && !!signature && equal(signature, this.signature(expiration));
  }
  login(request: IncomingMessage, token: string): string {
    const address = request.socket.remoteAddress ?? "local", time = Date.now();
    for (const [key, value] of this.attempts) if (value.until < time) this.attempts.delete(key);
    const attempt = this.attempts.get(address) ?? { count: 0, until: time + 60_000 };
    if (++attempt.count > 10) throw Object.assign(new Error("Too many login attempts. Try again in a minute."), { status: 429 });
    this.attempts.set(address, attempt);
    if (!equal(token, this.token)) throw Object.assign(new Error("Incorrect access token"), { status: 401 });
    this.attempts.delete(address);
    const expiration = String(time + 7 * 24 * 60 * 60_000);
    return `relay_session=${expiration}.${this.signature(expiration)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${this.config.origin?.startsWith("https:") ? "; Secure" : ""}`;
  }
}
