// KNOWN LIMITATION, reproduced live: the same-field write race in Vikunja v2.8.0.
// Vikunja offers no conditional write (v2 PATCH ignores If-Match; v1 has none). The adapter re-reads and checks the
// revision immediately before writing, but a write by another client that lands AFTER that check and BEFORE our
// PATCH is overwritten if it touched the same field. These tests inject exactly that interleaving to document
// what happens. They PASS when the behaviour matches the documented limitation; a future fix should flip them.
//   node scripts/vikunja/instance.mjs reset && node --test tests-live/vikunja.race.test.ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Broker } from '../packages/broker/src/broker.ts';
import type { KV } from '../packages/broker/src/broker.ts';
import { makeVikunjaAdapter, makeFetchHttp, CAPS } from '../packages/adapters/src/vikunja/ops.ts';
import type { ActionRequest, ObservedState } from '../packages/schemas/src/contracts.ts';
// @ts-ignore — plain ESM helper
import { SEED_FILE, API_BASE, loginJwt } from '../scripts/vikunja/instance.mjs';

const ORIGIN = 'http://localhost:3456';
let seed: any;
let jwt: string;

class MemKV implements KV {
  m = new Map<string, string>();
  async get<T>(k: string) { const v = this.m.get(k); return v === undefined ? undefined : (JSON.parse(v) as T); }
  async set(k: string, v: unknown) { this.m.set(k, JSON.stringify(v)); }
  async remove(k: string) { this.m.delete(k); }
}

async function asApp(method: string, path: string, body?: unknown) {
  const r = await fetch(`${API_BASE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

/** Network that runs `interleave()` (another client's write) right before forwarding our PATCH. */
function racingNet(interleave: () => Promise<void>) {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input).replace(ORIGIN, API_BASE);
    if ((init?.method ?? 'GET').toUpperCase() === 'PATCH') await interleave();
    return fetch(url, init);
  };
  return makeFetchHttp(async () => seed.apiToken, fetchImpl, 4000);
}

function mk(http: ReturnType<typeof makeFetchHttp>) {
  const adapter = makeVikunjaAdapter(http);
  const broker = new Broker({ kv: new MemKV(), adapters: [adapter], hasPermission: async () => true, isPaused: async () => false, now: () => Date.now(), randomId: () => Math.random().toString(36).slice(2), executeTimeoutMs: 4000 });
  return { adapter, broker };
}

function req(s: ObservedState, objectId: string, args: Record<string, string>): ActionRequest {
  const now = Date.now();
  const obj = s.collections.tasks.find((t) => t.objectId === objectId)!;
  return { actionId: `race-${now}-${Math.random().toString(36).slice(2, 8)}`, capabilityId: CAPS.update.id, target: { appId: 'vikunja', origin: ORIGIN, documentInstanceId: s.documentInstanceId, objectId, display: { app: 'Vikunja', document: s.documentTitle } }, expectedRevision: obj.revision, args, approvalToken: null, createdAt: now, expiresAt: now + 60_000 };
}

before(async () => {
  seed = JSON.parse(await readFile(SEED_FILE(), 'utf8'));
  jwt = await loginJwt();
});

test('KNOWN LIMITATION: same-field write by another client inside the pre-write→PATCH window is silently overwritten', async () => {
  const id = seed.taskIds[0];
  const http = racingNet(async () => {
    const t = await asApp('GET', `/tasks/${id}`);
    await asApp('POST', `/tasks/${id}`, { ...t, title: 'Title written by another client' });
  });
  const { adapter, broker } = mk(http);
  const s = await adapter.readContext({ origin: ORIGIN, projectId: seed.projectId });
  const r = await broker.execute(req(s, String(id), { title: 'Title written by the adapter' }));
  const final = await asApp('GET', `/tasks/${id}`);
  // What actually happens today:
  assert.equal(r.status, 'verified', 'the adapter reports success…');
  assert.equal(final.title, 'Title written by the adapter', '…and the other client\'s title is lost, with no warning to either side');
});

test('CONTROL: a different-field write inside the same window is preserved (partial PATCH)', async () => {
  const id = seed.taskIds[1];
  const http = racingNet(async () => {
    const t = await asApp('GET', `/tasks/${id}`);
    await asApp('POST', `/tasks/${id}`, { ...t, description: '<p>description written by another client</p>' });
  });
  const { adapter, broker } = mk(http);
  const s = await adapter.readContext({ origin: ORIGIN, projectId: seed.projectId });
  const r = await broker.execute(req(s, String(id), { priority: 'urgent' }));
  const final = await asApp('GET', `/tasks/${id}`);
  assert.equal(final.priority, 4);
  assert.equal(final.description, '<p>description written by another client</p>', 'other client\'s different-field change survives');
  // The untouched-field fingerprint notices that something else changed during our write and refuses to call it verified.
  assert.notEqual(r.status, 'verified', `status ${r.status}: ${r.observedPostcondition}`);
});

test('OUTSIDE the window (before the pre-write check): same-field change is refused as stale, nothing written', async () => {
  const id = seed.taskIds[2];
  const http = racingNet(async () => {});
  const { adapter, broker } = mk(http);
  const s = await adapter.readContext({ origin: ORIGIN, projectId: seed.projectId });
  const t = await asApp('GET', `/tasks/${id}`);
  await asApp('POST', `/tasks/${id}`, { ...t, title: 'Changed before the adapter wrote' });
  const r = await broker.execute(req(s, String(id), { title: 'Adapter title' }));
  assert.equal(r.errorCode, 'STALE_REVISION');
  assert.equal((await asApp('GET', `/tasks/${id}`)).title, 'Changed before the adapter wrote');
});
