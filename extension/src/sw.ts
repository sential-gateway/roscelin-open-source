// MV3 service worker: hosts the action broker and all adapters. Ephemeral by design — durable state
// (journal, approvals, profile) lives in chrome.storage.local; app tokens live in chrome.storage.session
// (memory-only, cleared when the browser closes, not readable by content scripts). No keepalive loops.

import { Broker } from '../../packages/broker/src/broker.ts';
import type { KV, AdapterPort } from '../../packages/broker/src/broker.ts';
import * as fixture from '../../packages/adapters/src/reference-tasks/ops.ts';
import * as vikunja from '../../packages/adapters/src/vikunja/ops.ts';
import { BROWSER_CAP, browserControl, inspectTask, makeBrowserAdapter } from '../../packages/adapters/src/vikunja/browser.ts';
import type { BrowserSession } from '../../packages/adapters/src/vikunja/browser.ts';
import type { ObservedState, TargetIdentity, ActionRequest, AppDescriptor } from '../../packages/schemas/src/contracts.ts';
import { migrateProfile } from '../../packages/schemas/src/profile.ts';

declare const chrome: any;

const MAX_MSG_BYTES = 128 * 1024;
const APPS: AppDescriptor[] = [vikunja.APP, fixture.APP];
const appOf = (url: string | undefined): AppDescriptor | null => {
  if (!url) return null;
  try {
    const o = new URL(url).origin;
    return APPS.find((a) => a.origins.includes(o)) ?? null;
  } catch {
    return null;
  }
};

const kv: KV = {
  async get<T>(key: string) {
    return (await chrome.storage.local.get(key))[key] as T | undefined;
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.local.remove(key);
  },
};

// Session storage defaults to TRUSTED_CONTEXTS (extension pages + worker only). Set explicitly anyway.
chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch?.(() => {});
const tokenKey = (origin: string) => `token:${origin}`;
async function getToken(origin: string): Promise<string | null> {
  return ((await chrome.storage.session.get(tokenKey(origin)))[tokenKey(origin)] as string | undefined) ?? null;
}

async function granted(origin: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false);
}

async function appTabs(): Promise<any[]> {
  const origins: string[] = [];
  for (const a of APPS) for (const o of a.origins) if (await granted(o)) origins.push(`${o}/*`);
  if (!origins.length) return [];
  return chrome.tabs.query({ url: origins });
}

// ---------- reference fixture (dom-semantic via content script) ----------
async function readFixtureTab(tabId: number): Promise<ObservedState> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  const r = await chrome.tabs.sendMessage(tabId, { type: 'ai.read' });
  if (!r?.ok) throw new Error(r?.error ?? 'no response from page');
  return r.state as ObservedState;
}
async function resolveFixture(target: TargetIdentity): Promise<{ tabId: number; state: ObservedState }> {
  for (const t of await appTabs()) {
    if (appOf(t.url)?.appId !== fixture.APP_ID || !t.url.startsWith(target.origin + '/')) continue;
    try {
      const state = await readFixtureTab(t.id);
      if (state.documentInstanceId === target.documentInstanceId) return { tabId: t.id, state };
    } catch { /* next */ }
  }
  throw new Error('The target document is no longer open.');
}
const fixtureAdapter = fixture.makeAdapter({
  async readState(target) {
    return (await resolveFixture(target!)).state;
  },
  async execute(req: ActionRequest) {
    const { tabId } = await resolveFixture(req.target);
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ai.exec', request: req });
    return { dispatched: !!r?.dispatched, detail: r?.detail };
  },
});

// ---------- Vikunja (documented API, token auth, no site cookies) ----------
const vikunjaAdapter = vikunja.makeVikunjaAdapter(vikunja.makeFetchHttp(getToken));

