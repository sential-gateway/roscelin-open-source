import {test} from 'node:test';
import assert from 'node:assert/strict';
import {navigationIndex,LocalReadAloud} from '../extension/src/accessibility.ts';
test('tab/radio navigation wraps and supports Home/End',()=>{assert.equal(navigationIndex('ArrowRight',2,3),0);assert.equal(navigationIndex('ArrowLeft',0,3),2);assert.equal(navigationIndex('Home',2,3),0);assert.equal(navigationIndex('End',0,3),2);assert.equal(navigationIndex('Tab',0,3),null);assert.equal(navigationIndex('Home',0,0),null);});
function setup(voices:any[]){let spoken:any=null,status='';let cancels=0;const r=new LocalReadAloud({synthesis:{getVoices:()=>voices,cancel:()=>cancels++,speak:(u:any)=>spoken=u},Utterance:class{text:string;constructor(text:string){this.text=text;}},status:s=>status=s});return {r,get spoken(){return spoken;},get status(){return status;},get cancels(){return cancels;}};}
test('read aloud refuses cloud-only or unknown voices',()=>{for(const voices of [[],[{lang:'en-US',localService:false}],[{lang:'en-US'}],[{lang:'de-DE',localService:true}]]){const x=setup(voices);x.r.read('hello');assert.equal(x.spoken,null);assert.match(x.status,/No local/);}});
test('speech is opt-in, local, bounded and cancellable; late events ignored',()=>{const voice={lang:'en-US',localService:true};const x=setup([voice]);assert.equal(x.spoken,null);x.r.read('a'.repeat(13000));assert.equal(x.spoken.text.length,12000);assert.equal(x.spoken.voice,voice);const done=x.spoken.onend;x.r.stop();done();assert.equal(x.status,'Read aloud stopped.');assert.equal(x.cancels,2);});
test('empty workspace never starts speech',()=>{const x=setup([{lang:'en-US',localService:true}]);x.r.read('  ');assert.equal(x.spoken,null);});

test('stop is silent when nothing is being read (Escape, tab switch, page hide), and announces only a real stop',()=>{
  const x=setup([{lang:'en-US',localService:true}]);
  x.r.stop();assert.equal(x.status,'','idle stop must not announce');
  x.r.read('hello');assert.match(x.status,/Reading workspace aloud/);
  x.spoken.onend();assert.equal(x.status,'Read aloud finished.');
  x.r.stop();assert.equal(x.status,'Read aloud finished.','stop after speech ended stays silent');
  x.r.read('again');x.r.stop();assert.equal(x.status,'Read aloud stopped.');
});
