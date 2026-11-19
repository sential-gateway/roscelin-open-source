import { TaskMap } from './task-map.ts';
import { navigationIndex, LocalReadAloud } from './accessibility.ts';
import { Dictation } from './dictation.ts';
// Extension-owned workspace. Generates/accepts layouts, renders them with the trusted renderer,
// and routes every action through the service-worker broker with an in-panel review step.

import type { Capability, ObservedState, ActionRequest, ActionResult, AppDescriptor } from '../../packages/schemas/src/contracts.ts';
import type { UISurface } from '../../packages/schemas/src/ui-schema.ts';
import { validateSurface, stateFields } from '../../packages/schemas/src/validate.ts';
import { defaultProfile, migrateProfile, exportProfile } from '../../packages/schemas/src/profile.ts';
import type { Profile } from '../../packages/schemas/src/profile.ts';
import { planSurface } from '../../packages/planner/src/planner.ts';
import { refineSurface } from '../../packages/planner/src/refine.ts';
import type { PlannerContext } from '../../packages/planner/src/planner.ts';
import { gatewayClient, getAiConfig, setAiEnabled, pair, forgetPairing } from './ai-gateway.ts';
import { renderSurface, outline } from '../../packages/renderer/src/render.ts';
import type { UIState } from '../../packages/renderer/src/render.ts';

declare const chrome: any;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (msg: unknown): Promise<any> => chrome.runtime.sendMessage(msg);

let caps: Capability[] = [];
let capMap = new Map<string, Capability>();
let apps: (AppDescriptor & { granted: boolean; connected: boolean })[] = [];
let lastAppId = 'reference-tasks';
const appCaps = () => caps.filter((c) => c.appId === state?.appId);
const currentApp = () => state?.appId ?? lastAppId;
let profile: Profile = defaultProfile();
let state: ObservedState | null = null;
let surface: UISurface | null = null;
let proposal: UISurface | null = null;
let proposing: AbortController | null = null; // the AI request in progress, if any
/** Versions of the current proposal (newest last): the original and each refinement. */
interface ProposalVersion { surface: UISurface; source: string; sent: PlannerContext | null; changes: string }
let versions: ProposalVersion[] = [];
let versionIdx = -1;
let proposalIntent = '';
const MAX_VERSIONS = 8;
const AI_TIMEOUT_MS = 12000; // real-model layouts measured at 4.5-7.1 s in Phase A
const layoutHistory: UISurface[] = [];
let busy = false;
const ui: UIState = { selectedId: null, filters: {}, draft: null, draftForId: null, draftRevision: null, createDraft: {} };

function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  clearTimeout((toast as any).h);
  (toast as any).h = setTimeout(() => (t.textContent = ''), 6000);
}

function applyProfile() {
  const r = document.documentElement;
  r.dataset.density = profile.density;
  r.dataset.contrast = profile.contrast;
  r.dataset.reducedMotion = String(profile.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches);
  r.style.setProperty('--scale', String(profile.textScale));
}

async function saveProfile() {
  await chrome.storage.local.set({ profile });
  applyProfile();
  draw();
}

function newId() {
  return crypto.randomUUID();
}

function target(objectId: string | null) {
  if (!state) throw new Error('no state');
  const obj = objectId ? state.collections.tasks?.find((t) => t.objectId === objectId) : null;
  return {
    appId: state.appId,
    origin: state.origin,
    documentInstanceId: state.documentInstanceId,
    objectId,
    display: { app: state.appName, document: state.documentTitle, object: obj ? String(obj.fields.title) : undefined },
  };
}

function buildRequest(capabilityId: string, objectId: string | null, args: Record<string, string>, expectedRevision: number): ActionRequest {
  const now = Date.now();
  return { actionId: newId(), capabilityId, target: target(objectId), expectedRevision, args, approvalToken: null, createdAt: now, expiresAt: now + 120_000 };
}

// ---------- review & execution (extension-owned) ----------
/** Put keyboard focus back where the person was in the workspace, after it was redrawn (WCAG 2.4.3). */
function restoreWorkspaceFocus(key: string | null) {
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected && !(active as HTMLButtonElement).disabled) return;
  const container = $('surface');
  const same = key ? container.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) : null;
  const target = same && !(same as HTMLButtonElement).disabled ? same : container.querySelector<HTMLElement>('[data-autofocus]') ?? container;
  target.focus({ preventScroll: false });
}

