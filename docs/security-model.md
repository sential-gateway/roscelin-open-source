# Security model

This describes what the code in this repository does today. It's a developer build, not a consumer product.

## Trust boundaries

```
 web page (untrusted) ──DOM──▶ content script (isolated world; accepts only service-worker messages)
                                     ▲  service worker → content script only
 side panel (extension origin) ──runtime messages──▶ service worker: broker
   └─ review dialog (extension-owned)                 ├─ checks shape, arguments, capability, target, revision, Stop
                                                      ├─ medium/high risk: requires a single-use approval token
                                                      ├─ journal written before the write is sent
                                                      ├─ sends the write to the app
                                                      └─ reads the app again → verified | failed | unknown
```

**Untrusted input** includes page content, document text, task titles, AI output, imported profiles and saved layouts. All of it is treated as data. The reference app includes a task titled as a fake system instruction, and document text asking an AI to send data elsewhere. The tests check that both render as inert text and that nothing runs.

**Layouts are data.** `validateSurface` rejects unknown components, settings and keys, unregistered or undeclared capabilities, actions on non-action components, URLs, `javascript:`, event-handler text, `<script>`, nesting deeper than 8, more than 150 nodes, strings over 400 characters and payloads over 64 KB. The renderer never builds links from layout text.

## How a write happens

Every write goes through the broker in the service worker, in this order:

1. **Preview.** The panel asks the broker for a preview. The broker checks the request: the capability is registered and currently available, the arguments match the schema, the target app, origin, document and object exist, the expected revision is current, Stop is off and the app isn't paused, and the host permission is granted. The panel shows the before-and-after lines in a review dialog.
2. **Approval.** What happens next depends on the capability's risk class:
   - **Medium and high risk** (today: creating a task, in both adapters). When the person confirms, the broker issues a random approval token. It's single use and bound to the target, the expected revision and the material arguments. After 60 seconds it expires, and an expired approval token can no longer authorize an action. The broker refuses to run the action without a matching, unused, unexpired token. A used or expired token's record stays in storage until it's cleaned up (see the table under "Stored data").
   - **Low risk** (today: changing an existing task's title, status or priority, in both adapters). The panel still shows the review dialog and only sends the action after the person confirms. **The broker doesn't require an approval token for these.** Any code that can send messages to the service worker as the extension could run a low-risk action without the dialog. Only extension pages and the extension's own scripts can send those messages.
   - `read` and `prohibited` capabilities are never run as actions.
3. **Re-check and journal.** The broker checks the request again, takes a per-item lock, and writes a journal entry marked "executing" **before** sending anything.
4. **Write.** The broker checks Stop and the app's pause one last time, then asks the adapter to send the write. For Vikunja, the adapter re-reads the task first and refuses if its revision changed. **The write reaches the app at this point, before anything confirms it.**
5. **Read-back.** The broker reads the app again, independently of what the write call returned, and records one of three outcomes:
   - **Verified:** the requested change is visible and, for Vikunja updates, the untouched fields are unchanged.
   - **Failed:** the adapter reports the write was definitely not sent, for example because the revision changed or permission was refused.
   - **Unknown:** the write timed out (10 seconds), or the change can't be seen. The broker never retries an unknown write by itself. The person can reconcile it later, which reads the app again, or dismiss it.

Read-back confirms or questions a write that has already happened. It doesn't prevent it. If read-back fails, the change may still be in the app.

## Stop

The Stop button or `Alt+Shift+.` sets a flag in `chrome.storage.local`. It stays on until the person presses Resume.

- The broker refuses new actions while Stop is on. It checks at the start and again just before sending the write.
- **Stop doesn't cancel a write that has already been sent.** That write may still complete in the app. The broker still reads back and records verified, failed or unknown.
- Stop doesn't close the side panel or disconnect apps.

There's also a pause for each app in the profile, which works the same way for that app.

## Permissions

| Permission | Why |
| --- | --- |
| `sidePanel` | The workspace |
| `storage` | Profile, journal, approvals and settings, stored locally |
| `scripting` | Inject the content script into the granted reference-app tab, on demand |
| Optional host `localhost:4317`, `127.0.0.1:4317` | The reference app. Requested only when the person presses a button. |
| Optional host `localhost:3456`, `127.0.0.1:3456` | A local Vikunja instance. Requested only when the person presses a button. |

The extension doesn't request `<all_urls>`, `tabs`, `history`, `cookies`, `downloads`, clipboard, `desktopCapture`, `nativeMessaging` or incognito access. The extension pages' content security policy is `script-src 'self'; object-src 'none'; base-uri 'none'`, and `connect-src` allows only the local Vikunja instance and `http://127.0.0.1:4318`, the address of an optional AI service.

The `--e2e` build adds a required host permission for the reference app, because headless tests can't click a permission prompt. It's labelled as a test build and must never be distributed.

## What is sent to an AI service

AI layouts are off by default. No AI service is included in this repository. If the person turns AI layouts on, pairs with a service at `127.0.0.1:4318` and presses Propose or Refine, the extension sends a `PlannerContext`:

- **The person's request, as typed**, up to 500 characters. For Refine, this is the original request plus the refinement. **It isn't redacted.** Whatever the person types, including names or other private text, is sent.
- Display preferences: density, keyboard-first, vocabulary and text size.
- Each available capability's id, operation, label, risk class and argument names.
- Each collection's name, field names and number of items.
- The adapter's id and version.

It doesn't send task titles, field values, document text or other app content. The panel shows the exact payload under "What was sent to the AI".

The extension can't control what an AI service does with this data, such as forwarding it to a model provider or keeping logs. Check the service you pair with. Whatever the service returns is validated, and anything invalid is replaced by the rule-based layout. An AI service can't approve or run an action.

## Stored data and what "delete" removes

| Data | Where | Removed by |
| --- | --- | --- |
| Profile (preferences, per-app pause) and saved layouts | `chrome.storage.local` | **Delete profile and saved layouts** |
| Last layout shown for each app | `chrome.storage.local` | **Delete profile and saved layouts** |
| Approval token records | `chrome.storage.local` | **Delete profile and saved layouts**. Otherwise, records that have expired are deleted the next time a new approval is issued. |
| **Action journal**: each action's request, including its arguments such as typed titles, and its result | `chrome.storage.local` | **Nothing in the extension today.** It's kept on purpose so unresolved writes can be reconciled. It stays until the extension is removed or its storage is cleared in Chrome. |
| Stop flag | `chrome.storage.local` | Resume. Deleting the profile turns Stop **on**. |
| AI layouts on/off setting | `chrome.storage.local` | Turning the setting off. It isn't removed by deleting the profile. |
| Workload map view setting | `chrome.storage.local` | Not removed by deleting the profile |
| Vikunja API token | `chrome.storage.session` | Disconnect, or closing the browser |
| AI pairing secret | `chrome.storage.session` | Forget pairing, or closing the browser |
| Observed app state | Memory only | Closing the panel |
| Read-aloud text and dictation | Local voices and on-device recognition only, with consent for dictation each session | Not stored |

"Delete profile and saved layouts" asks for confirmation, keeps the activity and recovery records, and turns Stop on until the person resumes. Removing the extension from Chrome deletes all of its stored data, including the journal.

`chrome.storage.local` isn't encrypted at rest.

Roscelin doesn't read passwords, cookies, one-time codes, payment data, browsing history or screenshots.

See [known-limitations.md](known-limitations.md) for the open gaps.
