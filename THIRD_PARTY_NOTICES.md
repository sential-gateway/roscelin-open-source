# Third-party notices

Roscelin is licensed under the Apache License 2.0 (see `LICENSE`). It includes or uses the following third-party components, each under its own licence. Keep these notices with any copy or distribution that includes the component.

## Shipped in the browser extension

### three.js 0.180.0

- Used for: the optional workload map (`extension/src/task-map.ts`).
- How it ships: `scripts/build.mjs` copies `three.module.js` and `three.core.js` from `node_modules/three/build/` into `dist/extension/vendor/`, along with its licence as `THREE-LICENSE.txt`.
- Licence: MIT. Copyright © 2010-2025 three.js authors. Full text: `node_modules/three/LICENSE` after `npm ci`, and `dist/extension/vendor/THREE-LICENSE.txt` in a build.

### Hanken Grotesk

- Used for: the extension's interface font (`extension/fonts/`).
- Licence: SIL Open Font License 1.1. Full text and copyright notice: `extension/fonts/OFL-hanken-grotesk.txt`.

## Used for testing only, not distributed

### Vikunja

- Used for: a local test instance with synthetic data that the Vikunja adapter is tested against (`scripts/vikunja/`).
- Licence: AGPL-3.0.
- No Vikunja code or binaries are in this repository or in the extension. The setup scripts download or build Vikunja into the ignored `.local/` folder. Roscelin talks to Vikunja only through its HTTP API.

### Development tools

The build and test scripts use Node.js built-ins and a locally installed Chrome. No other third-party packages are included.
