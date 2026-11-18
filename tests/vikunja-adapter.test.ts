// Offline tests of the Vikunja adapter logic (mapping, full-object update, verification, scoping).
// Live behaviour against a real Vikunja v2.8.0 instance is covered separately in tests-live/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyArgs, buildState, toObject, parseVikunjaUrl, parseDocumentId, documentId, OPS, CAPS, makeVikunjaAdapter, HttpError, revisionOf, patchBody,
} from '../packages/adapters/src/vikunja/ops.ts';
import type { VTask, VikunjaHttp } from '../packages/adapters/src/vikunja/ops.ts';
import type { ActionRequest } from '../packages/schemas/src/contracts.ts';

const O = 'http://localhost:3456';
const task = (over: Partial<VTask> = {}): VTask => ({
  id: 7, title: 'Draft copy', description: '<p>keep me</p>', done: false, priority: 3, project_id: 2,
  updated: '2026-11-17T10:00:00Z', due_date: '2026-12-01T00:00:00Z', hex_color: 'ff0000', percent_done: 0.5, repeat_after: 0, repeat_mode: 0, ...over,
});
const updateOp = OPS.find((o) => o.capability.id === CAPS.update.id)!;
const req = (args: Record<string, string>, expectedRevision: number | null = revisionOf(task())): ActionRequest => ({
  actionId: 'act-12345678', capabilityId: CAPS.update.id,
  target: { appId: 'vikunja', origin: O, documentInstanceId: documentId(1, 2), objectId: '7', display: { app: 'Vikunja', document: 'p' } },
  expectedRevision, args, approvalToken: null, createdAt: 0, expiresAt: Date.now() + 1e5,
});

test('applyArgs changes only requested fields and keeps the rest of the full task', () => {
  const next = applyArgs(task(), { status: 'done', priority: 'urgent' });
  assert.equal(next.done, true);
  assert.equal(next.priority, 4);
  assert.equal(next.description, '<p>keep me</p>');
  assert.equal(next.due_date, '2026-12-01T00:00:00Z');
  assert.equal(next.hex_color, 'ff0000');
  assert.equal(next.title, 'Draft copy');
});

test('state mapping: status/priority labels, revision from updated, deep link, no description text in state', () => {
  const s = buildState({ origin: O, accountId: 1, project: { id: 2, title: 'Synthetic' }, tasks: [task()], observedAt: 1 });
  const o = s.collections.tasks[0];
  assert.deepEqual([o.fields.status, o.fields.priority, o.revision, o.link], ['open', 'high', revisionOf(task()), `${O}/tasks/7`]);
  assert.ok(!JSON.stringify(s).includes('keep me'), 'description content must not be copied into state');
  assert.equal(s.documentInstanceId, 'vikunja:1:project:2');
});

test('verify passes only when requested fields match, revision moved, and untouched fields are unchanged', () => {
  const before = buildState({ origin: O, accountId: 1, project: { id: 2, title: 'p' }, tasks: [task()], observedAt: 1 });
  const ctx = updateOp.prepare!(before, req({ status: 'done' }));
  const ok = buildState({ origin: O, accountId: 1, project: { id: 2, title: 'p' }, tasks: [task({ done: true, updated: '2026-11-17T10:00:05Z' })], observedAt: 2 });
  assert.equal(updateOp.verify(ok, req({ status: 'done' }), ctx).verified, true);
  // Classic Vikunja pitfall: a partial POST wipes description/due date. Must NOT verify.
  const wiped = buildState({ origin: O, accountId: 1, project: { id: 2, title: 'p' }, tasks: [task({ done: true, description: '', due_date: '0001-01-01T00:00:00Z', updated: '2026-11-17T10:00:05Z' })], observedAt: 2 });
  const v = updateOp.verify(wiped, req({ status: 'done' }), ctx);
  assert.equal(v.verified, false);
  assert.match(v.observed, /OTHER FIELDS CHANGED/);
  // Same-second write (identical `updated`, as observed live) still yields a new revision because content changed.
  const sameSecond = buildState({ origin: O, accountId: 1, project: { id: 2, title: 'p' }, tasks: [task({ done: true })], observedAt: 2 });
  assert.equal(updateOp.verify(sameSecond, req({ status: 'done' }), ctx).verified, true);
});

