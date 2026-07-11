# Contributing to CodePi

Thanks for your interest in improving CodePi!

## Development setup

Follow the prerequisites and "Run locally" steps in the [README](README.md):

```bash
npm install
npm run dev
```

Use an isolated development profile for screenshots or destructive UI testing:

```bash
CODEPI_USER_DATA_DIR=/tmp/codepi-profile npm run dev
```

This override is ignored by packaged builds.

## Before opening a pull request

```bash
npm run check
```

Linting, type-checking, tests, and the production bundle must all pass. Please
keep pull requests focused on one change and describe the user-visible behavior
it affects.

## Reporting issues

Include your macOS version, Node.js version, the Pi version (`pi --version`),
and reproduction steps. For rendering or RPC issues, the thread error screen
text and any console output help a lot. Remove credentials, personal paths, and
private conversation content before attaching logs or screenshots. Report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Code style

- TypeScript throughout; keep the main/preload/renderer privilege boundary
  intact (no Node primitives in the renderer).
- Prefer small, typed IPC surfaces added to `src/shared/contracts.ts` and
  validated in `src/main/validation.ts`.
- Shared logic used by both the main process and the renderer belongs in
  `src/shared/`.
- IPC channel names are defined once in `src/shared/ipc-channels.ts`; do not
  duplicate string literals in main or preload code.
- Add or update tests for every bug fix and behavior change.

## Community and licensing

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). By
submitting a contribution, you agree that it is licensed under the project's
[MIT License](LICENSE).
