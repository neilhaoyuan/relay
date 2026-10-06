/** Validated host configuration. All persistent paths are derived from one data root. */
import { resolve } from "node:path";
import { availableParallelism, totalmem } from "node:os";

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

export const config = {
  port: integer("RELAY_PORT", 8080, 1, 65535),
  host: process.env.RELAY_HOST ?? "127.0.0.1",
  origin: process.env.RELAY_PUBLIC_ORIGIN,
  dataDir: resolve(process.env.RELAY_DATA_DIR ?? ".relay-data"),
  image: process.env.RELAY_IMAGE ?? "relay-workspace:0.1.0",
  maxAgents: integer("RELAY_MAX_AGENTS", 2, 1, 8),
  maxEnvironments: integer("RELAY_MAX_ENVIRONMENTS", 3, 1, 16),
  memoryMb: integer("RELAY_MEMORY_MB", 2048, 256, 65536),
  cpus: Number(process.env.RELAY_CPUS ?? "0.5"),
  timeoutMs: integer("RELAY_RUN_TIMEOUT_MINUTES", 60, 1, 1440) * 60_000,
  hostMemoryMb: Math.floor(totalmem() / 1024 / 1024),
  hostCpus: availableParallelism(),
};
if (!Number.isFinite(config.cpus) || config.cpus <= 0 || config.cpus > config.hostCpus) throw new Error("RELAY_CPUS must fit the host CPU count");
if (config.origin && new URL(config.origin).origin !== config.origin) throw new Error("RELAY_PUBLIC_ORIGIN must be an origin without a trailing slash");
export type Config = typeof config;
