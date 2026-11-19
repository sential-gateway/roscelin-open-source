# Roscelin

**Your software, your interface.** Roscelin is a Chrome extension that builds a personal workspace for an app, in Chrome's side panel, from the actions the app really supports. A set of rules, or an optional AI service that you run yourself, suggests a layout. Roscelin checks every layout before showing it. Every change to the app needs your confirmation in a review dialog. After the change is sent, Roscelin reads the app again to confirm it.

> Early development: a developer-source release, not a consumer product. Interfaces may change between releases.

## What's here

| Part | Path | What it does |
| --- | --- | --- |
| Extension | `extension/` | Side panel workspace, service worker that hosts the action broker, content script, manifest |
| UI schema and validator | `packages/schemas` | How layouts, capabilities and profiles are described, and the checks every layout must pass |
| Action broker | `packages/broker` | Checks, approval tokens for medium and high risk actions, journal, stale-write refusal, read-back and reconciliation |
| Components | `packages/renderer` | Trusted renderer components, built with DOM APIs and no HTML strings |
| Planner | `packages/planner` | Rule-based layouts, the Refine loop, and the interface an AI service plugs into |
| Adapters | `packages/adapters` | A reference adapter for the test app, and a Vikunja adapter |
| Test app | `test-fixtures/reference-app` | A controlled app with an adversarial page, used by the tests |
| Tests and tools | `tests/`, `tests-live/`, `scripts/` | Offline tests, side-panel tests in headless Chrome, local Vikunja setup |

No AI service is included, and nothing here depends on a hosted service. Without an AI service, Roscelin makes layouts with its built-in rules. A developer can run their own AI service that implements a small documented interface. Its output passes the same validator as everything else. See [docs/architecture.md](docs/architecture.md) and, for what's sent to it, [docs/security-model.md](docs/security-model.md#what-is-sent-to-an-ai-service).

## Get started

You need Node.js 24 or later. The side-panel tests also need Chrome or Chromium 116 or later.

```bash
npm ci --ignore-scripts
npm run check        # build, then run the offline tests
npm run test:a11y    # accessibility checks in headless Chrome
npm run test:audit   # accessibility pass over every layout in the real side panel
npm run test:panel   # side-panel tests against the reference app
```

None of these needs an account, an API key or a paid service.

To try the extension:

```bash
npm run build        # builds dist/extension
npm run fixture      # serves the reference app on http://localhost:4317
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and select `dist/extension`. Open the reference app, open the Roscelin side panel and connect.

To test against a real app, see [docs/vikunja-local-testing.md](docs/vikunja-local-testing.md). The Vikunja scripts currently work on Windows only.

## Documentation

- [Architecture](docs/architecture.md)
- [Write an adapter](docs/adapter-guide.md)
- [Security model](docs/security-model.md)
- [Known limitations](docs/known-limitations.md)
- [Local Vikunja testing](docs/vikunja-local-testing.md)

## Contribute

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Commits need a DCO sign-off (`git commit -s`).

Don't report security problems in public issues. See [SECURITY.md](SECURITY.md).

## Licence

Apache License 2.0. See [LICENSE](LICENSE). Third-party components and their licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The licence doesn't grant rights to the Roscelin name or logo.
