// Bounded browser-semantic prototype: one reviewed click in a pinned Vikunja task page.
import type { ActionRequest, Capability, ObservedState, TargetIdentity } from '../../../schemas/src/contracts.ts';
import type { AdapterPort } from '../../../broker/src/broker.ts';
import { OPS } from './ops.ts';
export const BROWSER_CAP: Capability = {
 schemaVersion:1,id:'vikunja.browser.complete',adapterId:'vikunja.browser',adapterVersion:'0.1.0',appId:'vikunja',operation:'browser.complete',label:'Click Complete in the original task page',
 argumentSchema:{session:{type:'string',maxLength:100,required:true,material:true}},requiredScopes:['approved-localhost','authenticated-page','api-read'],riskClass:'medium',reversible:true,
 preconditions:['Pinned active tab and document','Same open task and revision','Non-recurring task','Explicit approval'],verificationMethod:'Independent API read-back; no automatic click retry',supportedVersions:['v2.8.0']
};
export interface BrowserSession { id:string;tabId:number;documentId:string;url:string;target:TargetIdentity;revision:number;title:string;expiresAt:number;used:boolean }
export function assertBrowserSession(s:BrowserSession|undefined,req:ActionRequest,now:number) {
 if(!s||s.used||s.expiresAt<now||s.id!==req.args.session||s.revision!==req.expectedRevision||['appId','origin','documentInstanceId','objectId'].some(k=>(s.target as any)[k]!==(req.target as any)[k]))throw Error('Browser inspection expired or changed. Inspect this task again.');
}
export function inspectTask(s:ObservedState,id:string){const task=s.collections.tasks?.find(t=>t.objectId===id);if(!task||task.fields.status!=='open')throw Error('Choose an open task. Already completed tasks are not toggled.');return task;}
// Serialized by chrome.scripting. No page-provided selector/code, no input focus, no navigation.
export function browserControl(mode:'inspect'|'click',url:string,title:string){
 if(location.href!==url||document.visibilityState!=='visible')throw Error('Task page changed or is not visible.');
 const headings=[...document.querySelectorAll('.task-view .heading h1')];
 const buttons=[...document.querySelectorAll('.task-view .button--mark-done')];
 if(headings.length!==1||headings[0].textContent?.trim()!==title.trim()||buttons.length!==1)throw Error('Task identity or control is ambiguous.');
 const button=buttons[0] as HTMLButtonElement;const rect=button.getBoundingClientRect();
 const style=getComputedStyle(button);const x=rect.left+rect.width/2,y=rect.top+rect.height/2;const hit=document.elementFromPoint(x,y);
 if(style.visibility!=='visible'||Number(style.opacity)===0||x<0||y<0||x>=innerWidth||y>=innerHeight||!hit||!(hit===button||button.contains(hit)))throw Error('Complete control is not visibly reachable.');
 if(!button.classList.contains('is-pending')||button.disabled||button.getAttribute('aria-disabled')==='true'||rect.width<=0||rect.height<=0)throw Error('Complete control unavailable or task already done.');
 if(mode==='inspect'){button.style.outline='3px solid #167d8d';button.style.outlineOffset='4px';setTimeout(()=>{button.style.outline='';button.style.outlineOffset='';},15000);return {ready:true};}
 // Anything after this point may have effects. Caller treats thrown errors as unknown.
 button.click();return {clicked:true};
}
export interface BrowserPorts { /** Offline fake ports only; production must omit this. */ syntheticTestDispatch?:boolean;read(target:TargetIdentity):Promise<ObservedState>;session(id:string):Promise<BrowserSession|undefined>;save(s:BrowserSession):Promise<void>;checkPage(s:BrowserSession):Promise<void>;checkTask(s:BrowserSession):Promise<void>;click(s:BrowserSession):Promise<void>;stopped():Promise<boolean>;now():number}
export function makeBrowserAdapter(p:BrowserPorts):AdapterPort {
 const update=OPS.find(o=>o.capability.operation==='task.update')!;
 const asUpdate=(r:ActionRequest):ActionRequest=>({...r,args:{status:'done'}});
 return {adapterId:BROWSER_CAP.adapterId,adapterVersion:BROWSER_CAP.adapterVersion,ops:[{capability:BROWSER_CAP,describe:()=>['One click on Complete in the inspected original task page.','Browser app session performs the write; API token independently verifies.','No OS cursor movement or autonomous multi-step browsing.'],prepare:(before,r)=>{const task=before.collections.tasks?.find(t=>t.objectId===r.target.objectId);return {base:update.prepare!(before,asUpdate(r)),title:task?.fields.title,priority:task?.fields.priority};},verify:(after,r,ctx)=>{const c=ctx as any;const task=after.collections.tasks?.find(t=>t.objectId===r.target.objectId);if(!c||c.title===undefined||c.priority===undefined||task?.fields.title!==c.title||task?.fields.priority!==c.priority)return {verified:false,observed:'Browser verification evidence missing or title/priority changed',afterRevision:task?.revision??null};return update.verify(after,asUpdate(r),c.base);}}],
 async readState(target){const s=await p.read(target);return {...s,availableCapabilityIds:[...s.availableCapabilityIds,BROWSER_CAP.id]};},
 async execute(req){
  if(p.syntheticTestDispatch!==true)return {dispatched:false,detail:"Browser writes disabled: the original page may hold stale task data and overwrite other fields. Use the API-backed controls."};
  const s=await p.session(String(req.args.session));
  try {assertBrowserSession(s,req,p.now());if(await p.stopped())throw Error('Stopped before browser click.');await p.checkPage(s!);await p.checkTask(s!);const before=await p.read(req.target);const task=inspectTask(before,req.target.objectId!);if(before.documentInstanceId!==req.target.documentInstanceId||task.revision!==req.expectedRevision)throw Error('Task changed; inspect again.');await p.checkPage(s!);if(await p.stopped())throw Error('Stopped before browser click.');}
  catch(e){return {dispatched:false,detail:String((e as Error).message)};}
  // Consume session durably BEFORE potentially effectful click. No retry after uncertainty.
  s!.used=true;await p.save(s!);
  if(p.now()>s!.expiresAt||p.now()>req.expiresAt||await p.stopped())return {dispatched:false,detail:"Stopped or expired before browser click."};
  await p.click(s!);
  // Bounded read-only settling, never another click. Broker also independently verifies.
  for(let i=0;i<8;i++){await new Promise(r=>setTimeout(r,150));const after=await p.read(req.target);if(after.collections.tasks?.find(t=>t.objectId===req.target.objectId)?.fields.status==='done')break;}
  return {dispatched:true};
 }};
}
