# Architecture

Roscelin is a Chromium Manifest V3 extension. It reads an app's state through an adapter and offers a workspace in the side panel, built from the app's real capabilities. Every change goes through a broker that checks it, asks the person to confirm, sends it, and then reads the result back from the app.

```
 app (web page or HTTP API)
        ▲   read state / send write
        │
   adapter  ── declares capabilities, collectionSchema, collectionRoles
        ▲
        │
 service worker: broker ── checks request, approval token for medium/high risk,
        ▲                  journal, send write, read back, reconcile
        │ runtime messages
 side panel: workspace ── planner (rules, optional AI service) → validator → renderer
```

## Parts

### UI schema and validator (`packages/schemas`)

A layout is data: a `UISurface` tree of known components with known settings. `validateSurface` runs on every layout, whoever made it. It rejects:

- unknown components, settings and keys;
- capabilities that aren't registered, or that the layout doesn't declare in `bindings`;
- actions on components that can't carry one;
- fields a collection doesn't have, and values outside their declared options or ranges;
- URLs, `javascript:`, event-handler text and markup;
- layouts that are too deep, too large or too long.

`contracts.ts` defines capabilities, targets, observed state, action requests and results. `profile.ts` defines the person's preferences, such as density, text size, keyboard-first use and saved layouts.

### Planner (`packages/planner`)

- `deterministicSurface` picks one of the built-in compositions from the request and the person's preferences. It needs no AI. The compositions are Focus, Guided and Compare two, plus lists, forms and tables.
- `refineSurface` applies plain-language edits to a proposal, such as "more compact", "show priority first" or "hide status". It never invents fields or removes the last visible one.
- `planSurface` optionally asks a `ModelGateway` (an AI service) for a layout. Whatever comes back is validated, and any failure falls back to the rule-based layout.

### Broker (`packages/broker`)

The broker is the only path to a write. In short:

1. It checks the request: the capability, arguments, target, current revision, Stop and pause, and host permission.
2. For **medium and high risk** capabilities, it requires a single-use approval token that expires after 60 seconds and is bound to the target, revision and material arguments. **Low-risk** capabilities, such as changing a task, don't need a token. For those, the panel's review dialog is the confirmation step.
3. It writes a journal entry, then sends the write. **The write reaches the app before anything confirms it.**
4. It reads the app again and records the outcome as verified, failed or unknown.
5. It never retries an unknown write by itself. The person can reconcile it later.

Stop blocks new writes and writes not yet sent. It can't recall one that's already been sent. The full sequence, and which actions need a token today, are in [security-model.md](security-model.md#how-a-write-happens).

### Components (`packages/renderer`)

Trusted components render a validated layout with DOM APIs only. They never build links or markup from layout text. Before a proposal is accepted, a read-only preview renders it inside an inert container.

### Adapters (`packages/adapters`)

- `reference-tasks`: the controlled test app in `test-fixtures/reference-app`, read through its page.
- `vikunja`: Vikunja v2.8.0 through its REST API, using a least-privilege API token.

See [adapter-guide.md](adapter-guide.md).

### Extension (`extension/`)

- `sw.ts`: the service worker. It hosts the broker and the adapters, and owns the journal and approvals.
- `sidepanel.ts`: the workspace. It handles requests, proposals, previews, Refine and version history, the review dialog, saved layouts and undo.
- `content.ts`: reads the reference app's page. It accepts messages only from the service worker.
- `accessibility.ts`, `dictation.ts`: accessibility settings, local read-aloud, and on-device dictation.
- `task-map.ts`: an optional workload map. It always includes an exact table; a 3D view using three.js is off by default.
- `ai-gateway.ts`: the client for an optional AI service (see below).

## The AI service interface

AI layouts are off by default. **No AI service is included in this repository**, and this repository doesn't depend on any hosted service. To use AI layouts, a developer runs their own service on `http://127.0.0.1:4318` that implements this interface:

- `POST /v1/pair` with `{ "code": "123456" }` returns `{ "secret": "<64 hex characters>" }`. The extension keeps the secret in `chrome.storage.session` for the browser session only.
- `POST /v1/plan` with `Authorization: Bearer <secret>` and a `PlannerContext` body returns `{ "surfaceText": "<JSON UISurface>" }`.

`PlannerContext` contains the person's request **as typed** (up to 500 characters, not redacted), a few display preferences, capability descriptors, and collection names, field names and counts. It doesn't contain task titles, field values or document text. [security-model.md](security-model.md#what-is-sent-to-an-ai-service) lists every field. The panel shows the exact payload under "What was sent to the AI".

The extension treats the response as untrusted text. It's parsed, validated against the app's real capabilities and fields, and replaced by the rule-based layout if anything is wrong. An AI service can't approve or run an action.

Without a service, everything else works with rule-based layouts.

## Data

The extension stores its data in Chrome's extension storage on the device: the profile, saved layouts, settings and the action journal in `chrome.storage.local`, and the Vikunja token and AI pairing secret in `chrome.storage.session`. Writes go to the app the person connected. The planner context goes to an AI service only if AI layouts are on and paired. [security-model.md](security-model.md#stored-data-and-what-delete-removes) explains what's stored and what the delete control removes.
