import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, req, target, MemKV } from './helpers.ts';
import { CAPS } from '../packages/adapters/src/reference-tasks/ops.ts';
import { Broker, approvalBinding } from '../packages/broker/src/broker.ts';
import { OPS, CAPS as VC, buildState } from '../packages/adapters/src/vikunja/ops.ts';
import { buildContext } from '../packages/planner/src/planner.ts';
import { defaultProfile } from '../packages/schemas/src/profile.ts';

const create = OPS.find(o => o.capability.id === VC.create.id)!;
const state = (tasks: any[] = []) => buildState({ origin: 'http://localhost:3456', accountId: 1, project: {id:2,title:'Private project'}, tasks, observedAt: 1 });
const object = (id=99, title='Synthetic external task') => ({ id,title,done:false,priority:0,project_id:2,updated:'2026-11-17T10:00:00Z' });
const vr = () => req({capabilityId:VC.create.id,target:{appId:'vikunja',origin:'http://localhost:3456',documentInstanceId:'vikunja:1:project:2',objectId:null,display:{app:'Vikunja',document:'Synthetic'}},expectedRevision:state().workspaceRevision,args:{title:'Synthetic external task',priority:'unset'}});

test('concurrent unresolved actions retain both journal entries after restart', async () => {
 const {broker,app,restart}=setup(); app.mode='drop';
 const actions=['t1','t2'].map(id=>req({capabilityId:CAPS.update.id,target:target(id),args:{status:'done'}}));
 await Promise.all(actions.map(r=>broker.execute(r)));
 const journal=await restart().listJournal();
 assert.equal(journal.length,2); assert.deepEqual(new Set(journal.map(e=>e.request.actionId)),new Set(actions.map(r=>r.actionId)));
 assert.ok(journal.every(e=>e.status==='unknown'));
});
test('simultaneous duplicate action across brokers sharing KV dispatches once', async () => {
 const {broker,app,restart}=setup(); const r=req({capabilityId:CAPS.update.id,target:target('t1'),args:{status:'done'}});
 const results=await Promise.all([broker.execute(r),restart().execute(r)]);
 assert.equal(app.writes,1); assert.ok(results.some(r=>r.errorCode==='DUPLICATE_ACTION'));
});
test('approval binds action identity and adapter/schema version', () => {
 const r=req({capabilityId:CAPS.create.id,target:target(null),args:{title:'One'}});
 const original=approvalBinding(r,CAPS.create);
 assert.notEqual(original,approvalBinding({...r,actionId:r.actionId+'x'},CAPS.create));
 assert.notEqual(original,approvalBinding(r,{...CAPS.create,adapterVersion:'99.0.0'}));
 assert.notEqual(original,approvalBinding(r,{...CAPS.create,schemaVersion:2} as any));
});
test('parallel approval issuance preserves both tokens', async () => {
 const {broker,kv}=setup(); const r=req({capabilityId:CAPS.create.id,target:target(null),args:{title:'One'}});
 const tokens=await Promise.all([broker.issueApproval(r),broker.issueApproval({...r,actionId:r.actionId+'x'})]);
 const map=await kv.get<Record<string,unknown>>('broker.approvals.v1');
 assert.ok(tokens.every(t=>t.token && map?.[t.token]));
});
test('reconcile concurrent with dispatch never erases a different action journal', async () => {
 const {broker,app}=setup(); app.mode='drop';
 await broker.execute(req({capabilityId:CAPS.update.id,target:target('t1'),args:{status:'done'}}));
 await Promise.all([broker.reconcile(),broker.execute(req({capabilityId:CAPS.update.id,target:target('t2'),args:{status:'done'}}))]);
 assert.equal((await broker.listJournal()).length,2);
});
test('external matching create is not confirmed without a durable receipt', () => {
 const r=vr(), ctx=create.prepare!(state(),r);
 assert.equal(create.verify(state([object()]),r,ctx).verified,false);
 const receipt=create.captureReceipt!(ctx,{objectId:'99'});
 assert.equal(create.verify(state([object()]),r,receipt).verified,true);
 assert.equal(create.verify(state([object(100)]),r,receipt).verified,false);
 assert.equal(create.verify(state([object(99,'Different title')]),r,receipt).verified,false);
});
test('broker persists receipt before readback and restart; missing response remains unknown', async () => {
 for(const received of [true,false]) {
  const kv=new MemKV(); let after=false, readable=true,writes=0;
  const adapter={adapterId:'vikunja.api',adapterVersion:'0.1.0',ops:OPS,
   readState:async()=>{if(!readable)throw Error('disconnected');return state(after?[object()]:[]);},
   execute:async()=>{writes++;after=true;readable=false;if(!received)throw Error('response lost');return {dispatched:true,receipt:{objectId:'99'}};}};
  const mk=()=>new Broker({kv,adapters:[adapter],hasPermission:async()=>true,isPaused:async()=>false,now:()=>Date.now(),randomId:()=> 'token-synthetic'});
  const b=mk(),r=vr();const approval=await b.issueApproval(r);
  const outcome=await b.execute({...r,approvalToken:approval.token!});assert.equal(outcome.status,'unknown');
  readable=true; const journal=await mk().reconcile();assert.equal(journal[0].status,received?'verified':'unknown');assert.equal(writes,1);
 }
});
test('different private task content yields byte-identical public planner envelope', () => {
 const a=buildContext('Show tasks',defaultProfile(),Object.values(VC),state([object(99,'Private A')]));
 const b=buildContext('Show tasks',defaultProfile(),Object.values(VC),state([object(100,'Private B')]));
 assert.equal(JSON.stringify(a),JSON.stringify(b));
});

