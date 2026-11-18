import {spawnSync} from 'node:child_process';
// Isolated headless accessibility checks. No real accounts, microphone, model or gateway.
import {launchChrome,checker} from './lib/cdp.mjs';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {FakeApp} from '../tests/helpers.ts';
import {CAPS} from '../packages/adapters/src/reference-tasks/ops.ts';
const OUT=resolve('outputs/accessibility-20261118'),EXT=resolve('dist/extension-accessibility-check');
await mkdir(OUT,{recursive:true});
// Build to an isolated, checked directory. Never replace another builder's extension output.
const root=process.cwd();if(!EXT.startsWith(root+sep))throw Error('Build target outside repo');
await mkdir('.local',{recursive:true});
const build=(await readFile('scripts/build.mjs','utf8')).replace("const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));",'const ROOT = '+JSON.stringify(root)+';').replace("const OUT = join(ROOT, 'dist', E2E ? 'extension-e2e' : 'extension');",'const OUT = '+JSON.stringify(EXT)+';');
if(!build.includes('const OUT = '+JSON.stringify(EXT)))throw Error('Build output override failed');
await writeFile('.local/accessibility-build.mjs',build);
const built=spawnSync(process.execPath,['.local/accessibility-build.mjs'],{stdio:'inherit',windowsHide:true});if(built.status!==0)throw Error('Isolated build failed');
await writeFile(join(EXT,'accessibility-test.html'),'<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="sidepanel.css"></head><body><div id="surface"></div><div id="preview"></div></body></html>');
const browser=await launchChrome();const {check,assert,results}=checker();
try{
 const {id}=await browser.cdp('Extensions.loadUnpacked',{path:EXT});
 const page=await browser.open(`chrome-extension://${id}/sidepanel.html`);const s=page.sessionId;
 await browser.waitFor(s,"document.getElementById('tab-workspace')?.onclick",'panel');
 const ev=expr=>browser.evaluate(s,expr);
 const key=async k=>{await browser.cdp('Input.dispatchKeyEvent',{type:'keyDown',key:k},s);await browser.cdp('Input.dispatchKeyEvent',{type:'keyUp',key:k},s);};
 await check('real key events navigate tabs with one tab stop',async()=>{await ev("document.getElementById('tab-workspace').focus()");await key('ArrowRight');assert(await ev("document.activeElement.id==='tab-settings' && !document.getElementById('panel-settings').hidden && document.querySelectorAll('[role=tab][tabindex=\"0\"]').length===1"),'settings selected');await key('End');assert(await ev("document.activeElement.id==='tab-activity'"),'End');await key('Home');});
 await check('read-aloud remains explicit and empty workspace stays silent',async()=>{assert(await ev("document.getElementById('read-status').textContent===''"),'not auto started');await ev("document.getElementById('read-aloud').click()");assert(await ev("/No local|no workspace/i.test(document.getElementById('read-status').textContent)"),'refused safely');});
 await check('320px shell at 2x text does not overflow horizontally',async()=>{await browser.cdp('Emulation.setDeviceMetricsOverride',{width:320,height:800,deviceScaleFactor:1,mobile:false},s);await ev("document.documentElement.style.setProperty('--scale','2');document.getElementById('tab-settings').click()");assert(await ev('document.documentElement.scrollWidth<=320'),'no shell overflow: '+JSON.stringify(await ev(`[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>321).map(e=>({tag:e.tagName,id:e.id,width:e.getBoundingClientRect().width})).slice(0,10)`)));});
 const test=await browser.open(`chrome-extension://${id}/accessibility-test.html`);const t=test.sessionId;const run=x=>browser.evaluate(t,x);
 // Wait for the test page itself: evaluating before it loads resolves the module path against about:blank.
 await browser.waitFor(t,"location.pathname.endsWith('/accessibility-test.html') && document.readyState==='complete'",'accessibility test page');
 const data={state:new FakeApp().state(),caps:Object.values(CAPS)};
 await run(`(async()=>{window.data=${JSON.stringify(data)};window.mod=await import('./packages/renderer/src/render.js');window.profile={density:'comfortable',contrast:'standard',textScale:1,reducedMotion:false,vocabulary:'plain',pinnedControls:[]};window.ui={selectedId:'t1',filters:{},draft:null,draftForId:null,draftRevision:null,createDraft:{}};window.ctx={state:data.state,profile,ui,caps:new Map(data.caps.map(c=>[c.id,c])),busy:false,on:{select:id=>{ui.selectedId=id;draw()},setFilter:(field,value)=>{ui.filters[field]=value;draw()},draftChange:()=>{},createChange:()=>{},save:()=>{},create:()=>{},openOriginal:()=>{},togglePin:()=>{},rerender:()=>draw()}};window.surface={root:{component:'stack',children:[{component:'provenance'},{component:'filter',props:{field:'status',options:['all','todo','doing']}},{component:'list',bind:'tasks',props:{fields:['title']}},{component:'edit-form',bind:'tasks',capabilityId:data.caps.find(c=>c.id.endsWith('task.update')).id,props:{fields:['title','status']}},{component:'create-form',capabilityId:data.caps.find(c=>c.id.endsWith('task.create')).id,props:{fields:['title']}}]}};window.draw=()=>mod.renderSurface(document.getElementById('surface'),surface,ctx);draw();mod.renderSurface(document.getElementById('preview'),surface,ctx);})()`);
 const tk=async k=>{await browser.cdp('Input.dispatchKeyEvent',{type:'keyDown',key:k},t);await browser.cdp('Input.dispatchKeyEvent',{type:'keyUp',key:k},t);};
 await check('preview and active forms have unique, correctly bound labels',async()=>{assert(await run("(()=>{const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);return new Set(ids).size===ids.length&&[...document.querySelectorAll('label')].every(l=>l.control&&l.parentElement===l.control.parentElement)})()"),'unique/bound labels');});
 await check('filter arrow key changes selection and preserves focus on redraw',async()=>{await run("document.querySelector('#surface [role=radio]').focus()");await tk('ArrowRight');assert(await run("ui.filters.status==='todo'&&document.activeElement.textContent==='todo'&&document.activeElement.getAttribute('aria-checked')==='true'"),'radio changed');});
 await check('filtered-out selection retains a keyboard entry point',async()=>{await run("ctx.ui.selectedId='t2';draw()");assert(await run("document.querySelector('#surface [role=option]').tabIndex===0"),'list reachable');});
 await check('background redraw retains focused field and caret',async()=>{await run("ui.filters.status='all';ui.selectedId='t1';draw();const input=document.querySelector('#surface input');input.focus();input.setSelectionRange(2,2);draw()");assert(await run("document.activeElement.tagName==='INPUT'&&document.activeElement.selectionStart===2"),'focus/caret');});
 await check('provenance no longer repeats as a live region',async()=>{assert(await run("document.querySelector('#surface .ai-provenance').getAttribute('role')==='note'&&!document.querySelector('#surface .ai-provenance').hasAttribute('aria-live')"),'static note');});
 await check('renderer fits 320px at 2x text',async()=>{await browser.cdp('Emulation.setDeviceMetricsOverride',{width:320,height:800,deviceScaleFactor:1,mobile:false},t);await run("document.documentElement.style.setProperty('--scale','2')");assert(await run('document.documentElement.scrollWidth<=320'),'no renderer overflow');});
}finally{await writeFile(join(OUT,'report.json'),JSON.stringify({scope:'Isolated headless extension page and trusted renderer; not physical screen reader or microphone',results},null,2));await browser.close();}
if(results.some(r=>!r.pass))process.exitCode=1;