async function review(req: ActionRequest) {
  // The trigger is redrawn (and disabled while busy), so remember it by its stable key to return focus afterwards.
  const opener = document.activeElement as HTMLElement | null;
  const returnKey = opener && $('surface').contains(opener) ? opener.getAttribute('data-key') : null;
  busy = true;
  draw();
  try {
    const pr = await send({ type: 'broker.preview', request: req });
    const p = pr?.preview;
    if (!pr?.ok || !p?.ok) {
      toast(`Not possible: ${p?.message ?? pr?.error ?? 'unknown error'}`);
      await refresh();
      return;
    }
    const dlg = $<HTMLDialogElement>('review');
    $('review-title').textContent = p.message;
    $('review-target').textContent = `${p.display.object ? `“${p.display.object}” in ` : ''}${p.display.document}, ${p.display.app} (${new URL(req.target.origin).host})`;
    $('review-lines').replaceChildren(...p.lines.map((l: string) => Object.assign(document.createElement('li'), { textContent: l })));
    $('review-risk').textContent = p.requiresApproval
      ? `Needs your approval. ${p.capability.reversible ? 'You can change it back in the original app.' : 'Roscelin can\'t undo this; you would remove it in the original app.'}`
      : `Low risk. You can change it back in the original app.`;
    const confirm = $('review-confirm');
    confirm.textContent = p.requiresApproval ? 'Approve and apply' : 'Apply change';
    const choice = await new Promise<boolean>((resolve) => {
      const done = (v: boolean) => {
        confirm.onclick = null;
        $('review-cancel').onclick = null;
        dlg.onclose = null;
        if (dlg.open) dlg.close();
        resolve(v);
      };
      confirm.onclick = () => done(true);
      $('review-cancel').onclick = () => done(false);
      dlg.onclose = () => done(false);
      dlg.showModal();
      confirm.focus();
    });
    if (!choice) {
      toast('Cancelled. Nothing changed.');
      return;
    }
    if (p.requiresApproval) {
      const ar = await send({ type: 'broker.approve', request: req });
      if (!ar?.approval?.ok) {
        toast(`Approval refused: ${ar?.approval?.message ?? ar?.error}`);
        return;
      }
      req.approvalToken = ar.approval.token;
    }
    toast('Applying…');
    let er: any;
    try {
      er = await send({ type: 'broker.execute', request: req });
    } catch {
      // The extension's background worker went away mid-action (Chrome can stop it at any time). The action was
      // journaled before dispatch; ask a fresh worker to re-check it read-only and report the real outcome.
      toast('Lost contact with the extension during this change. Checking whether it was applied…');
      er = null;
      let last: any = null;
      // Keep re-checking (read-only) while the outcome is unresolved: the write may still be on the wire.
      for (let i = 0; i < 12 && !er; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const j = await send({ type: 'broker.journal' }).catch(() => null);
        const e = j?.journal?.find((x: any) => x.request.actionId === req.actionId);
        if (e?.result) last = { result: e.result };
        if (e && (e.status === 'verified' || e.status === 'failed' || e.status === 'cancelled')) er = { result: e.result };
      }
      if (!er) er = last ?? { result: { status: 'unknown', message: 'Outcome not confirmed yet. It will not be retried automatically; see Activity.', observedPostcondition: null } };
    }
    const res: ActionResult | undefined = er?.result;
    if (!res) toast(`Error: ${er?.error ?? 'no result'}`);
    else if (res.status === 'verified') {
      toast(`✓ ${res.message} (${res.observedPostcondition})`);
      if (req.target.objectId) ui.verifiedId = req.target.objectId;
      ui.draft = null;
      ui.draftForId = null;
      ui.draftRevision = null;
      if (req.capabilityId.endsWith('task.create')) ui.createDraft = {};
    } else if (res.status === 'unknown') toast(`? ${res.message}`);
    else toast(`✗ ${res.message}`);
    return res;
  } finally {
    busy = false;
    await refresh();
    restoreWorkspaceFocus(returnKey);
  }
}

// The sticky header's height changes with text size and wrapping; scroll padding follows it (see sidepanel.css).
{
  const head = document.querySelector<HTMLElement>('.shell-head');
  if (head) new ResizeObserver(() => document.documentElement.style.setProperty('--sticky-head', `${Math.ceil(head.getBoundingClientRect().height) + 8}px`)).observe(head);
}

