// Milestone 1 slice 5: refining a proposal with plain requests (deterministic edits, validated, history in the panel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refineSurface } from '../packages/planner/src/refine.ts';
import { deterministicSurface } from '../packages/planner/src/planner.ts';
import { validateSurface, stateFields } from '../packages/schemas/src/validate.ts';
import { defaultProfile } from '../packages/schemas/src/profile.ts';
import * as vik from '../packages/adapters/src/vikunja/ops.ts';
import type { UISurface, UINode } from '../packages/schemas/src/ui-schema.ts';

const vt = (id: number, title: string, done: boolean, priority: number) => ({ id, title, description: '', done, priority, project_id: 2, updated: '2026-11-18T10:00:00Z' });
const state = vik.buildState({ origin: 'http://localhost:3456', accountId: 1, project: { id: 2, title: 'S' }, observedAt: 1, tasks: [vt(1, 'A', false, 3), vt(2, 'B', true, 1)] });
const caps = [...vik.OPS.map((o) => o.capability), ...vik.READ_CAPS].filter((c) => c.appId === state.appId);
const base = (intent: string) => deterministicSurface(intent, defaultProfile(), caps, state);
const all = (s: UISurface) => { const out: UINode[] = []; const w = (n: UINode) => { out.push(n); (n.children ?? []).forEach(w); }; w(s.root); return out; };
const lists = (s: UISurface) => all(s).filter((n) => n.component === 'list');
const valid = (s: UISurface) => { const v = validateSurface(s, caps, stateFields(state)); assert.ok(v.ok, v.errors.join('; ')); };

test('several refinements in one request apply in order, each explained, and the result validates', () => {
  const b = base('Show the tasks');
  const r = refineSurface(b, 'more compact, show priority first, hide status', caps, state)!;
  assert.deepEqual(r.changes, ['Made the list compact', 'Showed Priority first', 'Hid Status']);
  const l = lists(r.surface)[0];
  assert.equal(l.props!.compact, true);
  assert.deepEqual(l.props!.fields, ['priority', 'title']);
  assert.match(r.surface.rationale, /Refined: Made the list compact; Showed Priority first; Hid Status\./);
  valid(r.surface);
  assert.notDeepEqual(b, r.surface, 'the base proposal is not mutated');
  assert.equal(lists(b)[0].props!.compact, false);
});

test('add and remove the create form; keyboard shortcuts; less compact', () => {
  const focus = base('What needs my attention now?');
  const withCreate = refineSurface(focus, 'let me add new tasks too', caps, state)!;
  assert.deepEqual(withCreate.changes, ['Added a form for adding tasks']);
  assert.ok(all(withCreate.surface).some((n) => n.component === 'create-form') && withCreate.surface.bindings.capabilityIds.includes('vikunja.task.create'));
  valid(withCreate.surface);
  const without = refineSurface(withCreate.surface, 'remove the create form', caps, state)!;
  assert.deepEqual(without.changes, ['Removed the form for adding tasks']);
  assert.ok(!all(without.surface).some((n) => n.component === 'create-form') && !without.surface.bindings.capabilityIds.includes('vikunja.task.create'));
  valid(without.surface);
  const keys = refineSurface(base('Show the tasks'), 'add keyboard shortcuts', caps, state)!;
  assert.ok(all(keys.surface).some((n) => n.component === 'shortcut-help') && lists(keys.surface)[0].props!.shortcutKeys === true);
  valid(keys.surface);
  const roomy = refineSurface(base('Compact list with keyboard shortcuts'), 'more space please', caps, state)!;
  assert.equal(lists(roomy.surface)[0].props!.compact, false);
});

test('top N limits the Focus view; it is refused where there is nothing to limit', () => {
  const r = refineSurface(base('What needs my attention now?'), 'only the top 3', caps, state)!;
  assert.deepEqual(r.changes, ['Showing the top 3']);
  assert.equal(all(r.surface).find((n) => n.component === 'attention')!.props!.limit, 3);
  valid(r.surface);
  assert.equal(refineSurface(base('Show the tasks'), 'top 3', caps, state), null, 'no attention view: not understood');
});

test('never removes the last field; reports fields that are not shown; unknown requests return null', () => {
  const b = base('Show the tasks');
  const once = refineSurface(b, 'hide status, hide priority', caps, state)!;
  assert.deepEqual(lists(once.surface)[0].props!.fields, ['title']);
  const last = refineSurface(once.surface, 'hide title', caps, state)!;
  assert.deepEqual(last.changes, ['Kept Title: it is the only thing shown']);
  assert.deepEqual(lists(last.surface)[0].props!.fields, ['title']);
  assert.equal(refineSurface(b, 'make it purple with sparkles', caps, state), null);
  assert.equal(refineSurface(b, 'show assignee', caps, state), null, 'unknown field is not invented');
  const mixed = refineSurface(b, 'more compact, make it sparkle', caps, state)!;
  assert.deepEqual(mixed.changes, ['Made the list compact']);
  assert.deepEqual(mixed.notUnderstood, ['make it sparkle']);
});

test('synonyms map to real fields; refinement keeps rationale under the validator limit', () => {
  const r = refineSurface(base('Show the tasks'), 'show priorities first', caps, state)!;
  assert.deepEqual(r.changes, ['Showed Priority first']);
  let s = r.surface;
  for (let i = 0; i < 30; i++) s = refineSurface(s, i % 2 ? 'more compact' : 'more space', caps, state)!.surface;
  assert.ok(s.rationale.length <= 400);
  valid(s);
});
