# CodePi Swift Shell — Rewrite Plan

Status: **Draft for review** · Companion document: [SWIFT_SHELL_DESIGN.md](SWIFT_SHELL_DESIGN.md)

## Guiding principles

1. **The renderer is frozen ground.** No renderer changes except the build split
   (`build:web`) and, if unavoidable, changes that keep working identically under
   Electron too.
2. **The contract is the spec.** `src/shared/contracts.ts` (53 request methods, 5 event
   streams) defines done. A phase ships only when its slice of the parity checklist
   passes on the Swift shell.
3. **Electron keeps shipping.** `main` stays releasable via Electron until the final
   cutover phase; `src/main` is feature-frozen (bug fixes must land in both shells).
4. **Riskiest unknowns first.** Phase 0 exists to kill the WKWebView unknowns (bridge
   latency, paste, IME, vibrancy) before we commit to the bulk port.
5. **Never two writers.** Dev builds use `works.earendil.codepi.dev` +
   `CODEPI_STATE_DIR`; only the release cutover build touches the real
   `~/Library/Application Support/CodePi`.

## Phases

Sizes are relative (S < M < L). Each phase ends with its checklist rows green plus the
listed acceptance gate. Phases 3–5 are largely independent of each other and can be
reordered or parallelized if useful.

> **Status (2026-07-12):** Phases 0–4 implemented. Phases 1–2 gate-checked
> against a copy of real app data (sidebar/library round-trip, real Pi spawn,
> transcript/model/stats via the bridge; streaming verified by the fake-pi
> suite). Phase 3 (diff parsing, stage/commit/push, worktree
> create/copy/apply/remove with safety checks) and Phase 4 (openpty +
> posix_spawn PTY with SETSID controlling terminal, coalesced output, SIGHUP →
> SIGKILL close) are covered by real-git fixture tests and live-shell PTY
> tests. Remaining deferrals: capability discovery (Pi runs with default
> extension/skill discovery; toggles list empty), and the Phase 5 channels
> (`exportThread`, workspace files, preview, transcript-tier search). The
> in-app click-through of the Changes tab and terminal pane is still owed as a
> manual gate check.

### Phase 0 — Shell spike (M)

Scope: prove the architecture end to end with a walking skeleton.

