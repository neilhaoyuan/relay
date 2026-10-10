/** Browser and HTTP acceptance checks against an isolated real Relay server, without Docker or paid inference. */
import { chromium } from "playwright";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const root = resolve(".test-data"); await mkdir(root,{recursive:true});
const dataDir = await mkdtemp(join(root,"browser-"));
const port = 18800 + Math.floor(Math.random()*500), origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath,["server/dist/index.js"], { env:{...process.env,RELAY_PORT:String(port),RELAY_HOST:"127.0.0.1",RELAY_PUBLIC_ORIGIN:origin,RELAY_DATA_DIR:dataDir},stdio:["ignore","pipe","pipe"],windowsHide:true });
let log=""; child.stdout.on("data",data=>{log+=data}); child.stderr.on("data",data=>{log+=data});
let browser, browserServer;
try {
  let ready=false;
  for(let attempt=0;attempt<80;attempt++) { try { const response=await fetch(`${origin}/api/session`); if(response.ok){ready=true;break;} }catch{} await new Promise(resolve=>setTimeout(resolve,250)); }
  assert.ok(ready,`Server failed to start: ${log}`);
  assert.equal((await fetch(`${origin}/api/state`)).status,200);
  await assert.rejects(readFile(join(dataDir,"access-token")),/ENOENT/);
  assert.equal((await fetch(`${origin}/api/workspaces`,{method:"POST",headers:{"content-type":"application/json",Origin:"https://wrong.example"},body:JSON.stringify({name:"blocked"})})).status,403);
  assert.equal((await fetch(`${origin}/api/state`,{headers:{"Sec-Fetch-Site":"cross-site"}})).status,403);
  await new Promise((resolve,reject)=>{
    const socket=new WebSocket(`${origin.replace("http","ws")}/ws/events`,{origin});
    socket.once("message",()=>{socket.close();resolve();}); socket.once("error",reject);
  });
  await new Promise((resolve,reject)=>{
    const socket=new WebSocket(`${origin.replace("http","ws")}/ws/events`,{origin:"https://wrong.example"});
    socket.once("open",()=>{socket.close();reject(new Error("Cross-origin socket was accepted"));});
    socket.once("error",error=>{try{assert.match(error.message,/403/);resolve();}catch(failure){reject(failure);}});
  });
  browserServer=await chromium.launchServer({headless:true,...(process.env.RELAY_BROWSER_CHANNEL ? {channel:process.env.RELAY_BROWSER_CHANNEL} : process.platform==="win32" ? {channel:"msedge"} : {})});
  browser=await chromium.connect(browserServer.wsEndpoint());
  const page=await browser.newPage({viewport:{width:1512,height:982}}), errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto(origin);
  assert.equal(await page.locator("#tasks-view").isVisible(),true);
  await page.locator("#new-workspace").click();
  await page.getByLabel("Workspace name").fill("Relay acceptance workspace");
  await page.locator("#modal-submit").click();
  await page.locator("#view-code").click();
  await page.getByRole("button",{name:"⌑ README.md"}).click();
  const content=page.locator(".cm-content"); await content.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("# Relay acceptance workspace\n\nEdited and saved through the browser IDE.\n");
  await page.keyboard.press("ControlOrMeta+s");
  await page.waitForFunction(()=>document.querySelector("#save-file").disabled);
  const state=await page.evaluate(async()=>fetch("/api/state").then(response=>response.json()));
  const id=state.workspaces[0].id;
  assert.match(await readFile(join(dataDir,"workspaces",id,"source","README.md"),"utf8"),/Edited and saved/);
  await page.locator("#new-file").click();
  await page.getByLabel("File path").fill("src/index.ts");
  await page.locator("#modal-submit").click();
  await page.locator("#file-status").filter({hasText:"src/index.ts"}).waitFor();
  await content.click(); await page.keyboard.insertText('export const greeting = "Hello from Relay";\n\nexport function welcome(name: string) {\n  return `${greeting}, ${name}`;\n}\n');
  await page.keyboard.press("ControlOrMeta+s");
  await page.waitForFunction(()=>document.querySelector("#save-file").disabled);
  // Splitter dragging and keyboard resizing must change actual rendered panel dimensions.
  const drag = async (id,dx,dy) => {
    const box=await page.locator(id).boundingBox(); assert.ok(box);
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down();
    await page.mouse.move(box.x+box.width/2+dx,box.y+box.height/2+dy,{steps:8}); await page.mouse.up();
  };
  const sidebarBefore=(await page.locator("#sidebar").boundingBox()).width;
  await drag("#sidebar-resizer",60,0);
  assert.ok((await page.locator("#sidebar").boundingBox()).width>sidebarBefore+40);
  const agentBefore=(await page.locator("#agent-pane").boundingBox()).width;
  await drag("#agent-resizer",-50,0);
  assert.ok((await page.locator("#agent-pane").boundingBox()).width>agentBefore+30);
  const terminalBefore=(await page.locator("#terminal-pane").boundingBox()).height;
  await drag("#terminal-resizer",0,-50);
  assert.ok((await page.locator("#terminal-pane").boundingBox()).height>terminalBefore+30);
  await page.locator("#sidebar-resizer").focus(); await page.keyboard.press("ArrowRight");
  const sidebarWidth=(await page.locator("#sidebar").boundingBox()).width;
  assert.ok(sidebarWidth>sidebarBefore+60);
  await page.locator("#move-agent").click();
  assert.ok((await page.locator("#agent-pane").boundingBox()).x<(await page.locator("#code-column").boundingBox()).x);
  await page.locator("#move-agent").click();
  await page.keyboard.press("ControlOrMeta+j"); assert.equal(await page.locator("#terminal-pane").isVisible(),false);
  await page.keyboard.press("ControlOrMeta+j"); assert.equal(await page.locator("#terminal-pane").isVisible(),true);
  await page.locator("#maximize-terminal").click(); assert.equal(await page.locator(".editor-region").isVisible(),false);
  await page.locator("#maximize-terminal").click(); assert.equal(await page.locator(".editor-region").isVisible(),true);
  await page.locator("#close-agent").click(); assert.equal(await page.locator("#agent-pane").isVisible(),false);
  await page.locator("#toggle-agent").click();
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByLabel("Search commands").fill("toggle sidebar"); await page.keyboard.press("Enter");
  assert.equal(await page.locator("#sidebar").isVisible(),false);
  await page.keyboard.press("ControlOrMeta+b"); assert.equal(await page.locator("#sidebar").isVisible(),true);
  // Drag tabs, preserve undo through tab switches, and protect unsaved edits on close.
  await page.locator('[data-file="src/index.ts"]').dragTo(page.locator('[data-file="README.md"]'));
  assert.equal(await page.locator(".file-tab").first().getAttribute("data-file"),"src/index.ts");
  await content.click(); await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.insertText("// unsaved\n");
  await page.getByRole("tab",{name:/README.md/}).click();
  await page.getByRole("tab",{name:/index.ts/}).click();
  assert.match(await content.innerText(),/unsaved/);
  await page.locator("#view-tasks").click(); assert.equal(await page.locator("#tasks-view").isVisible(),true);
  await page.locator("#view-code").click(); assert.match(await content.innerText(),/unsaved/);
  await page.keyboard.press("ControlOrMeta+z"); assert.doesNotMatch(await content.innerText(),/unsaved/);
  await page.keyboard.insertText("// keep me\n");
  page.once("dialog",dialog=>dialog.dismiss()); await page.getByRole("button",{name:"Close src/index.ts",exact:true}).click();
  assert.equal(await page.getByRole("tab",{name:/index.ts/}).count(),1);
  page.once("dialog",dialog=>dialog.accept()); await page.getByRole("button",{name:"Close src/index.ts",exact:true}).click();
  assert.equal(await page.getByRole("tab",{name:/index.ts/}).count(),0);
  await page.locator("summary",{hasText:"src"}).click();
  await page.locator('[data-path="src/index.ts"]').click();
  assert.doesNotMatch(await content.innerText(),/keep me/);
  await page.screenshot({path:join(root,"relay-ide.png"),fullPage:true});
  await page.reload();
  assert.equal(await page.locator("#tasks-view").isVisible(),true);
  await page.locator("#view-code").click();
  await page.getByRole("button",{name:"⌑ README.md"}).click();
  await content.filter({hasText:"Edited and saved through the browser IDE"}).waitFor();
  assert.match(await content.innerText(),/Edited and saved through the browser IDE/);
  assert.equal(await page.locator("#login").count(),0);
  assert.equal((await page.locator("#sidebar").boundingBox()).width,sidebarWidth);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:join(root,"relay-mobile.png"),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,"Page overflows mobile viewport");
  assert.equal(await page.locator("#sidebar").isVisible(),false);
  await page.locator("#activity-explorer").click(); assert.equal(await page.locator("#sidebar").isVisible(),true);
  await page.locator('[data-path="README.md"]').click(); assert.equal(await page.locator("#sidebar").isVisible(),false);
  await page.locator("#activity-agent").click(); assert.equal(await page.locator("#agent-pane").isVisible(),true);
  await page.locator("#close-agent").click();
  // Agent/Docker-dependent UI flows use explicit browser fixtures; the filesystem/IDE checks above use the real server.
  await page.setViewportSize({width:1512,height:982});
  const parent=state.workspaces[0], groupId=randomUUID(), childA={...parent,id:randomUUID(),name:"Pagination approach A",kind:"agent",parentId:id,groupId,baselineRevision:"baseline",baseFingerprint:"base"}, childB={...childA,id:randomUUID(),name:"Pagination approach B"};
  const runA={id:randomUUID(),title:"Add pagination",workspaceId:childA.id,prompt:"Add pagination and run the test suite.",state:"waiting",createdAt:new Date().toISOString(),startedAt:new Date().toISOString(),finishedAt:null,error:null,threadId:"test-thread",turnId:"test-turn"};
  const runB={...runA,id:randomUUID(),workspaceId:childB.id,title:"Alternative pagination",state:"failed",error:"Test command exited with code 1."};
  const fixture={...state,workspaces:[parent,childA,childB],runs:[runA,runB],system:{...state.system,docker:true,imageReady:true,message:"Ready"}};
  const patch="diff --git a/src/index.ts b/src/index.ts\nindex 1111111..2222222 100644\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const pageSize = 10;\n+export const pageSize = 20;\n";
  const extraPatch="diff --git a/image.bin b/image.bin\nindex 111..222 100644\nGIT binary patch\nliteral 2\nabc\ndiff --git a/deleted.md b/deleted.md\ndeleted file mode 100644\n--- a/deleted.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-old content\n";
  const proposals=new Map([childA,childB].map(w=>[w.id,{id:randomUUID(),workspaceId:w.id,parentId:id,baseFingerprint:"base",resultFingerprint:"result",patch:patch+extraPatch,summary:"3 files changed",createdAt:new Date().toISOString(),appliedAt:null}]));
  let createdRequest, approvalResolved=false;
  await page.route("**/api/state",route=>route.fulfill({json:fixture}));
  await page.route("**/api/workspaces/**",async route=>{
    const url=new URL(route.request().url()), parts=url.pathname.split("/"), workspaceId=parts[3], action=parts[4];
    if(action==="files" && workspaceId!==id) return route.fulfill({json:[]});
    if(action==="review") return route.fulfill({json:proposals.get(workspaceId)});
    if(action==="tasks") {
      createdRequest=route.request().postDataJSON();
      const workspace={...childA,id:randomUUID(),name:createdRequest.name,groupId:null},run={...runA,id:randomUUID(),workspaceId:workspace.id,title:createdRequest.name,prompt:createdRequest.prompt,state:"queued"};
      fixture.workspaces.push(workspace);fixture.runs.push(run); return route.fulfill({status:201,json:{workspace,run}});
    }
    return route.continue();
  });
  await page.route("**/api/runs/**",route=>{
    const parts=new URL(route.request().url()).pathname.split("/"), runId=parts[3], action=parts[4];
    if(action==="events") return route.fulfill({json:new URL(route.request().url()).searchParams.get("after")!=="0" ? [] : [{sequence:1,runId,type:"item/completed",createdAt:runA.createdAt,data:{item:{id:"command-1",type:"commandExecution",command:"npm test",status:"completed",exitCode:0,aggregatedOutput:"12 tests passed"}}}]});
    if(action==="approvals") {
      if(route.request().method()==="POST") {approvalResolved=true;runA.state="completed";return route.fulfill({json:{resolved:true}});}
      return route.fulfill({json:runId===runA.id && !approvalResolved ? [{id:"approval-1",method:"item/commandExecution/requestApproval",params:{command:"npm test"}}] : []});
    }
    if(action==="cancel") {const run=fixture.runs.find(r=>r.id===runId);run.state="cancelled";return route.fulfill({json:run});}
    return route.continue();
  });
  await page.route("**/api/changes/*/apply",route=>{
    const proposal=[...proposals.values()].find(p=>route.request().url().includes(p.id));
    if(proposal.workspaceId===childB.id) return route.fulfill({status:409,json:{error:"The primary workspace changed after this snapshot. Resolve the differences manually."}});
    childA.appliedAt=new Date().toISOString();proposal.appliedAt=childA.appliedAt; return route.fulfill({json:proposal});
  });
  await page.reload();
  await page.locator(`[data-run="${runA.id}"]`).click();
  await page.locator("#task-detail-title").filter({hasText:"Add pagination"}).waitFor();
  await page.getByRole("button",{name:"Allow",exact:true}).click();
  await page.locator("#task-detail-status").filter({hasText:"Completed"}).waitFor();
  assert.equal(approvalResolved,true);
  await page.locator("#task-search").fill("Alternative"); assert.equal(await page.locator(".task-card").count(),1);
  await page.locator("#task-search").fill("");
  await page.screenshot({path:join(root,"relay-tasks.png"),fullPage:true});
  await page.locator("#view-experiments").click();
  await page.locator(`[data-compare="${childA.id}"]`).check();await page.locator(`[data-compare="${childB.id}"]`).check();
  await page.locator("#compare-experiments").click();
  await page.locator(".review-card").filter({hasText:"Pagination approach B"}).getByRole("button",{name:"src/index.ts",exact:true}).waitFor();
  assert.equal(await page.locator(".split-diff").count(),2);
  assert.match(await page.locator(".split-diff").first().innerText(),/pageSize = 20/);
  const firstReview=page.locator(`[data-review-workspace="${childA.id}"]`);
  await firstReview.getByRole("button",{name:"image.bin · binary",exact:true}).click();
  await firstReview.getByText("Binary file changed.",{exact:false}).waitFor();
  await firstReview.getByRole("button",{name:"deleted.md · deleted",exact:true}).click();
  assert.match(await firstReview.locator(".split-diff").innerText(),/old content/);
  await firstReview.getByRole("button",{name:"src/index.ts",exact:true}).click();
  await page.screenshot({path:join(root,"relay-review.png"),fullPage:true});
  page.once("dialog",dialog=>dialog.accept());
  await page.locator(`[data-review-workspace="${childA.id}"]`).getByRole("button",{name:"Apply to primary",exact:true}).click();
  await page.locator(`[data-review-workspace="${childA.id}"]`).getByRole("button",{name:"Applied",exact:true}).waitFor();
  page.once("dialog",dialog=>dialog.accept());
  await page.locator(`[data-review-workspace="${childB.id}"]`).getByRole("button",{name:"Apply to primary",exact:true}).click();
  await page.locator(`[data-review-workspace="${childB.id}"] .review-error`).filter({hasText:"primary workspace changed"}).waitFor();
  await page.locator("#view-tasks").click();await page.locator("#new-task").click();
  await page.getByLabel("Task name",{exact:true}).fill("Add keyboard navigation");
  await page.getByLabel("Instructions",{exact:true}).fill("Implement keyboard navigation and verify focus order.");
  await page.locator("#modal-submit").click();
  await page.locator("#task-detail-title").filter({hasText:"Add keyboard navigation"}).waitFor();
  assert.equal(createdRequest.isolated,true);assert.equal(createdRequest.name,"Add keyboard navigation");
  page.once("dialog",dialog=>dialog.accept());await page.locator("#cancel-run").click();
  await page.locator("#task-detail-status").filter({hasText:"Cancelled"}).waitFor();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,"Task view overflows mobile viewport");
  await page.screenshot({path:join(root,"relay-tasks-mobile.png"),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log("Browser checks passed: token-free access, HTTP/WebSocket origin checks, workspace creation, editing/saving, resizing, panel docking and toggles, command palette, tab dragging/closing, undo preservation, persisted layout, mobile views, task creation/filtering/approval/cancellation, experiment comparison, review application/conflicts, no browser exceptions.");
  console.log("Screenshots: .test-data/relay-{ide,mobile,tasks,review,tasks-mobile}.png");
} finally {
  console.log("Closing acceptance-test browser…");
  await browser?.close();
  if(browserServer){
    // Edge may keep background processes after a graceful close. Kill only this owned test process tree.
    const processId=browserServer.process().pid;
    if(process.platform==="win32" && processId) await promisify(execFile)("taskkill",["/PID",String(processId),"/T","/F"],{windowsHide:true}).catch(()=>{});
    await browserServer.kill();
  }
  console.log("Stopping acceptance-test server…");
  if(child.exitCode===null){child.kill();await Promise.race([once(child,"exit"),new Promise(resolve=>setTimeout(resolve,5000))]);}
  child.stdout.destroy(); child.stderr.destroy(); child.unref();
  assert.ok(dataDir.startsWith(root)); await rm(dataDir,{recursive:true,force:true});
  console.log("Acceptance-test cleanup complete.");
}
