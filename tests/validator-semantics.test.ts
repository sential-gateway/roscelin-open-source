// Every deterministic (rule-based) layout must pass the stricter field-aware validator, for both apps,
// every layout class and the profile variations that change it. The rule-based layout is the fallback,
// so it can never be one the validator rejects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSurface, collectionFields } from '../packages/schemas/src/validate.ts';
import { defaultProfile } from '../packages/schemas/src/profile.ts';
import { deterministicSurface } from '../packages/planner/src/planner.ts';
import * as fixture from '../packages/adapters/src/reference-tasks/ops.ts';
import * as vik from '../packages/adapters/src/vikunja/ops.ts';
import { FakeApp } from './helpers.ts';

const vtk = (id: number, title: string, done: boolean, priority: number) => ({ id, title, description: '', done, priority, project_id: 2, updated: '2026-11-17T10:00:00Z' });
const apps = [
  { name: 'reference fixture', caps: [...fixture.OPS.map((o) => o.capability), ...fixture.READ_CAPS], state: new FakeApp().state() },
  { name: 'vikunja', caps: [...vik.OPS.map((o) => o.capability), ...vik.READ_CAPS], state: vik.buildState({ origin: 'http://localhost:3456', accountId: 1, project: { id: 2, title: 'Synthetic' }, observedAt: 1, tasks: [vtk(1, 'A', false, 3), vtk(2, 'B', true, 1)] }) },
  { name: 'vikunja (empty project)', caps: [...vik.OPS.map((o) => o.capability), ...vik.READ_CAPS], state: vik.buildState({ origin: 'http://localhost:3456', accountId: 1, project: { id: 2, title: 'Empty' }, observedAt: 1, tasks: [] }) },
];
const intents = ['compact keyboard', 'guide me step by step', 'compare by status', 'make this easier', 'dense expert view', 'add tasks quickly', ''];
const profiles = [defaultProfile(), { ...defaultProfile(), keyboardFirst: true, density: 'compact' as const }, { ...defaultProfile(), textScale: 1.6, vocabulary: 'plain' as const }];

test('every deterministic layout passes the field-aware validator (both apps, all intents and profiles)', () => {
  let n = 0;
  for (const app of apps) {
    const fields = collectionFields(app.state.collections);
    for (const intent of intents) for (const profile of profiles) {
      const s = deterministicSurface(intent, profile, app.caps.filter((c) => c.appId === app.state.appId), app.state);
      const v = validateSurface(s, app.caps.filter((c) => c.appId === app.state.appId), fields);
      assert.ok(v.ok, `${app.name} / "${intent}" / ${JSON.stringify(profile).slice(0, 60)}: ${v.errors.join('; ')}`);
      n++;
    }
  }
  assert.equal(n, apps.length * intents.length * profiles.length);
});

test('empty collection: fields unknown, so field checks are skipped but the collection name is still enforced', () => {
  const app = apps[2];
  const caps = app.caps.filter((c) => c.appId === app.state.appId);
  const fields = collectionFields(app.state.collections);
  const s = deterministicSurface('compact keyboard', defaultProfile(), caps, app.state) as any;
  s.root.children.push({ component: 'list', bind: 'emails', props: { fields: ['title'] } });
  const v = validateSurface(s, caps, fields);
  assert.ok(v.errors.some((e) => /unsupported binding emails/.test(e)), v.errors.join('; '));
});

test('collectionFields unions object fields and drops adapter-internal ones', () => {
  const f = collectionFields({ tasks: [{ fields: { title: 'a', _raw: 1 } }, { fields: { status: 'open' } }], empty: [] });
  assert.deepEqual(f, { tasks: ['title', 'status'], empty: null });
});

test('declared fields: an empty Vikunja project is fully field-checked and the planner context still names its fields', async () => {
  const { stateFields } = await import('../packages/schemas/src/validate.ts');
  const { buildContext } = await import('../packages/planner/src/planner.ts');
  const app = apps[2];
  const caps = app.caps.filter((c) => c.appId === app.state.appId);
  const fields = stateFields(app.state);
  assert.deepEqual(fields.tasks, ['title', 'status', 'priority'], 'declared, not unknown');
  const s = deterministicSurface('compact keyboard', defaultProfile(), caps, app.state) as any;
  assert.ok(validateSurface(s, caps, fields).ok, 'rule-based layout valid with declared fields');
  s.root.children.push({ component: 'list', bind: 'tasks', props: { fields: ['assignee'] } });
  const v = validateSurface(s, caps, fields);
  assert.ok(v.errors.some((e) => /assignee is not a field of tasks/.test(e)), v.errors.join('; '));
  const ctx = buildContext('x', defaultProfile(), caps, app.state);
  assert.deepEqual(ctx.collections, [{ name: 'tasks', fields: ['title', 'status', 'priority'], count: 0 }]);
});

test('declared fields are authoritative over observed ones; adapter-internal names are dropped', () => {
  const f = collectionFields({ tasks: [{ fields: { title: 'a', extra: 1 } }] }, { tasks: ['title', 'status', '_hidden'] });
  assert.deepEqual(f.tasks, ['title', 'status']);
});

test('every deterministic layout also passes with declared fields (both apps, all intents and profiles)', async () => {
  const { stateFields } = await import('../packages/schemas/src/validate.ts');
  for (const app of apps) {
    const caps = app.caps.filter((c) => c.appId === app.state.appId);
    for (const intent of intents) for (const profile of profiles) {
      const v = validateSurface(deterministicSurface(intent, profile, caps, app.state), caps, stateFields(app.state));
      assert.ok(v.ok, `${app.name} / "${intent}": ${v.errors.join('; ')}`);
    }
  }
});