- `macos/` scaffold (SwiftPM package, app + `CodePiKit` + tests targets), CI job.
- `npm run build:web` (plain Vite build of the existing renderer + shim compile).
- `codepi://` scheme handler serving the web build; dev-server mode.
- Bridge: envelope codec, router, `WKScriptMessageHandlerWithReply` round-trip, event
  dispatcher with coalescing; shim implementing `CodePiApi` (stub responses where the
  backend doesn't exist yet), type-checked against `contracts.ts`.
- Main window chrome: hidden titlebar, traffic-light inset, sidebar vibrancy behind a
  transparent web view; native menu emitting `menuAction`; `themeChanged` wiring.
- Spike checks: paste an image into the composer, IME composition in the composer,
  ⌘K palette focus, bridge round-trip latency measured < 2 ms median.

**Gate:** renderer boots to the onboarding screen inside the Swift shell, theme + menu
+ palette work, spike checks recorded in the PR description.

### Phase 1 — State and library (M)

Scope: everything that reads/writes `state.json` and the filesystem, no Pi yet.

- `StateStore` (v2 schema, atomic writes, v1 migration), `ThreadLibrary`,
  `SessionStore` discovery/recovery, settings get/save, `validatePi`.
- Bridge methods: `bootstrap`, `addProject`, `toggleProject`, `selectThread`,
  `updateThread`, `deleteThread` / `restoreThread` / `purgeThread`,
  `listPromptTemplates` / `savePromptTemplate` / `deletePromptTemplate`,
  `getUsageDashboard`, `searchThreads`.
- Dialogs: project picker (NSOpenPanel), external editor (`openInEditor` minus git
  parts), `openSettings` window.
- Ported XCTest suites: state-store, thread-library, sessions; contract fixtures wired
  into both CIs.

**Gate:** point the shell at a copy of real app data — sidebar, projects, pins, tags,
archive/trash, prompt library, and usage dashboard render and mutate correctly; the
same file re-opens cleanly in the Electron build afterward.

### Phase 2 — Pi core loop (L, the heart)

Scope: `PiRpcClient` + `PiProcessManager` + capability discovery.

- Process lifecycle: lazy open, `--session` reopen, per-thread env/cwd, restart,
  archive/quit teardown, crash → recoverable thread error.
- Full RPC map: prompt / steer / follow_up / abort, models + set_model,
  thinking level, commands, compaction + auto-compaction + auto-retry,
  get_state / get_messages / get_session_stats, session naming.
- Event normalization to the existing `ThreadEvent` union; streaming through the
  coalescing dispatcher; queue events; settled + usage ledger recording.
- `createThread` / `duplicateThread` / `branchThread` (session cloning),
  capabilities list/toggle with per-thread `--extension`/`--skill` args and
  safe-restart flow; attachments (picker, size/count validation, per-thread storage);
  `sendMessage` with attachments; `getHistory`.
- Fake-Pi integration suite; pi-rpc XCTest port; streaming throughput test.

**Gate:** daily-drive milestone — parallel threads stream, steer, queue, abort,
compact, switch models, toggle skills, and survive a `kill -9` of one Pi process, all
against real Pi, with usage recorded identically to the Electron build.

### Phase 3 — Git and worktrees (M)

- `GitService`: status/diff parsing (port of `parse-diff` usage), stage/unstage,
  commit, commit+push, `getChanges` stageable semantics for worktrees.
- `WorktreeService`: create/remove `.pi-gui/worktrees/<id>`, `pi/<id>` branches,
  isolated duplication, `applyToMain` with the existing safety checks, removal-risk
  checks on purge.
- XCTest against disposable fixture repos (same scenarios as today's tests).

**Gate:** Changes tab fully functional in both plain and worktree threads; apply-to-main
and purge behave byte-identically to Electron on the fixture matrix.

### Phase 4 — Terminal (M, focused risk)

- `PtyService` (openpty/termios/`TIOCSWINSZ`), shell resolution parity with
  `terminal-platform.ts`, lifecycle tied to threads (archive/trash/quit teardown).
- Bridge: `openTerminal` / `writeTerminal` / `resizeTerminal` / `closeTerminal` +
  coalesced `terminalEvent` stream.
- Soak: vim, htop, `yes` flood, resize storms, unicode/emoji, exit-code reporting.

**Gate:** soak checklist green; xterm.js behavior indistinguishable from the Electron
build side by side.

### Phase 5 — Preview, workspace, export, search (M)

- `PreviewController` (overlay WKWebView, bounds sync, loopback-only policy, action
  routing, state events).
- `WorkspaceService` (file listing/preview with today's caps), `searchProjectFiles`,
  `getRecentFiles`.
- `ExportService` (Markdown/HTML transcripts, NSSavePanel), `TranscriptSearchService`
  for the command palette.
- Native drag-and-drop file drop path (design §7.4) with its parity test.

**Gate:** workspace dock (Files/Terminal/Preview), exports, and palette transcript
search at parity; drop/paste/picker attachment matrix green.

### Phase 6 — Hardening and cutover (M)

- Full parity checklist sweep (below) on a fresh machine profile and on a real
  long-lived data directory copy.
- Edge cases: onboarding with missing Pi, corrupted state file, future-version state
  rejection, session recovery, incompatible-extension restart flow.
- Packaging: Developer ID signing, notarization, DMG, release checklist update
  (`docs/RELEASING.md`), README architecture section update.
- Cutover: release bundle id switches to `works.earendil.codepi`; Electron build marked
  legacy in README; `src/main` retained one release cycle, then removed together with
  Electron devDependencies.

**Gate:** notarized DMG installs over an Electron-created profile and everything works;
rollback to the Electron build verified against the same profile.

## Parity checklist

Legend: phase that must turn the row green. Every row is verified on the Swift shell
against the Electron build's behavior before its phase closes.

| Contract surface | Phase |
| --- | --- |
| `bootstrap`, `addProject`, `toggleProject`, `selectThread` | 1 |
| Thread metadata: `updateThread`, `deleteThread`, `restoreThread`, `purgeThread` | 1 |
| Prompt templates (3 methods), `getUsageDashboard`, `searchThreads` (metadata tier) | 1 |
| Settings: `openSettings`, `getSettings`, `saveSettings`, `validatePi` | 1 |
| `createThread`, `openThread`, `restartThread(±capabilities)`, `duplicateThread`, `branchThread`, `getHistory` | 2 |
| `sendMessage` (prompt/steer/followUp ± attachments), `abortThread` | 2 |
| `setModel`, `setThinkingLevel`, `getCommands`, `compactThread`, `setAutoCompaction`, `setAutoRetry` | 2 |
| Capabilities: `getCapabilities`, `setCapabilityEnabled`, safe-restart flow | 2 |
| `pickAttachments` + paste + drag-drop matrix | 2 (picker/paste) / 5 (drop) |
| `threadEvent` stream: status, deltas, tool calls/outputs, message/turn end, queue, settled, aborted, error | 2 |
| Git: `getChanges`, `setFileStaged`, `commit` (±push), `applyToMain`, `openInEditor` | 3 |
| Worktree lifecycle incl. isolated duplicate + purge safety | 3 |
| Terminal: 4 methods + `terminalEvent` + soak matrix | 4 |
| Preview: 4 methods + `previewEvent` + policy denials (popups, downloads, non-loopback, credentials) | 5 |
| Workspace: `listWorkspaceFiles`, `readWorkspaceFile`, `searchProjectFiles`, `getRecentFiles` | 5 |
| `exportThread` (markdown + html), transcript-tier `searchThreads` | 5 |
| `menuAction`, `themeChanged`, window chrome, shortcuts | 0 |
| Lifecycle: quit teardown, crash recovery, single instance, state compat both directions | 6 |

## Out of scope (unchanged from today, tracked as follow-ups)

- Keychain-backed settings env storage.
- Sparkle auto-updates.
- Full-native SwiftUI renderer (re-evaluate once `CodePiKit` is proven).
- Windows/Linux support.

## Definition of done

The Swift shell is the shipping CodePi when: every parity row is green; the ported and
fixture test suites pass in CI; a notarized build upgrades and downgrades cleanly
against a real Electron profile; and the README/RELEASING docs describe the new build.
Until all of that holds, the Electron target remains the release artifact.
