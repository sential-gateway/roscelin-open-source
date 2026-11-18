import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSurface } from '../packages/schemas/src/validate.ts';
import { defaultProfile, migrateProfile, exportProfile } from '../packages/schemas/src/profile.ts';
import { planSurface, deterministicSurface, buildContext } from '../packages/planner/src/planner.ts';
import type { ModelGateway } from '../packages/planner/src/planner.ts';
import { CAPS, OPS, READ_CAPS } from '../packages/adapters/src/reference-tasks/ops.ts';
import { FakeApp } from './helpers.ts';

const caps = [...OPS.map((o) => o.capability), ...READ_CAPS];
const state = new FakeApp().state();
const cols = Object.keys(state.collections);

const good = () => deterministicSurface('compact keyboard', defaultProfile(), caps, state);

test('deterministic surfaces validate', () => {
  for (const intent of ['compact with shortcuts', 'guided step by step', 'compare by status', 'show the document and its tasks together']) {
    const s = deterministicSurface(intent, defaultProfile(), caps, state);
    const v = validateSurface(s, caps, cols);
    assert.ok(v.ok, `${intent}: ${v.errors.join('; ')}`);
  }
});

test('three intents yield materially different layouts', () => {
  const ids = new Set(['compact keyboard', 'guided step', 'compare side by side'].map((i) => deterministicSurface(i, defaultProfile(), caps, state).surfaceId));
  assert.equal(ids.size, 3);
});

test('rejects unknown component', () => {
  const s = good();
  s.root.children!.push({ component: 'iframe' as never });
  assert.ok(!validateSurface(s, caps, cols).ok);
});

test('rejects invented capability (email.send when only tasks exposed)', () => {
  const s = good();
  s.root.children!.push({ component: 'create-form', capabilityId: 'reference-tasks.email.send', props: { fields: ['to'] } });
  const v = validateSurface(s, caps, cols);
  assert.ok(!v.ok);
  assert.ok(v.errors.some((e) => e.includes('unknown capability')));
});

test('rejects capability on non-action component and undeclared capability', () => {
  const s = good();
  s.root.children!.push({ component: 'list', capabilityId: CAPS.update.id, bind: 'tasks' });
  assert.ok(!validateSurface(s, caps, cols).ok);
  const s2 = good();
  s2.bindings.capabilityIds = [CAPS.update.id];
  s2.root.children!.push({ component: 'create-form', capabilityId: CAPS.create.id });
  assert.ok(!validateSurface(s2, caps, cols).ok);
});

test('rejects script, event handlers and exfiltration URLs in props', () => {
  for (const text of ['<script>alert(1)</script>', 'click javascript:alert(1)', 'img onerror=steal()', 'see https://evil.example/?d=', 'file://C:/x']) {
    const s = good();
    s.root.children!.push({ component: 'text', props: { text } });
    assert.ok(!validateSurface(s, caps, cols).ok, text);
  }
});

test('rejects unknown props, unknown keys, bad bindings', () => {
  const a = good();
  a.root.children!.push({ component: 'text', props: { html: '<b>x</b>' } as never });
  assert.ok(!validateSurface(a, caps, cols).ok);
  const b = good() as unknown as Record<string, unknown>;
  b.script = 'fetch()';
  assert.ok(!validateSurface(b, caps, cols).ok);
  const c = good();
  c.root.children!.push({ component: 'list', bind: 'cookies' });
  assert.ok(!validateSurface(c, caps, cols).ok);
});

test('rejects malformed JSON, excessive nesting and node count, oversize payloads', () => {
  assert.ok(!validateSurface('{"schemaVersion":1,', caps, cols).ok);
  const deep = good();
  let n = deep.root;
  for (let i = 0; i < 12; i++) {
    const c = { component: 'stack' as const, children: [] as never[] };
    n.children = [c];
    n = c;
  }
  assert.ok(!validateSurface(deep, caps, cols).ok);
  const wide = good();
  wide.root.children = Array.from({ length: 200 }, () => ({ component: 'shortcut-help' as const }));
  assert.ok(!validateSurface(wide, caps, cols).ok);
  const big = good();
  big.root.children = Array.from({ length: 149 }, () => ({ component: 'text' as const, props: { text: 'x'.repeat(399) } }));
  assert.ok(!validateSurface(big, caps, cols).ok);
});

test('planner falls back when model returns invented actions', async () => {
  const evil: ModelGateway = {
    name: 'evil',
    async generate() {
      const s = good();
      s.root.children!.push({ component: 'create-form', capabilityId: 'reference-tasks.email.send' });
      return JSON.stringify(s);
    },
  };
  const r = await planSurface('compact', defaultProfile(), caps, state, evil);
  assert.equal(r.source, 'deterministic-fallback');
  assert.ok(r.notes[0].startsWith('Model output rejected'));
});

test('planner falls back on timeout and on garbage', async () => {
  const slow: ModelGateway = { name: 'slow', generate: (_c, signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))) };
  const r = await planSurface('compact', defaultProfile(), caps, state, slow, 20);
  assert.equal(r.source, 'deterministic-fallback');
  const junk: ModelGateway = { name: 'junk', generate: async () => 'not json' };
  assert.equal((await planSurface('x', defaultProfile(), caps, state, junk)).source, 'deterministic-fallback');
});

test('planner accepts a valid model surface', async () => {
  const ok: ModelGateway = { name: 'ok', generate: async () => JSON.stringify({ ...good(), generatedBy: 'model', title: 'Model layout' }) };
  const r = await planSurface('x', defaultProfile(), caps, state, ok);
  assert.equal(r.source, 'model');
});

test('planner context is content-free (no task titles or document text)', () => {
  const ctx = JSON.stringify(buildContext('show tasks', defaultProfile(), caps, state));
  assert.ok(!ctx.includes('Draft outline'));
  assert.ok(!ctx.includes('Review sources'));
});

test('profile migration from v0 and sanitization', () => {
  const p = migrateProfile({ fontScale: 5, highContrast: true, density: 'weird', pinnedControls: ['a', 3], password: 'hunter2', perApp: { x: { paused: true, token: 'abc' } } });
  assert.equal(p.textScale, 2);
  assert.equal(p.contrast, 'high');
  assert.equal(p.density, 'comfortable');
  assert.deepEqual(p.pinnedControls, ['a']);
  assert.deepEqual(p.perApp.x, { paused: true });
  assert.ok(!('password' in p));
});

test('profile export contains no secrets or unknown fields', () => {
  const p = { ...defaultProfile(), apiKey: 'sk-live-123', cookie: 'sid=1' } as never;
  const out = exportProfile(p);
  assert.ok(!out.includes('sk-live'));
  assert.ok(!out.includes('sid='));
});

test('surface adapter identity/version must match the active registry', () => {
 for(const mutation of [{adapterId:'unrelated.adapter'},{adapterVersion:'99.0.0'}]) {
  const surface=good();Object.assign(surface.bindings,mutation);
  assert.equal(validateSurface(surface,caps,cols).ok,false);
 }
 assert.equal(validateSurface(good(),[],cols).ok,false);
 assert.equal(validateSurface(good(),[...caps,{...caps[0],adapterVersion:'99.0.0'}],cols).ok,false);
});
test('planner rejects model surface from a different adapter and uses validated fallback', async () => {
 const surface=good();surface.bindings.adapterId='unrelated.adapter';
 const result=await planSurface('compact',defaultProfile(),caps,state,{name:'synthetic',generate:async()=>JSON.stringify(surface)});
 assert.equal(result.source,'deterministic-fallback');
 assert.ok(result.notes.some(n=>n.includes('adapter identity/version')));
});