// ---------- rendering ----------
const taskMap=new TaskMap($('task-map'),id=>{const obj=state?.collections.tasks?.find(t=>t.objectId===id);if(!obj)return;ui.selectedId=id;ui.draft=Object.fromEntries(Object.entries(obj.fields).map(([k,v])=>[k,String(v)]));ui.draftForId=id;ui.draftRevision=obj.revision;draw();});
function draw() {
  taskMap.update(state);
  const container = $('surface');
  $('surface-bar').hidden = !surface;
  if (!surface || !state) {
    container.replaceChildren();
    return;
  }
  $('surface-name').textContent = surface.title;
  $('surface-kind').textContent = surface.generatedBy === 'model' ? 'AI layout' : surface.generatedBy === 'user-saved' ? 'Saved layout' : 'Standard layout';
  $('undo-layout').hidden = layoutHistory.length === 0;
  renderSurface(container, surface, {
    state,
    profile,
    ui,
    caps: capMap,
    busy,
    on: {
      select(id) {
        const obj = state!.collections.tasks?.find((t) => t.objectId === id);
        ui.selectedId = id;
        ui.draft = obj ? Object.fromEntries(Object.entries(obj.fields).map(([k, v]) => [k, String(v)])) : null;
        ui.draftForId = id;
        ui.draftRevision = obj?.revision ?? null;
        draw();
      },
      toggleCompare(id) {
        const ids = ui.compareIds ?? [];
        ui.compareIds = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id].slice(-2);
        draw();
      },
      setFilter(f, v) {
        ui.filters[f] = v;
        draw();
      },
      draftChange(f, v) {
        if (ui.draft) ui.draft[f] = v;
      },
      createChange(f, v) {
        ui.createDraft[f] = v;
      },
      save(capId, objectId, args, rev) {
        review(buildRequest(capId, objectId, args, rev));
      },
      async create(capId, args) {
        // A create does not depend on other items' content: re-read first so an unrelated change in the
        // app since the last poll is not mistaken for a conflict. The broker still checks the revision.
        await refresh();
        if (state) review(buildRequest(capId, null, args, state.workspaceRevision));
      },
      async openOriginal(link?: string) {
        const r = await send({ type: 'origin.open', link });
        if (!r?.ok) toast(r?.error ?? 'Could not open the original app');
      },
      async togglePin(key) {
        const i = profile.pinnedControls.indexOf(key);
        if (i >= 0) profile.pinnedControls.splice(i, 1);
        else profile.pinnedControls.push(key);
        await saveProfile();
      },
      rerender: draw,
    },
  });
}

async function loadRegistry() {
  const reg = await send({ type: 'registry' });
  caps = reg.caps;
  apps = reg.apps;
  capMap = new Map(caps.map((c) => [c.id, c]));
}

function drawAccess() {
  const anyGranted = apps.some((a) => a.granted);
  // Keep the chooser visible until at least one app is granted; afterwards it lives under Profile.
  $('access').hidden = anyGranted;
  const list = $('grant-list');
  list.replaceChildren(
    ...apps.map((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = a.granted ? '' : 'primary';
      b.disabled = a.granted;
      b.textContent = a.granted ? `${a.name}: access granted` : `Grant access to ${a.name} (${new URL(a.origins[0]).host})${a.kind === 'controlled-fixture' ? ', test app' : ''}`;
      b.addEventListener('click', async () => {
        // Specific origin only, requested in response to this click.
        const ok = await chrome.permissions.request({ origins: [`${a.origins[0]}/*`] });
        toast(ok ? `Access granted to ${new URL(a.origins[0]).host}.` : 'Access not granted.');
        await loadRegistry();
        await refresh();
      });
      return b;
    }),
  );
  const vik = apps.find((a) => a.needsToken);
  $('connect').hidden = !(vik && vik.granted && !vik.connected);
  $('disconnect').hidden = !(vik && vik.connected);
}

