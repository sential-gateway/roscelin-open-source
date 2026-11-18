// Live verification of the Vikunja v2.8.0 API details the adapter depends on. Synthetic data only.
// Writes outputs/vikunja-api-probe.json. Uses the least-privilege API token from instance/seed.json.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_FILE, API_BASE } from './instance.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const seed = JSON.parse(await readFile(SEED_FILE(), 'utf8'));
const T = seed.apiToken;

async function call(method, path, body, { v = 'v1', headers = {} } = {}) {
  const r = await fetch(`${API_BASE}/api/${v}${path}`, {
    method,
    headers: { authorization: `Bearer ${T}`, ...(body !== undefined ? { 'content-type': v === 'v2' && method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: r.status, etag: r.headers.get('etag'), json, text: text.slice(0, 300) };
}
const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? '✓' : '✗'} ${name} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };

// 1. Token identity
const u = await call('GET', '/user');
rec('API token may call GET /api/v1/user (account identity)', u.status === 200 && typeof u.json?.id === 'number', { status: u.status, id: u.json?.id, username: u.json?.username });

// 2. Project-scoped task listing via filter
const f = await call('GET', `/tasks?filter=${encodeURIComponent(`project = ${seed.projectId}`)}&per_page=50&sort_by=id&order_by=asc`);
const projIds = [...new Set((f.json ?? []).map((t) => t.project_id))];
rec('filter "project = N" returns only that project', f.status === 200 && projIds.length === 1 && projIds[0] === seed.projectId, { status: f.status, count: f.json?.length, projectIds: projIds });
const fAll = await call('GET', `/tasks?per_page=50`);
rec('(context) unfiltered /tasks spans projects', fAll.status === 200, { count: fAll.json?.length, projectIds: [...new Set((fAll.json ?? []).map((t) => t.project_id))] });

// 3. Partial update wipes untouched fields (on a synthetic task we prepare first)
const tid = seed.taskIds[1];
const base = (await call('GET', `/tasks/${tid}`)).json;
const prepared = await call('POST', `/tasks/${tid}`, { ...base, description: '<p>synthetic description</p>', due_date: '2026-12-24T12:00:00Z', percent_done: 0.5, hex_color: '1973ff', priority: 2 });
rec('(setup) full-object update accepted', prepared.status === 200, { status: prepared.status });
const before = (await call('GET', `/tasks/${tid}`)).json;
const partial = await call('POST', `/tasks/${tid}`, { done: true });
const afterPartial = (await call('GET', `/tasks/${tid}`)).json;
rec('POST /tasks/{id} with a PARTIAL body resets omitted fields', afterPartial && afterPartial.description === '' && afterPartial.priority === 0 && afterPartial.percent_done === 0, {
  status: partial.status, title_after: afterPartial?.title, description_before: before.description, description_after: afterPartial?.description, priority: `${before.priority}→${afterPartial?.priority}`, due: `${before.due_date}→${afterPartial?.due_date}`, color: `${before.hex_color}→${afterPartial?.hex_color}`,
});

// 4. Full-object update preserves untouched fields
await call('POST', `/tasks/${tid}`, { ...before, done: false });
const restored = (await call('GET', `/tasks/${tid}`)).json;
const full = await call('POST', `/tasks/${tid}`, { ...restored, done: true });
const afterFull = (await call('GET', `/tasks/${tid}`)).json;
const kept = ['description', 'priority', 'due_date', 'hex_color', 'percent_done', 'title', 'project_id'].filter((k) => JSON.stringify(afterFull[k]) !== JSON.stringify(restored[k]));
rec('full-object update changes only the intended field', full.status === 200 && afterFull.done === true && kept.length === 0, { changedUnintended: kept });

// 5. `updated` precision and same-second behaviour
const u1 = (await call('GET', `/tasks/${tid}`)).json.updated;
await call('POST', `/tasks/${tid}`, { ...afterFull, title: afterFull.title + ' ·' });
const u2json = (await call('GET', `/tasks/${tid}`)).json;
await call('POST', `/tasks/${tid}`, { ...u2json, title: afterFull.title });
const u3 = (await call('GET', `/tasks/${tid}`)).json.updated;
rec('`updated` format / precision', true, { examples: [u1, u2json.updated, u3], subSecond: /\.\d+/.test(u2json.updated) });
rec('two writes within one second produce distinct `updated` values', u2json.updated !== u3 && u1 !== u2json.updated, { u1, u2: u2json.updated, u3 });

// 6. v2: ETag and conditional PATCH
const g2 = await call('GET', `/tasks/${tid}`, undefined, { v: 'v2' });
rec('v2 GET /tasks/{id} works with the API token and returns an ETag', g2.status === 200 && !!g2.etag, { status: g2.status, etag: g2.etag, text: g2.status === 200 ? '' : g2.text });
if (g2.status === 200 && g2.etag) {
  const stale = await call('PATCH', `/tasks/${tid}`, { priority: 4 }, { v: 'v2', headers: { 'if-match': '"definitely-stale"' } });
  const afterStale = (await call('GET', `/tasks/${tid}`)).json;
  rec('v2 PATCH with a stale If-Match is refused (412) and nothing changes', stale.status === 412 && afterStale.priority !== 4, { status: stale.status, priorityAfter: afterStale.priority, text: stale.text });
  const fresh = await call('GET', `/tasks/${tid}`, undefined, { v: 'v2' });
  const good = await call('PATCH', `/tasks/${tid}`, { priority: 4 }, { v: 'v2', headers: { 'if-match': fresh.etag } });
  const afterGood = (await call('GET', `/tasks/${tid}`)).json;
  const untouched = ['description', 'due_date', 'hex_color', 'percent_done', 'done', 'title'].filter((k) => JSON.stringify(afterGood[k]) !== JSON.stringify(fresh.json?.[k]));
  rec('v2 PATCH with matching If-Match applies a PARTIAL change and keeps other fields', good.status === 200 && afterGood.priority === 4 && untouched.length === 0, { status: good.status, priorityAfter: afterGood.priority, changedUnintended: untouched, text: good.status === 200 ? '' : good.text });
  // Does If-Match get enforced at all? Same request, ETag now outdated after the write above.
  const replay = await call('PATCH', `/tasks/${tid}`, { priority: 1 }, { v: 'v2', headers: { 'if-match': fresh.etag } });
  rec('v2 PATCH replaying the pre-write ETag is refused (412)', replay.status === 412, { status: replay.status });
}

// 7. Least privilege: token cannot delete, cannot read tokens, cannot touch projects
const del = await call('DELETE', `/tasks/${seed.taskIds[0]}`);
const stillThere = await call('GET', `/tasks/${seed.taskIds[0]}`);
rec('token without delete permission cannot delete a task', del.status >= 400 && stillThere.status === 200, { deleteStatus: del.status, after: stillThere.status });
const projUpd = await call('POST', `/projects/${seed.projectId}`, { title: 'renamed by token' });
rec('token cannot update a project (not granted)', projUpd.status >= 400, { status: projUpd.status });
const tokens = await call('GET', '/tokens');
rec('token cannot list API tokens', tokens.status >= 400, { status: tokens.status });

// 8. Create via token
const created = await call('PUT', `/projects/${seed.projectId}/tasks`, { title: 'Probe-created task', priority: 1 });
rec('token can create a task in the project (PUT /projects/{id}/tasks)', created.status === 201 || created.status === 200, { status: created.status, id: created.json?.id });

// 9. Cross-project access (scope boundary of API tokens)
const otherTasks = await call('GET', `/tasks?filter=${encodeURIComponent(`project = ${seed.otherProjectId}`)}`);
rec('(limitation) token can read the same user\'s OTHER projects (tokens are per-user, not per-project)', otherTasks.status === 200, { status: otherTasks.status, count: otherTasks.json?.length });

await mkdir(join(ROOT, 'outputs'), { recursive: true });
await writeFile(join(ROOT, 'outputs', 'vikunja-api-probe.json'), JSON.stringify({ ranAt: new Date().toISOString(), vikunja: 'v2.8.0 (source build)', results }, null, 2));
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks true`);
