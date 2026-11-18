import type { ObservedState, ActionRequest, TargetIdentity } from '../packages/schemas/src/contracts.ts';
import { Broker } from '../packages/broker/src/broker.ts';
import type { KV } from '../packages/broker/src/broker.ts';
import { makeAdapter, APP_ID, CAPS } from '../packages/adapters/src/reference-tasks/ops.ts';

export const ORIGIN = 'http://localhost:4317';

export class MemKV implements KV {
  data = new Map<string, string>();
  async get<T>(k: string) {
    const v = this.data.get(k);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }
  async set(k: string, v: unknown) {
    this.data.set(k, JSON.stringify(v));
  }
  async remove(k: string) {
    this.data.delete(k);
  }
}

/** In-memory stand-in for the fixture app, with knobs for failure injection. */
export class FakeApp {
  doc = 'doc-1';
  wsRev = 1;
  tasks = [
    { objectId: 't1', revision: 1, fields: { title: 'Draft outline', status: 'todo', priority: 'normal' } as Record<string, string> },
    { objectId: 't2', revision: 1, fields: { title: 'Review sources', status: 'doing', priority: 'high' } as Record<string, string> },
  ];
  writes = 0;
  /** 'ok' | 'drop' (dispatch claims success but nothing changes) | 'hang' | 'apply-then-hang' | 'throw-read' */
  mode = 'ok';
  nextId = 3;

  state(): ObservedState {
    if (this.mode === 'throw-read') throw new Error('read failed');
    return {
      appId: APP_ID,
      appName: 'Reference Tasks (fixture)',
      origin: ORIGIN,
      documentInstanceId: this.doc,
      documentTitle: 'Synthetic plan',
      workspaceRevision: this.wsRev,
      observedAt: Date.now(),
      sourceMethod: 'fixture',
      collections: { tasks: structuredClone(this.tasks), paragraphs: [] },
      collectionSchema: { tasks: ['title', 'status', 'priority'], paragraphs: ['text'] },
      collectionRoles: { tasks: { status: 'status', doneValues: ['done'], rank: 'priority', rankOrder: ['low', 'normal', 'high'] } },
      availableCapabilityIds: Object.values(CAPS).map((c) => c.id),
      limitations: [],
    };
  }

  apply(req: ActionRequest) {
    this.writes++;
    if (req.capabilityId === CAPS.update.id) {
      const t = this.tasks.find((x) => x.objectId === req.target.objectId)!;
      Object.assign(t.fields, req.args);
      t.revision++;
    } else {
      this.tasks.push({ objectId: `t${this.nextId++}`, revision: 1, fields: { title: String(req.args.title), status: 'todo', priority: String(req.args.priority ?? 'normal') } });
    }
    this.wsRev++;
  }

  async execute(req: ActionRequest) {
    if (this.mode === 'hang') return new Promise<never>(() => {});
    if (this.mode === 'apply-then-hang') {
      this.apply(req);
      return new Promise<never>(() => {});
    }
    if (this.mode === 'apply-then-crash') {
      // write lands, then the app becomes unreadable (e.g. tab crashed / worker killed)
      this.apply(req);
      this.mode = 'throw-read';
      return new Promise<never>(() => {});
    }
    if (this.mode === 'drop') return { dispatched: true };
    this.apply(req);
    return { dispatched: true };
  }
}

export function setup(opts: { paused?: boolean; permitted?: boolean } = {}) {
  const app = new FakeApp();
  const kv = new MemKV();
  let paused = opts.paused ?? false;
  let n = 0;
  const adapter = makeAdapter({ readState: async () => app.state(), execute: (r) => app.execute(r) });
  const mk = () =>
    new Broker({
      kv,
      adapters: [adapter],
      hasPermission: async (o) => (opts.permitted ?? true) && o === ORIGIN,
      isPaused: async () => paused,
      now: () => Date.now(),
      randomId: () => `tok-${++n}-${Math.random().toString(36).slice(2)}`,
      executeTimeoutMs: 50,
    });
  return { app, kv, broker: mk(), restart: mk, setPaused: (p: boolean) => (paused = p) };
}

let seq = 0;
export function target(objectId: string | null, doc = 'doc-1'): TargetIdentity {
  return { appId: APP_ID, origin: ORIGIN, documentInstanceId: doc, objectId, display: { app: 'Reference Tasks', document: 'Synthetic plan' } };
}
export function req(partial: Partial<ActionRequest> & Pick<ActionRequest, 'capabilityId' | 'target' | 'args'>): ActionRequest {
  const now = Date.now();
  return { actionId: `act-${++seq}-${now}`, expectedRevision: 1, approvalToken: null, createdAt: now, expiresAt: now + 60_000, ...partial };
}
