// Vikunja adapter (API tier) — pinned to Vikunja v2.8.0. Third-party app; runs locally with synthetic data.
// Verified LIVE against v2.8.0 (scripts/vikunja/probe-api.mjs → outputs/vikunja-api-probe.json):
//  - POST /api/v1/tasks/{id} REPLACES the task: a partial body reset description, priority, due date, colour.
//  - PATCH /api/v2/tasks/{id} (JSON merge patch) changes only the sent fields. Used for updates.
//  - v2 PATCH ignores If-Match in v2.8.0 (stale ETag accepted) → no server-side conditional write.
//  - `updated` has 1-second resolution; two writes in one second share it. Revision is therefore a
//    fingerprint of `updated` + content, so any visible change alters it even within the same second.
//  - API tokens get 401 on /api/v1/user and /api/v2/user → identity is the connected token (hashed).
//  - `filter=project = N` scopes the list to project N.
// Postconditions are checked by an independent GET, including that fields we did not touch are unchanged.

import type { Capability, ObservedState, ObservedObject, ActionRequest, AppDescriptor } from '../../../schemas/src/contracts.ts';
import type { AdapterOp, AdapterPort } from '../../../broker/src/broker.ts';

export const ADAPTER_ID = 'vikunja.api';
export const ADAPTER_VERSION = '0.1.0';
export const APP_ID = 'vikunja';
export const SUPPORTED_VERSIONS = ['v2.8.0'];
export const APP: AppDescriptor = {
  appId: APP_ID,
  name: 'Vikunja',
  origins: ['http://localhost:3456', 'http://127.0.0.1:3456'],
  kind: 'third-party',
  needsToken: true,
};

export const PRIORITIES = ['unset', 'low', 'medium', 'high', 'urgent', 'do-now'];
export const STATUSES = ['open', 'done'];

const base = { schemaVersion: 1, adapterId: ADAPTER_ID, adapterVersion: ADAPTER_VERSION, appId: APP_ID, supportedVersions: SUPPORTED_VERSIONS };

export const CAPS: Record<string, Capability> = {
  projects: {
    ...base, id: 'vikunja.project.list', operation: 'project.list', label: 'Read projects', argumentSchema: {},
    requiredScopes: ['token:projects.read_all'], riskClass: 'read', reversible: true, preconditions: [], verificationMethod: 'n/a (read)',
  },
  list: {
    ...base, id: 'vikunja.task.list', operation: 'task.list', label: 'Read tasks', argumentSchema: {},
    requiredScopes: ['token:tasks.read_all'], riskClass: 'read', reversible: true, preconditions: [], verificationMethod: 'n/a (read)',
  },
  update: {
    ...base, id: 'vikunja.task.update', operation: 'task.update', label: 'Edit task',
    argumentSchema: {
      title: { type: 'string', maxLength: 250, material: true },
      status: { type: 'enum', values: STATUSES, material: true },
      priority: { type: 'enum', values: PRIORITIES, material: true },
    },
    requiredScopes: ['token:tasks.read_one', 'token:tasks.update'], riskClass: 'low', reversible: true,
    preconditions: ['Task exists and belongs to the target project', 'Task `updated` equals expectedRevision immediately before write', 'Token user equals target account'],
    verificationMethod: 'Independent GET /tasks/{id}: requested fields equal, `updated` changed, untouched fields (description, dates, colour, percent done, repeat, project) unchanged',
  },
  create: {
    ...base, id: 'vikunja.task.create', operation: 'task.create', label: 'Create task',
    argumentSchema: {
      title: { type: 'string', maxLength: 250, required: true, material: true },
      priority: { type: 'enum', values: PRIORITIES, material: true, default: 'unset' },
    },
    requiredScopes: ['token:tasks.create'], riskClass: 'medium', reversible: false,
    preconditions: ['Project exists and token user can write to it'],
    verificationMethod: 'Durable create-response task id plus independent project read-back of that id, title and priority; missing receipt remains unknown',
  },
};

// ---------- mapping (pure; unit-testable) ----------
export interface VTask {
  id: number;
  title: string;
  description?: string;
  done: boolean;
  priority: number;
  project_id: number;
  updated: string;
  due_date?: string;
  start_date?: string;
  end_date?: string;
  hex_color?: string;
  percent_done?: number;
  repeat_after?: number;
  repeat_mode?: number;
  identifier?: string;
  [k: string]: unknown;
}

/** Small stable hash (FNV-1a 32-bit) so untouched-field checks don't copy content into state. */
export function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Revision = fingerprint of server `updated` + all content this adapter can observe (see header). */
export function revisionOf(t: VTask): number {
  if (!Number.isFinite(Date.parse(t.updated))) throw new Error(`unparseable updated: ${t.updated}`);
  return fnv(JSON.stringify([t.updated, t.title, t.done, t.priority, untouchedFingerprint(t)]));
}

