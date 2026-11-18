// Action broker: authorization, risk policy, approval binding, journal, locking,
// execution through an adapter, independent read-back, and reconciliation.
// Pure logic with injected ports so it runs in the MV3 service worker and in Node tests.

import type {
  Capability,
  ActionRequest,
  ActionResult,
  ObservedState,
  TargetIdentity,
  ErrorCode,
} from '../../schemas/src/contracts.ts';
import { validateArgs, validateActionRequestShape } from '../../schemas/src/validate.ts';

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface VerifyOutcome {
  verified: boolean;
  observed: string;
  afterRevision: number | null;
}

export interface AdapterOp {
  capability: Capability;
  /** Check the postcondition against an independently read state. */
  verify(after: ObservedState, req: ActionRequest, ctx: unknown): VerifyOutcome;
  /** Capture minimal pre-state needed to verify later (persisted in the journal; no content beyond what is needed). */
  prepare?(before: ObservedState, req: ActionRequest): unknown;
  /** Merge a transport receipt into durable verification context; never infer a receipt from read-back. */
  captureReceipt?(ctx: unknown, receipt: unknown): unknown;
  /** Human-readable before/after for previews. */
  describe(before: ObservedState, req: ActionRequest): string[];
}

export interface AdapterPort {
  adapterId: string;
  adapterVersion: string;
  ops: AdapterOp[];
  readState(target: TargetIdentity): Promise<ObservedState>;
  /** Perform the write. Resolving does NOT mean success; the broker verifies by read-back. */
  execute(req: ActionRequest, cap: Capability): Promise<{ dispatched: boolean; detail?: string; receipt?: unknown }>;
}

export interface BrokerPorts {
  kv: KV;
  adapters: AdapterPort[];
  hasPermission(origin: string): Promise<boolean>;
  isPaused(appId: string): Promise<boolean>;
  now(): number;
  randomId(): string;
  /** Hard timeout for adapter execute; after it the outcome is UNKNOWN, never retried. */
  executeTimeoutMs?: number;
}

export interface JournalEntry {
  request: ActionRequest;
  status: ActionResult['status'];
  beforeRevision: number | null;
  verifyContext?: unknown;
  createdAt: number;
  updatedAt: number;
  result?: ActionResult;
}

export interface Preview {
  ok: boolean;
  errorCode?: ErrorCode;
  message: string;
  capability?: Capability;
  requiresApproval: boolean;
  lines: string[];
  display?: TargetIdentity['display'];
  observedAt?: number;
}

const APPROVAL_TTL_MS = 60_000;
const JOURNAL_KEY = 'broker.journal.v1';
const APPROVALS_KEY = 'broker.approvals.v1';

/** Canonical binding of an approval to exact target and material arguments. */
export function approvalBinding(req: ActionRequest, cap: Capability): string {
  const material: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(cap.argumentSchema).sort(([a], [b]) => a.localeCompare(b))) {
    if (spec.material !== false) material[k] = req.args[k] ?? null;
  }
  return JSON.stringify([
    req.actionId,
    cap.schemaVersion,
    cap.adapterId,
    cap.adapterVersion,
    cap.id,
    req.target.appId,
    req.target.origin,
    req.target.documentInstanceId,
    req.target.objectId,
    req.expectedRevision,
    material,
  ]);
}

// All broker mutations share one queue per KV identity within this JS realm.
// Production has exactly one storage owner: the extension service worker.
// This is NOT a cross-process/database lock. Separate KV wrappers over one backing
// store must not be used as concurrent writers; use a transactional store first.
const mutationQueues = new WeakMap<KV, Promise<unknown>>();

export class Broker {
  private ports: BrokerPorts;
  private locks = new Set<string>();

  constructor(ports: BrokerPorts) {
    this.ports = ports;
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const previous = mutationQueues.get(this.ports.kv) ?? Promise.resolve();
    const next = previous.then(run, run);
    mutationQueues.set(this.ports.kv, next.then(() => undefined, () => undefined));
    return next;
  }

