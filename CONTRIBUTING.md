# Contributing to CodePi

Thanks for your interest in improving CodePi!

## Development setup

Follow the prerequisites and "Run locally" steps in the [README](README.md):

```bash
npm install
npm run dev
```

## Before opening a pull request

```bash
npm run typecheck
npm test
```

Both must pass. Please keep pull requests focused on one change and describe
the user-visible behavior it affects.

## Reporting issues

Include your macOS version, Node.js version, the Pi version (`pi --version`),
and reproduction steps. For rendering or RPC issues, the thread error screen
text and any console output help a lot.

## Code style

- TypeScript throughout; keep the main/preload/renderer privilege boundary
  intact (no Node primitives in the renderer).
- Prefer small, typed IPC surfaces added to `src/shared/contracts.ts` and
  validated in `src/main/validation.ts`.
- Shared logic used by both the main process and the renderer belongs in
  `src/shared/`.