// ---------- state refresh (data updates never reorganize the accepted layout) ----------
async function refresh() {
  // Re-read grants/connection each time so the panel never shows a stale "connect" or "grant" state.
  await loadRegistry().catch(() => {});
  drawAccess();
  if (!apps.some((a) => a.granted)) {
    $('noapp').hidden = true;
    $('intent-form').hidden = true;
    state = null;
    draw();
    return;
  }
  if (profile.perApp[currentApp()]?.paused) {
    $('noapp').hidden = true;
    $('intent-form').hidden = true;
    $('docchange').hidden = false;
    $('docchange').textContent = 'This app is paused in your profile. Nothing is read or changed. Unpause it under Profile.';
    state = null;
    draw();
    return;
  }
  const r = await send({ type: 'state.read' }).catch((e: Error) => ({ ok: false, error: e.message }));
  if (!r?.ok) {
    $('noapp').hidden = false;
    $('noapp-text').textContent = r?.error && !/No open tab/.test(r.error) ? r.error : 'Open a granted app in a tab (for example a Vikunja project), then press Refresh.';
    $('intent-form').hidden = true;
    state = null;
    draw();
    return;
  }
  $('noapp').hidden = true;
  $('intent-form').hidden = false;
  const prev = state;
  state = r.state as ObservedState;
  lastAppId = state.appId;
  const switched = !!prev && (prev.appId !== state.appId || prev.documentInstanceId !== state.documentInstanceId);
  if (switched) {
    $('docchange').hidden = false;
    $('docchange').textContent =
      prev!.appId !== state.appId
        ? `Now adapting ${state.appName}. Selection and drafts were cleared.`
        : 'The open document changed (reloaded, another project, or another tab). Selection and drafts were cleared; controls now target the new document.';
    ui.selectedId = null;
    ui.draft = null;
    ui.draftForId = null;
    ui.draftRevision = null;
    ui.createDraft = {};
    ui.filters = {};
    if (prev!.appId !== state.appId) {
      surface = null;
      layoutHistory.length = 0;
    }
  } else if (!prev) $('docchange').hidden = true;
  if (!surface) {
    const restored = await restoreLast();
    if (!restored) await propose(profile.keyboardFirst ? 'compact keyboard' : 'show the document and its tasks together', true);
  }
  // Don't rebuild while the user is typing in a field of the surface; the next tick will catch up.
  const a = document.activeElement;
  if (a && $('surface').contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT') && !busy) return;
  draw();
}

function setProposing(on: boolean, startedAt = 0) {
  $('proposal-busy').hidden = !on;
  ($('intent-form').querySelector('button[type="submit"]') as HTMLButtonElement).disabled = on;
  document.querySelectorAll<HTMLButtonElement>('.chips button').forEach((b) => (b.disabled = on));
  if (on) {
    const tick = () => { if (!proposing) return; $('proposal-busy-text').textContent = `Designing a layout… ${Math.round((Date.now() - startedAt) / 1000)} s`; setTimeout(tick, 500); };
    tick();
  }
}

function clearProposal() {
  proposal = null;
  versions = [];
  versionIdx = -1;
  $('proposal').hidden = true;
  $('proposal-preview').replaceChildren();
  $('proposal-changes').textContent = '';
}

/** Ask the planner (AI when on and paired, otherwise rule-based) for a layout. */
async function plan(intent: string, allowAi: boolean) {
  let sent: PlannerContext | null = null;
  const gateway = allowAi ? await gatewayClient((ctx) => { sent = ctx; }) : null;
  const ctl = new AbortController();
  if (gateway) { proposing = ctl; setProposing(true, Date.now()); }
  try {
    const result = await planSurface(intent, profile, caps, state!, gateway, AI_TIMEOUT_MS, ctl.signal);
    const source = result.source === 'model'
      ? 'AI suggestion, checked by Roscelin'
      : gateway ? `Standard layout. AI wasn't used: ${result.notes.join(' ').replace(/^Model (unavailable|output rejected): ?/, '').slice(0, 300)}` : 'Standard layout';
    return { result, source, sent: sent as PlannerContext | null, aborted: ctl.signal.aborted };
  } finally {
    if (gateway) { proposing = null; setProposing(false); }
  }
}

/** Show the current version of the proposal: title, source, what changed, read-only preview, history controls. */
function showProposal() {
  const v = versions[versionIdx];
  if (!v || !state) return;
  proposal = v.surface;
  $('proposal').hidden = false;
  $('proposal-title').textContent = `Proposed: ${proposal.title}`;
  $('proposal-why').textContent = proposal.rationale;
  $('proposal-source').textContent = v.source;
  $('proposal-changes').textContent = v.changes;
  $('proposal-sent').hidden = !v.sent;
  $('proposal-sent-body').textContent = v.sent ? JSON.stringify(v.sent, null, 2) : '';
  $('proposal-outline').textContent = outline(proposal).join('\n');
  $('proposal-history').hidden = versions.length < 2;
  $('proposal-version').textContent = `Version ${versionIdx + 1} of ${versions.length}`;
  const back = $('proposal-back') as HTMLButtonElement;
  const forward = $('proposal-forward') as HTMLButtonElement;
  const hadFocus = document.activeElement;
  back.disabled = versionIdx === 0;
  forward.disabled = versionIdx === versions.length - 1;
  // A button that becomes disabled loses keyboard focus; keep focus in the version controls instead of dropping it.
  if (hadFocus === back && back.disabled && !forward.disabled) forward.focus();
  if (hadFocus === forward && forward.disabled && !back.disabled) back.focus();
  // Read-only preview: rendered with no-op handlers inside an inert container (no focus, no clicks, no writes).
  const noop = () => {};
  renderSurface($('proposal-preview'), proposal, {
    state, profile, caps: capMap, busy: true,
    ui: { selectedId: null, filters: {}, draft: null, draftForId: null, draftRevision: null, createDraft: {} },
    on: { select: noop, setFilter: noop, draftChange: noop, createChange: noop, save: noop, create: noop, openOriginal: noop, togglePin: noop, rerender: noop },
  } as Parameters<typeof renderSurface>[2]);
}

function addVersion(v: ProposalVersion) {
  versions = versions.slice(0, versionIdx + 1);
  versions.push(v);
  if (versions.length > MAX_VERSIONS) versions.shift();
  versionIdx = versions.length - 1;
  showProposal();
}

/** Refine the current proposal: known requests edit it directly (validated); anything else re-proposes. */
async function refine(request: string) {
  if (!proposal || !state || proposing || !request.trim()) return;
  const r = refineSurface(proposal, request, appCaps(), state);
  if (r) {
    const v = validateSurface(r.surface, appCaps(), stateFields(state));
    if (!v.ok) { $('proposal-changes').textContent = `Couldn't apply that: ${v.errors[0]}. The previous version is kept.`; return; }
    const note = `${r.changes.join('. ')}.${r.notUnderstood.length ? ` Not understood: “${r.notUnderstood.join('”, “')}”.` : ''}`;
    addVersion({ surface: v.value!, source: versions[versionIdx].source, sent: null, changes: note });
    return;
  }
  // Not a known edit: propose again for the original request plus the refinement.
  const combined = `${proposalIntent}. ${request}`.slice(0, 480);
  const { result, source, sent, aborted } = await plan(combined, true);
  if (aborted) { $('proposal-changes').textContent = 'Refinement cancelled. The current version is kept.'; return; }
  addVersion({ surface: result.surface, source, sent, changes: `Proposed again for “${request.trim()}”.` });
}

async function propose(intent: string, autoAccept = false) {
  if (!state || proposing) return;
  const proposalTrigger = document.activeElement;
  // AI layouts only on an explicit request (never for the automatic first layout), and only when switched on
  // and paired. The planner validates whatever comes back and falls back to the rule-based layout.
  if (!autoAccept) clearProposal();
  const { result, source, sent, aborted } = await plan(intent, !autoAccept);
  if (aborted) { toast('Layout request cancelled. Your current layout is unchanged.'); return; }
  if (autoAccept) {
    surface = result.surface;
    await chrome.storage.local.set({ [`lastSurface:${state.appId}`]: surface });
    draw();
    return;
  }
  proposalIntent = intent;
  versions = [{ surface: result.surface, source, sent, changes: '' }];
  versionIdx = 0;
  showProposal();
  if (document.activeElement === proposalTrigger) $('accept').focus();
}

async function restoreLast(): Promise<boolean> {
  if (!state) return false;
  const key = `lastSurface:${state.appId}`;
  const lastSurface = (await chrome.storage.local.get(key))[key];
  if (!lastSurface) return false;
  const v = validateSurface(lastSurface, appCaps(), stateFields(state));
  if (!v.ok || v.value!.bindings.adapterVersion !== appCaps()[0]?.adapterVersion) return false;
  surface = v.value!;
  return true;
}

// ---------- settings ----------
function fillSettings() {
  const f = $<HTMLFormElement>('settings');
  (f.querySelector(`[name=density][value=${profile.density}]`) as HTMLInputElement).checked = true;
  (f.querySelector(`[name=contrast][value=${profile.contrast}]`) as HTMLInputElement).checked = true;
  (f.querySelector(`[name=vocabulary][value=${profile.vocabulary}]`) as HTMLInputElement).checked = true;
  ($('textScale') as HTMLInputElement).value = String(profile.textScale);
  $('textScaleOut').textContent = `${Math.round(profile.textScale * 100)}%`;
  (f.elements.namedItem('reducedMotion') as HTMLInputElement).checked = profile.reducedMotion;
  (f.elements.namedItem('keyboardFirst') as HTMLInputElement).checked = profile.keyboardFirst;
  (f.elements.namedItem('pauseApp') as HTMLInputElement).checked = !!profile.perApp[currentApp()]?.paused;
  $('pause-app-name').textContent = apps.find((a) => a.appId === currentApp())?.name ?? 'this app';
  const saved = profile.savedWorkspaces[currentApp()] ?? {};
  $('saved').replaceChildren(
    ...(Object.keys(saved).length
      ? Object.keys(saved).map((name) => {
          const li = document.createElement('li');
          const load = Object.assign(document.createElement('button'), { type: 'button', textContent: `Use “${name}”` });
          load.onclick = () => {
            if (!state) return;
            const v = validateSurface(saved[name], appCaps(), stateFields(state));
            if (!v.ok) return toast(`Saved layout no longer matches this app version: ${v.errors[0]}`);
            if (surface) layoutHistory.push(surface);
            surface = { ...v.value!, generatedBy: 'user-saved' };
            chrome.storage.local.set({ [`lastSurface:${state.appId}`]: surface });
            selectTab('workspace');
            draw();
          };
          const del = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Remove' });
          del.onclick = async () => {
            delete saved[name];
            await saveProfile();
            fillSettings();
          };
          li.append(load, del);
          return li;
        })
      : [Object.assign(document.createElement('li'), { className: 'ai-empty', textContent: 'None yet. Use “Save layout” on the workspace.' })]),
  );
}

$('settings').addEventListener('change', async (e) => {
  const t = e.target as HTMLInputElement;
  if (t.name === 'density') profile.density = t.value as Profile['density'];
  if (t.name === 'contrast') profile.contrast = t.value as Profile['contrast'];
  if (t.name === 'vocabulary') profile.vocabulary = t.value as Profile['vocabulary'];
  if (t.name === 'reducedMotion') profile.reducedMotion = t.checked;
  if (t.name === 'keyboardFirst') profile.keyboardFirst = t.checked;
  if (t.name === 'pauseApp') profile.perApp[currentApp()] = { ...profile.perApp[currentApp()], paused: t.checked };
  await saveProfile();
  if (t.name === 'pauseApp') await refresh();
});
$('textScale').addEventListener('input', async (e) => {
  profile.textScale = Number((e.target as HTMLInputElement).value);
  $('textScaleOut').textContent = `${Math.round(profile.textScale * 100)}%`;
  await saveProfile();
});
$('export').addEventListener('click', () => {
  const blob = new Blob([exportProfile(profile)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'adaptive-interface-profile.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('import').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file || file.size > 256 * 1024) return toast('Profile file missing or too large.');
  try {
    profile = migrateProfile(JSON.parse(await file.text()));
    await saveProfile();
    fillSettings();
    toast('Profile imported.');
  } catch {
    toast('That file is not a valid profile.');
  }
});
$('reset').addEventListener('click', async () => {
  profile = { ...defaultProfile(), savedWorkspaces: profile.savedWorkspaces };
  await saveProfile();
  fillSettings();
  toast('Preferences reset. Saved layouts kept.');
});
$('wipe').addEventListener('click', async () => {
  if (!confirm('Delete your profile and saved layouts? Activity and recovery records will be kept for safety. Apps will stay stopped until you resume. This cannot be undone.')) return;
  const reset = await send({ type: 'profile.reset' });
  if (!reset?.ok) return toast(reset?.error ?? 'Could not reset preferences. Nothing was cleared by this panel.');
  profile = defaultProfile();
  surface = null;
  layoutHistory.length = 0;
  applyProfile();
  fillSettings();
  await refresh();
  toast('Profile and layouts deleted. Activity retained; apps stopped.');
});

// ---------- activity ----------
async function drawJournal() {
  const r = await send({ type: 'broker.journal' });
  const items = (r?.journal ?? []) as any[];
  $('journal').replaceChildren(
    ...(items.length
      ? items.slice(0, 50).map((e) => {
          const li = document.createElement('li');
          const st = document.createElement('strong');
          st.className = `st-${e.status}`;
          st.textContent = e.status;
          li.append(st, ` ${e.request.capabilityId.split('.').slice(-2).join('.')} on ${e.request.target.display?.object ?? e.request.target.display?.document ?? 'the app'}, ${new Date(e.updatedAt).toLocaleTimeString()}`);
          if (e.result?.message) li.append(document.createElement('br'), e.result.message);
          if (e.status === 'unknown') {
            const d = Object.assign(document.createElement('button'), { type: 'button', textContent: 'I checked — dismiss' });
            d.onclick = async () => {
              await send({ type: 'broker.dismiss', actionId: e.request.actionId });
              drawJournal();
            };
            li.append(' ', d);
          }
          return li;
        })
      : [Object.assign(document.createElement('li'), { textContent: 'No actions yet.' })]),
  );
}
$('reconcile').addEventListener('click', async () => {
  const r = await send({ type: 'broker.reconcile' });
  toast(`Re-checked ${r?.changed?.length ?? 0} unresolved action(s).`);
  drawJournal();
});

// ---------- tabs, workspace controls, stop ----------
function selectTab(name: 'workspace' | 'settings' | 'activity') {
  taskMap.pause(name !== 'workspace');
  for (const n of ['workspace', 'settings', 'activity']) {
    $(`tab-${n}`).setAttribute('aria-selected', String(n === name));
    $(`tab-${n}`).tabIndex = n === name ? 0 : -1;
    $(`panel-${n}`).hidden = n !== name;
  }
  if (name === 'settings') fillSettings();
  if (name === 'activity') drawJournal();
}
$('tab-workspace').onclick = () => selectTab('workspace');
$('tab-settings').onclick = () => selectTab('settings');
$('tab-activity').onclick = () => selectTab('activity');
const tabNames = ['workspace','settings','activity'] as const;
tabNames.forEach((name,index)=>$('tab-'+name).addEventListener('keydown',e=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
  const next=navigationIndex(e.key,index,tabNames.length);if(next===null)return;
  e.preventDefault();selectTab(tabNames[next]);$('tab-'+tabNames[next]).focus();
}));
const reader=new LocalReadAloud({synthesis:window.speechSynthesis,Utterance:window.SpeechSynthesisUtterance,status:text=>$('read-status').textContent=text});
$('read-aloud').addEventListener('click',()=>reader.read($('surface').innerText));
$('read-stop').addEventListener('click',()=>reader.stop());
$('stop').addEventListener('click',()=>reader.stop());
window.addEventListener('pagehide',()=>reader.stop());
document.addEventListener('visibilitychange',()=>{if(document.hidden)reader.stop();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')reader.stop();});
chrome.storage.onChanged.addListener((c:any)=>{if(c.stopAll?.newValue)reader.stop();});
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',applyProfile);

$('connect').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('token');
  const r = await send({ type: 'app.connect', appId: 'vikunja', token: input.value });
  input.value = ''; // never keep the secret in the page
  toast(r?.ok ? `Connected to Vikunja. ${r.note ?? ''}` : r?.error ?? 'Could not connect.');
  await loadRegistry();
  await refresh();
});
$('disconnect').addEventListener('click', async () => {
  await send({ type: 'app.disconnect', appId: 'vikunja' });
  await loadRegistry();
  toast('Vikunja token removed from this browser session.');
  await refresh();
});
$('refresh').addEventListener('click', refresh);
$('intent-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = ($('intent') as HTMLInputElement).value.trim();
  if (v) propose(v);
});
document.querySelectorAll<HTMLButtonElement>('.chips button').forEach((b) =>
  b.addEventListener('click', () => {
    ($('intent') as HTMLInputElement).value = b.dataset.intent ?? '';
    propose(b.dataset.intent ?? '');
  }),
);
$('accept').addEventListener('click', async () => {
  if (!proposal) return;
  const focusAccepted = document.activeElement === $('accept');
  if (surface) layoutHistory.push(surface);
  surface = proposal;
  ui.verifiedId = null; // 'Confirmed' belongs to the layout where the change was made
  clearProposal();
  await chrome.storage.local.set({ [`lastSurface:${state!.appId}`]: surface });
  draw();
  if (focusAccepted && (document.activeElement === document.body || document.activeElement === $('accept'))) $('surface').focus();
  toast(`Layout changed to “${surface.title}”. Undo is available.`);
});
$('discard').addEventListener('click', clearProposal);
$('refine-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('refine') as HTMLInputElement;
  const request = input.value;
  await refine(request);
  input.value = '';
  input.focus();
});
$('proposal-back').addEventListener('click', () => { if (versionIdx > 0) { versionIdx--; showProposal(); } });
$('proposal-forward').addEventListener('click', () => { if (versionIdx < versions.length - 1) { versionIdx++; showProposal(); } });
$('proposal-cancel').addEventListener('click', () => proposing?.abort());
$('undo-layout').addEventListener('click', async () => {
  const prev = layoutHistory.pop();
  ui.verifiedId = null;
  if (!prev) return;
  surface = prev;
  await chrome.storage.local.set({ [`lastSurface:${state!.appId}`]: surface });
  draw();
  toast('Previous layout restored. App data was not touched.');
});
$('save-layout').addEventListener('click', async () => {
  if (!surface) return;
  const name = prompt('Name this layout', surface.title)?.trim().slice(0, 40);
  if (!name) return;
  profile.savedWorkspaces[currentApp()] = { ...(profile.savedWorkspaces[currentApp()] ?? {}), [name]: surface };
  await saveProfile();
  toast(`Saved “${name}”.`);
});

