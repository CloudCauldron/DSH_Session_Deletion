import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { zipSync, strToU8 } from 'fflate';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import type { SessionHeader } from '../lib/core.js';
import { encodeSegment, exists, projectKey, listRequests, SUPPORTED_DSH } from '../lib/core.js';
import { runGuard } from '../lib/guard.js';
import { tryLock } from '../lib/locks.js';

const repo=resolve('.');
const base=await fs.mkdtemp(join(tmpdir(),'dsh-deletion-integration-'));
const temporary=join(base,'tmp');await fs.mkdir(temporary,{mode:0o700});
// Keep browser profiles, DSH spills and package-manager scratch data inside the fixture.
process.env.TMP=process.env.TEMP=process.env.TMPDIR=temporary;
const home=join(base,'home');
await fs.mkdir(join(home,'profiles/web'),{recursive:true,mode:0o700});

await fs.writeFile(join(home,'profiles/web/package.json'),JSON.stringify({name:'dsh-profile-web',private:true,dependencies:{'@deepseek-ai/dsh-terminal':SUPPORTED_DSH},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@deepseek-ai/dsh-deepseek-chat-import']}}}));
await fs.writeFile(join(home,'profiles/web/pnpm-workspace.yaml'),'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  koffi: true\n');
await fs.writeFile(join(home,'profiles/web/cordis.yml'),'[]\n');
await fs.writeFile(join(home,'profiles/web/cordis.patch.yml'),'[]\n');
// A remote launch selects DSH's in-app folder browser on both platforms.
const env={...process.env,SSH_CONNECTION:'127.0.0.1 10000 127.0.0.1 22',DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',pnpm_config_store_dir:join(base,'pnpm-store')};
// Native Windows cannot spawn a .cmd shim directly; an explicit CLI entry also
// lets either platform test an isolated DSH installation.
const dshArgs=process.env.DSH_CLI?[...process.execArgv.filter(arg=>arg==='--expose-internals'),process.env.DSH_CLI]:[];
const spawnDsh=(args: string[])=>spawn(dshArgs.length?process.execPath:'dsh',[...dshArgs,...args],{env,stdio:['ignore','pipe','pipe']});
const install=spawnDsh(['plugin','--profile','web','add','file:'+repo]);
let installText='';install.stdout.on('data',d=>{installText+=d});install.stderr.on('data',d=>{installText+=d});
assert.equal(await new Promise(r=>install.on('exit',r)),0,'Install failed: '+installText);
await fs.writeFile(join(home,'profiles/web/cordis.patch.yml'),'- insert:\n    - id: deletion-test-terminals\n      name: "@deepseek-ai/dsh-terminal"\n    - id: deletion-test-controls\n      name: '+JSON.stringify(join(repo,'test/host-fixture.ts'))+'\n');
const cwd=join(base,'project');await fs.mkdir(cwd,{recursive:true});
await fs.writeFile(join(cwd,'keep.txt'),'project file');
const id='session-'+randomUUID();
const exclusive='a'.repeat(64),shared='b'.repeat(64);
const stagedShared=createHash('sha256').update('other draft upload').digest('hex');
const stagedExclusive=createHash('sha256').update('target draft upload').digest('hex');
const sessionDir=join(home,'sessions',projectKey(cwd),id);await fs.mkdir(sessionDir,{recursive:true,mode:0o700});
const log=join(sessionDir,'session.v4.jsonl.zstd');
const header: SessionHeader={type:'session',version:4,id,createdAt:Date.now(),cwd,isSeeded:false,delegationDepth:0};
const message={type:'user/message',seq:1,time:Date.now(),surfaceOp:'append',data:{id:randomUUID(),role:'user',source:{kind:'user',rpcId:randomUUID(),clientTimeZone:'Asia/Taipei'},content:[{type:'text',text:'Offline deletion integration fixture'},{type:'text',text:`sha256:${exclusive} sha256:${shared} sha256:${stagedShared}`} ]}};
const events=[{type:'turn/start',seq:0,time:Date.now(),data:{turn:1}},message,
 {type:'session/title',seq:2,time:Date.now(),data:{title:'Offline deletion integration fixture',messageSeqs:[],source:{kind:'user'}}}];
await fs.writeFile(log,Buffer.concat([zstdCompressSync(JSON.stringify(header)+'\n'),zstdCompressSync(events.map(e=>JSON.stringify(e)+'\n').join(''))]));
async function extraSession(name: string,age: number,attachment?: string,meta: Partial<SessionHeader>={}){
 const extra='session-'+randomUUID();const dir=join(home,'sessions',projectKey(meta.cwd??cwd),extra);await fs.mkdir(dir,{recursive:true,mode:0o700});
 const extraHeader={...header,id:extra,createdAt:header.createdAt-age,...meta};
 const extraEvents=events.map(e=>({...e,time:e.time-age,data:e.type==='user/message'?{...e.data,id:randomUUID(),content:[{type:'text',text:name+(attachment?' sha256:'+attachment:'')}]}:e.type==='session/title'?{...e.data,title:name}:e.data}));
 const path=join(dir,'session.v4.jsonl.zstd');await fs.writeFile(path,Buffer.concat([zstdCompressSync(JSON.stringify(extraHeader)+'\n'),zstdCompressSync(extraEvents.map(e=>JSON.stringify(e)+'\n').join(''))]));return {id:extra,path};
}
const preserved=await extraSession('Preserved fixture',20000,shared);const cold=await extraSession('Archived deletion fixture',10000);
const oldWorkspace=join(base,'former-project');await fs.mkdir(oldWorkspace);
const filtered=await extraSession('Filtered workspace membership',90000,undefined,{cwd:oldWorkspace});
const draftOwner=await extraSession('Draft owner fixture',30000);
const interrupted=await extraSession('Interrupted deletion fixture',50000);
const nativeActive=await extraSession('Native active deletion fixture',60000);
const raceDestination=await extraSession('Concurrent reminder destination',70000);
const family=await extraSession('测试含子代理的会话',40000);
const child=await extraSession('Child fixture',39000,undefined,{origin:'subagent',parentSession:family.id,delegationDepth:1});
const grandchild=await extraSession('Grandchild fixture',38000,undefined,{origin:'subagent',parentSession:child.id,delegationDepth:2});
const preservedHash=createHash('sha256').update(await fs.readFile(preserved.path)).digest('hex');
for(const hash of [exclusive,shared]){const path=join(home,'attachments/v1/objects',hash.slice(0,2),hash);await fs.mkdir(join(path,'..'),{recursive:true,mode:0o700});await fs.writeFile(path,'fixture attachment');}
await fs.mkdir(join(home,'llm-deepseek'),{recursive:true,mode:0o700});
await fs.writeFile(join(home,'llm-deepseek/files-v3.json'),JSON.stringify({formatVersion:3,records:[exclusive,shared].map(hash=>({scope:'c'.repeat(64),attachmentId:'sha256:'+hash,variantId:'sha256:'+hash,fileId:'file-'+hash.slice(0,8),bytes:18,createdAt:Date.now(),expiresAt:Date.now()+3600000}))}));
const imageCache=join(home,'cache/attachments/request-images/aa/fixture');
await fs.mkdir(join(imageCache,'..'),{recursive:true,mode:0o700});await fs.writeFile(imageCache,'derived fixture image');
let host: ReturnType<typeof spawnDsh> | undefined;let browser: Browser | undefined;let bootLog='';let exited: Promise<{code:number|null;signal:NodeJS.Signals|null}> | undefined;let port='0';
const errors: string[]=[];
async function start(){
 bootLog='';host=spawnDsh(['web','--no-open','--host','127.0.0.1','--port',port]);
 const running=host;
 exited=new Promise(r=>running.on('exit',(code,signal)=>r({code,signal})));
 host.stdout.on('data',d=>{bootLog+=d});host.stderr.on('data',d=>{bootLog+=d});
 for(let i=0;i<200;i++){
  const match=bootLog.match(/http:\/\/127\.0\.0\.1:(\d+)\/[^\s]*/);
  if(match){assert.doesNotMatch(bootLog.replace(/token=[^\s]+/g,'token=[redacted]'),/entries did not activate/);port=match[1];return match[0];}
  if(host.exitCode!==null)throw new Error('Boot failed: '+bootLog.replace(/token=[^\s]+/g,'token=[redacted]'));
  await delay(100);
 }
 throw new Error('Boot timeout: '+bootLog.replace(/token=[^\s]+/g,'token=[redacted]'));
}
async function stop(){
 if(!host)return;assert(exited);
 if(host.exitCode===null&&host.signalCode===null){host.kill('SIGINT');await Promise.race([exited,delay(15000,undefined,{ref:false}).then(()=>{throw new Error('Host did not exit')})]);}
}
async function waitForHost(check:()=>Promise<boolean>,description:string){
 const deadline=performance.now()+60000;
 while(!await check()){
  assert.ok(performance.now()<deadline,description);
  await delay(100);
 }
}
try{
 const url=await start();
 for(const path of ['status','receipt','gc-size']){
  const response=await fetch(`http://127.0.0.1:${port}/session-deletion/api/${path}`);
  assert.ok([401,403].includes(response.status),path);
  const denied=await response.json();
  assert.equal(denied.error,'Not authorized');
  assert.deepEqual(denied.messages,[{key:'error.unauthorized'}]);
 }
 const catalogs=await fetch(`http://127.0.0.1:${port}/api/session-deletion/locales`);
 assert.ok([401,403].includes(catalogs.status),'the DSH catalog route requires an authenticated owner');
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?join(process.env.PROGRAMFILES!,'Google/Chrome/Application/chrome.exe'):'/opt/google/chrome/chrome'),headless:true,args:['--no-sandbox']});
 // Native UI selectors below use Simplified Chinese, independent of the host locale.
 const context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}});
 context.on('weberror',event=>{
  const error=event.error();
  errors.push((error.stack??error.message).replace(/token=[^\s&]+/g,'token=[redacted]'));
 });
 const page=await context.newPage();
 async function checkDirectoryPicker(){
  await page.getByRole('button',{name:'添加工作区',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'选择工作区目录'});
  await picker.getByRole('button',{name:'打开',exact:true,disabled:false}).waitFor();
  await picker.getByRole('button',{name:'取消'}).click();
 }
 let receiptRequests=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/session-deletion/api/receipt')receiptRequests++});
 const releaseStatus=Promise.withResolvers<void>();
 await page.route('**/session-deletion/api/status',async route=>{await releaseStatus.promise;await route.continue()},{times:1});
 try {
  await Promise.all([page.waitForRequest('**/session-deletion/api/status'),page.goto(url,{waitUntil:'domcontentloaded'})]);
  await page.waitForTimeout(2000);
  const welcome=page.getByRole('button',{name:'继续',exact:true});if(await welcome.count())await welcome.click();
  await page.getByText('开始使用',{exact:true}).waitFor({timeout:5000});
  const onboarding=page.getByRole('dialog').filter({hasText:'开始使用'});
  await onboarding.locator('button').first().click();
  await page.addLocatorHandler(page.getByRole('dialog',{name:'开始使用'}),async dialog=>{const close=dialog.locator('button').first();if(await close.isEnabled())await close.click()},{noWaitAfter:true});
  await checkDirectoryPicker();
 } finally { releaseStatus.resolve(); }
 await waitForHost(async()=>receiptRequests>0,'the plugin did not mount after status became available');
 const getApi=(path:string)=>context.request.get(`http://127.0.0.1:${port}/session-deletion/api/${path}`,{maxRetries:1});
 const status=async()=>{const r=await getApi('status');assert.equal(r.status(),200);return r.json()};
 const receipt=async()=>{const r=await getApi('receipt');assert.equal(r.status(),200);return r.json()};
 async function expectClearRefused(key: string) {
  const { receipt }=await status();
  const response=await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/clear-records`,{
   headers:{'X-DSH-Session-Deletion':'1'},data:{confirmation:'CLEAR_DELETION_RECORDS',revision:receipt.revision},
  });
  assert.equal(response.status(),409);
  assert.deepEqual((await response.json()).messages,[{key}]);
  assert.deepEqual((await status()).receipt,receipt);
 }
 const initialStatus=await status();
 assert.equal(initialStatus.ok,true);
 assert.equal(initialStatus.version,SUPPORTED_DSH);
 const initialReceipt=await receipt();
 assert.deepEqual(initialReceipt,{ok:true,revision:'',deletedIdHashes:[]});
 assert.deepEqual((await status()).receipt,{revision:'',count:0});
 assert.equal(receiptRequests,1,'unchanged receipt is fetched only once despite status polling');
 const unknownRoute=await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/unknown`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:id}});
 assert.equal(unknownRoute.status(),404);
 assert.deepEqual((await unknownRoute.json()).messages,[{key:'error.unknownRoute'}]);
 const debugPreview=await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/preview`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:id}});
 assert.equal(debugPreview.status(),200,'Fixture must be visible to the persistence service');
 // Wait for the real sidebar row, then use the host context menu.
 const row=page.getByText(/^(未命名|Offline deletion integration fixture)$/).first();
 await row.waitFor({timeout:15000});
 await row.click();
 const controls=async(action: string,data: Record<string, unknown>={})=>context.request.post(`http://127.0.0.1:${port}/deletion-test/`+action,{data,maxRetries:action==='state'?1:0});
 for(let i=0;i<100;i++){if((await (await controls('state',{id})).json()).agentResident)break;await delay(50)}
 const archivedProbe=await (await controls('archive-probe',{id})).json();
 assert.deepEqual(archivedProbe,{archived:true,agentResident:true,sessionResident:true,status:'idle',writerOpen:true});
 const writerLock=await tryLock(join(sessionDir,'session.lock'));
 if(writerLock)await writerLock.close();
 assert.equal(writerLock,undefined,'the plugin must contend with the real DSH writer lock');
 console.log('ARCHIVE PROBE: archived=true; Agent, Session and write handle remain resident');
 await controls('unarchive',{id});
 // Compare against the actual native archive dialog, then cancel without stopping anything.
 const dialogAppearance=async (locator: Locator)=>locator.evaluate(node=>{
  const pick=(element: Element | null,keys: readonly (keyof CSSStyleDeclaration)[])=>{if(!element)throw new Error('Missing native dialog element');return Object.fromEntries(keys.map(key=>[key,getComputedStyle(element)[key]]));};
  const description=node.querySelector('p');
  const buttons=[...node.querySelectorAll('button')];
  const cancel=buttons.find(button=>button.textContent==='取消');
  const confirm=buttons.at(-1);
  if(!description||!cancel||!confirm)throw new Error('Native dialog fixture is incomplete');
  const typography=['fontFamily','fontSize','fontWeight','lineHeight','color'] as const;
  const buttonKeys=[...typography,'padding','borderRadius','borderWidth','backgroundColor'] as const;
  return {panel:pick(node,['width','borderRadius','backgroundColor','boxShadow']),title:pick(node.querySelector('h2'),typography),
   description:pick(description,[...typography,'marginTop','marginBottom']),content:pick(description.parentElement,['padding','gap']),
   footer:pick(cancel.parentElement,['padding','gap','justifyContent']),cancel:pick(cancel,buttonKeys),confirm:pick(confirm,buttonKeys)};
 });
 assert.equal((await controls('visual-activity',{id})).status(),200);
 await row.hover();await row.locator('xpath=ancestor::*[.//button][1]').locator('button').first().click();
 await page.getByRole('menuitem',{name:'归档会话',exact:true}).click();
 const nativeDialog=page.getByRole('dialog',{name:'停止并归档此会话？',exact:true});
 await nativeDialog.waitFor();
 const nativeAppearance=await dialogAppearance(nativeDialog);
 await nativeDialog.getByRole('button',{name:'取消',exact:true}).click();
 await controls('visual-activity',{});
 // The count excludes the root, includes recursive subagents, and cancellation preserves all records.
 assert.equal((await controls('open',{id:family.id})).status(),200);
 const familyRow=page.getByText('测试含子代理的会话',{exact:true}).first();
 await familyRow.hover();await familyRow.locator('xpath=ancestor::*[.//button][1]').locator('button').first().click();
 await page.getByRole('menuitem',{name:'删除会话',exact:true}).click();
 const familyDialog=page.getByRole('dialog',{name:'删除此会话？',exact:true});
 await familyDialog.getByText('该会话将被彻底移除（包含与之关联的 2 个子代理），已保存的文件与附件不受影响；如需释放存储空间，可前往左侧「更多」→「释放空间」。',{exact:true}).waitFor();
 assert.equal(await familyDialog.getByRole('checkbox').count(),0);
 assert.equal(await familyDialog.locator('strong').innerText(),'测试含子代理的会话');
 const codeAppearance=(code:Locator)=>code.evaluate(el=>{
  const style=getComputedStyle(el);
  return [style.display,style.marginTop,style.fontFamily,style.fontSize,style.lineHeight,style.color,style.overflowWrap];
 });
 const sessionCode=familyDialog.locator('p code');
 assert.equal(await sessionCode.innerText(),family.id);
 const sessionCodeAppearance=await codeAppearance(sessionCode);
 assert.equal(await familyDialog.getByRole('button',{name:'确认删除',exact:true}).isEnabled(),true);
 await controls('archive-probe',{id:family.id});
 const archivedDialog=page.getByRole('dialog',{name:'删除此会话？',exact:true});
 await archivedDialog.getByRole('button',{name:'确认删除',exact:true}).waitFor();
 await archivedDialog.getByRole('button',{name:'取消',exact:true}).click();
 for(const record of [family,child,grandchild])assert.equal(await exists(record.path),true);
 for(const [sessionId,text] of [[draftOwner.id,'other draft upload'],[id,'target draft upload']]){
  const staged=await controls('stage',{id:sessionId,text});assert.equal(staged.status(),200,await staged.text());
 }
 assert.equal((await controls('maintain',{id})).status(),200);
 // Allow the same-home host scan to finish before the intentionally held work times out.
 await controls('stop-timeout',{ms:2000});

 await page.waitForTimeout(1200);
 await row.hover();await row.locator('xpath=ancestor::*[.//button][1]').locator('button').first().click();
 await page.getByRole('menuitem',{name:'删除会话',exact:true}).waitFor({timeout:5000});
 assert.equal(await page.getByRole('menuitem',{name:'删除会话',exact:true}).count(),1);
 const busyPreview=await (await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/preview`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:id}})).json();
 const refused=await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/delete`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:id,token:busyPreview.token,confirmation:'DELETE_SESSION'}});
 assert.equal(refused.status(),409,'backend must reject busy deletion even if UI is bypassed');
 assert.equal((await status()).pending.length,0);assert.equal(await exists(log),true);
 assert.equal((await status()).archived.includes(id),false,'a refused stop must preserve the original archive state');
 assert.equal((await status()).deletionRunning,true,'a timed-out request retains protection until actual cleanup settles');
 await page.keyboard.press('Escape');await controls('release-maintenance',{id});
 await waitForHost(async()=>!(await status()).deletionRunning,'timed-out deletion did not settle');
 await controls('stop-timeout',{ms:30000});
 await controls('maintain',{id:draftOwner.id});
 const busyGc=await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/gc`,{headers:{'X-DSH-Session-Deletion':'1'},data:{confirmation:'COLLECT_ORPHAN_ATTACHMENTS'}});
 assert.equal(busyGc.status(),409,'GC requires every agent to be idle');
 await page.waitForTimeout(1200);
 const otherPage=await context.newPage();await otherPage.goto(`http://127.0.0.1:${port}/`);await otherPage.waitForTimeout(1200);
 const otherWelcome=otherPage.getByRole('dialog').filter({hasText:'开始使用'});if(await otherWelcome.count())await otherWelcome.locator('button').first().click();
 await otherPage.addLocatorHandler(otherPage.getByRole('dialog',{name:'开始使用'}),async dialog=>{const close=dialog.locator('button').first();if(await close.isEnabled())await close.click()},{noWaitAfter:true});
 await otherPage.getByText(/^(未命名|Offline deletion integration fixture)$/).first().click();
 const independentPage=await context.newPage();
 await independentPage.goto(`http://127.0.0.1:${port}/`);await independentPage.waitForTimeout(1200);
 await independentPage.addLocatorHandler(independentPage.getByRole('dialog',{name:'开始使用'}),async dialog=>{const close=dialog.locator('button').first();if(await close.isEnabled())await close.click()},{noWaitAfter:true});
 await independentPage.getByText('Draft owner fixture',{exact:true}).first().click();
 async function openRecordSettings(tab: Page) {
  await tab.getByRole('button',{name:'插件',exact:true}).click();
  await tab.locator('[data-plugin-package="dsh-session-deletion"]').getByRole('button',{name:/^查看/}).click();
  return tab.locator('[data-plugin-detail="dsh-session-deletion"] [data-plugin-config]');
 }
 const recordSettings=await openRecordSettings(independentPage);
 const clearRecords=(disabled:boolean)=>recordSettings.getByRole('button',{name:'清理',exact:true,disabled});
 await recordSettings.getByText('当前无会话删除记录',{exact:true}).waitFor();
 await clearRecords(true).waitFor();
 for(const tab of [page,otherPage,independentPage])await tab.evaluate(()=>{const input=document.createElement('textarea');input.id='deletion-lock-probe';document.body.append(input)});
 await page.waitForTimeout(1000);
 await controls('hold-delete',{id});
 await row.hover();
 await row.locator('xpath=ancestor::*[.//button][1]').locator('button').first().click();
 const deletionItem=page.getByRole('menuitem',{name:'删除会话',exact:true});
 const menuItems=page.getByRole('menuitem');
 assert.match(await menuItems.nth(-2).innerText(),/^归档会话/);
 assert.equal(await menuItems.last().innerText(),'删除会话','deletion follows the native archive action');
 assert.equal(await deletionItem.locator('svg').count(),1);
 assert.equal(await deletionItem.evaluate(el=>getComputedStyle(el).fontSize),await menuItems.first().evaluate(el=>getComputedStyle(el).fontSize));
 await deletionItem.hover();
 await deletionItem.click({timeout:5000});
 const deletionDialog=page.getByRole('dialog',{name:'删除此会话？',exact:true});
 await deletionDialog.getByText('该会话将被彻底移除，已保存的文件与附件不受影响；如需释放存储空间，可前往左侧「更多」→「释放空间」。',{exact:true}).waitFor();
 assert.equal(await deletionDialog.getByRole('checkbox').count(),0);
 assert.equal(await deletionDialog.locator('strong').innerText(),'Offline deletion integration fixture');
 assert.equal(await deletionDialog.locator('code').innerText(),id);
 assert.equal((await deletionDialog.innerText()).includes('子代理'),false,'no zero-subagent boilerplate');
 const deletionAppearance=await dialogAppearance(deletionDialog);
 assert.deepEqual(deletionAppearance,nativeAppearance,'private deletion uses the actual native modal and button styles');
 await page.getByRole('button',{name:'确认删除',exact:true}).click();
 const waitForHeldDeletion=()=>waitForHost(async()=>(await (await controls('held')).json()).held,'deletion did not reach the projection cleanup');
 await waitForHeldDeletion();
 const lockedProbe=await controls('locked-transcript',{id});assert.equal(lockedProbe.status(),200,await lockedProbe.text());
 const selected=await lockedProbe.json();assert.equal(selected.location.path,log);
 const [journal]=await listRequests(home);
 assert.equal(journal.schema,1);assert.deepEqual(journal.plan.ids,[id]);
 const [target]=journal.plan.directories;
 assert.equal(join(home,target.path,target.transcript.path),log);
 const storedHash=createHash('sha256');
 for await(const chunk of createReadStream(selected.location.path))storedHash.update(chunk);
 assert.deepEqual(target.transcript,{path:basename(log),sizeBytes:selected.sizeBytes,sha256:storedHash.digest('hex')});
 const deleteToast=page.getByRole('alert').filter({hasText:'正在删除会话…'});
 await page.waitForFunction(()=>[...document.querySelectorAll('[role="alert"]')].some(el=>el.textContent==='正在删除会话…'));
 assert.match(await deleteToast.getAttribute('class')??'',/toast/,'progress uses the DSH Toast primitive');
 assert.equal(await deleteToast.evaluate(el=>el.parentElement===document.body),true,'native Toast renders through its portal');
 await otherPage.waitForFunction(()=>[...document.querySelectorAll('[role="alert"]')].some(el=>el.textContent==='正在删除会话…'));
 assert.equal((await status()).deletionRunning,true);
 await expectClearRefused('error.cleanupBusy');
 const pendingNotice='会话删除未完成';
 assert.equal(await otherPage.getByText(pendingNotice,{exact:true}).count(),0,'a pending journal is not an interruption while the server is deleting');
 const deletingDialog=page.getByRole('dialog',{name:/归档并删除此会话|删除此会话/});
 assert.equal(await deletingDialog.locator('button').evaluateAll((buttons: HTMLButtonElement[])=>buttons.every(button=>button.disabled)),true);
 await page.keyboard.press('Escape');
 assert.equal(await deletingDialog.count(),1,'native deletion modal stays open until submission completes');
 await page.mouse.click(5,5);assert.equal(await deletingDialog.count(),1,'backdrop clicks cannot dismiss an executing deletion');
 await page.waitForFunction(()=>document.querySelector<HTMLElement>('#deletion-lock-probe')?.inert===true);
 await otherPage.waitForFunction(()=>document.querySelector<HTMLElement>('#deletion-lock-probe')?.inert===true);
 assert.equal((await controls('input',{id})).status(),409,'another tab/API cannot send input during deletion');
 assert.equal(await independentPage.locator('#deletion-lock-probe').evaluate((el: HTMLElement)=>el.inert),false,'another conversation stays interactive');
 assert.equal((await controls('direct-input',{id:draftOwner.id})).status(),200,'another agent can publish while private deletion is in progress');
 assert.equal((await controls('stage',{id:draftOwner.id,text:'parallel upload'})).status(),200,'another conversation can upload during private deletion');
 assert.equal((await controls('pin',{id})).status(),409,'workspace pin cannot recreate target bookkeeping during cleanup');
 assert.equal((await controls('stage',{id,text:'late upload'})).status(),409,'uploads cannot publish after the target is locked');
 await controls('release-delete');
 await page.getByRole('dialog',{name:/归档并删除此会话|删除此会话/}).waitFor({state:'hidden',timeout:30000});
 const deletedToast=page.getByRole('alert').filter({hasText:'会话已删除：Offline deletion integration fixture'});
 await deletedToast.waitFor();
 assert.equal(await deletedToast.locator(':scope > :first-child svg').count(),1);
 assert.match(await deletedToast.getAttribute('class')??'',/toast/);
 assert.equal(await deletedToast.evaluate(el=>el.parentElement===document.body),true);
 assert.equal(host!.exitCode,null,'DSH must remain running during deletion');
 assert.equal(await exists(log),false,'session log must disappear before DSH exits');
 assert.equal((await status()).pending.length,0);
 const deletedReceipt=await receipt();
 assert.notEqual(deletedReceipt.revision,initialReceipt.revision);
 assert.deepEqual(deletedReceipt.deletedIdHashes,[createHash('sha256').update(id).digest('hex')]);
 assert.deepEqual((await status()).receipt,{revision:deletedReceipt.revision,count:1});
 await recordSettings.getByText('已累积 1 条会话删除记录',{exact:true}).waitFor();
 await clearRecords(false).waitFor(); // The unrelated active session still allows record cleanup.
 await page.waitForFunction(()=>!document.querySelector<HTMLElement>('#deletion-lock-probe')?.inert);
 await page.evaluate(id=>localStorage.setItem('dsh.conversation.'+id,JSON.stringify({draft:'late stale-tab write'})),id);
 await page.waitForFunction(id=>localStorage.getItem('dsh.conversation.'+id)===null,id);
 assert.equal(receiptRequests,2,'one new receipt fetch after deletion; late writes use cached tombstones');
 assert.equal(await fs.readFile(join(cwd,'keep.txt'),'utf8'),'project file');
 assert.equal(await exists(join(home,'attachments/v1/objects',exclusive.slice(0,2),exclusive)),true,'private deletion retains all attachments');
 assert.equal(await exists(imageCache),true,'private deletion does not clear the shared image cache');
 assert.equal(await fs.readFile(join(home,'attachments/v1/objects',shared.slice(0,2),shared),'utf8'),'fixture attachment');
 assert.deepEqual(JSON.parse(await fs.readFile(join(home,'llm-deepseek/files-v3.json'),'utf8')).records.map((r: { attachmentId: string })=>r.attachmentId),['sha256:'+exclusive,'sha256:'+shared]);
 assert.equal(createHash('sha256').update(await fs.readFile(preserved.path)).digest('hex'),preservedHash);
 assert.equal(await fs.readFile(join(home,'attachments/v1/file-objects',stagedShared.slice(0,2),stagedShared),'utf8'),'other draft upload','another session staged receipt protects its bytes');
 assert.equal(await exists(join(home,'attachments/v1/file-objects',stagedExclusive.slice(0,2),stagedExclusive)),true,'private deletion leaves staged-only uploads for later GC');
 assert.equal((await (await controls('adapters')).json()).ids.includes(id),false,'plugin restoration closures must release deleted agents');
 // GC is separately initiated from the native More menu; busy failure changes no attachments.
 const reclaimableBytes=Buffer.byteLength('fixture attachment')+Buffer.byteLength('target draft upload')+Buffer.byteLength('derived fixture image');
 const gcMenuName=`释放空间（${reclaimableBytes} B）`;
 let releaseSize!: () => void;
 const sizeHold=new Promise<void>(resolve=>{releaseSize=resolve});
 await page.route('**/session-deletion/api/gc-size',async route=>{await sizeHold;await route.continue()},{times:1});
 await page.locator('nav').getByRole('button',{name:'更多',exact:true}).click();
 const sizeLoading=page.getByRole('status',{name:'正在计算可清理体积',exact:true});
 await sizeLoading.waitFor();
 assert.equal(await sizeLoading.locator('svg[data-state="ongoing"]').count(),1,'size preview uses the native StateDot spinner');
 assert.notEqual(await sizeLoading.locator('svg g').evaluate(el=>getComputedStyle(el).animationName),'none','the native loading circle animates');
 const sizeResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/session-deletion/api/gc-size');
 releaseSize();
 const sizeResult=await sizeResponse;assert.equal(sizeResult.status(),200,await sizeResult.text());
 await page.getByRole('menuitem',{name:gcMenuName,exact:true}).click();
 await page.getByRole('dialog',{name:'清理残留附件与缓存？',exact:true}).waitFor();
 await page.getByText('将移除无关联的本地附件及临时图片缓存以释放空间，操作期间请确保其他会话处于空闲状态。',{exact:true}).waitFor();
 const gcAppearance=await dialogAppearance(page.getByRole('dialog',{name:'清理残留附件与缓存？',exact:true}));
 assert.deepEqual(gcAppearance,{...nativeAppearance,confirm:{...nativeAppearance.confirm,color:nativeAppearance.cancel.color}},
  'GC uses native modal and button styles with the default confirmation text color');
 await page.getByRole('dialog',{name:'清理残留附件与缓存？',exact:true}).getByRole('button',{name:'取消',exact:true}).click();
 assert.equal((await status()).gc,null,'cancel does not execute GC');
 assert.equal(await page.getByRole('alert').filter({hasText:/共清理/}).count(),0);
 await page.route('**/session-deletion/api/gc-size',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Cannot scan'})}),{times:1});
 await page.locator('nav').getByRole('button',{name:'更多',exact:true}).click();
 await page.getByRole('menuitem',{name:'释放空间（大小未知）',exact:true}).click();
 await page.getByRole('button',{name:'确认清理',exact:true}).click();
 await page.getByRole('dialog',{name:'清理残留附件与缓存？',exact:true}).getByRole('alert').waitFor();
 assert.match(await page.getByRole('dialog',{name:'清理残留附件与缓存？',exact:true}).getByRole('alert').innerText(),/仍有|尚未结束/);
 await page.waitForFunction(()=>[...document.querySelectorAll<HTMLButtonElement>('.dsh-session-deletion-modal button')].every(button=>!button.disabled));
 assert.equal(await exists(join(home,'attachments/v1/objects',exclusive.slice(0,2),exclusive)),true);
 await controls('clear-input',{id:draftOwner.id});await controls('release-maintenance',{id:draftOwner.id});
 assert.equal((await controls('hold-gc')).status(),200);
 await page.getByRole('button',{name:'确认清理',exact:true}).click();
 for(let i=0;i<100;i++){if((await (await controls('gc-held')).json()).held)break;await delay(50)}
 assert.equal((await (await controls('gc-held')).json()).held,true);
 await clearRecords(true).waitFor();
 await expectClearRefused('error.cleanupBusy');
 const importArchive=(workspace:string,data:Buffer)=>context.request.post(`http://127.0.0.1:${port}/api/deepseek-chat-import/archive?workspaceId=${workspace}`,{
  headers:{'Content-Type':'application/octet-stream'},data,
 });
 const busyImport=await importArchive('unused',Buffer.alloc(0));
 assert.equal((await busyImport.json()).outcome.error.reason,'busy');
 await page.getByRole('button',{name:'正在清理残留附件与缓存…',exact:true}).waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('[role="alert"]')].some(el=>el.textContent==='正在清理残留附件与缓存…'));
 const busyDialog=page.getByRole('dialog',{name:'清理残留附件与缓存？',exact:true});
 assert.equal(await busyDialog.locator('button').count(),3);
 assert.equal(await busyDialog.locator('button').evaluateAll((buttons: HTMLButtonElement[])=>buttons.every(button=>button.disabled)),true,'all native GC buttons, including close, are disabled');
 assert.equal(await page.locator('nav button').evaluateAll((buttons: HTMLElement[])=>buttons.every(button=>button.inert)),true,'session navigation controls remain inert');
 await page.mouse.click(5,5); // Native backdrop dismissal is also blocked.
 await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('dialog',{name:'清理残留附件与缓存？',exact:true}).count(),1,'busy GC cannot be dismissed through native Modal keyboard handling');
 await independentPage.waitForFunction(()=>document.querySelector<HTMLElement>('#deletion-lock-probe')?.inert===true);
 assert.equal((await controls('direct-input',{id:draftOwner.id})).status(),409,'GC blocks synchronous background publication');
 let uploaded=false;
 const duringGc=controls('stage',{id:draftOwner.id,text:'after GC upload'}).then(response=>{uploaded=true;return response});
 await delay(100);assert.equal(uploaded,false,'new uploads queue until GC completes');
 await controls('release-gc');
 const resultToast=page.getByRole('alert').filter({hasText:'共清理 3 项残留附件与缓存文件。'});
 await resultToast.waitFor({timeout:30000});
 assert.equal(await resultToast.locator(':scope > :first-child svg').count(),1);
 assert.equal(await resultToast.innerText(),'共清理 3 项残留附件与缓存文件。');
 assert.match(await resultToast.getAttribute('class')??'',/toast/);
 assert.equal(await resultToast.evaluate(el=>el.parentElement===document.body),true);
 assert.equal(await page.locator('.dsh-session-deletion-gc').count(),0,'successful GC closes its modal automatically');
 assert.equal((await duringGc).status(),200);
 await page.waitForFunction(()=>!document.querySelector<HTMLElement>('#deletion-lock-probe')?.inert);
 // A second pass has nothing to reclaim and still uses the native Toast.
 await page.locator('nav').getByRole('button',{name:'更多',exact:true}).click();
 await page.getByRole('menuitem',{name:'释放空间（0 B）',exact:true}).click();
 await page.getByRole('button',{name:'确认清理',exact:true}).click();
 const emptyResult=page.getByRole('alert').filter({hasText:'共清理 0 项残留附件与缓存文件。'});
 await emptyResult.waitFor({timeout:30000});
 assert.equal(await emptyResult.locator(':scope > :first-child svg').count(),1);
 assert.equal(await emptyResult.innerText(),'共清理 0 项残留附件与缓存文件。');
 assert.equal(await page.locator('.dsh-session-deletion-gc').count(),0);
 assert.equal(await exists(join(home,'attachments/v1/objects',exclusive.slice(0,2),exclusive)),false);
 assert.equal(await exists(imageCache),false,'explicit GC clears derived image cache');
 assert.equal(await exists(join(home,'attachments/v1/file-objects',stagedExclusive.slice(0,2),stagedExclusive)),false);
 assert.equal(await exists(join(home,'attachments/v1/file-objects',stagedShared.slice(0,2),stagedShared)),true,'GC protects other staged drafts');
 assert.equal(await exists(join(home,'attachments/v1/objects',shared.slice(0,2),shared)),true);
 assert.deepEqual(JSON.parse(await fs.readFile(join(home,'llm-deepseek/files-v3.json'),'utf8')).records.map((r: { attachmentId: string })=>r.attachmentId),['sha256:'+shared]);
 // DSH resolves the encoded ID using the volume's own case semantics.
 const caseAlias=join(dirname(dirname(cold.path)),cold.id.toUpperCase());
 if(await exists(caseAlias))await fs.rename(dirname(cold.path),caseAlias);
 const coldProbe=await (await controls('archive-probe',{id:cold.id})).json();assert.equal(coldProbe.archived,true);
 // A cold session copied from Windows has no pre-existing POSIX writer lock.
 if(process.platform==='linux')assert.equal(await exists(join(cold.path,'../session.lock')),false);
 const coldPreview=await (await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/preview`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:cold.id}})).json();assert.equal(coldPreview.archived,true);
 await controls('block-status');
 const coldDeleted=await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/delete`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:cold.id,token:coldPreview.token,confirmation:'DELETE_SESSION'}});
 assert.equal(coldDeleted.status(),500,'inject a diagnostic write failure after the durable deletion receipt');
 await controls('unblock-status');
 assert.equal(await exists(cold.path),false);
 assert.ok((await receipt()).deletedIdHashes.includes(createHash('sha256').update(cold.id).digest('hex')),'post-commit diagnostic failure still publishes the new receipt');
 assert.equal((await controls('input',{id:cold.id})).status(),409,'post-commit failure must still install the deleted-session tombstone');
 // Real native cold resume, external Activation, owned job, and current schedule schema.
 const nativeStarted=await controls('native-tree',{id:nativeActive.id,otherId:preserved.id});assert.equal(nativeStarted.status(),200,await nativeStarted.text());
 const nativeTree=await nativeStarted.json();
 for(let i=0;i<100;i++){const state=await(await controls('native-tree-state',{id:nativeActive.id})).json();if(state.rootActive&&state.childActive)break;await delay(20)}
 const nativeBefore=await(await controls('native-tree-state',{id:nativeActive.id})).json();
 assert.equal(nativeBefore.rootActive,true);assert.equal(nativeBefore.childActive,true);assert.equal(nativeBefore.externalStopped,false);
 assert.equal((await status()).archived.includes(nativeActive.id),false);
 const nativePreview=await(await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/preview`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:nativeActive.id}})).json();
 assert.equal(nativePreview.count,2);
 const activeRow=page.locator(`[data-row-key="session:${nativeActive.id}"]`);
 await activeRow.hover();await activeRow.locator('button').first().click();
 // The click waits for the next status poll after the injected diagnostic failure.
 await page.getByRole('menuitem',{name:'删除会话',exact:true}).click();
 const stoppingDialog=page.getByRole('dialog',{name:'删除此会话？',exact:true});
 await stoppingDialog.getByRole('button',{name:'确认删除',exact:true}).click();
 for(let i=0;i<100;i++){if((await(await controls('native-tree-state',{id:nativeActive.id})).json()).externalPending)break;await delay(20)}
 assert.equal((await(await controls('native-tree-state',{id:nativeActive.id})).json()).externalPending,true);
 assert.equal(await activeRow.count(),1,'the visible main row remains throughout native preparation');
 assert.equal(await exists(nativeActive.path),true);assert.equal((await status()).pending.length,0);
 assert.equal(await stoppingDialog.locator('button').evaluateAll((buttons:HTMLButtonElement[])=>buttons.every(button=>button.disabled)),true);
 await page.keyboard.press('Escape');await page.mouse.click(5,5);assert.equal(await stoppingDialog.count(),1);
 assert.equal((await controls('native-tree-admit',{id:nativeActive.id})).status(),409,'native admission cannot start another external child while stopping');
 await controls('release-external');await stoppingDialog.waitFor({state:'hidden',timeout:30000});
 const nativeAfter=await(await controls('native-tree-state',{id:nativeActive.id})).json();
 assert.equal(nativeAfter.rootActive,false);assert.equal(nativeAfter.childActive,false);assert.equal(nativeAfter.externalStopped,true);assert.equal(nativeAfter.jobStopped,true);
 assert.equal(nativeAfter.tasks.includes(nativeTree.targetTask),false,'remove the actual reminder destination');
 assert.equal(nativeAfter.tasks.includes(nativeTree.otherTask),true,'an involved actor does not own an unrelated destination');
 assert.equal(nativeAfter.terminalClosed,true);assert.equal(nativeAfter.hasTerminalActivity,false,'the real terminal registry released its native sessionId');
 assert.equal(await exists(nativeActive.path),false);assert.equal((await status()).archived.includes(nativeActive.id),false);
 // A lost request body can arrive after an idle status. Replacing the preview revokes it.
 const delayedPreview=await(await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/preview`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:family.id}})).json();
 const delayedBody=JSON.stringify({sessionId:family.id,token:delayedPreview.token,confirmation:'DELETE_SESSION'});
 const cookie=(await context.cookies()).map(value=>value.name+'='+value.value).join('; ');
 let finishResponse!: (status:number)=>void;
 const delayedResult=new Promise<number>(resolve=>{finishResponse=resolve});
 const delayed=httpRequest(`http://127.0.0.1:${port}/session-deletion/api/delete`,{method:'POST',headers:{'Content-Type':'application/json','X-DSH-Session-Deletion':'1','Content-Length':Buffer.byteLength(delayedBody),Cookie:cookie}},response=>{response.resume();finishResponse(response.statusCode!)});
 delayed.on('error',()=>finishResponse(0));delayed.write(delayedBody.slice(0,10));
 const replacement=await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/preview`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:family.id}});
 assert.equal(replacement.status(),200);assert.equal((await status()).deletionRunning,false);
 delayed.end(delayedBody.slice(10));assert.equal(await delayedResult,409);assert.equal(await exists(family.path),true);
 // A new-session reminder reserves its current destination before publishing it.
 const pendingStarted=await controls('pending-schedule',{cwd});assert.equal(pendingStarted.status(),200,await pendingStarted.text());
 const pendingTask=await pendingStarted.json();
 const pendingPreview=await(await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/preview`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:pendingTask.sessionId}})).json();
 const pendingDeletion=await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/delete`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:pendingTask.sessionId,token:pendingPreview.token,confirmation:'DELETE_SESSION'}});
 const pendingResumed=await controls('release-pending-schedule');assert.equal(pendingResumed.status(),200,await pendingResumed.text());
 const resumedPending=await pendingResumed.json();
 assert.equal(pendingDeletion.status(),409,JSON.stringify({status:pendingDeletion.status(),...resumedPending}));
 assert.deepEqual(resumedPending,{firstFailed:false,retryFailed:false},'an in-flight reminder remains usable after a refused deletion');
 // A real interrupted private deletion must produce the recovery notice in other tabs.
 const raceSetup=await controls('schedule-race',{id:interrupted.id,otherId:raceDestination.id});assert.equal(raceSetup.status(),200,await raceSetup.text());
 const raceTask=await raceSetup.json();
 assert.equal((await controls('attach',{cwd,id:interrupted.id})).status(),200);
 assert.equal((await controls('pin',{id:interrupted.id})).status(),200);
 const interruptedRow=page.locator(`[data-row-key="session:${interrupted.id}"]`);
 await interruptedRow.click();
 await interruptedRow.click({button:'right'});
 await page.getByRole('menuitem',{name:'删除会话',exact:true}).click();
 const interruptedDialog=page.getByRole('dialog',{name:'删除此会话？',exact:true});
 const interrupting=page.waitForResponse(r=>new URL(r.url()).pathname==='/session-deletion/api/delete');
 await interruptedDialog.getByRole('button',{name:'确认删除',exact:true}).click();
 assert.equal((await controls('release-schedule-race')).status(),200);
 assert.equal((await interrupting).status(),500);
 assert.equal((await status()).deletionRunning,false);
 assert.equal((await status()).pending.length,1);
 await clearRecords(true).waitFor();
 await expectClearRefused('error.pendingCleanup');
 const recoveryToast=page.getByRole('alert').filter({hasText:pendingNotice});
 await recoveryToast.waitFor();
 assert.equal(await recoveryToast.locator('svg').count(),1,'recovery uses the native warning icon');
 await page.waitForFunction(text=>[...document.querySelectorAll('[role="alert"]')].some(el=>el.textContent===text&&getComputedStyle(el).opacity==='1'),pendingNotice);
 assert.ok(await interruptedDialog.getByRole('button',{name:'确认删除',exact:true}).isDisabled());
 await interruptedDialog.getByRole('button',{name:'取消',exact:true}).click();
 await page.getByRole('button',{name:'插件',exact:true}).click();
 await page.locator('[data-plugin-package="dsh-session-deletion"]').waitFor();
 await recoveryToast.waitFor({state:'detached',timeout:12000});
 await delay(1200);
 assert.equal(await recoveryToast.count(),0,'polling an unchanged state must not reopen an expired Toast');
 const reopen=await controls('open',{id:interrupted.id});
 assert.equal(reopen.status(),200,await reopen.text());
 await page.evaluate(id=>localStorage.setItem('dsh.conversation.'+id,JSON.stringify({draft:'private fixture draft'})),id);
 // Exiting and reopening DSH both leave the interrupted request pending.
 await Promise.all([otherPage.close(),independentPage.close(),page.goto('about:blank')]);
 await stop();
 assert.equal((await listRequests(home)).length,1);
 const reopened=await start();await page.goto(reopened);
 assert.equal((await status()).pending.length,1);
 assert.equal((await controls('attach',{cwd,id:preserved.id})).status(),200);
 assert.equal((await controls('pin',{id:preserved.id})).status(),200);
 async function clickPluginSwitch(kind:'package'|'component',enabled:boolean){
  await page.getByRole('button',{name:/^(插件|Plugins)$/}).click();
  const card=page.locator('[data-plugin-package="dsh-session-deletion"]');
  const detail=page.locator('[data-plugin-detail="dsh-session-deletion"]');
  await card.or(detail).first().waitFor();
  if(kind==='component'&&!await detail.isVisible())await card.getByRole('button',{name:/^查看/}).click();
  const controls=kind==='package'?card:detail.locator('[data-plugin-rows]');
  await controls.getByRole('switch',{checked:!enabled}).click();
  return controls.getByRole('switch',{checked:enabled,disabled:false});
 }
 const waitForPlugin=(enabled:boolean)=>waitForHost(async()=>{
  const response=await getApi('status');
  return enabled ? response.ok() && (await response.json()).ok===true : response.status()===404;
 },`plugin did not become ${enabled?'available':'unavailable'}`);
 async function switchPlugin(kind:'package'|'component',enabled:boolean){
  const applied=await clickPluginSwitch(kind,enabled);
  await applied.waitFor({timeout:60000});
  await waitForPlugin(enabled);
 }
 const survivor=page.locator(`[data-row-key="session:${preserved.id}"]`);
 const visibleSessions=()=>page.locator('[data-row-key^="session:"]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-row-key')).sort());
 await survivor.click();
 const transcript=page.getByText('Preserved fixture sha256:'+shared,{exact:true});
 await transcript.waitFor();
 async function nextSession(previous:string){
  const selection=await page.waitForFunction(previous=>{
   const id=JSON.parse(localStorage.getItem('dsh.sessions.current')??'{}').sessionId;
   return typeof id==='string' && id.length>0 && id!==previous ? id : undefined;
  },previous,{timeout:10000});
  const id=await selection.jsonValue();assert.ok(id);return id;
 }
 async function emptyWorkspace(){
  const workspace=await fs.mkdtemp(join(base,'toggle-'));
  assert.equal((await controls('create-workspace',{cwd:workspace})).status(),200);
  return workspace;
 }
 for(const kind of ['package','package','component','component'] as const){
  // DSH can reuse an existing blank. Give each switch state a workspace with no sessions.
  const disabledWorkspace=await emptyWorkspace(), enabledWorkspace=await emptyWorkspace();
  let disabledSession: string | undefined;
  for(const enabled of [false,true]){
   await survivor.click();
   await transcript.waitFor();
   const expected=await visibleSessions();
   await switchPlugin(kind,enabled);
   if(enabled){
    assert.ok(disabledSession);
    const state=await controls('state',{id:disabledSession});
    assert.equal(state.status(),200);
    assert.ok((await state.json()).agentResident,'the session opened while disabled survives re-enable');
    assert.equal((await status()).pending.length,1);
   }
   await survivor.click();
   await transcript.waitFor();
   const action=page.getByRole('menuitem',{name:'删除会话',exact:true});
   // DSH captures the registered providers when it opens a context menu.
   await waitForHost(async()=>{
    await survivor.click({button:'right'});
    await page.getByRole('menuitem',{name:'重命名',exact:true}).waitFor();
    if(await action.isVisible()===enabled)return true;
    await page.keyboard.press('Escape');
    return false;
   },'the session menu did not reflect the plugin switch');
   assert.equal(await action.count(),Number(enabled));
   if(enabled)assert.ok(await action.isDisabled(),'the pending journal still blocks new deletions');
   await page.keyboard.press('Escape');
   const more=page.locator('nav').getByRole('button',{name:'更多',exact:true});
   if(enabled || await more.isVisible()){
    await more.click();
    const gc=page.getByRole('menuitem',{name:/^释放空间/});
    await gc.waitFor({state:enabled?'visible':'hidden'});
    assert.equal(await gc.count(),Number(enabled));
    await page.keyboard.press('Escape');
   }
   await page.getByRole('button',{name:'新建会话',exact:true}).filter({hasText:'新会话'}).click();
   const blank=await nextSession(preserved.id);
   const workspace=enabled?enabledWorkspace:disabledWorkspace;
   const label=basename(workspace);
   await page.getByText(label,{exact:true}).hover();
   await page.getByRole('button',{name:`在“${label}”中新建会话`,exact:true}).click();
   const created=await nextSession(blank);
   assert.ok(await exists(join(home,'sessions',projectKey(workspace),encodeSegment(created))));
   if(!enabled)disabledSession=created;
   await checkDirectoryPicker();
   await survivor.click();
   await transcript.waitFor();
   await page.reload();
   await survivor.click();
   await transcript.waitFor();
   assert.deepEqual(await visibleSessions(),expected);
  }
 }
 await page.goto('about:blank');await stop();
 // Linux exposes the exec-time environment. Run this ambiguous-host case outside
 // the parallel unit workers, since it must defer maintenance in every home.
 const hostDir=join(base,'@deepseek-ai/dsh/lib'), entry=join(hostDir,'bin.js');
 await fs.mkdir(hostDir,{recursive:true});
 await fs.writeFile(entry,'console.log(process.env.DSH_HOME); setInterval(() => {}, 1000)');
 await fs.writeFile(join(base,'boot.env'),'DSH_HOME='+home+'\n');
 const launchEnv={...process.env};delete launchEnv.DSH_HOME;
 const envHost=spawn(process.execPath,['--env-file','boot.env',entry],{cwd:base,env:launchEnv,stdio:['ignore','pipe','pipe']});
 const envExited=once(envHost,'exit');
 try{
  const [resolvedHome]=await once(envHost.stdout,'data');assert.equal(String(resolvedHome).trim(),home);
  await assert.rejects(runGuard(home),process.platform==='linux'?/launch environment/:/Another DSH process/);
  assert.equal((await listRequests(home)).length,1);
 }finally{envHost.kill();await envExited}
 // Reopening a native session can persist more events before the host stops.
 const [queued]=await listRequests(home);
 assert.deepEqual(queued.plan.ids,[interrupted.id]);
 const survivorRecord=queued.plan.directories[0];
 assert.equal(join(home,survivorRecord.path,survivorRecord.transcript.path),interrupted.path);
 const beforeRecovery=await fs.readFile(interrupted.path);
 const changed=createHash('sha256').update(beforeRecovery).digest('hex')!==survivorRecord.transcript.sha256;
 const reports:string[]=[];
 await runGuard(home,line=>reports.push(line));
 assert.deepEqual(reports,[`Deletion ${changed?'abandoned':'completed'} for ${interrupted.id}.`]);
 if(changed)assert.deepEqual(await fs.readFile(interrupted.path),beforeRecovery);
 else assert.equal(await exists(interrupted.path),false);
 await fs.rmdir(oldWorkspace);await fs.writeFile(oldWorkspace,'former workspace directory');
 const again=await start();await page.goto(again);await page.waitForTimeout(2000);
 assert.equal((await status()).pending.length,0);
 assert.equal((await receipt()).deletedIdHashes.includes(createHash('sha256').update(interrupted.id).digest('hex')),!changed);
 const scheduleAfterRecovery=JSON.parse(await fs.readFile(join(home,'storages/schedule.json'),'utf8'));
 assert.equal(scheduleAfterRecovery.tables.tasks[raceTask.taskId].target.sessionId,raceDestination.id,'a concurrently retargeted reminder survives both failure and recovery');
 assert.equal(await page.evaluate(id=>localStorage.getItem('dsh.conversation.'+id),id),null);
 assert.equal(await page.getByText('Offline deletion integration fixture',{exact:true}).count(),0);
 async function recordTab() {
  const tab=await context.newPage();
  await tab.goto(again);
  await tab.addLocatorHandler(tab.getByRole('dialog',{name:'开始使用'}),dialog=>dialog.locator('button').first().click());
  const detail=await openRecordSettings(tab);
  return {tab,detail,clear:detail.getByRole('button',{name:'清理',exact:true}),dialog:tab.getByRole('dialog',{name:'清理会话删除记录？',exact:true})};
 }
 const {tab:recordPage,detail:settingsDetail,clear,dialog:confirmation}=await recordTab();
 const count=(await status()).receipt.count;
 await settingsDetail.getByText(`已累积 ${count} 条会话删除记录`,{exact:true}).waitFor();
 await settingsDetail.getByText('已删除会话的匿名标识，用于同步清理其他浏览器或桌面端的残留状态。',{exact:true}).waitFor();
 await recordPage.setViewportSize({width:360,height:740});
 const buttonLayout=await clear.evaluate(button=>{
  const label=document.createRange();label.selectNodeContents(button);
  return {height:button.getBoundingClientRect().height,lines:label.getClientRects().length};
 });
 assert.deepEqual(buttonLayout,{height:28,lines:1},'the native small button keeps its label on one line at narrow widths');
 await recordPage.setViewportSize({width:1440,height:1000});
 await clear.click();
 await confirmation.getByText(`将清空已累积的 ${count} 条会话删除记录，不会影响现有或已删除的会话；若曾在其他浏览器或桌面端使用过 DSH，建议先打开一次以完成同步，再执行清理。`,{exact:true}).waitFor();
 assert.deepEqual(await dialogAppearance(confirmation),gcAppearance);
 await confirmation.getByRole('button',{name:'取消',exact:true}).click();
 assert.equal((await status()).receipt.count,count);
 await clear.click();
 const confirmClear=confirmation.getByRole('button',{name:'确认清理',exact:true});
 const peer=spawn(process.execPath,[entry],{env,stdio:['ignore','pipe','pipe']});
 const peerExited=once(peer,'exit');
 try {
  await once(peer.stdout,'data');
  await confirmClear.click();
  assert.equal(await confirmation.getByRole('alert').innerText(),'另一个 DSH 进程正在使用相同目录，请先关闭它。');
  assert.equal((await status()).receipt.count,count);
 } finally {peer.kill();await peerExited}
 const waiting=await recordTab(), late=await recordTab();
 await waiting.clear.click();await late.clear.click();
 await waiting.dialog.waitFor();
 // Deliver the stale confirmation after another client observes the cleared receipt.
 const synced=page.waitForResponse('**/session-deletion/api/receipt');
 await late.tab.route('**/session-deletion/api/clear-records',async route=>{await synced;await route.continue()},{times:1});
 const lateReply=late.tab.waitForResponse('**/session-deletion/api/clear-records');
 await late.dialog.getByRole('button',{name:'确认清理',exact:true}).click();
 await late.dialog.getByRole('button',{name:'正在清理…',disabled:true}).waitFor();
 const submit=Promise.withResolvers<void>();
 await recordPage.route('**/session-deletion/api/clear-records',async route=>{await submit.promise;await route.continue()},{times:1});
 try {
  await confirmClear.click();
  await confirmation.getByRole('button',{name:'正在清理…',disabled:true}).waitFor();
  assert.equal(await confirmation.getByRole('button',{disabled:true}).count(),3);
  await recordPage.keyboard.press('Escape');
  assert.ok(await confirmation.isVisible());
 } finally {submit.resolve()}
 await confirmation.waitFor({state:'hidden'});
 await settingsDetail.getByText('当前无会话删除记录',{exact:true}).waitFor();
 assert.ok(await clear.isDisabled());
 const clearedToast=recordPage.getByRole('alert').filter({hasText:`已清理 ${count} 条会话删除记录。`});
 await clearedToast.waitFor();
 assert.equal(await clearedToast.locator(':scope > :first-child svg').count(),1);
 assert.deepEqual((await receipt()).deletedIdHashes,[]);
 assert.equal(await exists(log),false);
 assert.ok(await exists(preserved.path));
 assert.deepEqual((await (await synced).json()).deletedIdHashes,[]);
 await waiting.dialog.waitFor({state:'hidden'});
 await waiting.detail.getByText('当前无会话删除记录',{exact:true}).waitFor();
 assert.equal((await (await lateReply).json()).cleared,0);
 await late.dialog.waitFor({state:'hidden'});
 await late.detail.getByText('当前无会话删除记录',{exact:true}).waitFor();
 assert.equal(await late.tab.getByRole('alert').filter({hasText:'已清理 0 条会话删除记录。'}).count(),0);
 await Promise.all([recordPage.close(),waiting.tab.close(),late.tab.close()]);
 // The native inventory lists one external entry and resolves its shipped locale metadata.
 const zhDescription='DSH 会话的即时删除与残留附件的清理。';
 const enDescription='Immediate session deletion and orphan attachment cleanup for DSH.';
 await page.getByRole('button',{name:'账号菜单',exact:true}).click();
 await page.getByRole('menuitem',{name:'设置',exact:true}).click();
 const settings=page.locator('[data-shortcut-modal="settings"]');
 await settings.getByRole('button',{name:'内置插件',exact:true}).click();
 await settings.getByRole('searchbox',{name:'搜索插件',exact:true}).fill('dsh-session-deletion');
 const pluginCard=settings.locator('[data-plugin-module^="dsh-session-deletion"]');
 await pluginCard.getByText('DSH 会话删除',{exact:true}).waitFor();
 await pluginCard.getByText(zhDescription,{exact:true}).waitFor();
 assert.equal(await pluginCard.getByText(enDescription,{exact:true}).count(),0);
 assert.equal(await pluginCard.count(),1,'internal plugin scopes must not become Loader inventory entries');
 assert.equal(await pluginCard.getAttribute('data-plugin-module'),'dsh-session-deletion');
 assert.equal(await pluginCard.getAttribute('data-failed'),null);
 await settings.getByRole('button',{name:'通用设置',exact:true}).click();
 await settings.getByRole('button',{name:'中文',exact:true}).click();
 await page.getByRole('menuitem',{name:'English',exact:true}).click();
 await settings.getByRole('button',{name:'Built-in plugins',exact:true}).click();
 await settings.getByRole('searchbox',{name:'Search plugins',exact:true}).fill('dsh-session-deletion');
 await pluginCard.getByText('DSH Session Deletion',{exact:true}).waitFor();
 await pluginCard.getByText(enDescription,{exact:true}).waitFor();
 assert.equal(await pluginCard.getByText(zhDescription,{exact:true}).count(),0);
 assert.equal(await pluginCard.count(),1);
 assert.equal(await pluginCard.getByText('DSH 会话删除',{exact:true}).count(),0);
 // The same plugin renders its English menu, dialog and buttons through the native locale service.
 await settings.getByRole('button',{name:'Close',exact:true}).click();
 await page.route('**/session-deletion/api/gc-size',route=>route.fulfill({json:{bytes:128.75*1024**2}}),{times:1});
 await page.locator('nav').getByRole('button',{name:'More',exact:true}).click();
 const englishMenuItem=page.getByRole('menuitem',{name:'Free Up Space (128.75 MiB)',exact:true});
 await englishMenuItem.waitFor();
 assert.ok(await englishMenuItem.evaluate(item=>{
  const range=document.createRange();
  range.selectNodeContents(item);
  return range.getBoundingClientRect().right<=item.getBoundingClientRect().right;
 }),'the English label and size must fit inside the native menu item');
 await englishMenuItem.click();
 const englishGc=page.getByRole('dialog',{name:'Clean up orphaned attachments and cache?',exact:true});
 await englishGc.getByText('Unlinked local attachments and temporary image cache will be removed to free up space. Make sure all other sessions are idle during cleanup.',{exact:true}).waitFor();
 assert.equal(await englishGc.getByRole('button',{name:'Confirm Cleanup',exact:true}).count(),1);
 assert.equal(await englishGc.getByRole('button',{name:'Close',exact:true}).count(),1);
 const rawDiagnostic='Cannot remove attachment\n<original> & {path}';
 await page.route('**/session-deletion/api/gc',route=>route.fulfill({status:500,json:{error:rawDiagnostic}}),{times:1});
 await englishGc.getByRole('button',{name:'Confirm Cleanup',exact:true}).click();
 const diagnosticAlert=englishGc.locator('p').getByRole('alert');
 await diagnosticAlert.waitFor();
 assert.equal(await diagnosticAlert.textContent(),'Unknown error.'+rawDiagnostic);
 const block=diagnosticAlert.locator('code');
 assert.equal(await block.textContent(),rawDiagnostic);
 assert.deepEqual(await codeAppearance(block),sessionCodeAppearance);
 assert.equal(await block.evaluate(el=>getComputedStyle(el).whiteSpace),'pre-wrap');
 assert.equal(await englishGc.locator('pre').count(),0);
 await englishGc.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Account menu',exact:true}).click();
 await page.getByRole('menuitem',{name:'Settings',exact:true}).click();
 await settings.getByRole('button',{name:'General',exact:true}).click();
 await settings.getByRole('button',{name:'English',exact:true}).click();
 await page.getByRole('menuitem',{name:'中文',exact:true}).click();
 await settings.getByRole('button',{name:'内置插件',exact:true}).click();
 await settings.getByRole('searchbox',{name:'搜索插件',exact:true}).fill('dsh-session-deletion');
 await pluginCard.getByText('DSH 会话删除',{exact:true}).waitFor();
 await pluginCard.getByText(zhDescription,{exact:true}).waitFor();
 assert.equal(await pluginCard.getByText(enDescription,{exact:true}).count(),0);
 // The importer publishes each image before creating the cold Session that owns it.
 const workspace=await controls('import-workspace',{cwd});assert.equal(workspace.status(),200,await workspace.text());
 const stamp='2026-01-01T00:00:00Z', file='chat_sessions/export_files/img-pixel.png';
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64');
 const conversation={id:'export',title:'Import GC fixture',inserted_at:stamp,messages:[
  {id:1,parent_id:null,role:'USER',status:'FINISHED',inserted_at:stamp,fragments:[
   {type:'REQUEST',content:'Imported image'},
   {type:'FILE',files:[{id:'img',file_name:'pixel.png',file_size:png.length,inserted_at:stamp,export_path:file,is_image:true,width:1,height:1}]}]},
  {id:2,parent_id:1,role:'ASSISTANT',status:'FINISHED',inserted_at:stamp,fragments:[{type:'RESPONSE',content:'Offline answer'}]},
 ]};
 const archive=zipSync({'manifest.json':strToU8('{"export_format_version":3}'),
  'chat_session_index.json':strToU8(JSON.stringify([{id:'export',title:conversation.title,pinned:false,inserted_at:stamp,updated_at:stamp,message_count:2}])),
  'chat_sessions/export.json':strToU8(JSON.stringify(conversation)),[file]:png});
 const workspaceId=(await workspace.json()).id;
 const upload=()=>importArchive(workspaceId,Buffer.from(archive));
 const importedSession=async(request:ReturnType<typeof upload>):Promise<string>=>{
  const response=await request;
  assert.equal(response.status(),200);
  const {outcome}=JSON.parse((await response.text()).trim().split('\n').at(-1)!);
  assert.equal(outcome.ok,true,JSON.stringify(outcome));assert.equal(outcome.value.sessionIds.length,1);
  return outcome.value.sessionIds[0];
 };
 const gcApi=`http://127.0.0.1:${port}/session-deletion/api/`;
 const post=(route:string,data:Record<string,unknown>)=>context.request.post(gcApi+route,{headers:{'X-DSH-Session-Deletion':'1'},data});
 const collect=()=>post('gc',{confirmation:'COLLECT_ORPHAN_ATTACHMENTS'});
 const reclaimable=()=>getApi('gc-size');
 const workspacePath=join(home,'storages/workspace.json');
 const hasFilteredMember=async()=>Object.values(JSON.parse(await fs.readFile(workspacePath,'utf8')).tables.workspaces as Record<string,{sessionIds:string[]}>)
  .some(row=>row.sessionIds.includes(filtered.id));
 const removeSession=async(sessionId:string)=>{
  const preview=await post('preview',{sessionId});assert.equal(preview.status(),200,await preview.text());
  const deletion=await post('delete',{sessionId,token:(await preview.json()).token,confirmation:'DELETE_SESSION'});
  assert.equal(deletion.status(),200,await deletion.text());assert.equal((await deletion.json()).deleted,1);
 };
 const importing=upload();
 let importedHash:string|undefined;
 try {
  for(let i=0;i<100&&!importedHash;i++){
   importedHash=(await (await controls('import-image')).json()).id?.slice(7);
   if(!importedHash)await delay(50);
  }
  assert.ok(importedHash,'import must stage the image before writing its session');
  for(const response of [await reclaimable(),await collect()]){
   assert.equal(response.status(),409);assert.deepEqual((await response.json()).messages,[{key:'activity.chatImport'}]);
  }
 } finally {await controls('release-image')}
 const firstOwner=await importedSession(importing),lastOwner=await importedSession(upload());
 assert.notEqual(firstOwner,lastOwner);
 const object=join(home,'attachments/v1/objects',importedHash.slice(0,2),importedHash);
 const imageBytes=(await fs.stat(object)).size;
 assert.ok(imageBytes>0);
 const clean=await collect();assert.equal(clean.status(),200,await clean.text());
 const detached=await controls('detach',{cwd,id:firstOwner});assert.equal(detached.status(),200,await detached.text());
 for(const sessionId of [firstOwner,lastOwner]){
  await removeSession(sessionId);
  if(sessionId===firstOwner){
   const attach=await controls('attach',{cwd,id:sessionId});
   assert.equal(attach.status(),500);assert.match((await attach.json()).error,/session persistence holds no such session/);
  }
  assert.ok(await exists(object),'session deletion leaves the image for explicit GC');
  const orphan=sessionId===lastOwner;
  if(orphan){
   const indexPath=join(home,'llm-deepseek/files-v3.json'), saved=await fs.readFile(indexPath);
   const {records}=JSON.parse(saved.toString()) as {records:Array<Record<string,unknown>>};
   assert.ok(records.length,'the shared attachment still has a valid native upload mapping');
   const record:Record<string,unknown>={...records[0],attachmentId:'sha256:'+importedHash};
   const damaged:string=JSON.stringify({formatVersion:3,records:[record,record]});
   await fs.writeFile(indexPath,damaged);
   try {
    for(const response of [await reclaimable(),await collect()]){
     assert.equal(response.status(),500);assert.deepEqual((await response.json()).messages,[{key:'error.fileCacheSchema'}]);
    }
    assert.ok(await exists(object));assert.equal(await fs.readFile(indexPath,'utf8'),damaged);
   } finally {await fs.writeFile(indexPath,saved)}
  }
  const size=await reclaimable();assert.equal(size.status(),200,await size.text());
  assert.equal((await size.json()).bytes,orphan?imageBytes:0);
  const gc=await collect();assert.equal(gc.status(),200,await gc.text());
  const {total,objects}=await gc.json();
  assert.deepEqual({total,objects},orphan?{total:1,objects:1}:{total:0,objects:0});
  assert.equal(await exists(object),!orphan);
 }
 // DSH supports French. The plugin has no French catalog, so its controls use English.
 await settings.getByRole('button',{name:'通用设置',exact:true}).click();
 await settings.getByRole('button',{name:'中文',exact:true}).click();
 await page.getByRole('menuitem',{name:'Français',exact:true}).click();
 await page.waitForFunction(()=>document.documentElement.lang==='fr');
 await settings.getByRole('button',{name:'Fermer',exact:true}).click();
 await page.locator('nav').getByRole('button',{name:'Plus',exact:true}).click();
 await page.getByRole('menuitem',{name:/^Free Up Space/}).click();
 await page.getByRole('dialog',{name:'Clean up orphaned attachments and cache?',exact:true})
  .getByRole('button',{name:'Cancel',exact:true}).click();
 // Disable from the sidebar while the admitted deletion is paused after journal publication.
 assert.ok(await hasFilteredMember(),'the stored workspace retains the filtered candidate');
 assert.equal((await controls('hold-delete',{id:filtered.id})).status(),200);
 await Promise.all([removeSession(filtered.id),(async()=>{
  try {
   await waitForHeldDeletion();
   await clickPluginSwitch('package',false);
   await waitForHost(async()=>{
    const response=await reclaimable();
    return response.status()===409 && (await response.json()).messages[0]?.key==='error.runtimeUnavailable';
   },'disable did not close admission while the deletion was held');
   assert.ok(await exists(filtered.path));
  } finally { await controls('release-delete'); }
 })()]);
 await waitForPlugin(false);
 assert.equal(await exists(filtered.path),false);
 assert.equal(await hasFilteredMember(),false);
 assert.equal((await listRequests(home)).length,0);
 await switchPlugin('package',true);
 assert.ok((await receipt()).deletedIdHashes.includes(createHash('sha256').update(filtered.id).digest('hex')));
 assert.deepEqual(errors,[]);
 console.log('INTEGRATION PASS: active native turns, cold-resumed and external subagents, jobs, schedules, preparation UI locks, private deletion, isolated publication, GC, deletion record cleanup, recovery, and live zh/en metadata');
}catch(e){
 if(browser){const pages=browser.contexts().flatMap(c=>c.pages());if(pages[0]){await fs.mkdir('test-results',{recursive:true});await pages[0].screenshot({path:'test-results/failure.png'});console.error((await pages[0].locator('body').innerText()).slice(0,6000));}}
 console.error('Browser errors:',errors);
 console.error('Profile manifest:',await fs.readFile(join(home,'profiles/web/package.json'),'utf8'));
 console.error('Host log:',bootLog.replace(/token=[^\s]+/g,'token=[redacted]').slice(-6000));throw e;
}finally{
 await browser?.close();await stop();
 await fs.rm(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
