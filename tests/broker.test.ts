import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, req, target } from './helpers.ts';
import { CAPS } from '../packages/adapters/src/reference-tasks/ops.ts';

test('low-risk update executes and is verified by independent read-back', async () => {
  const { broker, app } = setup();
  const r = await broker.execute(req({ capabilityId: CAPS.update.id, target: target('t1'), args: { status: 'done' } }));
  assert.equal(r.status, 'verified', r.message);
  assert.equal(app.tasks[0].fields.status, 'done');
  assert.equal(r.afterRevision, 2);
});

test('stale revision is rejected and nothing is written', async () => {
  const { broker, app } = setup();
  app.tasks[0].revision = 5; // changed in the original app
  const r = await broker.execute(req({ capabilityId: CAPS.update.id, target: target('t1'), args: { status: 'done' } }));
  assert.equal(r.errorCode, 'STALE_REVISION');
  assert.equal(app.writes, 0);
});

test('changed document instance is rejected as target mismatch', async () => {
  const { broker, app } = setup();
  app.doc = 'doc-2';
  const r = await broker.execute(req({ capabilityId: CAPS.update.id, target: target('t1'), args: { status: 'done' } }));
  assert.equal(r.errorCode, 'TARGET_MISMATCH');
  assert.equal(app.writes, 0);
});

test('unknown / invented capability is rejected', async () => {
  const { broker } = setup();
  const r = await broker.execute(req({ capabilityId: 'reference-tasks.email.send', target: target(null), args: {} }));
  assert.equal(r.errorCode, 'UNKNOWN_CAPABILITY');
});

test('invalid args (unknown field, bad enum, too long) rejected', async () => {
  const { broker, app } = setup();
  for (const args of [{ status: 'archived' }, { assignee: 'x' }, { title: 'x'.repeat(201) }]) {
    const r = await broker.execute(req({ capabilityId: CAPS.update.id, target: target('t1'), args: args as never }));
    assert.equal(r.errorCode, 'INVALID_ARGS', JSON.stringify(args));
  }
  assert.equal(app.writes, 0);
});

test('medium-risk create requires an approval token', async () => {
  const { broker, app } = setup();
  const r = await broker.execute(req({ capabilityId: CAPS.create.id, target: target(null), args: { title: 'New' } }));
  assert.equal(r.errorCode, 'APPROVAL_REQUIRED');
  assert.equal(app.writes, 0);
});

test('model-supplied approval boolean / forged token is not accepted', async () => {
  const { broker, app } = setup();
  const r = await broker.execute({ ...req({ capabilityId: CAPS.create.id, target: target(null), args: { title: 'New' } }), approved: true, approvalToken: 'tok-forged' });
  assert.equal(r.errorCode, 'APPROVAL_INVALID');
  assert.equal(app.writes, 0);
});

test('approval is bound to exact material args; changing title invalidates it', async () => {
  const { broker, app } = setup();
  const base = req({ capabilityId: CAPS.create.id, target: target(null), args: { title: 'Buy paper', priority: 'low' } });
  const a = await broker.issueApproval(base);
  assert.ok(a.ok && a.token);
  const tampered = { ...base, actionId: base.actionId + 'x', args: { title: 'Buy paper NOW', priority: 'low' }, approvalToken: a.token! };
  const r1 = await broker.execute(tampered);
  assert.equal(r1.errorCode, 'APPROVAL_INVALID');
  const r2 = await broker.execute({ ...base, approvalToken: a.token! });
  assert.equal(r2.status, 'verified', r2.message);
  assert.equal(app.writes, 1);
});

test('approval tokens are single-use', async () => {
  const { broker } = setup();
  const base = req({ capabilityId: CAPS.create.id, target: target(null), args: { title: 'One' } });
  const a = await broker.issueApproval(base);
  await broker.execute({ ...base, approvalToken: a.token! });
  const again = await broker.execute({ ...base, actionId: base.actionId + 'b', expectedRevision: 2, approvalToken: a.token! });
  assert.equal(again.errorCode, 'APPROVAL_INVALID');
});

test('expired approval is rejected', async () => {
  const { broker } = setup();
  const base = req({ capabilityId: CAPS.create.id, target: target(null), args: { title: 'Late' } });
  const a = await broker.issueApproval(base);
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    const r = await broker.execute({ ...base, expiresAt: Date.now() + 1000, approvalToken: a.token! });
    assert.equal(r.errorCode, 'APPROVAL_EXPIRED');
  } finally {
    Date.now = realNow;
  }
});

test('duplicate actionId is never executed twice', async () => {
  const { broker, app } = setup();
  const r = req({ capabilityId: CAPS.update.id, target: target('t1'), args: { status: 'done' } });
  await broker.execute(r);
  const again = await broker.execute(r);
  assert.equal(again.errorCode, 'DUPLICATE_ACTION');
  assert.equal(app.writes, 1);
});

