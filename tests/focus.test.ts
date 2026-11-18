// Milestone 1 slice 3: the Focus composition ("what needs my attention now") and its attention component.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankAttention } from '../packages/renderer/src/render.ts';
import { validateSurface, stateFields } from '../packages/schemas/src/validate.ts';
import { deterministicSurface, classifyIntent } from '../packages/planner/src/planner.ts';
import { defaultProfile } from '../packages/schemas/src/profile.ts';
import * as vik from '../packages/adapters/src/vikunja/ops.ts';
import * as fixture from '../packages/adapters/src/reference-tasks/ops.ts';
import { FakeApp } from './helpers.ts';

const vt = (id: number, title: string, done: boolean, priority: number) => ({ id, title, description: '', done, priority, project_id: 2, updated: '2026-11-18T10:00:00Z' });
const vState = vik.buildState({ origin: 'http://localhost:3456', accountId: 1, project: { id: 2, title: 'S' }, observedAt: 1, tasks: [vt(1, 'Low one', false, 1), vt(2, 'Urgent one', false, 4), vt(3, 'Done urgent', true, 4), vt(4, 'Unset one', false, 0), vt(5, 'High one', false, 3), vt(6, 'Second urgent', false, 4)] });
const vCaps = [...vik.OPS.map((o) => o.capability), ...vik.READ_CAPS];
const titles = (xs: { fields: Record<string, unknown> }[]) => xs.map((x) => x.fields.title);

test('rankAttention: done items dropped, most important first, ties keep app order, unset last', () => {
  const { open, ranked } = rankAttention(vState.collections.tasks, vState.collectionRoles!.tasks);
  assert.equal(open.length, 5, 'the done task is not open');
  assert.deepEqual(titles(ranked), ['Urgent one', 'Second urgent', 'High one', 'Low one', 'Unset one']);
});

test('rankAttention: without declared roles keeps app order and drops nothing', () => {
  const { open, ranked, order } = rankAttention(vState.collections.tasks);
  assert.equal(order, null);
  assert.equal(open.length, 6);
  assert.deepEqual(titles(ranked), titles(vState.collections.tasks));
});

test('rankAttention: an unknown rank value sorts after known ones', () => {
  const items = [{ objectId: 'a', revision: 1, fields: { title: 'Weird', status: 'open', priority: 'galactic' } }, { objectId: 'b', revision: 1, fields: { title: 'Low', status: 'open', priority: 'low' } }];
  assert.deepEqual(titles(rankAttention(items, vState.collectionRoles!.tasks).ranked), ['Low', 'Weird']);
});

test('planner: attention-style requests get the Focus layout; other intents are unchanged', () => {
  const p = defaultProfile();
  for (const i of ['What needs my attention now?', 'What is most important?', 'What should I do next', 'Show me what is urgent today']) assert.equal(classifyIntent(i, p), 'focus', i);
  assert.equal(classifyIntent('Compare tasks side by side by status', p), 'compare');
  assert.equal(classifyIntent('Guide me one task at a time', p), 'guided-edit');
  assert.equal(classifyIntent('Compact list with keyboard shortcuts', p), 'compact-list');
});

test('Focus layout is valid for Vikunja and the fixture, with attention as the edit form selection source', () => {
  const fxCaps = [...fixture.OPS.map((o) => o.capability), ...fixture.READ_CAPS];
  for (const [name, caps, state] of [['vikunja', vCaps, vState], ['fixture', fxCaps, new FakeApp().state()]] as const) {
    const appCaps = caps.filter((c) => c.appId === state.appId);
    const s = deterministicSurface('What needs my attention now?', defaultProfile(), appCaps, state);
    assert.equal(s.title, 'What needs attention');
    const comps = JSON.stringify(s.root);
    assert.ok(comps.includes('"attention"') && comps.includes('"edit-form"') && !comps.includes('"list"'), `${name}: attention replaces the list`);
    const v = validateSurface(s, appCaps, stateFields(state));
    assert.ok(v.ok, `${name}: ${v.errors.join('; ')}`);
  }
});

test('validator: attention needs bind, limit is an integer 0-20, fields must exist', () => {
  const base = (attn: Record<string, unknown>) => ({ schemaVersion: 1, surfaceId: 'f', title: 'Focus', generatedBy: 'model', rationale: 'x', bindings: { adapterId: vik.ADAPTER_ID, adapterVersion: vik.ADAPTER_VERSION, capabilityIds: [] }, root: { component: 'stack', children: [{ component: 'provenance' }, { component: 'attention', ...attn }] } });
  const check = (attn: Record<string, unknown>) => validateSurface(base(attn), vCaps, stateFields(vState));
  assert.ok(check({ bind: 'tasks', props: { fields: ['title'], limit: 0 } }).ok, 'limit 0 = all');
  assert.ok(check({ bind: 'tasks', props: { limit: 20 } }).ok);
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ props: { limit: 3 } }, /attention needs bind/],
    [{ bind: 'tasks', props: { limit: 21 } }, /limit: must be an integer 0-20/],
    [{ bind: 'tasks', props: { limit: 1.5 } }, /limit: must be an integer 0-20/],
    [{ bind: 'tasks', props: { limit: -1 } }, /limit: must be an integer 0-20/],
    [{ bind: 'tasks', props: { fields: ['assignee'] } }, /assignee is not a field of tasks/],
  ];
  for (const [attn, re] of cases) {
    const v = check(attn);
    assert.equal(v.ok, false, JSON.stringify(attn));
    assert.ok(v.errors.some((e) => re.test(e)), v.errors.join('; '));
  }
});

