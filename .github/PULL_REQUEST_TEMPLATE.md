## What this changes

<!-- What and why. Link the issue: "Closes #..." -->

## How it was tested

- [ ] `npm run check`
- [ ] `npm run test:a11y` (if the interface changed)
- [ ] `npm run test:panel` (if the side panel or an adapter changed)
- [ ] New or updated tests cover the change

## Safety checklist

- [ ] Every layout still goes through the validator
- [ ] Every write still goes through the broker and read-back; no capability's risk class was lowered
- [ ] No `innerHTML`, `eval`, remote scripts or CDNs
- [ ] No new extension permissions, or they were agreed in an issue
- [ ] Only synthetic data in tests, fixtures and screenshots; no keys, tokens or personal data
- [ ] Any new dependency is listed in `THIRD_PARTY_NOTICES.md` with a compatible licence
- [ ] Every commit is signed off (`git commit -s`) under the Developer Certificate of Origin

## Screenshots

<!-- For interface changes: before and after. -->