async function syncStop() {
  const { stopAll } = await chrome.storage.local.get('stopAll');
  $('stopped').hidden = !stopAll;
  $('stop').toggleAttribute('disabled', !!stopAll);
}
$('stop').addEventListener('click', async () => {
  await chrome.storage.local.set({ stopAll: true });
});
$('resume').addEventListener('click', async () => {
  await chrome.storage.local.set({ stopAll: false });
});
chrome.storage.onChanged.addListener((changes: any) => {
  if (changes.stopAll) syncStop();
});

// Panel keyboard shortcuts (only when not typing).
document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (($('review') as HTMLDialogElement).open || $('panel-workspace').hidden || t.isContentEditable) return;
  if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
  const surf = $('surface');
  if (e.key === 'n') {
    const el = surf.querySelector<HTMLElement>('form[aria-label] input');
    if (el) { e.preventDefault(); el.focus(); }
  } else if (e.key === '/') {
    const el = surf.querySelector<HTMLElement>('.ai-segmented button');
    if (el) { e.preventDefault(); el.focus(); }
  } else if (e.key === 'e') {
    const el = surf.querySelector<HTMLElement>('.ai-edit input, .ai-edit select');
    if (el) { e.preventDefault(); el.focus(); }
  }
});

// When opened as a full tab (not in the side panel), offer to move into the side panel of this window.
async function setupSidePanelButton() {
  const self = await chrome.tabs.getCurrent();
  if (!self) {
    document.documentElement.dataset.context = 'side-panel';
    return;
  }
  document.documentElement.dataset.context = 'tab';
  const b = $('to-sidepanel');
  b.hidden = false;
  b.addEventListener('click', async () => {
    try {
      // Must run synchronously in the click handler's activation window.
      await chrome.sidePanel.open({ windowId: self.windowId });
      toast('Opened in the side panel.');
    } catch (e) {
      toast(`Could not open the side panel: ${(e as Error).message}`);
    }
  });
}