test('revision changes on any observable content change even when `updated` is identical (1 s resolution)', () => {
  const a = revisionOf(task());
  assert.notEqual(a, revisionOf(task({ priority: 4 })));
  assert.notEqual(a, revisionOf(task({ description: '<p>edited elsewhere</p>' })));
  assert.equal(a, revisionOf(task()));
  assert.deepEqual(patchBody({ status: 'done', priority: 'urgent' }), { done: true, priority: 4 });
});

test('URL parsing: only Vikunja origins; project and task routes', () => {
  assert.deepEqual(parseVikunjaUrl('http://localhost:3456/projects/5/12'), { origin: O, projectId: 5 });
  assert.deepEqual(parseVikunjaUrl('http://localhost:3456/tasks/9'), { origin: O, taskId: 9 });
  assert.equal(parseVikunjaUrl('http://evil.example/projects/5'), null);
  assert.equal(parseVikunjaUrl('http://localhost:3457/projects/5'), null);
  assert.deepEqual(parseDocumentId('vikunja:3:project:9'), { accountId: 3, projectId: 9 });
  assert.equal(parseDocumentId('vikunja:x:project:9'), null);
});

function fakeHttp(tasks: VTask[], userId = 1) {
  const calls: string[] = [];
  const http: VikunjaHttp = {
    async identity() {
      return userId;
    },
    async call<T>(_o: string, method: string, path: string, body?: unknown): Promise<T> {
      calls.push(`${method} ${path}`);
      if (path.startsWith('/projects/') && method === 'GET') return { id: Number(path.split('/')[2]), title: 'P' } as T;
      if (path.startsWith('/tasks?')) return tasks as T; // includes a task from another project on purpose
      const m = /^\/tasks\/(\d+)$/.exec(path);
      if (m && method === 'GET') return tasks.find((t) => t.id === Number(m[1])) as T;
      if (m && method === 'PATCH') {
        const i = tasks.findIndex((t) => t.id === Number(m[1]));
        tasks[i] = { ...tasks[i], ...(body as Partial<VTask>) }; // merge patch; `updated` may stay the same second
        return tasks[i] as T;
      }
      throw new HttpError(404, path);
    },
  };
  return { http, calls };
}

test('readContext scopes to the target project even if the API filter returns extra tasks', async () => {
  const { http } = fakeHttp([task(), task({ id: 8, project_id: 99, title: 'other project' })]);
  const s = await makeVikunjaAdapter(http).readContext({ origin: O, projectId: 2 });
  assert.deepEqual(s.collections.tasks.map((t) => t.objectId), ['7']);
});

test('execute: re-reads before write, refuses stale revision, refuses identity switch, sends a partial PATCH', async () => {
  const tasks = [task()];
  const { http, calls } = fakeHttp(tasks);
  const a = makeVikunjaAdapter(http);
  assert.deepEqual(await a.execute(req({ status: 'done' }, 123), CAPS.update), { dispatched: false, detail: 'revision changed before write' });
  assert.ok(!calls.some((c) => c.startsWith('PATCH') || c.startsWith('POST')));
  const r = await a.execute(req({ status: 'done' }), CAPS.update);
  assert.equal(r.dispatched, true);
  assert.equal(tasks[0].done, true);
  assert.equal(tasks[0].description, '<p>keep me</p>', 'partial update must preserve untouched fields');
  assert.ok(calls.includes('PATCH /tasks/7') && !calls.some((c) => c.startsWith('POST')));
  const other = makeVikunjaAdapter(fakeHttp([task()], 2).http);
  assert.match((await other.execute(req({ status: 'done' }), CAPS.update)).detail ?? '', /different Vikunja (user|connection)/);
});

test('toObject clips very long titles', () => {
  assert.equal(String(toObject(task({ title: 'x'.repeat(5000) }), O).fields.title).length, 2000);
});

test('planner context for Vikunja: no internal fields, no titles, no description, no links', async () => {
  const { buildContext } = await import('../packages/planner/src/planner.ts');
  const { defaultProfile } = await import('../packages/schemas/src/profile.ts');
  const s = buildState({ origin: O, accountId: 1, project: { id: 2, title: 'Secret project' }, tasks: [task({ title: 'Confidential title' })], observedAt: 1 });
  const ctx = JSON.stringify(buildContext('compact please', defaultProfile(), [...OPS.map((o) => o.capability)], s));
  for (const bad of ['_untouched', '_project', 'Confidential title', 'Secret project', 'keep me', '/tasks/7', 'localhost']) assert.ok(!ctx.includes(bad), bad);
  assert.ok(ctx.includes('"fields":["title","status","priority"]'));
});
