# Contributing to Roscelin

Thanks for helping. This guide covers setup, what to work on, the safety rules, and how changes are reviewed.

## Ground rules

- Be respectful to everyone taking part.
- Don't report security problems in public issues or pull requests. Use the private route in [SECURITY.md](SECURITY.md).
- Never put real personal data, API keys, tokens or passwords in issues, pull requests, tests, fixtures or screenshots. Use synthetic data.

## Set up

```bash
npm ci --ignore-scripts
npm run check        # build and offline tests
npm run test:a11y    # accessibility checks (needs Chrome)
npm run test:panel   # side-panel tests against the reference app (needs Chrome)
```

None of these needs an account, an API key or a paid service.

## What to work on

Issues labelled `good first issue` and `help wanted` are a good place to start. Welcome areas:

- **Adapters** for self-hosted or open apps. See [docs/adapter-guide.md](docs/adapter-guide.md).
- **Components** in the renderer.
- **Validator rules**, each with tests that show what's rejected.
- **Refine edits**: plain-language requests the planner understands.
- **Accessibility**: keyboard, screen readers, contrast, reduced motion, large text.
- **Documentation and examples.**

For a large change, such as a new adapter, a new component type or a change to the UI schema, open an issue first so the approach can be agreed before you write the code.

## Safety rules

Roscelin changes real data in real apps, so these rules aren't negotiable:

- Every layout passes the validator, whether it came from a person, the rules or an AI service.
- Components never write directly. Every write goes through the broker, which checks it and reads it back. The panel shows a review dialog before every write, and the broker requires an approval token for medium and high risk actions. Don't lower a capability's risk class to avoid the token.
- Adapters only declare actions the app really supports, and they refuse stale writes rather than overwrite newer data.
- Components are built with DOM APIs, not `innerHTML` or other HTML strings.
- No remote code in the extension: no CDNs, `eval` or downloaded scripts.
- Don't widen the extension's permissions without agreeing it in an issue first.

Changes to the validator, the broker, adapters' write paths or permissions need, for now:

- an approving review from a maintainer;
- the offline, accessibility and side-panel tests passing;
- a short safety note in the pull request saying what could go wrong and how the change prevents it.

Once the project has a second maintainer, these changes will need two approving reviews.

## Make a change

1. Fork the repository and create a branch from `main`.
2. Make your change with tests. A bug fix includes a test that fails without the fix.
3. Run `npm run check`. If you changed the interface, also run the accessibility and side-panel tests.
4. Write commit messages that say what changed and why.
5. Sign off every commit with `git commit -s` (see "Developer Certificate of Origin" below).
6. Open a pull request and fill in the template.

## Review

- CI runs the offline tests on every pull request.
- A maintainer reviews the change and may ask for changes.
- Keep pull requests focused. Several small ones are easier to review than one large one.

## Style

- TypeScript and ES modules, run directly by Node.js. No build-time code generation.
- Interface text is plain, sentence case and active voice. Errors say what happened and what to do next.
- Keep dependencies to a minimum. Discuss a new dependency in an issue first, including its licence. It must be compatible with Apache-2.0 and be added to `THIRD_PARTY_NOTICES.md`.

## Developer Certificate of Origin

Roscelin uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/) (DCO), not a contributor licence agreement. Adding a `Signed-off-by` line to a commit certifies that you wrote the change or otherwise have the right to submit it under the project's licence:

```
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds it for you. You keep the copyright in your contribution. It's licensed to the project and its users under the Apache License 2.0, as section 5 of that licence describes.