// ---------- boot ----------
(async () => {
  setupSidePanelButton();
  await loadRegistry();
  profile = migrateProfile((await chrome.storage.local.get('profile')).profile);
  applyProfile();
  await syncStop();
  await refresh();
  // Light polling while visible keeps data fresh; layout is never changed by polling.
  setInterval(() => {
    if (document.visibilityState === 'visible' && !busy && !$<HTMLDialogElement>('review').open) refresh();
  }, 2500);
})();

// Visible bounded browser steps. Each inspection is one request; never auto-run or auto-retry.
let browserRequest:ActionRequest|null=null;
let browserWorking=false;
let browserGeneration=0;
const browserStatus=(text:string)=>{$('browser-status').textContent=text;};
$('browser-inspect').addEventListener('click',async()=>{
 if(browserWorking||busy)return;browserWorking=true;browserRequest=null;$('browser-review').setAttribute('disabled','');
 const generation=++browserGeneration;
 try {browserStatus('Inspecting the active task; no click sent.');const r=await send({type:'browser.inspect'});if(generation!==browserGeneration)return;if(!r?.ok)throw Error(r?.error??'Inspection failed');browserRequest=r.request;browserRequest=null;browserStatus('Inspected: '+r.label+'. The control is outlined. Browser writes are disabled: the original page may contain stale task data. Use the API-backed task controls.');}
 catch(e){browserStatus(String((e as Error).message));}finally{browserWorking=false;}
});
$('browser-review').addEventListener('click',async()=>{
 if(browserWorking||busy||!browserRequest)return;browserWorking=true;const request=browserRequest;browserRequest=null;$('browser-review').setAttribute('disabled','');
 try {browserStatus('Waiting for your approval in the trusted review dialog.');const result=await review(request);browserStatus(result?result.status+': '+result.message:'Cancelled or refused. Inspect again to retry.');}
 finally{browserWorking=false;}
});
$('browser-cancel').addEventListener('click',()=>{browserGeneration++;browserRequest=null;$('browser-review').setAttribute('disabled','');browserStatus('Steps cleared. A click already sent cannot be recalled; use Stop for future actions.');});

