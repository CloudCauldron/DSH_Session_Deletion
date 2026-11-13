// Loaded only by the isolated integration profile, never packaged or installed for the user.
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { HostContext } from '../lib/host.js';
import type { RuntimeContext } from '../lib/runtime.js';
import type { DeletionRuntime } from '../src/runtime.ts';

type Agent = NonNullable<ReturnType<RuntimeContext['agents']['get']>> & {
 inject(message: unknown): unknown;
 cancel(reason: { kind: 'user' }): unknown;
 runMaintenance(work: () => Promise<void>): Promise<unknown>;
};
type FixtureContext = Pick<HostContext, 'webServer' | 'connection'> & Pick<RuntimeContext, 'workspaceRegistry' | 'sessions' | 'effect' | 'sessionProjectionCache'> & {
 agents: { get(id: string): Agent | undefined };
 sessionPersistence: { tracker: { openHandles: Iterable<{ id: string; access: string }> } };
 sessionController: { resolveAgent(id: string): Promise<{ agent: Agent; error?: unknown }>; prompt(request: { sessionId: string }): Promise<unknown> };
 fileUploads: { upload(agent: Agent, data: { data: string; name: string }, signal: AbortSignal): Promise<unknown> };
 sessionDeletionRuntime: Pick<DeletionRuntime, keyof DeletionRuntime> & {
  snapshots: DeletionRuntime['snapshots']; agentRestorers: DeletionRuntime['agentRestorers'];
 };
 on(name: 'workspace/session-activity', callback: (request: { sessionId: string }, next: () => Promise<Array<{ kind: string }>>) => Promise<Array<{ kind: string }>>): () => void;
};
export const inject=['webServer','connection','agents','sessionController','sessionProjectionCache','workspaceRegistry','sessions','sessionPersistence','fileUploads','sessionDeletionRuntime'];
export function apply(ctx: FixtureContext){
 let visualActivityId: string | undefined;
 ctx.on('workspace/session-activity',async({sessionId},next)=>{
  const activity=await next();
  return sessionId===visualActivityId?[...activity,{kind:'job',items:[{id:'visual-reference',label:'样式核对用后台任务'}]}]:activity;
 });
 const holds=new Map<string, () => void>();let releaseDelete: (() => void) | undefined;let holdId: string | undefined;let failDeleteId: string | undefined;
 let holdGc=false,releaseGc: (() => void) | undefined;
 const runtime=ctx.sessionDeletionRuntime, snapshots=runtime.snapshots;
 runtime.snapshots=async function(){if(holdGc)await new Promise<void>(resolve=>{releaseGc=resolve});return snapshots.call(this)};
 const table=ctx.sessionProjectionCache.table;const original=table.delete;
 table.delete=async function(id){if(id===failDeleteId){failDeleteId=undefined;throw Error('Injected deletion interruption')}if(id===holdId)await new Promise<void>(resolve=>{releaseDelete=resolve});return original.call(this,id)};
 ctx.effect(()=>()=>{table.delete=original;for(const release of holds.values())release();releaseDelete?.();releaseGc?.();runtime.snapshots=snapshots});
 ctx.webServer.register({kind:'prefix',path:'/deletion-test',async handler(req,res){
  const admission=ctx.connection.admit(req);if('rejection'in admission||admission.peer.principal.kind!=='owner'){res.writeHead(403);res.end();return}
  try{let s='';for await(const chunk of req)s+=chunk;const data=JSON.parse(s||'{}') as { id?: string; text: string };
   const path=new URL(req.url || '/','http://localhost').pathname;
   if(path==='/deletion-test/state'||path==='/deletion-test/archive-probe'){
    if(path.endsWith('archive-probe'))await ctx.workspaceRegistry.archiveSession(data.id!);
    const agent=ctx.agents.get(data.id!);
    const writers=[...ctx.sessionPersistence.tracker.openHandles];
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({archived:ctx.workspaceRegistry.archivedSessionIds.includes(data.id!),agentResident:!!agent,sessionResident:!!ctx.sessions.get(data.id!),status:agent?.status,writerOpen:writers.some(h=>h.id===data.id!&&h.access==='write')}));return;
   }else if(path==='/deletion-test/visual-activity'){visualActivityId=data.id!}
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
    const path=join(ctx.sessionDeletionRuntime.home,'session-deletion/status.json');
    await fs.rm(path,{force:true});await fs.mkdir(path);
   }else if(path==='/deletion-test/unblock-status'){
    await fs.rmdir(join(ctx.sessionDeletionRuntime.home,'session-deletion/status.json'));
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
   else if(path==='/deletion-test/fail-delete'){failDeleteId=data.id!}
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
 }});
}
