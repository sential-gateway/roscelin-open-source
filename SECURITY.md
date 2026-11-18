# Security policy

## Report a vulnerability privately

Please **don't** report security problems in public issues, pull requests or discussions.

Use GitHub's private vulnerability reporting:

1. Go to this repository's **Security** tab.
2. Select **Report a vulnerability**.
3. Describe the problem, the affected version or commit, and the steps to reproduce it.

Reports are private to people authorized to participate in the GitHub security advisory: the repository's maintainers and any collaborators they add to the advisory. You can keep talking with them privately in the advisory.

If you can't use GitHub's reporting, or the **Report a vulnerability** button isn't there, email **security@roscelin.com** instead. Messages to that address go to the Roscelin maintainer. Email isn't end-to-end encrypted, so for a sensitive report, send a short first message without exploit details and we'll agree a safer way to share them.

## What to include

- What an attacker could do, and what they need first, such as a malicious web page, a malicious app response or a crafted AI layout.
- Steps or a minimal example to reproduce it, using synthetic data only.
- The affected part: validator, broker, renderer, an adapter, or the extension.

Please don't include real personal data, credentials or tokens, even your own.

## What happens next

We'll acknowledge your report, confirm whether it's a vulnerability, and agree a fix and a disclosure date with you. We'll credit you in the advisory unless you'd rather not be named.

## In scope

- The validator letting through a layout that offers an action the adapter doesn't support, or a control or value it shouldn't.
- A medium or high risk action running without a valid approval token, any write sent without going through the broker, a write that skips read-back, or a write that overwrites newer data in a way not already listed in `docs/known-limitations.md`.
- The extension sending data to an AI service beyond what `docs/security-model.md` lists.
- Script or HTML injection through app data, page content or AI output.
- Permission or data-access problems in the extension.

## Out of scope

- Problems in the third-party apps that adapters connect to. Please report those to the app's maintainers.
- Attacks that need an already compromised computer or browser.

## Supported versions

Roscelin is in early development. Only `main` gets security fixes.
