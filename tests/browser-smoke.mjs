/** Browser and HTTP acceptance checks against an isolated real Relay server, without Docker or paid inference. */
import { chromium } from "playwright";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";

const root = resolve(".test-data"); await mkdir(root,{recursive:true});
const dataDir = await mkdtemp(join(root,"browser-"));
const port = 18800 + Math.floor(Math.random()*500), origin = `http://127.0.0.1:${port}`;
const token = "relay-browser-test-token-only-no-real-secrets";
const child = spawn(process.execPath,["server/dist/index.js"], { env:{...process.env,RELAY_PORT:String(port),RELAY_HOST:"127.0.0.1",RELAY_PUBLIC_ORIGIN:origin,RELAY_DATA_DIR:dataDir,RELAY_ACCESS_TOKEN:token},stdio:["ignore","pipe","pipe"],windowsHide:true });
let log=""; child.stdout.on("data",data=>{log+=data}); child.stderr.on("data",data=>{log+=data});
let browser, browserServer;
try {
  let ready=false;
  for(let attempt=0;attempt<80;attempt++) { try { const response=await fetch(`${origin}/api/session`); if(response.ok){ready=true;break;} }catch{} await new Promise(resolve=>setTimeout(resolve,250)); }
  assert.ok(ready,`Server failed to start: ${log}`);
  assert.equal((await fetch(`${origin}/api/state`)).status,401);
  assert.equal((await fetch(`${origin}/api/session`,{method:"POST",headers:{"content-type":"application/json",Origin:"https://wrong.example"},body:JSON.stringify({token})})).status,403);
  browserServer=await chromium.launchServer({headless:true,...(process.env.RELAY_BROWSER_CHANNEL ? {channel:process.env.RELAY_BROWSER_CHANNEL} : process.platform==="win32" ? {channel:"msedge"} : {})});
  browser=await chromium.connect(browserServer.wsEndpoint());
  const page=await browser.newPage({viewport:{width:1512,height:982}}), errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto(origin);
  await page.locator("#login-token").fill(token);
  await page.getByRole("button",{name:"Open workspace"}).click();
  await page.locator("#welcome-new").click();
  await page.getByLabel("Workspace name").fill("Relay acceptance workspace");
  await page.locator("#modal-submit").click();
  await page.getByRole("button",{name:"⌑ README.md"}).click();
  const content=page.locator(".cm-content"); await content.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("# Relay acceptance workspace\n\nEdited and saved through the browser IDE.\n");
  await page.keyboard.press("ControlOrMeta+s");
  await page.getByText("File saved",{exact:true}).waitFor();
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
  await page.locator("summary",{hasText:"src"}).click();
  await page.screenshot({path:join(root,"relay-ide.png"),fullPage:true});
  await page.reload();
  await page.getByRole("button",{name:"⌑ README.md"}).click();
  assert.match(await content.innerText(),/Edited and saved through the browser IDE/);
  assert.equal(await page.locator("#login").isVisible(),false);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:join(root,"relay-mobile.png"),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,"Page overflows mobile viewport");
  assert.deepEqual(errors,[]);
  console.log("Browser checks passed: owner login, origin checks, project creation, IDE editing and save, nested file creation, persistence after reload, mobile layout, no browser exceptions.");
  console.log("Screenshots: .test-data/relay-ide.png and .test-data/relay-mobile.png");
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
