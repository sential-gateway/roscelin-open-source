# Known limitations

## Safety and data

| Limitation | Effect |
| --- | --- |
| **Low-risk actions have no broker-enforced approval token.** Changing a task is low risk, and only the panel's review dialog asks for confirmation. | Code running as the extension could send a low-risk action without the dialog. Medium and high risk actions, such as creating a task, need a token. |
| **The write happens before read-back.** Read-back confirms or questions a change that has already been sent. | If read-back fails or times out, the change may still be in the app. The outcome is recorded as unknown, for the person to reconcile. |
| **Stop can't recall a write that has already been sent.** | Stop blocks new actions and writes not yet sent. A write already sent may still complete. |
| **Vikunja same-field race.** Vikunja v2.8.0 has no conditional write. The v2 `PATCH` that Roscelin uses for updates ignores `If-Match`. | The adapter re-reads the task just before writing, but if another client changes the same field in that window (one round-trip), the change can be overwritten while read-back still reports success. It needs server-side support to fix. |
| Vikunja task creation has no idempotency key. | After a network failure, local duplicate suppression can't guarantee the task is created exactly once. Roscelin reconciles by receipt and read-back. |
| The action journal keeps each action's arguments, such as typed titles, with no rotation, size cap or delete control. | Local data grows and private text is kept. Only removing the extension or clearing its storage deletes it. |
| "Delete profile and saved layouts" doesn't remove the journal, the AI setting or the workload map setting. | See [security-model.md](security-model.md#stored-data-and-what-delete-removes). |
| `chrome.storage.local` isn't encrypted at rest. | Fine for synthetic data. Needs revisiting before real accounts. |
| The person's typed request is sent to the AI service as typed, when AI layouts are on. | It's shown under "What was sent to the AI". There's no redaction. |
| Writes to the original web page are turned off. | Browser actions are inspection only, until Roscelin can prove a page isn't stale. |
| The validator checks structure, actions, fields, values, ranges and styles, but not wording. | AI-written titles and notes could mislead. The review dialog and provenance labels are the protection. |

## Product

| Limitation | Notes |
| --- | --- |
| One real app (Vikunja) and one test app | No ordinary websites yet |
| Vikunja: first 50 tasks of a project only. API tokens are per user, not per project. | |
| The workload map loads three.js (about 2 MB) even when the map is off. Its labels and colours don't use the design system yet. | |
| This is a developer build with developer-only setup. | Not a consumer release |

## Portability

| Limitation | Notes |
| --- | --- |
| The test tooling defaults to Chrome's Windows install path. | Set `CHROME_PATH` to use another Chrome or Chromium. |
| The Vikunja scripts build and run a Windows `.exe`. | `npm run test:live`, `scripts/e2e-vikunja.mjs` and `scripts/e2e-three.mjs` work on Windows today. On other systems, build Vikunja v2.8.0 yourself and set `VIKUNJA_EXE`. This hasn't been tested. |
| `scripts/e2e-three.mjs` needs WebGL in Chrome and free ports 3456 and 3457. | WebGL needs a GPU or Chrome's software renderer, and some CI machines have neither. The offline suite, `test:a11y` and `test:panel` don't need Vikunja or WebGL. |

## Testing gaps

| Gap | Notes |
| --- | --- |
| Screen readers (NVDA, Narrator), keyboard-only use by a person, 200% zoom, Windows high contrast, switch devices | Manual testing not done yet |
| Real microphone dictation and audible read-aloud | Not tested |
| AI layouts end to end | This repository has no AI service, so its side-panel tests cover rule-based layouts only. The validator tests cover AI-style output offline. |
| Headless tests pre-declare host permissions | The real permission prompt needs a manual check before each release |