/** Fingerprint of fields this adapter never changes; must be identical before and after our writes. */
export function untouchedFingerprint(t: VTask): number {
  return fnv(JSON.stringify([t.description ?? '', t.due_date ?? '', t.start_date ?? '', t.end_date ?? '', t.hex_color ?? '', t.percent_done ?? 0, t.repeat_after ?? 0, t.repeat_mode ?? 0, t.project_id]));
}

export function toObject(t: VTask, origin: string): ObservedObject {
  return {
    objectId: String(t.id),
    revision: revisionOf(t),
    fields: {
      title: String(t.title ?? '').slice(0, 2000),
      status: t.done ? 'done' : 'open',
      priority: PRIORITIES[t.priority] ?? 'unset',
      _untouched: untouchedFingerprint(t),
      _project: t.project_id,
    },
    link: `${origin}/tasks/${t.id}`,
  };
}

export function documentId(accountId: number, projectId: number) {
  return `vikunja:${accountId}:project:${projectId}`;
}
export function parseDocumentId(id: string): { accountId: number; projectId: number } | null {
  const m = /^vikunja:(\d+):project:(\d+)$/.exec(id);
  return m ? { accountId: Number(m[1]), projectId: Number(m[2]) } : null;
}

export function buildState(args: { origin: string; accountId: number; project: { id: number; title: string }; tasks: VTask[]; observedAt: number }): ObservedState {
  const objs = args.tasks.map((t) => toObject(t, args.origin)).sort((a, b) => Number(a.objectId) - Number(b.objectId));
  return {
    appId: APP_ID,
    appName: 'Vikunja',
    origin: args.origin,
    documentInstanceId: documentId(args.accountId, args.project.id),
    documentTitle: args.project.title.slice(0, 300),
    workspaceRevision: fnv(objs.map((o) => `${o.objectId}:${o.revision}`).join('|')),
    observedAt: args.observedAt,
    sourceMethod: 'api',
    collections: { tasks: objs },
    collectionSchema: { tasks: ['title', 'status', 'priority'] },
    collectionRoles: { tasks: { status: 'status', doneValues: ['done'], rank: 'priority', rankOrder: PRIORITIES } },
    availableCapabilityIds: Object.values(CAPS).map((c) => c.id),
    limitations: [
      'Delete, labels, assignees, dates, description and comments are not exposed by this adapter.',
      'No server-side conditional write in Vikunja v2.8.0 (v2 PATCH ignores If-Match): a change to the same field landing between the pre-write read and the PATCH (one round-trip) is not detected. Other fields are never overwritten (partial PATCH).',
      'API tokens are per user, not per project: the token can read all projects of that user; the adapter scopes reads and writes to the open project.',
      'Showing at most the first 50 tasks of the project.',
    ],
  };
}

/** JSON merge-patch body containing only the requested fields. */
export function patchBody(args: Record<string, string | number | boolean>): Partial<VTask> {
  const b: Partial<VTask> = {};
  if (typeof args.title === 'string') b.title = args.title;
  if (typeof args.status === 'string') b.done = args.status === 'done';
  if (typeof args.priority === 'string') b.priority = Math.max(0, PRIORITIES.indexOf(args.priority));
  return b;
}

/** Apply requested fields onto a full task object (used by tests to model the expected result). */
export function applyArgs(t: VTask, args: Record<string, string | number | boolean>): VTask {
  const next: VTask = { ...t };
  if (typeof args.title === 'string') next.title = args.title;
  if (typeof args.status === 'string') next.done = args.status === 'done';
  if (typeof args.priority === 'string') next.priority = Math.max(0, PRIORITIES.indexOf(args.priority));
  return next;
}

// ---------- ops ----------
const tasksOf = (s: ObservedState) => s.collections.tasks ?? [];

const updateOp: AdapterOp = {
  capability: CAPS.update,
  describe(before, req) {
    const t = tasksOf(before).find((x) => x.objectId === req.target.objectId);
    if (!t) return ['Task not found'];
    return Object.entries(req.args).map(([k, v]) => `${k}: "${String(t.fields[k])}" → "${String(v)}"`);
  },
  prepare(before, req) {
    const t = tasksOf(before).find((x) => x.objectId === req.target.objectId);
    return { untouched: t?.fields._untouched ?? null };
  },
  verify(after, req, ctx) {
    const c = (ctx ?? {}) as { untouched?: number | null };
    const t = tasksOf(after).find((x) => x.objectId === req.target.objectId);
    if (!t) return { verified: false, observed: 'task missing after write', afterRevision: null };
    const mismatched = Object.entries(req.args).filter(([k, v]) => t.fields[k] !== v).map(([k]) => k);
    const revChanged = req.expectedRevision === null || t.revision !== req.expectedRevision;
    const collateral = c.untouched != null && t.fields._untouched !== c.untouched;
    if (!mismatched.length && revChanged && !collateral) {
      return { verified: true, observed: `task ${t.objectId}: ${Object.keys(req.args).join(', ')} match; other fields unchanged`, afterRevision: t.revision };
    }
    return {
      verified: false,
      observed: [mismatched.length ? `mismatched: ${mismatched.join(', ')}` : '', revChanged ? '' : 'revision unchanged', collateral ? 'OTHER FIELDS CHANGED' : ''].filter(Boolean).join('; '),
      afterRevision: t.revision,
    };
  },
};

