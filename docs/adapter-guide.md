# Write an adapter

An adapter connects Roscelin to one app. It tells Roscelin what the app's data looks like and which actions it supports, and it performs reads and writes. The broker does the rest: checks, approval tokens for medium and high risk actions, the journal and read-back. See [security-model.md](security-model.md#how-a-write-happens) for the exact sequence.

Start from the reference adapter in `packages/adapters/src/reference-tasks/`. The Vikunja adapter in `packages/adapters/src/vikunja/` shows a real HTTP API. The types are in `packages/schemas/src/contracts.ts` and `packages/broker/src/broker.ts`.

## 1. Describe the app

An `AppDescriptor` names the app, the origins Roscelin may be granted on, and whether it needs a token.

## 2. Declare capabilities

Each action is a `Capability`:

- `id`, `operation` and `label`, for example `update` and "Change task".
- `argumentSchema`: each argument's type, limits and allowed values. Mark arguments as `material` when changing them should invalidate an approval. Titles, statuses and dates usually are.
- `riskClass`: one of `read`, `low`, `medium`, `high` or `prohibited`. The broker requires a single-use approval token for `medium` and `high`. For `low`, only the panel's review dialog asks for confirmation. Choose `medium` or higher for anything hard to undo, such as creating or deleting, or anything that affects other people.
- `reversible`, `preconditions`, `verificationMethod` and `supportedVersions`.

Only declare actions the app really supports, for the versions you've tested.

## 3. Read state

`readState(target)` returns `ObservedState`:

- `collections`: the objects, each with `objectId`, a `revision` that changes whenever the object changes, and its `fields`.
- `collectionSchema`: the field names for each collection. This is authoritative and works even when a collection is empty.
- `collectionRoles`: what the fields mean, so generic components such as Focus can rank and filter without app-specific code. For example, `status` names the status field, `doneValues` lists the values that mean done, `rank` names the importance field, and `rankOrder` lists its values from least to most important.
- `availableCapabilityIds`: the actions that are allowed right now.
- `limitations`: plain-language notes, such as "first 50 tasks only".

Display names are for display only. Identity is the app, origin, document instance and object id.

## 4. Implement operations

Each `AdapterOp` pairs a capability with:

- `describe(before, req)`: before-and-after lines for the review dialog.
- `prepare(before, req)`, optional: the minimum pre-state needed to verify later. It's stored in the journal, so keep it free of content.
- `verify(after, req, ctx)`: checks the postcondition against an independently read state.
- `captureReceipt(ctx, receipt)`, optional: keeps a receipt from the write, such as a new object's id, for reconciliation. Never infer a receipt from read-back.

`execute(req, cap)` sends the write. The write reaches the app at this point. Resolving doesn't mean success: the broker reads back and verifies. Return `dispatched: false` only when you're sure nothing reached the app, for example when your pre-write revision check fails or the app refused the request before handling it.

## 5. Refuse stale writes

Before writing, re-read the object and refuse if its revision isn't the one the person reviewed. If the app supports conditional writes, such as `If-Match` with an ETag, use them. If the app replaces whole objects on write, send the freshly read object with only the requested fields changed, and check afterwards that the untouched fields didn't change.

If the source app doesn't support conditional writes, another change can occur between the read and the write and be overwritten. Reading the result back cannot prevent or recover an overwritten change.

Document any remaining race in the adapter and in [known-limitations.md](known-limitations.md).

## 6. Test

- Offline tests with a fake transport. See `tests/vikunja-adapter.test.ts` and `tests/helpers.ts`.
- Validator and planner tests that use your capabilities and fields.
- If possible, a local instance of the app with synthetic data, as `scripts/vikunja/` does for Vikunja. Never test against real accounts or real data.

Propose a new adapter with the **Adapter proposal** issue form before writing it.