test('lost create response with readable matching state stays unknown, not failed or verified', async () => {
 const kv=new MemKV();let after=false;
 const adapter={adapterId:'vikunja.api',adapterVersion:'0.1.0',ops:OPS,readState:async()=>state(after?[object()]:[]),execute:async()=>{after=true;throw Error('connection lost after write');}};
 const b=new Broker({kv,adapters:[adapter],hasPermission:async()=>true,isPaused:async()=>false,now:()=>Date.now(),randomId:()=> 'token-synthetic'});
 const r=vr(),a=await b.issueApproval(r);const result=await b.execute({...r,approvalToken:a.token!});
 assert.equal(result.status,'unknown');assert.equal((await b.reconcile())[0].status,'unknown');
});

test('real Vikunja adapter transports the response object id as a receipt', async () => {
 const {makeVikunjaAdapter}=await import('../packages/adapters/src/vikunja/ops.ts');
 const adapter=makeVikunjaAdapter({identity:async()=>1,call:async <T>(_o:string,method:string,path:string)=>{assert.equal(method,'PUT');assert.equal(path,'/projects/2/tasks');return object() as T;}});
 assert.deepEqual(await adapter.execute(vr(),VC.create),{dispatched:true,receipt:{objectId:'99'}});
});
test('explicit non-dispatch cannot become verified from a coincidental matching readback', async () => {
 const kv=new MemKV();let after=false;
 const adapter={adapterId:'vikunja.api',adapterVersion:'0.1.0',ops:OPS,readState:async()=>state(after?[object()]:[]),execute:async()=>{after=true;return {dispatched:false,detail:'permission denied'};}};
 const b=new Broker({kv,adapters:[adapter],hasPermission:async()=>true,isPaused:async()=>false,now:()=>Date.now(),randomId:()=> 'token-synthetic'});
 const r=vr(),a=await b.issueApproval(r);assert.equal((await b.execute({...r,approvalToken:a.token!})).status,'failed');
});

test('profile reset during in-flight dispatch preserves recovery and never clears backing storage', async () => {
 const {broker,kv,app,restart}=setup();
 await kv.set('profile',{savedWorkspaces:{test:'layout'}});
 await kv.set('lastSurface:vikunja',{title:'Accepted old layout'});
 const r=req({capabilityId:CAPS.update.id,target:target('t1'),args:{status:'done'}});
 let release!:()=>void, entered!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve);
 app.execute=async()=>{entered();await new Promise<void>(resolve=>release=resolve);return {dispatched:true};};
 const dispatch=broker.execute(r); await started;
 const reset=broker.resetProfile(['vikunja']);
 assert.equal((await restart().listJournal()).length,1,'durable journal survives while reset waits');
 release();await Promise.all([dispatch,reset]);
 assert.equal(await kv.get('profile'),undefined);
 assert.equal(await kv.get('lastSurface:vikunja'),undefined);
 assert.equal(await kv.get('stopAll'),true);
 assert.equal((await restart().listJournal())[0].status,'unknown');
 assert.equal((await restart().execute(r)).errorCode,'DUPLICATE_ACTION');
});
test('profile reset revokes approvals but preserves completed duplicate guards', async () => {
 const {broker,kv,restart}=setup();
 const r=req({capabilityId:CAPS.update.id,target:target('t1'),args:{status:'done'}});
 await broker.execute(r);
 const create=req({capabilityId:CAPS.create.id,target:target(null),args:{title:'Pending approval'},expectedRevision:2});
 await broker.issueApproval(create);
 await broker.resetProfile();
 assert.equal(await kv.get('broker.approvals.v1'),undefined);
 assert.equal((await restart().listJournal()).length,1);
 assert.equal((await restart().execute(r)).errorCode,'DUPLICATE_ACTION');
});
test('workspace reset uses worker RPC and never clears local storage directly', async () => {
 const {readFile}=await import('node:fs/promises');
 const panel=await readFile(new URL('../extension/src/sidepanel.ts',import.meta.url),'utf8');
 assert.ok(!panel.includes('chrome.storage.local.clear('));
 assert.ok(panel.includes("send({ type: 'profile.reset' })"));
});