const createOp: AdapterOp = {
  capability: CAPS.create,
  describe(before, req) {
    return [`New task in “${before.documentTitle}”: "${String(req.args.title)}"`, `Priority: ${String(req.args.priority ?? 'unset')}`, 'Not undoable through this adapter; delete it in Vikunja if needed.'];
  },
  prepare(before, req) {
    return { ids: tasksOf(before).map((t) => t.objectId), sameTitle: tasksOf(before).filter((t) => t.fields.title === req.args.title).length };
  },
  captureReceipt(ctx, receipt) {
    const r = receipt as { objectId?: unknown } | undefined;
    return { ...(ctx as object), receiptObjectId: typeof r?.objectId === 'string' && /^[1-9][0-9]*$/.test(r.objectId) ? r.objectId : null };
  },
  verify(after, req, ctx) {
    const c = (ctx ?? { ids: [], sameTitle: 0 }) as { ids: string[]; sameTitle: number; receiptObjectId?: string | null };
    if (!c.receiptObjectId) return { verified: false, observed: 'No durable create receipt; matching tasks cannot prove this operation created them', afterRevision: after.workspaceRevision };
    const fresh = tasksOf(after).filter((t) => t.objectId === c.receiptObjectId && t.fields.title === req.args.title && !c.ids.includes(t.objectId));
    if (fresh.length === 1) {
      const pr = (req.args.priority as string | undefined) ?? 'unset';
      if (fresh[0].fields.priority !== pr) return { verified: false, observed: `created ${fresh[0].objectId} with priority ${String(fresh[0].fields.priority)}`, afterRevision: after.workspaceRevision };
      return { verified: true, observed: `new task ${fresh[0].objectId} present`, afterRevision: after.workspaceRevision };
    }
    return { verified: false, observed: `${fresh.length} new matching tasks`, afterRevision: after.workspaceRevision };
  },
};

export const OPS: AdapterOp[] = [updateOp, createOp];
export const READ_CAPS: Capability[] = [CAPS.projects, CAPS.list];