test('dispatch that claims success but changes nothing is NOT verified', async () => {
  const { broker, app } = setup();
  app.mode = 'drop';
  const r = await broker.execute(req({ capabilityId: CAPS.update.id, target: target('t1'), args: { status: 'done' } }));
  assert.equal(r.status, 'unknown');
  assert.equal(r.errorCode, 'POSTCONDITION_NOT_OBSERVED');
});

test('timeout yields UNKNOWN, locks target, and is not retried', async () => {
  const { broker, app } = setup();
  app.mode = 'hang';
  const r = await broker.execute(req({ capabilityId: CAPS.update.id, target: target('t1'), args: { status: 'done' } }));
  assert.equal(r.status, 'unknown');
  app.mode = 'ok';
  const next = await broker.execute(req({ capabilityId: CAPS.update.id, target: target('t1'), args: { status: 'doing' } }));
  assert.equal(next.errorCode, 'TARGET_LOCKED');
  assert.equal(app.writes, 0);
});

test('worker restart: executing/unknown entries reconcile without re-dispatch', async () => {
  const { broker, app, restart } = setup();
  app.mode = 'apply-then-crash'; // write lands, but we never hear back or read back
  const r = await broker.execute(req({ capabilityId: CAPS.update.id, target: target('t1'), args: { status: 'done' } }));
  assert.equal(r.status, 'unknown');
  const writesBefore = app.writes;
  app.mode = 'ok';
  const fresh = restart(); // new Broker instance, same persisted journal
  const changed = await fresh.reconcile();
  assert.equal(changed.length, 1);
  assert.equal(changed[0].status, 'verified');
  assert.equal(app.writes, writesBefore, 'reconcile must not re-dispatch');
});

test('reconcile marks still-missing change as unknown; dismiss frees the lock', async () => {
  const { broker, app } = setup();
  app.mode = 'hang';
  const r = await broker.execute(req({ capabilityId: CAPS.update.id, target: target('t1'), args: { status: 'done' } }));
  app.mode = 'ok';
  const changed = await broker.reconcile();
  assert.equal(changed[0].status, 'unknown');
  assert.ok(await broker.dismiss(r.actionId));
  const next = await broker.execute(req({ capabilityId: CAPS.update.id, target: target('t1'), args: { status: 'doing' } }));
  assert.equal(next.status, 'verified');
});

test('paused app: stop takes effect immediately at the broker boundary', async () => {
  const { broker, app, setPaused } = setup();
  setPaused(true);
  const r = await broker.execute(req({ capabilityId: CAPS.update.id, target: target('t1'), args: { status: 'done' } }));
  assert.equal(r.errorCode, 'APP_PAUSED');
  assert.equal(app.writes, 0);
});

test('revoked host permission blocks execution', async () => {
  const { broker, app } = setup({ permitted: false });
  const r = await broker.execute(req({ capabilityId: CAPS.update.id, target: target('t1'), args: { status: 'done' } }));
  assert.equal(r.errorCode, 'PERMISSION_MISSING');
  assert.equal(app.writes, 0);
});

test('expired request rejected', async () => {
  const { broker } = setup();
  const r = await broker.execute(req({ capabilityId: CAPS.update.id, target: target('t1'), args: { status: 'done' }, expiresAt: Date.now() - 1 }));
  assert.equal(r.errorCode, 'REQUEST_EXPIRED');
});

test('malformed request shapes rejected', async () => {
  const { broker } = setup();
  for (const bad of [null, 'x', { actionId: '!!' }, { actionId: 'abcdefgh', capabilityId: 1 }]) {
    const r = await broker.execute(bad);
    assert.equal(r.status, 'failed');
  }
});

test('create verifies the specific new object, not just any change', async () => {
  const { broker, app } = setup();
  const base = req({ capabilityId: CAPS.create.id, target: target(null), args: { title: 'Draft outline' } }); // same title exists
  const a = await broker.issueApproval(base);
  const r = await broker.execute({ ...base, approvalToken: a.token! });
  assert.equal(r.status, 'verified', r.message);
  assert.equal(app.tasks.filter((t) => t.fields.title === 'Draft outline').length, 2);
});

test('preview shows exact diff and approval requirement', async () => {
  const { broker } = setup();
  const p = await broker.preview(req({ capabilityId: CAPS.update.id, target: target('t1'), args: { status: 'done' } }));
  assert.ok(p.ok);
  assert.equal(p.requiresApproval, false);
  assert.deepEqual(p.lines, ['status: "todo" → "done"']);
  const p2 = await broker.preview(req({ capabilityId: CAPS.create.id, target: target(null), args: { title: 'X' } }));
  assert.equal(p2.requiresApproval, true);
});

test('late read-back that observes the write marks it verified (timeout is not failure)', async () => {
  const { broker, app } = setup();
  app.mode = 'apply-then-hang';
  const r = await broker.execute(req({ capabilityId: CAPS.update.id, target: target('t1'), args: { status: 'done' } }));
  assert.equal(r.status, 'verified');
  assert.equal(app.writes, 1);
});