const browserHttp = vikunja.makeFetchHttp(getToken);
const browserKey=(id:string)=>'browser-step:'+id;
async function browserStopped(){return !!(await chrome.storage.local.get('stopAll')).stopAll || !!(await getProfile()).perApp.vikunja?.paused;}
async function checkBrowserPage(s:BrowserSession){
 const [active]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
 if(active?.id!==s.tabId||active.url!==s.url||!(await granted(s.target.origin)))throw Error('The inspected task tab is no longer active. Inspect again.');
}
async function checkBrowserTask(s:BrowserSession){
 const raw=await browserHttp.call<vikunja.VTask>(s.target.origin,'GET','/tasks/'+s.target.objectId);
 if(raw.repeat_after||raw.repeat_mode)throw Error('Recurring tasks are not supported by browser steps.');
}
const browserAdapter=makeBrowserAdapter({
 read:t=>vikunjaAdapter.readState(t),
 session:async id=>(await chrome.storage.session.get(browserKey(id)))[browserKey(id)],
 save:async s=>chrome.storage.session.set({[browserKey(s.id)]:s}),
 checkPage:checkBrowserPage,checkTask:checkBrowserTask,stopped:browserStopped,now:()=>Date.now(),
 click:async s=>{
  await checkBrowserPage(s);if(await browserStopped())throw Error('Stopped before browser click.');
  const result=await chrome.scripting.executeScript({target:{tabId:s.tabId,documentIds:[s.documentId]},func:browserControl,args:['click',s.url,s.title]});
  if(result.length!==1||!result[0].result?.clicked)throw Error('Browser click outcome unknown.');
 }
});
async function inspectBrowserTask(){
 if(await browserStopped())throw Error('Apps are stopped. Resume before inspecting.');
 const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
 if(!tab||!vikunja.APP.origins.includes(new URL(tab.url).origin))throw Error('Activate a granted local Vikunja task tab first.');
 const url=new URL(tab.url);const match=/^\/tasks\/([1-9][0-9]*)$/.exec(url.pathname);
 if(!match||url.search||url.hash||!(await granted(url.origin)))throw Error('Open a task directly at /tasks/ID in the original app.');
 const id=match[1],projectId=await vikunjaAdapter.projectOfTask(url.origin,Number(id));
 const state=await vikunjaAdapter.readContext({origin:url.origin,projectId});const obj=inspectTask(state,id);
 const target={appId:'vikunja',origin:url.origin,documentInstanceId:state.documentInstanceId,objectId:id,display:{app:'Vikunja',document:state.documentTitle,object:String(obj.fields.title)}};
 const session:BrowserSession={id:crypto.randomUUID(),tabId:tab.id,documentId:'',url:tab.url,target,revision:obj.revision,title:String(obj.fields.title),expiresAt:Date.now()+60000,used:false};
 await checkBrowserTask(session);await checkBrowserPage(session);
 const results=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},func:browserControl,args:['inspect',tab.url,session.title]});
 if(results.length!==1||!results[0].documentId||!results[0].result?.ready)throw Error('Could not pin the task document.');
 session.documentId=results[0].documentId;
 await chrome.storage.session.set({[browserKey(session.id)]:session});
 const now=Date.now();return {ok:true,request:{actionId:crypto.randomUUID(),capabilityId:BROWSER_CAP.id,target,expectedRevision:obj.revision,args:{session:session.id},approvalToken:null,createdAt:now,expiresAt:session.expiresAt},label:session.title};
}
const adapters: AdapterPort[] = [fixtureAdapter, vikunjaAdapter,browserAdapter];

