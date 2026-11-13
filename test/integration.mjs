import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { exists, encodeSegment } from '../lib/core.js';
import { tryLock } from '../lib/guard.js';

const repo=resolve('.');
const base=await fs.mkdtemp(join(tmpdir(),'dsh-deletion-integration-'));
const temporary=join(base,'tmp');await fs.mkdir(temporary,{mode:0o700});
// Keep browser profiles, DSH spills and package-manager scratch data inside the fixture.
process.env.TMP=process.env.TEMP=process.env.TMPDIR=temporary;
const home=join(base,'home');
await fs.mkdir(join(home,'profiles/web'),{recursive:true,mode:0o700});
if(!(await exists(join(home,'profiles/web/package.json')))){
  await fs.writeFile(join(home,'profiles/web/package.json'),JSON.stringify({name:'dsh-profile-web',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}));
  await fs.writeFile(join(home,'profiles/web/pnpm-workspace.yaml'),'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  koffi: true\n');
  await fs.writeFile(join(home,'profiles/web/cordis.yml'),'[]\n');
  await fs.writeFile(join(home,'profiles/web/cordis.patch.yml'),'[]\n');
}
const env={...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',pnpm_config_store_dir:join(base,'pnpm-store')};
// Native Windows cannot spawn a .cmd shim directly; an explicit CLI entry also
// lets either platform test an isolated DSH installation.
const dshArgs=process.env.DSH_CLI?[...process.execArgv.filter(arg=>arg==='--expose-internals'),process.env.DSH_CLI]:[];
const spawnDsh=args=>spawn(dshArgs.length?process.execPath:'dsh',[...dshArgs,...args],{env,stdio:['ignore','pipe','pipe']});
const install=spawnDsh(['plugin','--profile','web','add','file:'+repo]);
let installText='';install.stdout.on('data',d=>{installText+=d});install.stderr.on('data',d=>{installText+=d});
assert.equal(await new Promise(r=>install.on('exit',r)),0,'Install failed: '+installText);
await fs.writeFile(join(home,'profiles/web/cordis.patch.yml'),'- insert:\n    - id: deletion-test-controls\n      name: '+JSON.stringify(join(repo,'test/host-fixture.mjs'))+'\n');
const cwd=join(base,'project');await fs.mkdir(cwd,{recursive:true});
await fs.writeFile(join(cwd,'keep.txt'),'project file');
const id='session-'+randomUUID();
const exclusive='a'.repeat(64),shared='b'.repeat(64);
const stagedShared=createHash('sha256').update('other draft upload').digest('hex');
const stagedExclusive=createHash('sha256').update('target draft upload').digest('hex');
const projectKey='--'+encodeSegment(cwd.replace(/[\\/:]+/g,'-').replace(/^-+/,'')||'root').slice(0,251)+'--';
const sessionDir=join(home,'sessions',projectKey,id);await fs.mkdir(sessionDir,{recursive:true,mode:0o700});
const log=join(sessionDir,'session.v4.jsonl.zstd');
const header={type:'session',version:4,id,createdAt:Date.now(),cwd,isSeeded:false,delegationDepth:0};
const message={type:'user/message',seq:1,time:Date.now(),surfaceOp:'append',data:{id:randomUUID(),role:'user',source:{kind:'user',rpcId:randomUUID(),clientTimeZone:'Asia/Taipei'},content:[{type:'text',text:'Offline deletion integration fixture'},{type:'text',text:`sha256:${exclusive} sha256:${shared} sha256:${stagedShared}`} ]}};
const events=[{type:'turn/start',seq:0,time:Date.now(),data:{turn:1}},message,
 {type:'session/title',seq:2,time:Date.now(),data:{title:'Offline deletion integration fixture',messageSeqs:[],source:{kind:'user'}}}];
await fs.writeFile(log,Buffer.concat([zstdCompressSync(JSON.stringify(header)+'\n'),zstdCompressSync(events.map(e=>JSON.stringify(e)+'\n').join(''))]));
if(process.platform!=='win32')await fs.writeFile(join(sessionDir,'session.lock'),'');
async function extraSession(name,age,attachment,meta={}){
 const extra='session-'+randomUUID();const dir=join(home,'sessions',projectKey,extra);await fs.mkdir(dir,{recursive:true,mode:0o700});
 const extraHeader={...header,id:extra,createdAt:header.createdAt-age,...meta};
 const extraEvents=events.map(e=>({...e,time:e.time-age,data:e.type==='user/message'?{...e.data,id:randomUUID(),content:[{type:'text',text:name+(attachment?' sha256:'+attachment:'')}]}:e.type==='session/title'?{...e.data,title:name}:e.data}));
 const path=join(dir,'session.v4.jsonl.zstd');await fs.writeFile(path,Buffer.concat([zstdCompressSync(JSON.stringify(extraHeader)+'\n'),zstdCompressSync(extraEvents.map(e=>JSON.stringify(e)+'\n').join(''))]));if(process.platform!=='win32')await fs.writeFile(join(dir,'session.lock'),'');return {id:extra,path};
}
const preserved=await extraSession('Preserved fixture',20000,shared);const cold=await extraSession('Archived deletion fixture',10000);
const draftOwner=await extraSession('Draft owner fixture',30000);
const interrupted=await extraSession('Interrupted deletion fixture',50000);
const family=await extraSession('测试含子代理的会话',40000);
const child=await extraSession('Child fixture',39000,undefined,{origin:'subagent',parentSession:family.id,delegationDepth:1});
const grandchild=await extraSession('Grandchild fixture',38000,undefined,{origin:'subagent',parentSession:child.id,delegationDepth:2});
const preservedHash=createHash('sha256').update(await fs.readFile(preserved.path)).digest('hex');
for(const hash of [exclusive,shared]){const path=join(home,'attachments/v1/objects',hash.slice(0,2),hash);await fs.mkdir(join(path,'..'),{recursive:true,mode:0o700});await fs.writeFile(path,'fixture attachment');}
await fs.mkdir(join(home,'llm-deepseek'),{recursive:true,mode:0o700});
await fs.writeFile(join(home,'llm-deepseek/files-v3.json'),JSON.stringify({formatVersion:3,records:[exclusive,shared].map(hash=>({scope:'c'.repeat(64),attachmentId:'sha256:'+hash,variantId:'sha256:'+hash,fileId:'file-'+hash.slice(0,8),bytes:18,createdAt:Date.now(),expiresAt:Date.now()+3600000}))}));
const imageCache=join(home,'cache/attachments/request-images/aa/fixture');
await fs.mkdir(join(imageCache,'..'),{recursive:true,mode:0o700});await fs.writeFile(imageCache,'derived fixture image');
let host;let browser;let bootLog='';let exited;let port='0';
const errors=[];
async function start(){
 bootLog='';host=spawnDsh(['web','--no-open','--host','127.0.0.1','--port',port]);
 exited=new Promise(r=>host.on('exit',(code,signal)=>r({code,signal})));
 host.stdout.on('data',d=>{bootLog+=d});host.stderr.on('data',d=>{bootLog+=d});
 for(let i=0;i<200;i++){
  const match=bootLog.match(/http:\/\/127\.0\.0\.1:(\d+)\/[^\s]*/);
  if(match){port=match[1];return match[0];}
  if(host.exitCode!==null)throw new Error('Boot failed: '+bootLog.replace(/token=[^\s]+/g,'token=[redacted]'));
  await delay(100);
 }
 throw new Error('Boot timeout: '+bootLog.replace(/token=[^\s]+/g,'token=[redacted]'));
}
async function stop(){
 if(!host)return;
 if(host.exitCode===null&&host.signalCode===null){host.kill('SIGINT');await Promise.race([exited,delay(15000,undefined,{ref:false}).then(()=>{throw new Error('Host did not exit')})]);}
 const path=join(home,'session-deletion/lifecycle.lock');
 if(process.platform!=='win32'&&!(await exists(path)))return;
 const deadline=Date.now()+15000;
 for(;;){
  const lock=await tryLock(path,true,true);
  if(lock){await lock.close();return;}
  if(Date.now()>=deadline)throw new Error('Recovery guard has not finished; retain the fixture until it exits');
  await delay(50);
 }
}
try{
 const url=await start();
 const unauthorized=await fetch(`http://127.0.0.1:${port}/session-deletion/api/status`);
 assert.ok([401,403].includes(unauthorized.status),`Unauthenticated status ${unauthorized.status}: ${(await unauthorized.text()).slice(0,400)}`);
 const unauthorizedReceipt=await fetch(`http://127.0.0.1:${port}/session-deletion/api/receipt`);
 assert.ok([401,403].includes(unauthorizedReceipt.status));
 const unauthorizedSize=await fetch(`http://127.0.0.1:${port}/session-deletion/api/gc-size`);
 assert.ok([401,403].includes(unauthorizedSize.status));
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?join(process.env.PROGRAMFILES,'Google/Chrome/Application/chrome.exe'):'/opt/google/chrome/chrome'),headless:true,args:['--no-sandbox']});
 // Native UI selectors below use Simplified Chinese, independent of the host locale.
 const context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 let receiptRequests=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/session-deletion/api/receipt')receiptRequests++});
 await page.goto(url);await page.waitForTimeout(2000);
 const welcome=page.getByRole('button',{name:'继续',exact:true});if(await welcome.count())await welcome.click();
 await page.getByText('开始使用',{exact:true}).waitFor({timeout:5000});
 const onboarding=page.getByRole('dialog').filter({hasText:'开始使用'});
 await onboarding.locator('button').first().click();
 await page.addLocatorHandler(page.getByRole('dialog',{name:'开始使用'}),async dialog=>{const close=dialog.locator('button').first();if(await close.isEnabled())await close.click()},{noWaitAfter:true});
 const status=async()=>{const r=await context.request.get(`http://127.0.0.1:${port}/session-deletion/api/status`);assert.equal(r.status(),200);return r.json()};
 const receipt=async()=>{const r=await context.request.get(`http://127.0.0.1:${port}/session-deletion/api/receipt`);assert.equal(r.status(),200);return r.json()};
 assert.equal((await status()).guardHealthy,true);
 const initialReceipt=await receipt();
 assert.deepEqual(initialReceipt,{ok:true,revision:'',deletedIdHashes:[]});
 assert.deepEqual((await status()).receipt,{revision:'',count:0});
 assert.equal(receiptRequests,1,'unchanged receipt is fetched only once despite status polling');
 const debugPreview=await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/preview`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:id}});
 assert.equal(debugPreview.status(),200,'Fixture must be visible to the persistence service');
 // Wait for the real sidebar row, then use the host context menu.
 const row=page.getByText(/^(未命名|Offline deletion integration fixture)$/).first();
 await row.waitFor({timeout:15000});
 await row.click();
 const controls=async(action,data={})=>context.request.post(`http://127.0.0.1:${port}/deletion-test/`+action,{data});
 for(let i=0;i<100;i++){if((await (await controls('state',{id})).json()).agentResident)break;await delay(50)}
 const archivedProbe=await (await controls('archive-probe',{id})).json();
 assert.deepEqual(archivedProbe,{archived:true,agentResident:true,sessionResident:true,status:'idle',writerOpen:true});
 const writerLock=await tryLock(join(sessionDir,'session.lock'));
 if(writerLock)await writerLock.close();
 assert.equal(writerLock,undefined,'the plugin must contend with the real DSH writer lock');
 console.log('ARCHIVE PROBE: archived=true; Agent, Session and write handle remain resident');
 await controls('unarchive',{id});
 // Compare against the actual native archive dialog, then cancel without stopping anything.
 const dialogAppearance=async locator=>locator.evaluate(node=>{
  const pick=(element,keys)=>Object.fromEntries(keys.map(key=>[key,getComputedStyle(element)[key]]));
  const description=node.querySelector('p');
  const buttons=[...node.querySelectorAll('button')];
  const cancel=buttons.find(button=>button.textContent==='取消');
  const confirm=buttons.at(-1);
  const typography=['fontFamily','fontSize','fontWeight','lineHeight','color'];
  const buttonKeys=[...typography,'padding','borderRadius','borderWidth','backgroundColor'];
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
 const familyDialog=page.getByRole('dialog',{name:'归档并删除此会话？',exact:true});
 await familyDialog.getByText('该会话将被彻底移除（包含与之关联的 2 个子代理），已保存的文件与附件不受影响；如需释放存储空间，可前往左侧「更多」→「清理残留附件与缓存」。',{exact:true}).waitFor();
 assert.equal(await familyDialog.getByRole('checkbox').count(),0);
 assert.equal(await familyDialog.locator('strong').innerText(),'测试含子代理的会话');
 assert.equal(await familyDialog.locator('code').innerText(),family.id);
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

 await page.waitForTimeout(1200);
 await row.hover();await row.locator('xpath=ancestor::*[.//button][1]').locator('button').first().click();
 await page.getByRole('menuitem',{name:'删除会话',exact:true}).waitFor({timeout:5000});
 assert.equal(await page.getByRole('menuitem',{name:'删除会话',exact:true}).count(),1);
 const busyPreview=await (await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/preview`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:id}})).json();
 const refused=await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/delete`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:id,token:busyPreview.token,confirmation:'DELETE_IDLE_SESSION'}});
 assert.equal(refused.status(),409,'backend must reject busy deletion even if UI is bypassed');
 assert.equal((await status()).pending.length,0);assert.equal(await exists(log),true);
 assert.ok((await status()).archived.includes(id),'native archive remains even when final cleanup refuses unsettled maintenance');
 await page.keyboard.press('Escape');await controls('release-maintenance',{id});await controls('unarchive',{id});
 await controls('maintain',{id:draftOwner.id});
 const busyGc=await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/gc`,{headers:{'X-DSH-Session-Deletion':'1'},data:{confirmation:'COLLECT_ORPHAN_ATTACHMENTS'}});
 assert.equal(busyGc.status(),409,'GC requires every agent to be idle');
 await page.waitForTimeout(1200);
 const otherPage=await context.newPage();otherPage.on('pageerror',e=>errors.push(e.message));await otherPage.goto(`http://127.0.0.1:${port}/`);await otherPage.waitForTimeout(1200);
 const otherWelcome=otherPage.getByRole('dialog').filter({hasText:'开始使用'});if(await otherWelcome.count())await otherWelcome.locator('button').first().click();
 await otherPage.addLocatorHandler(otherPage.getByRole('dialog',{name:'开始使用'}),async dialog=>{const close=dialog.locator('button').first();if(await close.isEnabled())await close.click()},{noWaitAfter:true});
 await otherPage.getByText(/^(未命名|Offline deletion integration fixture)$/).first().click();
 const independentPage=await context.newPage();independentPage.on('pageerror',e=>errors.push(e.message));
 await independentPage.goto(`http://127.0.0.1:${port}/`);await independentPage.waitForTimeout(1200);
 await independentPage.addLocatorHandler(independentPage.getByRole('dialog',{name:'开始使用'}),async dialog=>{const close=dialog.locator('button').first();if(await close.isEnabled())await close.click()},{noWaitAfter:true});
 await independentPage.getByText('Draft owner fixture',{exact:true}).first().click();
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
 const deletionDialog=page.getByRole('dialog',{name:'归档并删除此会话？',exact:true});
 await deletionDialog.getByText('该会话将被彻底移除，已保存的文件与附件不受影响；如需释放存储空间，可前往左侧「更多」→「清理残留附件与缓存」。',{exact:true}).waitFor();
 assert.equal(await deletionDialog.getByRole('checkbox').count(),0);
 assert.equal(await deletionDialog.locator('strong').innerText(),'Offline deletion integration fixture');
 assert.equal(await deletionDialog.locator('code').innerText(),id);
 assert.equal((await deletionDialog.innerText()).includes('子代理'),false,'no zero-subagent boilerplate');
 const deletionAppearance=await dialogAppearance(deletionDialog);
 assert.deepEqual(deletionAppearance,nativeAppearance,'private deletion uses the actual native modal and button styles');
 await page.getByRole('button',{name:'确认删除',exact:true}).click();
 for(let i=0;i<100;i++){if((await (await controls('held')).json()).held)break;await delay(50)}
 assert.equal((await (await controls('held')).json()).held,true,'test must pause after the backend locks the target');
 const deleteToast=page.getByRole('alert').filter({hasText:'正在删除会话…'});
 await page.waitForFunction(()=>[...document.querySelectorAll('[role="alert"]')].some(el=>el.textContent==='正在删除会话…'));
 assert.match(await deleteToast.getAttribute('class'),/toast/,'progress uses the DSH Toast primitive');
 assert.equal(await deleteToast.evaluate(el=>el.parentElement===document.body),true,'native Toast renders through its portal');
 await otherPage.waitForFunction(()=>[...document.querySelectorAll('[role="alert"]')].some(el=>el.textContent==='正在删除会话…'));
 assert.equal((await status()).deletionRunning,true);
 assert.equal(await otherPage.getByText('清理未完成，将在下次启动时自动恢复',{exact:true}).count(),0,'a pending journal is not an interruption while the server is deleting');
 const deletingDialog=page.getByRole('dialog',{name:/归档并删除此会话|删除此会话/});
 assert.equal(await deletingDialog.locator('button').evaluateAll(buttons=>buttons.every(button=>button.disabled)),true);
 await page.keyboard.press('Escape');
 assert.equal(await deletingDialog.count(),1,'native deletion modal stays open until submission completes');
 await page.waitForFunction(()=>document.querySelector('#deletion-lock-probe')?.inert===true);
 await otherPage.waitForFunction(()=>document.querySelector('#deletion-lock-probe')?.inert===true);
 assert.equal((await controls('input',{id})).status(),409,'another tab/API cannot send input during deletion');
 assert.equal(await independentPage.locator('#deletion-lock-probe').evaluate(el=>el.inert),false,'another conversation stays interactive');
 assert.equal((await controls('direct-input',{id:draftOwner.id})).status(),200,'another agent can publish while private deletion is in progress');
 assert.equal((await controls('stage',{id:draftOwner.id,text:'parallel upload'})).status(),200,'another conversation can upload during private deletion');
 assert.equal((await controls('pin',{id})).status(),409,'workspace pin cannot recreate target bookkeeping during cleanup');
 assert.equal((await controls('stage',{id,text:'late upload'})).status(),409,'uploads cannot publish after the target is locked');
 await controls('release-delete');
 await page.getByRole('dialog',{name:/归档并删除此会话|删除此会话/}).waitFor({state:'hidden',timeout:30000});
 const deletedToast=page.getByRole('alert').filter({hasText:'会话已删除：Offline deletion integration fixture'});
 await deletedToast.waitFor();
 assert.match(await deletedToast.getAttribute('class'),/toast/);
 assert.equal(await deletedToast.evaluate(el=>el.parentElement===document.body),true);
 assert.equal(host.exitCode,null,'DSH must remain running during deletion');
 assert.equal(await exists(log),false,'session log must disappear before DSH exits');
 assert.equal((await status()).pending.length,0);
 const deletedReceipt=await receipt();
 assert.notEqual(deletedReceipt.revision,initialReceipt.revision);
 assert.deepEqual(deletedReceipt.deletedIdHashes,[createHash('sha256').update(id).digest('hex')]);
 assert.deepEqual((await status()).receipt,{revision:deletedReceipt.revision,count:1});
 await page.waitForFunction(()=>!document.querySelector('#deletion-lock-probe')?.inert);
 await page.evaluate(id=>localStorage.setItem('dsh.conversation.'+id,JSON.stringify({draft:'late stale-tab write'})),id);
 await page.waitForFunction(id=>localStorage.getItem('dsh.conversation.'+id)===null,id);
 assert.equal(receiptRequests,2,'one new receipt fetch after deletion; late writes use cached tombstones');
 assert.equal(await fs.readFile(join(cwd,'keep.txt'),'utf8'),'project file');
 assert.equal(await exists(join(home,'attachments/v1/objects',exclusive.slice(0,2),exclusive)),true,'private deletion retains all attachments');
 assert.equal(await exists(imageCache),true,'private deletion does not clear the shared image cache');
 assert.equal(await fs.readFile(join(home,'attachments/v1/objects',shared.slice(0,2),shared),'utf8'),'fixture attachment');
 assert.deepEqual(JSON.parse(await fs.readFile(join(home,'llm-deepseek/files-v3.json'),'utf8')).records.map(r=>r.attachmentId),['sha256:'+exclusive,'sha256:'+shared]);
 assert.equal(createHash('sha256').update(await fs.readFile(preserved.path)).digest('hex'),preservedHash);
 assert.equal(await fs.readFile(join(home,'attachments/v1/file-objects',stagedShared.slice(0,2),stagedShared),'utf8'),'other draft upload','another session staged receipt protects its bytes');
 assert.equal(await exists(join(home,'attachments/v1/file-objects',stagedExclusive.slice(0,2),stagedExclusive)),true,'private deletion leaves staged-only uploads for later GC');
 assert.equal((await (await controls('adapters')).json()).ids.includes(id),false,'plugin restoration closures must release deleted agents');
 // GC is separately initiated from the native More menu; busy failure changes no attachments.
 const reclaimableBytes=Buffer.byteLength('fixture attachment')+Buffer.byteLength('target draft upload')+Buffer.byteLength('derived fixture image');
 const gcMenuName=`清理残留附件与缓存（${reclaimableBytes} B）`;
 let releaseSize;
 const sizeHold=new Promise(resolve=>{releaseSize=resolve});
 await page.route('**/session-deletion/api/gc-size',async route=>{await sizeHold;await route.continue()},{times:1});
 await page.locator('nav').getByRole('button',{name:'更多',exact:true}).click();
 const sizeLoading=page.getByRole('status',{name:'正在计算可清理体积',exact:true});
 await sizeLoading.waitFor();
 assert.equal(await sizeLoading.locator('svg[data-state="ongoing"]').count(),1,'size preview uses the native StateDot spinner');
 assert.notEqual(await sizeLoading.locator('svg g').evaluate(el=>getComputedStyle(el).animationName),'none','the native loading circle animates');
 releaseSize();
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
 await page.getByRole('menuitem',{name:'清理残留附件与缓存（无法计算体积）',exact:true}).click();
 await page.getByRole('button',{name:'确认清理',exact:true}).click();
 await page.getByRole('dialog',{name:'清理残留附件与缓存？',exact:true}).getByRole('alert').waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('.dsh-session-deletion-modal button')].every(button=>!button.disabled));
 assert.equal(await exists(join(home,'attachments/v1/objects',exclusive.slice(0,2),exclusive)),true);
 await controls('clear-input',{id:draftOwner.id});await controls('release-maintenance',{id:draftOwner.id});
 assert.equal((await controls('hold-gc')).status(),200);
 await page.getByRole('button',{name:'确认清理',exact:true}).click();
 for(let i=0;i<100;i++){if((await (await controls('gc-held')).json()).held)break;await delay(50)}
 assert.equal((await (await controls('gc-held')).json()).held,true);
 await page.getByRole('button',{name:'正在清理残留附件与缓存…',exact:true}).waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('[role="alert"]')].some(el=>el.textContent==='正在清理残留附件与缓存…'));
 const busyDialog=page.getByRole('dialog',{name:'清理残留附件与缓存？',exact:true});
 assert.equal(await busyDialog.locator('button').count(),3);
 assert.equal(await busyDialog.locator('button').evaluateAll(buttons=>buttons.every(button=>button.disabled)),true,'all native GC buttons, including close, are disabled');
 assert.equal(await page.locator('nav button').evaluateAll(buttons=>buttons.every(button=>button.inert)),true,'session navigation controls remain inert');
 await page.mouse.click(5,5); // Native backdrop dismissal is also blocked.
 await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('dialog',{name:'清理残留附件与缓存？',exact:true}).count(),1,'busy GC cannot be dismissed through native Modal keyboard handling');
 await independentPage.waitForFunction(()=>document.querySelector('#deletion-lock-probe')?.inert===true);
 assert.equal((await controls('direct-input',{id:draftOwner.id})).status(),409,'GC blocks synchronous background publication');
 let uploaded=false;
 const duringGc=controls('stage',{id:draftOwner.id,text:'after GC upload'}).then(response=>{uploaded=true;return response});
 await delay(100);assert.equal(uploaded,false,'new uploads queue until GC completes');
 await controls('release-gc');
 const resultToast=page.getByRole('alert').filter({hasText:'共清理 3 项残留附件与缓存文件。'});
 await resultToast.waitFor({timeout:30000});
 assert.equal(await resultToast.innerText(),'共清理 3 项残留附件与缓存文件。');
 assert.match(await resultToast.getAttribute('class'),/toast/);
 assert.equal(await resultToast.evaluate(el=>el.parentElement===document.body),true);
 assert.equal(await page.locator('.dsh-session-deletion-gc').count(),0,'successful GC closes its modal automatically');
 assert.equal((await duringGc).status(),200);
 await page.waitForFunction(()=>!document.querySelector('#deletion-lock-probe')?.inert);
 // A second pass has nothing to reclaim and still uses the native Toast.
 await page.locator('nav').getByRole('button',{name:'更多',exact:true}).click();
 await page.getByRole('menuitem',{name:'清理残留附件与缓存（0 B）',exact:true}).click();
 await page.getByRole('button',{name:'确认清理',exact:true}).click();
 const emptyResult=page.getByRole('alert').filter({hasText:'共清理 0 项残留附件与缓存文件。'});
 await emptyResult.waitFor({timeout:30000});
 assert.equal(await emptyResult.innerText(),'共清理 0 项残留附件与缓存文件。');
 assert.equal(await page.locator('.dsh-session-deletion-gc').count(),0);
 assert.equal(await exists(join(home,'attachments/v1/objects',exclusive.slice(0,2),exclusive)),false);
 assert.equal(await exists(imageCache),false,'explicit GC clears derived image cache');
 assert.equal(await exists(join(home,'attachments/v1/file-objects',stagedExclusive.slice(0,2),stagedExclusive)),false);
 assert.equal(await exists(join(home,'attachments/v1/file-objects',stagedShared.slice(0,2),stagedShared)),true,'GC protects other staged drafts');
 assert.equal(await exists(join(home,'attachments/v1/objects',shared.slice(0,2),shared)),true);
 assert.deepEqual(JSON.parse(await fs.readFile(join(home,'llm-deepseek/files-v3.json'),'utf8')).records.map(r=>r.attachmentId),['sha256:'+shared]);
 const coldProbe=await (await controls('archive-probe',{id:cold.id})).json();assert.equal(coldProbe.archived,true);
 const coldPreview=await (await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/preview`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:cold.id}})).json();assert.equal(coldPreview.archived,true);
 await controls('block-status');
 const coldDeleted=await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/delete`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:cold.id,token:coldPreview.token,confirmation:'DELETE_IDLE_SESSION'}});
 assert.equal(coldDeleted.status(),500,'inject a diagnostic write failure after the durable deletion receipt');
 await controls('unblock-status');
 assert.equal(await exists(cold.path),false);
 assert.ok((await receipt()).deletedIdHashes.includes(createHash('sha256').update(cold.id).digest('hex')),'post-commit diagnostic failure still publishes the new receipt');
 assert.equal((await controls('input',{id:cold.id})).status(),409,'post-commit failure must still install the deleted-session tombstone');
 // A real interrupted private deletion must produce the recovery notice in other tabs.
 assert.equal((await controls('fail-delete',{id:interrupted.id})).status(),200);
 const interruptedPreview=await (await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/preview`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:interrupted.id}})).json();
 const interruptedDelete=await context.request.post(`http://127.0.0.1:${port}/session-deletion/api/delete`,{headers:{'X-DSH-Session-Deletion':'1'},data:{sessionId:interrupted.id,token:interruptedPreview.token,confirmation:'DELETE_IDLE_SESSION'}});
 assert.equal(interruptedDelete.status(),500);
 assert.equal((await status()).deletionRunning,false);
 assert.equal((await status()).pending.length,1);
 const recoveryToast=page.getByRole('alert').filter({hasText:'清理未完成，将在下次启动时自动恢复'});
 await recoveryToast.waitFor();
 assert.equal(await recoveryToast.locator('svg').count(),1,'recovery uses the native warning icon');
 await page.waitForFunction(()=>[...document.querySelectorAll('[role="alert"]')].some(el=>el.textContent==='清理未完成，将在下次启动时自动恢复'&&getComputedStyle(el).opacity==='1'));
 await recoveryToast.waitFor({state:'detached',timeout:12000});
 await delay(1200);
 assert.equal(await recoveryToast.count(),0,'polling an unchanged state must not reopen an expired Toast');
 await page.evaluate(id=>localStorage.setItem('dsh.conversation.'+id,JSON.stringify({draft:'private fixture draft'})),id);
 // Restart recovery uses a fresh page while retaining the same browser storage.
 await Promise.all([otherPage.close(),independentPage.close(),page.goto('about:blank')]);
 await stop();
 const again=await start();await page.goto(again);await page.waitForTimeout(2000);
 assert.equal((await status()).pending.length,0);
 assert.equal(await exists(interrupted.path),false,'the pending deletion recovers on restart');
 assert.equal(await page.evaluate(id=>localStorage.getItem('dsh.conversation.'+id),id),null);
 assert.equal(await page.getByText('Offline deletion integration fixture',{exact:true}).count(),0);
 assert.deepEqual(errors,[]);
 console.log('INTEGRATION PASS: native menu and GC entry, private deletion during other maintenance/uploads, target-only locking, explicit idle GC, staged/shared references, GC publication barrier, recovery and restart');
}catch(e){
 if(browser){const pages=browser.contexts().flatMap(c=>c.pages());if(pages[0]){await fs.mkdir('test-results',{recursive:true});await pages[0].screenshot({path:'test-results/failure.png'});console.error((await pages[0].locator('body').innerText()).slice(0,6000));}}
 console.error('Browser errors:',errors);
 console.error('Profile manifest:',await fs.readFile(join(home,'profiles/web/package.json'),'utf8'));
 console.error('Host log:',bootLog.replace(/token=[^\s]+/g,'token=[redacted]').slice(-6000));throw e;
}finally{
 await browser?.close();await stop();
 // Both the host and its recovery guard have finished before the fixture is removed.
 await fs.rm(base,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
