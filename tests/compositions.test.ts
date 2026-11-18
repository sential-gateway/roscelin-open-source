// Milestone 1 slice 4: Guided steps (guided-task) and comparing two items (compare-items).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guidedStep, compareRows } from '../packages/renderer/src/render.ts';
import { validateSurface, stateFields } from '../packages/schemas/src/validate.ts';
import { deterministicSurface, classifyIntent } from '../packages/planner/src/planner.ts';
import { defaultProfile } from '../packages/schemas/src/profile.ts';
import * as vik from '../packages/adapters/src/vikunja/ops.ts';
import * as fixture from '../packages/adapters/src/reference-tasks/ops.ts';
import { FakeApp } from './helpers.ts';

const vt = (id: number, title: string, done: boolean, priority: number) => ({ id, title, description: '', done, priority, project_id: 2, updated: '2026-11-18T10:00:00Z' });
const vState = vik.buildState({ origin: 'http://localhost:3456', accountId: 1, project: { id: 2, title: 'S' }, observedAt: 1, tasks: [vt(1, 'Alpha', false, 3), vt(2, 'Beta', true, 3), vt(3, 'Gamma', false, 1)] });
const vCaps = [...vik.OPS.map((o) => o.capability), ...vik.READ_CAPS];
const fxCaps = [...fixture.OPS.map((o) => o.capability), ...fixture.READ_CAPS];
const [a, b] = vState.collections.tasks;

test('guidedStep: choose until something is selected, change while editing, done after a verified change', () => {
  assert.equal(guidedStep({ verifiedId: null, draft: null }, undefined), 1);
  assert.equal(guidedStep({ verifiedId: null, draft: { status: 'open' } }, a), 2);
  assert.equal(guidedStep({ verifiedId: a.objectId, draft: { status: 'done' } }, a), 2, 'editing again after a confirmed change');
  assert.equal(guidedStep({ verifiedId: a.objectId, draft: null }, a), 4);
  assert.equal(guidedStep({ verifiedId: b.objectId, draft: null }, a), 2, 'a different item was confirmed');
});

test('compareRows: one row per field, differences flagged', () => {
  const rows = compareRows(a, b, ['title', 'status', 'priority']);
  assert.deepEqual(rows.map((r) => [r.field, r.differs]), [['title', true], ['status', true], ['priority', false]]);
  assert.deepEqual(rows[1], { field: 'status', a: 'open', b: 'done', differs: true });
});

test('planner routing: guided and two-item comparison get their own layouts; group compare and focus unchanged', () => {
  const p = defaultProfile();
  assert.equal(classifyIntent('Guide me through changing one task at a time', p), 'guided-edit');
  for (const i of ['Compare two tasks', 'What is the difference between these two', 'Alpha versus Gamma']) assert.equal(classifyIntent(i, p), 'compare-items', i);
  assert.equal(classifyIntent('Compare tasks side by side by status', p), 'compare');
  assert.equal(classifyIntent('What needs my attention now?', p), 'focus');
});

test('Guided and Compare-two layouts are valid for Vikunja and the fixture; three compositions are genuinely different', () => {
  for (const [name, caps, state] of [['vikunja', vCaps, vState], ['fixture', fxCaps, new FakeApp().state()]] as const) {
    const appCaps = caps.filter((c) => c.appId === state.appId);
    const comps: Record<string, string[]> = {};
    for (const intent of ['Guided, one task at a time', 'Compare two tasks', 'What needs my attention now?']) {
      const s = deterministicSurface(intent, defaultProfile(), appCaps, state);
      const v = validateSurface(s, appCaps, stateFields(state));
      assert.ok(v.ok, `${name} / ${intent}: ${v.errors.join('; ')}`);
      comps[intent] = s.root.children!.map((c) => c.component);
    }
    assert.ok(comps['Guided, one task at a time'].includes('guided-task'), JSON.stringify(comps));
    assert.ok(comps['Compare two tasks'].includes('compare-items'), JSON.stringify(comps));
    assert.ok(comps['What needs my attention now?'].includes('attention'), JSON.stringify(comps));
    assert.equal(new Set(Object.values(comps).map((x) => x.join(','))).size, 3, `${name}: compositions differ`);
  }
});

test('validator: guided-task is an update action that needs bind; compare-items needs bind and known fields', () => {
  const surface = (node: Record<string, unknown>, capabilityIds: string[] = []) => ({ schemaVersion: 1, surfaceId: 'g', title: 'G', generatedBy: 'model', rationale: 'x', bindings: { adapterId: vik.ADAPTER_ID, adapterVersion: vik.ADAPTER_VERSION, capabilityIds }, root: { component: 'stack', children: [{ component: 'provenance' }, node] } });
  const check = (node: Record<string, unknown>, ids: string[] = []) => validateSurface(surface(node, ids), vCaps, stateFields(vState));
  assert.ok(check({ component: 'guided-task', bind: 'tasks', capabilityId: 'vikunja.task.update', props: { fields: ['title', 'status'] } }, ['vikunja.task.update']).ok, 'guided-task alone is enough: it chooses its own item');
  assert.ok(check({ component: 'compare-items', bind: 'tasks', props: { fields: ['title', 'priority'] } }).ok);
  const cases: [Record<string, unknown>, string[], RegExp][] = [
    [{ component: 'guided-task', bind: 'tasks' }, [], /guided-task requires capabilityId/],
    [{ component: 'guided-task', capabilityId: 'vikunja.task.update' }, ['vikunja.task.update'], /guided-task needs bind/],
    [{ component: 'guided-task', bind: 'tasks', capabilityId: 'vikunja.task.create' }, ['vikunja.task.create'], /guided-task needs a update capability/],
    [{ component: 'guided-task', bind: 'tasks', capabilityId: 'vikunja.task.update', props: { fields: ['description'] } }, ['vikunja.task.update'], /description is not an argument/],
    [{ component: 'compare-items', props: { fields: ['title'] } }, [], /compare-items needs bind/],
    [{ component: 'compare-items', bind: 'tasks', props: { fields: ['assignee'] } }, [], /assignee is not a field of tasks/],
    [{ component: 'compare-items', bind: 'tasks', capabilityId: 'vikunja.task.update' }, ['vikunja.task.update'], /compare-items cannot carry a capability/],
  ];
  for (const [node, ids, re] of cases) {
    const v = check(node, ids);
    assert.equal(v.ok, false, JSON.stringify(node));
    assert.ok(v.errors.some((e) => re.test(e)), `${JSON.stringify(node)}: ${v.errors.join('; ')}`);
  }
});

