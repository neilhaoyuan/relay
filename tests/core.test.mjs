/** Real Git/SQLite integration tests; fake containers isolate scheduler behavior from Docker availability. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { Store } from "../server/dist/store.js";
import { Files } from "../server/dist/files.js";
import { Orchestrator } from "../server/dist/orchestrator.js";
import { Access } from "../server/dist/auth.js";

const testRoot = resolve(".test-data");
await mkdir(testRoot, { recursive: true });
const config = { maxAgents: 2, maxEnvironments: 3, memoryMb: 512, hostMemoryMb: 4096, cpus: 0.5, hostCpus: 2, timeoutMs: 60_000, port: 8080 };
class FakeRuntime {
  containers = new Map();
  agents = [];
  stopped = [];
  available = true;
  async list() { if (!this.available) throw new Error("Docker offline"); return [...this.containers].map(([workspaceId, state]) => ({ workspaceId, state, name: workspaceId })); }
  async start(id) { this.containers.set(id, "running"); }
  async stop(id) { if (!this.available) throw new Error("Docker offline"); this.stopped.push(id); if (this.containers.has(id)) this.containers.set(id, "exited"); }
  async remove(id) { this.containers.delete(id); }
  async freeze(id, work) { return work(); }
  agent(id) {
    const process = new EventEmitter(); process.stdin = new PassThrough(); process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.kill = () => {};
    let buffer = "";
    process.stdin.on("data", data => {
      buffer += data.toString(); let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const message = JSON.parse(buffer.slice(0,index)); buffer = buffer.slice(index + 1);
        if (message.id == null) continue;
        const result = message.method === "initialize" ? {} : message.method.startsWith("thread/") ? { thread: { id: `thread-${id}` } } : { turn: { id: `turn-${id}` } };
        queueMicrotask(() => process.stdout.write(JSON.stringify({ id: message.id, result }) + "\n"));
      }
    });
    process.complete = (status = "completed") => process.stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { id: `turn-${id}`, status } } }) + "\n");
    this.agents.push({ id, process }); return process;
  }
}
async function fixture(t) {
  const dir = await mkdtemp(join(testRoot, "core-")), store = new Store(dir), files = new Files(dir), runtime = new FakeRuntime();
  const service = new Orchestrator(store, files, runtime, config);
  t.after(async () => { await service.shutdown(); store.close(); assert.ok(dir.startsWith(testRoot + "/") || dir.startsWith(testRoot + "\\")); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, files, runtime, service };
}
const settled = () => new Promise(resolve => setTimeout(resolve, 15));

test("SQLite events survive restart, paginate, and preserve their cursor order", async t => {
  const dir = await mkdtemp(join(testRoot, "events-")); t.after(() => rm(dir, { recursive: true, force: true }));
  let store = new Store(dir); const installation = store.installationId;
  for (let index=0;index<510;index++) store.event("a", "output", { index });
  store.event("b", "output", { other: true }); store.close(); store = new Store(dir);
  try {
    assert.equal(store.installationId, installation);
    const first = store.events("a"); assert.equal(first.length, 500);
    const second = store.events("a", first.at(-1).sequence); assert.equal(second.length, 10);
    assert.deepEqual([...first,...second].map(event => event.data.index), Array.from({length:510},(_,i)=>i));
  } finally { store.close(); }
});

test("file saves detect conflicts and reject traversal and symlink escapes", async t => {
  const { files, service, dir } = await fixture(t); const workspace = await service.import("main", "");
  const original = await files.read(workspace.id, "README.md");
  await files.save(workspace.id, original.path, "new contents", original.version);
  await assert.rejects(files.save(workspace.id, original.path, "overwrite", original.version), /changed since/);
  await assert.rejects(files.read(workspace.id, "../README.md"), /Invalid/);
  await assert.rejects(files.save(workspace.id, ".git/config", "bad", null), /excluded/);
  await mkdir(join(dir,"outside")); await writeFile(join(dir,"outside","secret"),"secret");
  await symlink(join(dir,"outside"), join(files.root(workspace.id),"link"), "junction");
  await assert.rejects(files.read(workspace.id,"link/secret"), /Symlink/);
});

test("experiments capture dirty and untracked files, exclude secrets, and promote once", async t => {
  const { files, service, store } = await fixture(t); const main = await service.import("main", "");
  const readme = await files.read(main.id, "README.md");
  await files.save(main.id, "README.md", "uncommitted baseline\n", readme.version);
  await files.save(main.id, "src/new.ts", "export const value = 1;\n", null);
  await writeFile(join(files.root(main.id), ".env"), "SECRET=must-not-copy");
  const [copy] = await service.copies(main.id,[{name:"experiment"}]);
  assert.equal((await files.read(copy.id,"README.md")).content,"uncommitted baseline\n");
  await assert.rejects(readFile(join(files.root(copy.id),".env")), /ENOENT/);
  const before = await files.read(copy.id,"src/new.ts");
  await files.save(copy.id,"src/new.ts","export const value = 2;\n",before.version);
  assert.equal((await files.read(main.id,"src/new.ts")).content,"export const value = 1;\n");
  const proposal = await service.propose(copy.id); assert.match(proposal.patch,/value = 2/);
  await service.apply(proposal.id); assert.equal((await files.read(main.id,"src/new.ts")).content,"export const value = 2;\n");
  assert.ok(store.workspace(copy.id).appliedAt); await assert.rejects(service.apply(proposal.id),/already applied/);
  await service.discard(copy.id); await service.discard(copy.id); assert.equal(store.workspace(copy.id).state,"discarded");
  assert.match((await files.read(main.id,"src/new.ts")).content,/value = 2/);
});

test("promotion rejects changed primary files and changes made after review", async t => {
  const { files, service } = await fixture(t); const main = await service.import("main", "");
  const [copy] = await service.copies(main.id,[{name:"experiment"}]);
  await files.save(copy.id,"new.txt","candidate",null);
  const proposal = await service.propose(copy.id);
  await files.save(copy.id,"later.txt","later",null);
  await assert.rejects(service.apply(proposal.id),/changed after review/);
  const current = await service.propose(copy.id);
  await files.save(main.id,"owner.txt","keep",null);
  await assert.rejects(service.apply(current.id),/primary workspace changed/);
  await assert.rejects(files.read(main.id,"new.txt"),/ENOENT/);
});

test("parallel agents use equivalent independent snapshots and obey total concurrency", async t => {
  const { service, runtime, store } = await fixture(t); const main = await service.import("main", "");
  const copies = await service.copies(main.id, [{name:"a",prompt:"first"},{name:"b",prompt:"second"},{name:"c",prompt:"third"}]);
  assert.equal(new Set(copies.map(copy=>copy.baseFingerprint)).size,1);
  assert.equal(new Set(copies.map(copy=>copy.id)).size,3);
  assert.equal(service.runs().find(run=>run.workspaceId===copies[0].id).title,"a");
  await service.tick(); await settled();
  assert.equal(runtime.agents.length,2); assert.equal(service.runs().filter(run=>run.state==="queued").length,1);
  runtime.agents[0].process.complete("failed"); await settled(); await service.tick(); await settled();
  assert.equal(runtime.agents.length,3); assert.equal(service.runs().filter(run=>run.state==="running").length,2);
  const second = service.runs().find(run=>run.workspaceId===copies[1].id);
  await service.cancel(second.id); assert.equal(store.run(second.id).state,"cancelled"); assert.ok(runtime.stopped.includes(copies[1].id));
  assert.equal(service.runs().find(run=>run.workspaceId===copies[2].id).state,"running");
});

test("restart reconciliation stops uncertain tasks and preserves queued work while Docker is offline", async t => {
  const { service, runtime, store } = await fixture(t); const main = await service.import("main", "");
  const run = service.enqueue(main.id,"interrupted task"); run.state="running"; store.put("run",run.id,run); runtime.containers.set(main.id,"running");
  runtime.available=false; await service.tick(); assert.equal(store.run(run.id).state,"running");
  runtime.available=true; await service.tick(); assert.equal(store.run(run.id).state,"interrupted"); assert.ok(runtime.stopped.includes(main.id));
  assert.equal(runtime.agents.length,0);
  const next = service.enqueue(main.id,"continue"); await service.tick(); await settled(); assert.equal(store.run(next.id).state,"running");
});

test("network access accepts loopback and configured Serve hosts, rejecting rebinding and cross-site requests", () => {
  const access = new Access({...config, host:"127.0.0.1", origin:"https://relay.example.ts.net"});
  const request = { headers: { host:"localhost:8080", origin:"http://localhost:8080" }, socket:{remoteAddress:"127.0.0.1"} };
  assert.equal(access.allowed(request),true); assert.equal(access.origin(request),true);
  const remote = {...request,headers:{host:"relay.example.ts.net",origin:"https://relay.example.ts.net"}};
  assert.equal(access.allowed(remote),true); assert.equal(access.origin(remote),true);
  assert.equal(access.allowed({...request,headers:{host:"attacker.example"}}),false);
  assert.equal(access.allowed({...request,headers:{...request.headers,"sec-fetch-site":"cross-site"}}),false);
  assert.equal(access.allowed({...remote,socket:{remoteAddress:"100.64.0.1"}}),false);
  assert.equal(access.origin({...request,headers:{origin:"https://attacker.example"}}),false);
  assert.equal(access.origin({...request,headers:{}}),false);
  assert.throws(()=>new Access({...config,host:"0.0.0.0"}),/127.0.0.1/);
});

test("restart recovery leaves interrupted paused tasks stopped and unpauses idle environments", async t => {
  const { service, runtime, store } = await fixture(t);
  const interrupted = await service.import("interrupted", ""), idle = await service.import("idle", "");
  const run = service.enqueue(interrupted.id, "previous task");
  run.state = "running"; store.put("run", run.id, run);
  runtime.containers.set(interrupted.id, "paused"); runtime.containers.set(idle.id, "paused");
  await service.tick();
  assert.equal(store.run(run.id).state, "interrupted");
  assert.equal(runtime.containers.get(interrupted.id), "exited");
  assert.equal(store.workspace(interrupted.id).state, "stopped");
  assert.equal(runtime.containers.get(idle.id), "running");
  assert.equal(runtime.agents.length, 0);
});

test("a batch larger than container capacity keeps draining as completed workers stop", async t => {
  const { service, runtime } = await fixture(t); const main = await service.import("main", "");
  await service.copies(main.id, Array.from({length:5},(_,index)=>({name:`agent ${index}`,prompt:`task ${index}`})));
  for(let step=0;step<4;step++) {
    await service.tick(); await settled();
    assert.ok(runtime.agents.filter(agent=>service.runs().some(run=>run.workspaceId===agent.id && run.state==="running")).length<=2);
    for(const agent of runtime.agents) if(service.runs().some(run=>run.workspaceId===agent.id && run.state==="running")) agent.process.complete();
    await settled();
  }
  assert.equal(service.runs().filter(run=>run.state==="completed").length,5);
  assert.equal([...runtime.containers.values()].filter(state=>state==="running").length,0);
});

test("a failed termination remains stopping until Docker confirms it, without relaunching", async t => {
  const { service, runtime, store } = await fixture(t); const main=await service.import("main","");
  const run=service.enqueue(main.id,"task"); await service.tick(); await settled();
  runtime.available=false; runtime.agents[0].process.emit("error",new Error("Transport lost")); await settled();
  assert.equal(store.run(run.id).state,"stopping"); assert.equal(store.workspace(main.id).state,"unknown");
  assert.throws(()=>service.enqueue(main.id,"duplicate"),/active or queued/);
  runtime.available=true; await service.tick();
  assert.equal(store.run(run.id).state,"failed"); assert.equal(runtime.agents.length,1);
});

test("binary changes and deletions apply without changing the primary Git index", async t => {
  const { files,service }=await fixture(t); const main=await service.import("main","");
  const original=await files.read(main.id,"README.md");
  await files.save(main.id,"README.md","staged contents\n",original.version);
  await files.git(files.root(main.id),["add","README.md"]);
  await writeFile(join(files.root(main.id),"image.bin"),Buffer.from([0,1,2,255]));
  const [copy]=await service.copies(main.id,[{name:"binary experiment"}]);
  await rm(join(files.root(copy.id),"README.md"));
  await writeFile(join(files.root(copy.id),"image.bin"),Buffer.from([0,100,200,255,0]));
  const proposal=await service.propose(copy.id); assert.match(proposal.patch,/GIT binary patch/);
  await service.apply(proposal.id);
  assert.deepEqual(await readFile(join(files.root(main.id),"image.bin")),Buffer.from([0,100,200,255,0]));
  await assert.rejects(readFile(join(files.root(main.id),"README.md")),/ENOENT/);
  assert.equal(await files.git(files.root(main.id),["show",":README.md"]),"staged contents\n");
});