/** Read state for whatever granted app tab is current (active in the last-focused window, else most recent). */
async function readCurrent(): Promise<{ tabId: number; state: ObservedState }> {
  const tabs = await appTabs();
  if (!tabs.length) throw new Error('No open tab of a granted app.');
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const ordered = [...tabs].sort((a, b) => Number(b.id === focused?.id) - Number(a.id === focused?.id) || Number(b.active) - Number(a.active) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  let lastErr: unknown = null;
  for (const t of ordered) {
    const app = appOf(t.url);
    try {
      if (app?.appId === fixture.APP_ID) return { tabId: t.id, state: await readFixtureTab(t.id) };
      if (app?.appId === vikunja.APP_ID) {
        const p = vikunja.parseVikunjaUrl(t.url);
        if (!p) continue;
        let projectId = p.projectId;
        if (!projectId && p.taskId) projectId = await vikunjaAdapter.projectOfTask(p.origin, p.taskId);
        if (!projectId) {
          lastErr = new Error('Open a Vikunja project or task to adapt it.');
          continue;
        }
        return { tabId: t.id, state: await vikunjaAdapter.readContext({ origin: p.origin, projectId }) };
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('Could not read any app tab.');
}

async function getProfile() {
  return migrateProfile((await chrome.storage.local.get('profile')).profile);
}

const broker = new Broker({
  kv,
  adapters,
  async hasPermission(origin) {
    if (!APPS.some((a) => a.origins.includes(origin))) return false;
    return granted(origin);
  },
  async isPaused(appId) {
    const { stopAll } = await chrome.storage.local.get('stopAll');
    if (stopAll) return true;
    return !!(await getProfile()).perApp[appId]?.paused;
  },
  now: () => Date.now(),
  randomId: () => crypto.randomUUID(),
  executeTimeoutMs: 8000,
});

// Reconcile anything left executing when the worker was terminated. Never re-dispatches.
const reconciled = broker.reconcile().catch(() => []);

// Unresolved (executing/unknown) actions are re-checked read-only whenever the workspace reads state or the
// activity log, at most every 3 s. A write still in flight when a new worker booted (observed live: the boot
// reconcile ran while the old worker's PATCH was still on the wire) is therefore resolved once it lands.
let lastRecheck = 0;
async function recheckUnresolved() {
  if (Date.now() - lastRecheck < 3000) return;
  lastRecheck = Date.now();
  const pending = (await broker.listJournal()).some((e) => e.status === 'executing' || e.status === 'unknown');
  if (pending) await broker.reconcile().catch(() => []);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup?.addListener(() => {
  broker.reconcile().catch(() => {});
});
chrome.commands.onCommand.addListener(async (cmd: string) => {
  if (cmd === 'emergency-stop') await chrome.storage.local.set({ stopAll: true });
});

/**
 * Accept broker commands only from the extension's own workspace page (side panel, or the same page
 * opened in a full tab). Content scripts report the *web page* URL as sender.url, and sidepanel.html is
 * not web-accessible, so no site can frame it or impersonate this origin.
 */
function fromWorkspace(sender: any): boolean {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return false;
  if (sender.frameId !== undefined && sender.frameId !== 0) return false;
  const page = chrome.runtime.getURL('sidepanel.html');
  return sender.url === page || sender.url.startsWith(page + '?') || sender.url.startsWith(page + '#');
}

chrome.runtime.onMessage.addListener((msg: any, sender: any, sendResponse: (r: unknown) => void) => {
  if (!fromWorkspace(sender)) {
    sendResponse({ ok: false, error: 'unauthorized sender' });
    return false;
  }
  let size = 0;
  try {
    size = JSON.stringify(msg).length;
  } catch {
    size = Infinity;
  }
  if (size > MAX_MSG_BYTES || typeof msg?.type !== 'string') {
    sendResponse({ ok: false, error: 'invalid message' });
    return false;
  }
  (async () => {
    await reconciled;
    switch (msg.type) {
      case 'registry': {
        const caps = [...fixtureAdapter.ops.map((o) => o.capability), ...fixture.READ_CAPS, ...vikunja.OPS.map((o) => o.capability), ...vikunja.READ_CAPS];
        const apps = await Promise.all(APPS.map(async (a) => ({ ...a, granted: (await Promise.all(a.origins.map(granted))).some(Boolean), connected: a.needsToken ? !!(await getToken(a.origins[0])) : true })));
        return { ok: true, caps, apps };
      }
      case 'state.read': {
        await recheckUnresolved();
        const { tabId, state } = await readCurrent();
        const tab = await chrome.tabs.get(tabId);
        return { ok: true, state, tabTitle: tab.title };
      }
      case 'app.connect': {
        // Token arrives from the workspace page only; validated against the app before storing; never echoed back.
        const app = APPS.find((a) => a.appId === msg.appId);
        if (!app?.needsToken || typeof msg.token !== 'string' || msg.token.length < 8 || msg.token.length > 512) return { ok: false, error: 'invalid token' };
        const origin = app.origins[0];
        if (!(await granted(origin))) return { ok: false, error: `Grant access to ${origin} first.` };
        await chrome.storage.session.set({ [tokenKey(origin)]: msg.token.trim() });
        try {
          const id = await vikunjaAdapter.validateConnection(origin);
          return { ok: true, accountId: id, note: 'Read access verified. Write permissions (tasks: create, update) are checked by Vikunja on the first change.' };
        } catch (e) {
          await chrome.storage.session.remove(tokenKey(origin));
          return { ok: false, error: `Token rejected: ${String((e as Error).message).slice(0, 160)}` };
        }
      }
      case 'app.disconnect': {
        const app = APPS.find((a) => a.appId === msg.appId);
        if (app) for (const o of app.origins) await chrome.storage.session.remove(tokenKey(o));
        return { ok: true };
      }
      case 'browser.inspect':
        return await inspectBrowserTask();
      case 'profile.reset':
        await broker.resetProfile(APPS.map((app) => app.appId));
        return { ok: true };
      case 'broker.preview':
        return { ok: true, preview: await broker.preview(msg.request) };
      case 'broker.approve':
        return { ok: true, approval: await broker.issueApproval(msg.request) };
      case 'broker.execute':
        return { ok: true, result: await broker.execute(msg.request) };
      case 'broker.journal':
        lastRecheck = 0; // an explicit look at the activity log always re-checks
        await recheckUnresolved();
        return { ok: true, journal: await broker.listJournal() };
      case 'broker.reconcile':
        return { ok: true, changed: await broker.reconcile() };
      case 'broker.dismiss':
        return { ok: true, dismissed: await broker.dismiss(String(msg.actionId)) };
      case 'origin.open': {
        // Deep links must stay on a granted app origin; otherwise focus the current app tab.
        const link = typeof msg.link === 'string' ? msg.link : null;
        const linkApp = link ? appOf(link) : null;
        if (link && linkApp && (await granted(new URL(link).origin))) {
          const { tabId } = await readCurrent();
          const tab = await chrome.tabs.update(tabId, { url: link, active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
          return { ok: true };
        }
        const { tabId } = await readCurrent();
        const tab = await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true };
      }
      default:
        return { ok: false, error: 'unknown message type' };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true;
});