  issueApproval(raw: unknown) { return this.serialize(() => this.issueApprovalExclusive(raw)); }
  execute(raw: unknown) { return this.serialize(() => this.executeExclusive(raw)); }
  reconcile() { return this.serialize(() => this.reconcileExclusive()); }
  dismiss(actionId: string) { return this.serialize(() => this.dismissExclusive(actionId)); }

  /** Reset presentation preferences without deleting recovery/deduplication evidence.
   * Never clear the backing store: timed-out transports can still finish later.
   * Stop stays enabled until the person explicitly resumes in the UI.
   */
  resetProfile(appIds: readonly string[] = []): Promise<void> {
    return this.serialize(async () => {
      await this.ports.kv.set('stopAll', true);
      await this.ports.kv.remove(APPROVALS_KEY);
      await this.ports.kv.remove('profile');
      for (const appId of appIds) await this.ports.kv.remove(`lastSurface:${appId}`);
    });
  }

  registry(): Capability[] {
    return this.ports.adapters.flatMap((a) => a.ops.map((o) => o.capability));
  }

  private findOp(capabilityId: string): { adapter: AdapterPort; op: AdapterOp } | null {
    for (const adapter of this.ports.adapters) {
      const op = adapter.ops.find((o) => o.capability.id === capabilityId);
      if (op) return { adapter, op };
    }
    return null;
  }

  private async journal(): Promise<Record<string, JournalEntry>> {
    return (await this.ports.kv.get<Record<string, JournalEntry>>(JOURNAL_KEY)) ?? {};
  }

  private async writeJournal(id: string, entry: JournalEntry) {
    const j = await this.journal();
    j[id] = entry;
    await this.ports.kv.set(JOURNAL_KEY, j);
  }

  async listJournal(): Promise<JournalEntry[]> {
    return Object.values(await this.journal()).sort((a, b) => b.createdAt - a.createdAt);
  }

  private lockKey(t: TargetIdentity) {
    return `${t.appId}|${t.origin}|${t.documentInstanceId}|${t.objectId ?? '*'}`;
  }

  private fail(req: { actionId?: string } | null, code: ErrorCode, message: string, recovery: string[] = []): ActionResult {
    return {
      actionId: req?.actionId ?? 'invalid',
      status: 'failed',
      beforeRevision: null,
      afterRevision: null,
      observedPostcondition: null,
      errorCode: code,
      message,
      recoveryOptions: recovery,
    };
  }

