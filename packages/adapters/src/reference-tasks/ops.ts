// Adapter definition for the CONTROLLED REFERENCE FIXTURE (test-fixtures/reference-app).
// This is NOT a third-party integration and does not satisfy the real-app milestone.
// It exercises the dom-semantic tier: reads semantic attributes, writes through the app's own controls.

import type { Capability, ObservedState, ActionRequest, TargetIdentity } from '../../../schemas/src/contracts.ts';
import type { AdapterOp, AdapterPort } from '../../../broker/src/broker.ts';

export const ADAPTER_ID = 'reference-tasks.dom';
export const ADAPTER_VERSION = '0.1.0';
export const APP_ID = 'reference-tasks';
export const APP = { appId: APP_ID, name: 'Reference Tasks (fixture)', origins: ['http://localhost:4317', 'http://127.0.0.1:4317'], kind: 'controlled-fixture' as const, needsToken: false };

const base = {
  schemaVersion: 1,
  adapterId: ADAPTER_ID,
  adapterVersion: ADAPTER_VERSION,
  appId: APP_ID,
  supportedVersions: ['fixture-1'],
};

const STATUS = ['todo', 'doing', 'done'];
const PRIORITY = ['low', 'normal', 'high'];

export const CAPS: Record<string, Capability> = {
  list: {
    ...base,
    id: 'reference-tasks.task.list',
    operation: 'task.list',
    label: 'Read tasks',
    argumentSchema: {},
    requiredScopes: ['host:read'],
    riskClass: 'read',
    reversible: true,
    preconditions: ['Fixture page is open and access granted'],
    verificationMethod: 'n/a (read)',
  },
  docRead: {
    ...base,
    id: 'reference-tasks.doc.read',
    operation: 'doc.read',
    label: 'Read document',
    argumentSchema: {},
    requiredScopes: ['host:read'],
    riskClass: 'read',
    reversible: true,
    preconditions: ['Fixture page is open and access granted'],
    verificationMethod: 'n/a (read)',
  },
  update: {
    ...base,
    id: 'reference-tasks.task.update',
    operation: 'task.update',
    label: 'Edit task',
    argumentSchema: {
      title: { type: 'string', maxLength: 200, material: true },
      status: { type: 'enum', values: STATUS, material: true },
      priority: { type: 'enum', values: PRIORITY, material: true },
    },
    requiredScopes: ['host:write'],
    riskClass: 'low',
    reversible: true,
    preconditions: ['Task exists', 'Task revision equals expectedRevision', 'Exactly one row matches the task id'],
    verificationMethod: 'Re-read row by data-task-id; every supplied field equals the requested value and revision increased',
  },
  create: {
    ...base,
    id: 'reference-tasks.task.create',
    operation: 'task.create',
    label: 'Create task',
    argumentSchema: {
      title: { type: 'string', maxLength: 200, required: true, material: true },
      priority: { type: 'enum', values: PRIORITY, material: true, default: 'normal' },
    },
    requiredScopes: ['host:write'],
    riskClass: 'medium',
    reversible: false,
    preconditions: ['Workspace revision equals expectedRevision'],
    verificationMethod: 'Re-read list; count of tasks with the exact title increased by one and a new id is present',
  },
};

function tasks(s: ObservedState) {
  return s.collections.tasks ?? [];
}

const updateOp: AdapterOp = {
  capability: CAPS.update,
  describe(before, req) {
    const t = tasks(before).find((x) => x.objectId === req.target.objectId);
    if (!t) return ['Task not found'];
    return Object.entries(req.args).map(([k, v]) => `${k}: "${String(t.fields[k])}" → "${String(v)}"`);
  },
  verify(after, req) {
    const t = tasks(after).find((x) => x.objectId === req.target.objectId);
    if (!t) return { verified: false, observed: 'task missing after write', afterRevision: null };
    const mismatched = Object.entries(req.args).filter(([k, v]) => t.fields[k] !== v);
    const revOk = req.expectedRevision === null || t.revision > req.expectedRevision;
    if (mismatched.length === 0 && revOk) {
      return { verified: true, observed: `task ${t.objectId} rev ${t.revision}: ${Object.keys(req.args).join(', ')} match`, afterRevision: t.revision };
    }
    return {
      verified: false,
      observed: `task ${t.objectId} rev ${t.revision}; mismatched: ${mismatched.map(([k]) => k).join(', ') || 'none'}${revOk ? '' : '; revision unchanged'}`,
      afterRevision: t.revision,
    };
  },
};

const createOp: AdapterOp = {
  capability: CAPS.create,
  describe(_before, req) {
    return [`New task: "${String(req.args.title)}"`, `Priority: ${String(req.args.priority ?? 'normal')}`, 'This app has no delete via this adapter; remove it in the original app if needed.'];
  },
  prepare(before, req) {
    return {
      ids: tasks(before).map((t) => t.objectId),
      sameTitle: tasks(before).filter((t) => t.fields.title === req.args.title).length,
    };
  },
  verify(after, req, ctx) {
    const c = (ctx ?? { ids: [], sameTitle: 0 }) as { ids: string[]; sameTitle: number };
    const matches = tasks(after).filter((t) => t.fields.title === req.args.title);
    const fresh = matches.filter((t) => !c.ids.includes(t.objectId));
    if (matches.length === c.sameTitle + 1 && fresh.length === 1) {
      const pr = (req.args.priority as string | undefined) ?? 'normal';
      if (fresh[0].fields.priority !== pr) return { verified: false, observed: `created ${fresh[0].objectId} but priority is ${String(fresh[0].fields.priority)}`, afterRevision: after.workspaceRevision };
      return { verified: true, observed: `new task ${fresh[0].objectId} present`, afterRevision: after.workspaceRevision };
    }
    return { verified: false, observed: `${fresh.length} new matching tasks`, afterRevision: after.workspaceRevision };
  },
};

export const OPS: AdapterOp[] = [updateOp, createOp];
export const READ_CAPS: Capability[] = [CAPS.list, CAPS.docRead];

export interface Transport {
  readState(target: TargetIdentity | null): Promise<ObservedState>;
  execute(req: ActionRequest): Promise<{ dispatched: boolean; detail?: string }>;
}

export function makeAdapter(transport: Transport): AdapterPort & { readCaps: Capability[] } {
  return {
    adapterId: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    ops: OPS,
    readCaps: READ_CAPS,
    readState: (t) => transport.readState(t),
    execute: (req) => transport.execute(req),
  };
}
