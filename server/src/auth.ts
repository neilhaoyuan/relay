/** Network access boundary: localhost development or Tailscale Serve, with host/origin checks. */
import type { IncomingMessage } from "node:http";
import type { Config } from "./config.js";

export class Access {
  private readonly hosts: Set<string>;
  private readonly origins: Set<string>;
  constructor(config: Pick<Config, "port" | "origin" | "host">) {
    if (config.host !== "127.0.0.1") throw new Error("Relay must listen on 127.0.0.1. Use Tailscale Serve for remote access.");
    this.origins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]);
    if (config.origin) this.origins.add(config.origin);
    this.hosts = new Set([...this.origins].map(origin => new URL(origin).host));
  }
  allowed(request: IncomingMessage): boolean {
    const peer = request.socket.remoteAddress;
    // Serve connects from loopback. Host checks also prevent browser DNS rebinding.
    return (peer === "127.0.0.1" || peer === "::ffff:127.0.0.1" || peer === "::1")
      && !!request.headers.host && this.hosts.has(request.headers.host)
      && request.headers["sec-fetch-site"] !== "cross-site";
  }
  origin(request: IncomingMessage): boolean {
    return !!request.headers.origin && this.origins.has(request.headers.origin);
  }
}