  /** Shared checks for preview, approval and execution. Reads current state. */
  private async check(
    raw: unknown,
  ): Promise<
    | { ok: true; req: ActionRequest; adapter: AdapterPort; op: AdapterOp; state: ObservedState }
    | { ok: false; result: ActionResult }
  > {
    const shape = validateActionRequestShape(raw);
    if (!shape.ok || !shape.value) return { ok: false, result: this.fail(null, 'INVALID_ARGS', shape.errors.join('; ')) };
    const req = shape.value;
    const found = this.findOp(req.capabilityId);
    if (!found) return { ok: false, result: this.fail(req, 'UNKNOWN_CAPABILITY', `No registered capability ${req.capabilityId}.`) };
    const { adapter, op } = found;
    const cap = op.capability;
    if (cap.appId !== req.target.appId) return { ok: false, result: this.fail(req, 'TARGET_MISMATCH', 'Capability does not belong to the target app.') };
    if (cap.riskClass === 'prohibited') return { ok: false, result: this.fail(req, 'PROHIBITED', 'This operation is not allowed.') };
    if (cap.riskClass === 'read') return { ok: false, result: this.fail(req, 'INVALID_ARGS', 'Read capabilities are not executed as actions.') };
    if (this.ports.now() > req.expiresAt) return { ok: false, result: this.fail(req, 'REQUEST_EXPIRED', 'Request expired. Review the current state and try again.') };
    if (await this.ports.isPaused(req.target.appId)) return { ok: false, result: this.fail(req, 'APP_PAUSED', 'This app is paused in your settings.') };
    if (!(await this.ports.hasPermission(req.target.origin))) {
      return { ok: false, result: this.fail(req, 'PERMISSION_MISSING', `No access to ${req.target.origin}.`, ['grant-access']) };
    }
    const args = validateArgs(cap, req.args);
    if (!args.ok) return { ok: false, result: this.fail(req, 'INVALID_ARGS', args.errors.join('; ')) };

    let state: ObservedState;
    try {
      state = await adapter.readState(req.target);
    } catch (e) {
      return { ok: false, result: this.fail(req, 'ADAPTER_ERROR', `Could not read current state: ${String((e as Error).message ?? e)}`, ['open-original']) };
    }
    if (state.documentInstanceId !== req.target.documentInstanceId || state.origin !== req.target.origin || state.appId !== req.target.appId) {
      return { ok: false, result: this.fail(req, 'TARGET_MISMATCH', 'The open document changed since this control was built. Review the new target.', ['refresh']) };
    }
    if (req.target.objectId !== null) {
      const obj = Object.values(state.collections).flat().find((o) => o.objectId === req.target.objectId);
      if (!obj) return { ok: false, result: this.fail(req, 'TARGET_MISMATCH', 'The target object no longer exists.', ['refresh']) };
      if (req.expectedRevision !== null && obj.revision !== req.expectedRevision) {
        return {
          ok: false,
          result: {
            ...this.fail(req, 'STALE_REVISION', `The item changed in the original app (revision ${req.expectedRevision} â†’ ${obj.revision}). Nothing was written.`, ['refresh']),
            beforeRevision: obj.revision,
          },
        };
      }
    } else if (req.expectedRevision !== null && state.workspaceRevision !== req.expectedRevision) {
      return { ok: false, result: this.fail(req, 'STALE_REVISION', 'The workspace changed. Nothing was written.', ['refresh']) };
    }
    if (!state.availableCapabilityIds.includes(cap.id)) {
      return { ok: false, result: this.fail(req, 'UNKNOWN_CAPABILITY', 'The app does not currently expose this operation.', ['open-original']) };
    }
    return { ok: true, req, adapter, op, state };
  }

  async preview(raw: unknown): Promise<Preview> {
    const c = await this.check(raw);
    if (!c.ok) return { ok: false, errorCode: c.result.errorCode ?? undefined, message: c.result.message, requiresApproval: false, lines: [] };
    const cap = c.op.capability;
    return {
      ok: true,
      message: cap.label,
      capability: cap,
      requiresApproval: cap.riskClass === 'medium' || cap.riskClass === 'high',
      lines: c.op.describe(c.state, c.req),
      display: c.req.target.display,
      observedAt: c.state.observedAt,
    };
  }

  /**
   * Issue a short-lived approval token bound to exact target + material args.
   * MUST only be reachable from extension-owned UI (enforced by the caller's sender check).
   */
  private async issueApprovalExclusive(raw: unknown): Promise<{ ok: boolean; token?: string; expiresAt?: number; message: string }> {
    const c = await this.check(raw);
    if (!c.ok) return { ok: false, message: c.result.message };
    const token = this.ports.randomId();
    const expiresAt = this.ports.now() + APPROVAL_TTL_MS;
    const approvals = (await this.ports.kv.get<Record<string, { binding: string; expiresAt: number; used: boolean }>>(APPROVALS_KEY)) ?? {};
    for (const [k, v] of Object.entries(approvals)) if (v.expiresAt < this.ports.now()) delete approvals[k];
    approvals[token] = { binding: approvalBinding(c.req, c.op.capability), expiresAt, used: false };
    await this.ports.kv.set(APPROVALS_KEY, approvals);
    return { ok: true, token, expiresAt, message: 'Approved for this exact change only.' };
  }

