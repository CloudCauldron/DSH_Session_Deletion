// Loaded only by the isolated integration profile, never packaged or installed for the user.
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { stateDir } from '../lib/core.js';
import type { HostContext } from '../lib/host.js';
import type { RuntimeContext } from '../lib/runtime.js';
import type { DeletionRuntime } from '../src/runtime.ts';

function defer(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}

type Agent = NonNullable<ReturnType<RuntimeContext['agents']['get']>> & {
 inject(message: unknown): unknown;
 followup(message: unknown): unknown;
 cancel(reason: { kind: 'user' }): unknown;
 runMaintenance(work: () => Promise<void>): Promise<unknown>;
};
interface NativeSubagents {
 registerProvider(provider: {
  name: string; capabilities: { agentOptions: boolean; agentPreset: boolean; outputSchema: boolean; depthLimit: boolean }; inheritsParentContext: boolean;
  start(): Promise<{ id: string; result: Promise<{ output: unknown[]; stopReason: 'aborted' }>; dispose(): Promise<void> }>;
 }): () => void;
 startActivation(spec: { provider: string; parent: Agent; childId?: string; label: string; prompt: Array<{ type: 'text'; text: string }>; signal: AbortSignal; delivery: 'caller'; maxDepth?: number }): Promise<{ childId: string; dispose(): Promise<void> }>;
 sendMessage(parent: Agent, child: string, content: Array<{ type: 'text'; text: string }>, options: { signal: AbortSignal }): Promise<unknown>;
}
type FixtureContext = Pick<HostContext, 'webServer' | 'connection'> & Pick<RuntimeContext, 'workspaceRegistry' | 'sessions' | 'effect' | 'sessionProjectionCache'> & {
 attachments: { saveImage(input: unknown): Promise<{ attachmentId: string }> };
 workspaceRegistry: RuntimeContext['workspaceRegistry'] & { create(path: string): Promise<{ id: string; attachSession(id: string): Promise<void>; detachSession(id: string): Promise<void> }> };
 agents: { get(id: string): Agent | undefined };
 sessionPersistence: { flush(): Promise<void>; tracker: { openHandles: Iterable<{ id: string; access: string }> } };
 sessionController: { resolveAgent(id: string): Promise<{ agent: Agent; error?: unknown }>; prompt(request: { sessionId: string }): Promise<unknown> };
 fileUploads: { upload(agent: Agent, data: { data: string; name: string }, signal: AbortSignal): Promise<unknown> };
 sessionDeletionRuntime: Pick<DeletionRuntime, keyof DeletionRuntime> & {
  agentRestorers: DeletionRuntime['agentRestorers'];
  stopTimeoutMs: DeletionRuntime['stopTimeoutMs'];
  schedule: DeletionRuntime['schedule']; editSchedule: DeletionRuntime['editSchedule'];
 };
 subagents: NativeSubagents;
 jobs: {
  attachController(name: string): () => void;
  start(spec: { kind: string; label: string; owner: string; run(): { done: Promise<{ status: 'killed' }>; cancel(): void } }): string;
 };
 schedule: {
  create(request: { title: string; prompt: string; timing: { kind: 'after'; after_seconds: number }; target: { kind: 'session'; sessionId: string }|{kind:'new';create:{cwd:string}} }, actor?: string): Promise<{ id: string }>;
  edit: RuntimeContext['schedule']['edit'];
  run(request:{id:string}):Promise<unknown>;
  catalog(): Promise<Array<{ id: string; target: { kind: string; sessionId?: string } }>>;
 };
 terminals: RuntimeContext['terminals'] & {
  spawn(agent:Agent,request:{type:string}):Promise<{sessionId:string}>;
  registerBackend(backend:{type:string;spawn(spec:{sessionId:string}):Promise<{
   motd:string;status():{kind:'running'|'exited'};close():Promise<void>;startSend():never;read():never;signal():never;
  }>}):()=>void;
 };
 on(name: 'workspace/session-activity', callback: (request: { sessionId: string }, next: () => Promise<Array<{ kind: string }>>) => Promise<Array<{ kind: string }>>): () => void;
 on(name: 'agent/pre-step', callback: (event: { agent: Agent; signal: AbortSignal }, next: () => Promise<unknown>) => Promise<unknown>): () => void;
};
export const inject=['attachments','webServer','connection','agents','sessionController','sessionProjectionCache','workspaceRegistry','sessions','sessionPersistence','fileUploads','sessionDeletionRuntime','subagents','jobs','schedule','terminals'];
export function apply(ctx: FixtureContext){
 const heldSteps=new Set<string>(),activeSteps=new Set<string>(),externalStopped=new Set<string>(),jobStopped=new Set<string>();
 let releaseExternal: (()=>void)|undefined;
 const nativeParents=new Map<string,Agent>();
 const nativeTrees=new Map<string,{childId:string;externalId:string;jobId:string;terminalId:string;targetTask:string;otherTask:string}>();
 const closedTerminals=new Set<string>();
 const unregisterTerminal=ctx.terminals.registerBackend({type:'deletion-fixture',spawn:async({sessionId})=>({
  motd:'Offline native terminal',status:()=>({kind:closedTerminals.has(sessionId)?'exited':'running'}),
  close:async()=>{closedTerminals.add(sessionId)},
  startSend(){throw Error('Unexpected terminal input')},read(){throw Error('Unexpected terminal read')},signal(){throw Error('Unexpected terminal signal')},
 })});
 ctx.on('agent/pre-step',({agent,signal},next)=>{
  if(!heldSteps.has(agent.id))return next();
  activeSteps.add(agent.id);
  return new Promise(resolve=>{
   const stop=()=>{activeSteps.delete(agent.id);resolve({kind:'reject'})};
   if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});
  });
 });
 const unregisterExternal=ctx.subagents.registerProvider({
  name:'deletion-test-external',inheritsParentContext:false,
  capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},
  start(){
   const id='external-'+randomUUID();let finish!: (result:{output:unknown[];stopReason:'aborted'})=>void;
   const result=new Promise<{output:unknown[];stopReason:'aborted'}>(resolve=>{finish=resolve});
   let closing: Promise<void>|undefined;
   return Promise.resolve({id,result,dispose:()=>closing??=(async()=>{
    await new Promise<void>(resolve=>{releaseExternal=resolve});
    releaseExternal=undefined;externalStopped.add(id);finish({output:[],stopReason:'aborted'});await result;
   })()});
  },
 });
 const detachJobs=ctx.jobs.attachController('deletion-test');
 ctx.effect(()=>()=>{releaseExternal?.();unregisterExternal();unregisterTerminal();detachJobs()});
 let visualActivityId: string | undefined;
 ctx.on('workspace/session-activity',async({sessionId},next)=>{
  const activity=await next();
  return sessionId===visualActivityId?[...activity,{kind:'job',items:[{id:'visual-reference',label:'样式核对用后台任务'}]}]:activity;
 });
 const holds=new Map<string, () => void>();let releaseDelete: (() => void) | undefined;let holdId: string | undefined;
 let importedImage: string | undefined;
 const releaseImage=defer();
 let holdGc=false,releaseGc: (() => void) | undefined;
 const runtime=ctx.sessionDeletionRuntime, persistence=ctx.sessionPersistence, flush=persistence.flush;
 persistence.flush=async function(){if(holdGc && runtime.gcRunning)await new Promise<void>(resolve=>{releaseGc=resolve});return flush.call(this)};
 const table=ctx.sessionProjectionCache.table;const original=table.delete;
 table.delete=async function(id){if(id===holdId)await new Promise<void>(resolve=>{releaseDelete=resolve});return original.call(this,id)};
 let scheduleRace:{id:string;ready:ReturnType<typeof defer>;retarget:Promise<unknown>;releaseResolve:ReturnType<typeof defer>;releaseDelete:ReturnType<typeof defer>}|undefined;
 let pendingSchedule:{id:string;sessionId:string;release:ReturnType<typeof defer>;finished:Promise<void>;failed:boolean}|undefined;
 ctx.effect(()=>()=>{table.delete=original;for(const release of holds.values())release();releaseDelete?.();releaseGc?.();persistence.flush=flush});
 ctx.effect(()=>ctx.webServer.register({kind:'prefix',path:'/deletion-test',async handler(req,res){
  const admission=ctx.connection.admit(req);if('rejection'in admission||admission.peer.principal.kind!=='owner'){res.writeHead(403);res.end();return}
  try{let s='';for await(const chunk of req)s+=chunk;const data=JSON.parse(s||'{}') as { id?: string; otherId: string; text: string; ms: number; cwd:string };
   const path=new URL(req.url || '/','http://localhost').pathname;
   if(path==='/deletion-test/import-workspace'){
    const workspace=await ctx.workspaceRegistry.create(data.cwd);
    const attachments=ctx.attachments,saveImage=attachments.saveImage;
    attachments.saveImage=async function(input){
     const ref=await saveImage.call(this,input);
     importedImage=ref.attachmentId;await releaseImage.promise;return ref;
    };
    ctx.effect(()=>()=>{releaseImage.resolve();attachments.saveImage=saveImage});
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:workspace.id}));return;
   }else if(path==='/deletion-test/attach'||path==='/deletion-test/detach'){
    const workspace=await ctx.workspaceRegistry.create(data.cwd);
    if(path.endsWith('/attach'))await workspace.attachSession(data.id!);else await workspace.detachSession(data.id!);
   }else if(path==='/deletion-test/import-image'){
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:importedImage}));return;
   }else if(path==='/deletion-test/release-image'){releaseImage.resolve()}
   else if(path==='/deletion-test/schedule-race'){
    const resolved=await ctx.sessionController.resolveAgent(data.id!);if(resolved.error)throw resolved.error;
    const service=runtime.schedule! as NonNullable<DeletionRuntime['schedule']>&{resolveTarget(target:{kind:string;sessionId?:string},signal?:AbortSignal):Promise<unknown>};
    const task=await ctx.schedule.create({title:'Retarget race',prompt:'Offline',timing:{kind:'after',after_seconds:3600},target:{kind:'session',sessionId:data.otherId}});
    const started=defer(),releaseResolve=defer(),ready=defer(),releaseDelete=defer();
    const resolveTarget=service.resolveTarget,editSchedule=runtime.editSchedule;let hold=true;
    service.resolveTarget=async function(target,...args){if(hold&&target.sessionId===data.otherId){hold=false;started.resolve();await releaseResolve.promise}return Reflect.apply(resolveTarget,this,[target,...args])};
    runtime.editSchedule=async(request,...args)=>{if(request.id===task.id&&request.action==='delete'){ready.resolve();await releaseDelete.promise}return editSchedule(request,...args)};
    ctx.effect(()=>()=>{releaseResolve.resolve();releaseDelete.resolve();service.resolveTarget=resolveTarget;runtime.editSchedule=editSchedule});
    const retarget=ctx.schedule.edit({id:task.id,action:'update',patch:{target:{kind:'session',sessionId:data.otherId}}});void retarget.catch(()=>{});
    await started.promise;
    await ctx.schedule.edit({id:task.id,action:'update',patch:{target:{kind:'session',sessionId:data.id!}}});
    scheduleRace={id:task.id,ready,retarget,releaseResolve,releaseDelete};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({taskId:task.id}));return;
   }else if(path==='/deletion-test/release-schedule-race'){
    const race=scheduleRace!;await race.ready.promise;race.releaseResolve.resolve();await race.retarget;race.releaseDelete.resolve();
   }else if(path==='/deletion-test/pending-schedule'){
    const service=runtime.schedule! as NonNullable<DeletionRuntime['schedule']>&{runtime:{send(agent:Agent,...args:unknown[]):Promise<unknown>}};
    const send=service.runtime.send,started=defer(),release=defer();let hold=true;
    const task=await ctx.schedule.create({title:'Pending new session',prompt:'Offline',timing:{kind:'after',after_seconds:3600},target:{kind:'new',create:{cwd:data.cwd}}});
    const state={id:task.id,sessionId:'',release,finished:Promise.resolve(),failed:false};pendingSchedule=state;
    service.runtime.send=async function(agent,...args){heldSteps.add(agent.id);if(hold){hold=false;state.sessionId=agent.id;started.resolve();await release.promise}return Reflect.apply(send,this,[agent,...args])};
    ctx.effect(()=>()=>{release.resolve();service.runtime.send=send});
    state.finished=ctx.schedule.run({id:task.id}).then(()=>{},()=>{state.failed=true});await started.promise;
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({taskId:task.id,sessionId:state.sessionId}));return;
   }else if(path==='/deletion-test/release-pending-schedule'){
    const state=pendingSchedule!;state.release.resolve();await state.finished;let retryFailed=false;
    try{await ctx.schedule.run({id:state.id})}catch{retryFailed=true}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({firstFailed:state.failed,retryFailed}));return;
   }else if(path==='/deletion-test/native-tree'){
    const resolved=await ctx.sessionController.resolveAgent(data.id!);if(resolved.error)throw resolved.error;
    const parent=resolved.agent,childId='session-'+randomUUID();heldSteps.add(parent.id);heldSteps.add(childId);
    const local=await ctx.subagents.startActivation({provider:'spawn',parent,childId,label:'Native child fixture',prompt:[{type:'text',text:'Held offline child'}],signal:new AbortController().signal,delivery:'caller',maxDepth:4});
    await local.dispose();if(ctx.agents.get(childId))throw Error('Native child did not become cold');
    // This standard restore path never returns a startActivation receipt to the plugin.
    await ctx.subagents.sendMessage(parent,childId,[{type:'text',text:'Resume offline child'}],{signal:new AbortController().signal});
    const external=await ctx.subagents.startActivation({provider:'deletion-test-external',parent,label:'External fixture',prompt:[{type:'text',text:'External offline child'}],signal:new AbortController().signal,delivery:'caller'});
    let finishJob!: (value:{status:'killed'})=>void;
    const done=new Promise<{status:'killed'}>(resolve=>{finishJob=resolve});
    const jobId=ctx.jobs.start({kind:'fixture',label:'Offline background work',owner:parent.id,run:()=>({done,cancel(){jobStopped.add(jobId);finishJob({status:'killed'})}})});
    const terminal=await ctx.terminals.spawn(parent,{type:'deletion-fixture'});
    const task=(sessionId:string)=>({title:'Offline reminder',prompt:'No execution',timing:{kind:'after' as const,after_seconds:3600},target:{kind:'session' as const,sessionId}});
    const targetTask=await ctx.schedule.create(task(parent.id),parent.id);
    const otherTask=await ctx.schedule.create(task(data.otherId),parent.id);
    parent.followup({id:randomUUID(),role:'user',source:{kind:'user',rpcId:randomUUID(),clientTimeZone:'Asia/Taipei'},content:[{type:'text',text:'Held offline root'}]});
    nativeTrees.set(parent.id,{childId,externalId:external.childId,jobId,terminalId:terminal.sessionId,targetTask:targetTask.id,otherTask:otherTask.id});
    nativeParents.set(parent.id,parent);
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(nativeTrees.get(parent.id)));return;
   }else if(path==='/deletion-test/native-tree-state'){
    const tree=nativeTrees.get(data.id!)!;
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({...tree,rootActive:activeSteps.has(data.id!),childActive:activeSteps.has(tree.childId),externalPending:!!releaseExternal,externalStopped:externalStopped.has(tree.externalId),jobStopped:jobStopped.has(tree.jobId),terminalClosed:closedTerminals.has(tree.terminalId),hasTerminalActivity:ctx.terminals.hasOwnerActivity(nativeParents.get(data.id!)!),tasks:(await ctx.schedule.catalog()).map(task=>task.id)}));return;
   }else if(path==='/deletion-test/native-tree-admit'){
    await ctx.subagents.startActivation({provider:'deletion-test-external',parent:nativeParents.get(data.id!)!,label:'Rejected new work',prompt:[{type:'text',text:'Must not start'}],signal:new AbortController().signal,delivery:'caller'});
   }else if(path==='/deletion-test/release-external'){
    releaseExternal?.();
   }else if(path==='/deletion-test/state'||path==='/deletion-test/archive-probe'){
    if(path.endsWith('archive-probe'))await ctx.workspaceRegistry.archiveSession(data.id!);
    const agent=ctx.agents.get(data.id!);
    const writers=[...ctx.sessionPersistence.tracker.openHandles];
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({archived:ctx.workspaceRegistry.archivedSessionIds.includes(data.id!),agentResident:!!agent,sessionResident:!!ctx.sessions.get(data.id!),status:agent?.status,writerOpen:writers.some(h=>h.id===data.id!&&h.access==='write')}));return;
   }else if(path==='/deletion-test/stop-timeout'){runtime.stopTimeoutMs=data.ms}
   else if(path==='/deletion-test/visual-activity'){visualActivityId=data.id!}
   else if(path==='/deletion-test/open'){
    const resolved=await ctx.sessionController.resolveAgent(data.id!);
    if(resolved.error)throw resolved.error;
   }else if(path==='/deletion-test/stage'){
    const resolved=await ctx.sessionController.resolveAgent(data.id!);
    if(resolved.error)throw resolved.error;
    const agent=resolved.agent;
    const receipt=await ctx.fileUploads.upload(agent,{data:Buffer.from(data.text).toString('base64'),name:'staged.txt'},new AbortController().signal);
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(receipt));return;
   }else if(path==='/deletion-test/adapters'){
    const ids=[...ctx.sessionDeletionRuntime.agentRestorers.keys()].map(agent=>agent.id);
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ids}));return;
   }else if(path==='/deletion-test/block-status'){
    const path=join(stateDir(ctx.sessionDeletionRuntime.home),'status.json');
    await fs.rm(path,{force:true});await fs.mkdir(path);
   }else if(path==='/deletion-test/unblock-status'){
    await fs.rmdir(join(stateDir(ctx.sessionDeletionRuntime.home),'status.json'));
   }else if(path==='/deletion-test/direct-input'){
    ctx.agents.get(data.id!)!.inject({id:randomUUID(),role:'user',source:{kind:'user',rpcId:randomUUID(),clientTimeZone:'Asia/Taipei'},content:[{type:'text',text:'parallel queued input'}]});
   }else if(path==='/deletion-test/clear-input'){ctx.agents.get(data.id!)!.cancel({kind:'user'})
   }else if(path==='/deletion-test/pin'){await ctx.workspaceRegistry.pinSession(data.id!)}
   else if(path==='/deletion-test/unarchive'){await ctx.workspaceRegistry.unarchiveSession(data.id!)}
   else if(path==='/deletion-test/maintain'){
    const agent=ctx.agents.get(data.id!);if(!agent)throw Error('Open fixture session first');
    const hold=new Promise<void>(resolve=>{holds.set(data.id!,resolve);});
    agent.runMaintenance(()=>hold).catch(()=>{});
   }else if(path==='/deletion-test/release-maintenance'){holds.get(data.id!)?.();holds.delete(data.id!)}
   else if(path==='/deletion-test/hold-delete'){holdId=data.id!}
   else if(path==='/deletion-test/release-delete'){holdId=undefined;releaseDelete?.();releaseDelete=undefined}
   else if(path==='/deletion-test/input'){
    // The runtime wrapper must reject this before it reaches payload validation or model execution.
    await ctx.sessionController.prompt({sessionId:data.id!});
   }else if(path==='/deletion-test/hold-gc'){holdGc=true}
   else if(path==='/deletion-test/release-gc'){holdGc=false;releaseGc?.();releaseGc=undefined}
   else if(path==='/deletion-test/gc-held'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({held:!!releaseGc}));return}
   else if(path==='/deletion-test/held'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({held:!!releaseDelete}));return}
   else throw Error('Unknown test route');
   res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');
  }catch(e){const status=typeof e==='object'&&e!==null&&'status' in e&&typeof e.status==='number'?e.status:500;res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e instanceof Error?e.message:String(e)}))}
 }}), 'session-deletion test controls');
}