// ---------- HTTP transport ----------
export interface VikunjaHttp {
  /** Calls `${origin}/api/${version}${path}` with the bearer token. Throws on non-2xx with status attached. */
  call<T>(origin: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown, version?: 'v1' | 'v2'): Promise<T>;
  /** Stable numeric identity of the connected credential (API tokens cannot read /user). */
  identity(origin: string): Promise<number>;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

export function makeFetchHttp(getToken: (origin: string) => Promise<string | null>, fetchImpl: typeof fetch = fetch, timeoutMs = 8000): VikunjaHttp {
  return {
    async identity(origin: string): Promise<number> {
      const token = await getToken(origin);
      if (!token) throw new HttpError(401, 'Not connected: add a Vikunja API token in the panel.');
      // One-way fingerprint of the credential; the token itself never leaves this function.
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
      return ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
    },
    async call<T>(origin: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown, version: 'v1' | 'v2' = 'v1'): Promise<T> {
      const token = await getToken(origin);
      if (!token) throw new HttpError(401, 'Not connected: add a Vikunja API token in the panel.');
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetchImpl(`${origin}/api/${version}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctl.signal,
          credentials: 'omit', // never ride on the site's cookies/session
          redirect: 'error',
        });
        const text = await r.text();
        if (!r.ok) throw new HttpError(r.status, `${method} ${path} → ${r.status}: ${text.slice(0, 200)}`);
        return (text ? JSON.parse(text) : null) as T;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function permissionMessage(perm: string, status: number) {
  return `Vikunja refused the change (${status}): the connected API token does not have "${perm}" permission. Nothing was changed. Create a token with projects: read all + read one, and tasks: read all + read one + create + update, then reconnect.`;
}

export interface VikunjaContext {
  origin: string;
  projectId: number;
}

/** Map a Vikunja frontend URL to a project context (task URLs are resolved through the API). */
export function parseVikunjaUrl(url: string): { origin: string; projectId?: number; taskId?: number } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!APP.origins.includes(u.origin)) return null;
  const p = /^\/projects\/(\d+)/.exec(u.pathname);
  if (p) return { origin: u.origin, projectId: Number(p[1]) };
  const t = /^\/tasks\/(\d+)/.exec(u.pathname);
  if (t) return { origin: u.origin, taskId: Number(t[1]) };
  return { origin: u.origin };
}

export function makeVikunjaAdapter(http: VikunjaHttp, now: () => number = Date.now): AdapterPort & {
  readCaps: Capability[];
  readContext(ctx: VikunjaContext): Promise<ObservedState>;
  accountId(origin: string): Promise<number>;
  projectOfTask(origin: string, taskId: number): Promise<number>;
  validateConnection(origin: string): Promise<number>;
} {
  const accountCache = new Map<string, number>();
  async function accountId(origin: string): Promise<number> {
    // Connection identity = fingerprint of the API token (Vikunja v2.8.0 returns 401 on /user for tokens).
    // Re-evaluated on every read and before every write, so swapping tokens invalidates open targets.
    const id = await http.identity(origin);
    accountCache.set(origin, id);
    return id;
  }
  async function readContext(ctx: VikunjaContext): Promise<ObservedState> {
    const acct = await accountId(ctx.origin);
    const project = await http.call<{ id: number; title: string }>(ctx.origin, 'GET', `/projects/${ctx.projectId}`);
    const filter = encodeURIComponent(`project = ${ctx.projectId}`);
    const tasks = await http.call<VTask[]>(ctx.origin, 'GET', `/tasks?filter=${filter}&per_page=50&sort_by=id&order_by=asc`);
    // Defence in depth: never trust the filter alone for target scoping.
    const scoped = (tasks ?? []).filter((t) => t.project_id === ctx.projectId);
    return buildState({ origin: ctx.origin, accountId: acct, project, tasks: scoped, observedAt: now() });
  }
  return {
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    ops: OPS,
    readCaps: READ_CAPS,
    accountId,
    readContext,
    /** Called on connect: proves the token is accepted by Vikunja and can read projects (the minimum we need). */
    async validateConnection(origin) {
      await http.call<unknown[]>(origin, 'GET', '/projects?per_page=1&page=1');
      return accountId(origin);
    },
    async projectOfTask(origin, taskId) {
      return (await http.call<VTask>(origin, 'GET', `/tasks/${taskId}`)).project_id;
    },
    async readState(target) {
      const d = parseDocumentId(target.documentInstanceId);
      if (!d) throw new Error('not a Vikunja target');
      const s = await readContext({ origin: target.origin, projectId: d.projectId });
      return s; // broker compares documentInstanceId (includes account id) to detect account switches
    },
    async execute(req: ActionRequest) {
      const d = parseDocumentId(req.target.documentInstanceId);
      if (!d) return { dispatched: false, detail: 'bad target' };
      const origin = req.target.origin;
      if ((await accountId(origin)) !== d.accountId) return { dispatched: false, detail: 'token belongs to a different Vikunja connection than the target' };
      if (req.capabilityId === CAPS.update.id) {
        const id = Number(req.target.objectId);
        const current = await http.call<VTask>(origin, 'GET', `/tasks/${id}`);
        if (current.project_id !== d.projectId) return { dispatched: false, detail: 'task is no longer in the target project' };
        if (req.expectedRevision !== null && revisionOf(current) !== req.expectedRevision) return { dispatched: false, detail: 'revision changed before write' };
        // Partial merge patch with only the requested fields: concurrent edits to other fields are not overwritten.
        try {
          await http.call<VTask>(origin, 'PATCH', `/tasks/${id}`, patchBody(req.args), 'v2');
        } catch (e) {
          // Auth is checked before the handler runs, so 401/403 means Vikunja made no change.
          if (e instanceof HttpError && (e.status === 401 || e.status === 403)) return { dispatched: false, detail: permissionMessage('tasks: update', e.status) };
          throw e;
        }
        return { dispatched: true };
      }
      if (req.capabilityId === CAPS.create.id) {
        const body: Partial<VTask> = { title: String(req.args.title), priority: Math.max(0, PRIORITIES.indexOf(String(req.args.priority ?? 'unset'))) };
        try {
          const created = await http.call<VTask>(origin, 'PUT', `/projects/${d.projectId}/tasks`, body);
          return { dispatched: true, receipt: { objectId: Number.isSafeInteger(created.id) && created.id > 0 ? String(created.id) : null } };
        } catch (e) {
          if (e instanceof HttpError && (e.status === 401 || e.status === 403)) return { dispatched: false, detail: permissionMessage('tasks: create', e.status) };
          throw e;
        }
        return { dispatched: true };
      }
      return { dispatched: false, detail: 'unsupported capability' };
    },
  };
}