  private async consumeApproval(req: ActionRequest, cap: Capability): Promise<ErrorCode | null> {
    if (!req.approvalToken) return 'APPROVAL_REQUIRED';
    const approvals = (await this.ports.kv.get<Record<string, { binding: string; expiresAt: number; used: boolean }>>(APPROVALS_KEY)) ?? {};
    const a = approvals[req.approvalToken];
    if (!a || a.used) return 'APPROVAL_INVALID';
    if (a.expiresAt < this.ports.now()) return 'APPROVAL_EXPIRED';
    if (a.binding !== approvalBinding(req, cap)) return 'APPROVAL_INVALID';
    a.used = true;
    await this.ports.kv.set(APPROVALS_KEY, approvals);
    return null;
  }

  private async executeExclusive(raw: unknown): Promise<ActionResult> {
    const actionId = (raw as ActionRequest)?.actionId;
    if (typeof actionId === 'string') {
      const existing = (await this.journal())[actionId];
      if (existing) {
        return this.fail({ actionId }, 'DUPLICATE_ACTION', `Action already ${existing.status}. It will not be sent again.`, existing.status === 'unknown' ? ['reconcile'] : []);
      }
    }
    const c = await this.check(raw);
    if (!c.ok) return c.result;
    const { req, adapter, op, state } = c;
    const cap = op.capability;

    if (cap.riskClass === 'medium' || cap.riskClass === 'high') {
      const err = await this.consumeApproval(req, cap);
      if (err) return this.fail(req, err, err === 'APPROVAL_EXPIRED' ? 'Approval expired. Review and approve again.' : 'This change needs your approval of the exact preview.', ['review']);
    }

    const lockKey = this.lockKey(req.target);
    const pendingOnTarget = (await this.listJournal()).some(
      (e) => (e.status === 'executing' || e.status === 'unknown') && this.lockKey(e.request.target) === lockKey,
    );
    if (this.locks.has(lockKey) || pendingOnTarget) {
      return this.fail(req, 'TARGET_LOCKED', 'Another action on this item is in progress or unresolved.', ['reconcile']);
    }
    this.locks.add(lockKey);

    const beforeRevision = req.target.objectId
      ? Object.values(state.collections).flat().find((o) => o.objectId === req.target.objectId)?.revision ?? null
      : state.workspaceRevision;
    const now = this.ports.now();
    let verifyContext = op.prepare ? op.prepare(state, req) : null;
    // Persist BEFORE dispatch so a worker restart can reconcile.
    await this.writeJournal(req.actionId, { request: req, status: 'executing', beforeRevision, verifyContext, createdAt: now, updatedAt: now });

    try {
      // Last-moment pause check (stop takes effect at the broker boundary).
      if (await this.ports.isPaused(req.target.appId)) {
        const r = { ...this.fail(req, 'APP_PAUSED', 'Stopped before dispatch.'), status: 'cancelled' as const, beforeRevision };
        await this.writeJournal(req.actionId, { request: req, status: 'cancelled', beforeRevision, verifyContext, createdAt: now, updatedAt: this.ports.now(), result: r });
        return r;
      }
      let dispatchError: string | null = null;
      let definitelyNotDispatched = false;
      let timedOut = false;
      const timeout = this.ports.executeTimeoutMs ?? 10_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const dispatch = await Promise.race([
          adapter.execute(req, cap).then((d) => {
            if (!d.dispatched) {
              dispatchError = d.detail ?? 'not dispatched';
              definitelyNotDispatched = true;
            }
            return d;
          }),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => {
              timedOut = true;
              rej(new Error('timeout'));
            }, timeout);
          }),
        ]);
        if (dispatch.dispatched && op.captureReceipt) {
          verifyContext = op.captureReceipt(verifyContext, dispatch.receipt);
          // A crash before this write leaves no durable receipt: reconciliation
          // must stay unknown, even if a matching object is visible.
          await this.writeJournal(req.actionId, { request: req, status: 'executing', beforeRevision, verifyContext, createdAt: now, updatedAt: this.ports.now() });
        }
      } catch (e) {
        if (!timedOut) dispatchError = String((e as Error).message ?? e);
      } finally {
        clearTimeout(timer);
      }

      // Independent read-back regardless of what execute reported.
      let after: ObservedState | null = null;
      try {
        after = await adapter.readState(req.target);
      } catch {
        after = null;
      }
      const outcome = after ? op.verify(after, req, verifyContext) : null;

      let result: ActionResult;
      if (outcome?.verified && !definitelyNotDispatched) {
        result = {
          actionId: req.actionId,
          status: 'verified',
          beforeRevision,
          afterRevision: outcome.afterRevision,
          observedPostcondition: outcome.observed,
          errorCode: null,
          message: 'Requested state observed by reading the app again.',
          recoveryOptions: [],
        };
      } else if (definitelyNotDispatched && !timedOut) {
        result = {
          ...this.fail(req, 'ADAPTER_ERROR', `Not applied: ${dispatchError}`, ['open-original']),
          beforeRevision,
          observedPostcondition: outcome?.observed ?? null,
        };
      } else {
        result = {
          actionId: req.actionId,
          status: 'unknown',
          beforeRevision,
          afterRevision: null,
          observedPostcondition: outcome?.observed ?? null,
          errorCode: timedOut ? 'OUTCOME_UNKNOWN' : 'POSTCONDITION_NOT_OBSERVED',
          message: 'Could not confirm whether this change happened. It will not be retried automatically. Check the original app, then reconcile.',
          recoveryOptions: ['reconcile', 'open-original'],
        };
      }
      await this.writeJournal(req.actionId, { request: req, status: result.status, beforeRevision, verifyContext, createdAt: now, updatedAt: this.ports.now(), result });
      return result;
    } finally {
      this.locks.delete(lockKey);
    }
  }

  /**
   * Re-check journal entries left executing/unknown (e.g. after service-worker termination).
   * Never re-dispatches. Marks verified only if the postcondition is observed now.
   */
  private async reconcileExclusive(): Promise<JournalEntry[]> {
    const j = await this.journal();
    const changed: JournalEntry[] = [];
    for (const [id, e] of Object.entries(j)) {
      if (e.status !== 'executing' && e.status !== 'unknown') continue;
      const found = this.findOp(e.request.capabilityId);
      if (!found) continue;
      let after: ObservedState | null = null;
      try {
        after = await found.adapter.readState(e.request.target);
      } catch {
        after = null;
      }
      if (!after) {
        if (e.status === 'executing') {
          e.status = 'unknown';
          e.updatedAt = this.ports.now();
          changed.push(e);
        }
        continue;
      }
      const v = found.op.verify(after, e.request, e.verifyContext ?? null);
      e.status = v.verified ? 'verified' : 'unknown';
      e.updatedAt = this.ports.now();
      e.result = {
        actionId: id,
        status: e.status,
        beforeRevision: e.beforeRevision,
        afterRevision: v.afterRevision,
        observedPostcondition: v.observed,
        errorCode: v.verified ? null : 'POSTCONDITION_NOT_OBSERVED',
        message: v.verified ? 'Reconciled: the change is present in the app.' : 'Reconciled: the change is not visible in the app. Resolve manually or dismiss.',
        recoveryOptions: v.verified ? [] : ['dismiss', 'open-original'],
      };
      changed.push(e);
    }
    await this.ports.kv.set(JOURNAL_KEY, j);
    return changed;
  }

  /** User-confirmed dismissal of an unresolved entry (marks failed; frees the target lock). */
  private async dismissExclusive(actionId: string): Promise<boolean> {
    const j = await this.journal();
    const e = j[actionId];
    if (!e || (e.status !== 'unknown' && e.status !== 'executing')) return false;
    e.status = 'failed';
    e.updatedAt = this.ports.now();
    await this.ports.kv.set(JOURNAL_KEY, j);
    return true;
  }
}