// Dictation has no execution callback. Only an explicit Insert updates the request field.
const voiceConsent=$<HTMLInputElement>('voice-consent'),voiceDraft=$<HTMLTextAreaElement>('voice-draft');
const voice=new Dictation({Recognition:(window as any).SpeechRecognition??(window as any).webkitSpeechRecognition,change:s=>{
 voiceDraft.value=s.text;voiceDraft.readOnly=s.active;$('voice-status').textContent=s.status;
 $('voice-start').toggleAttribute('disabled',s.active);$('voice-stop').toggleAttribute('disabled',!s.active);
 $('voice-insert').toggleAttribute('disabled',s.active||!s.text.trim());if(!s.active)voiceConsent.checked=false;
}});
const cancelVoice=()=>{voice.cancel();voiceConsent.checked=false;};
$('voice-start').addEventListener('click',()=>{if(busy||!$('stopped').hidden){$('voice-status').textContent='Resume the workspace and finish any active review before dictating.';return;}void voice.start(voiceConsent.checked);});
voiceConsent.addEventListener('change',()=>{if(!voiceConsent.checked)cancelVoice();});
$('voice-stop').addEventListener('click',()=>voice.stop());$('voice-cancel').addEventListener('click',cancelVoice);
voiceDraft.addEventListener('input',()=>{$('voice-insert').toggleAttribute('disabled',voice.active||!voiceDraft.value.trim());});
$('voice-insert').addEventListener('click',()=>{if(voice.active)return;const text=voiceDraft.value.trim();if(!text)return;const input=$<HTMLInputElement>('intent');input.value=[input.value.trim(),text].filter(Boolean).join(' ');cancelVoice();$('voice-status').textContent='Draft appended. Review the request and choose Propose yourself.';input.focus();});
$('voice').addEventListener('toggle',()=>{if(!($('voice') as HTMLDetailsElement).open)cancelVoice();});
$('stop').addEventListener('click',cancelVoice);$('intent-form').addEventListener('submit',cancelVoice);
chrome.storage.onChanged.addListener((c:any)=>{if(c.stopAll?.newValue)cancelVoice();});
window.addEventListener('pagehide',cancelVoice);document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelVoice();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&voice.active)cancelVoice();});

// ---- AI layouts (local gateway) settings
async function refreshAiSettings() {
  const { enabled, paired } = await getAiConfig();
  ($('ai-enabled') as HTMLInputElement).checked = enabled;
  $('ai-origin').textContent = `chrome-extension://${chrome.runtime.id}`;
  $('ai-status').textContent = !enabled ? 'Off. Propose uses the rule-based layout.' : paired ? 'On and paired for this browser session.' : 'On, but not paired: Propose uses the rule-based layout until you pair.';
}
$('ai-enabled').addEventListener('change', async () => { await setAiEnabled(($('ai-enabled') as HTMLInputElement).checked); await refreshAiSettings(); });
$('ai-pair').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('ai-secret') as HTMLInputElement;
  const err = await pair(input.value);
  input.value = '';
  if (err) $('ai-status').textContent = err; else await refreshAiSettings();
});
$('ai-forget').addEventListener('click', async () => { await forgetPairing(); await refreshAiSettings(); });
refreshAiSettings();
