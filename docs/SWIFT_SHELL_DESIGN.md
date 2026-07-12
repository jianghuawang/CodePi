# CodePi Swift Shell — Technical Design

Status: **Draft for review** · Companion document: [SWIFT_SHELL_PLAN.md](SWIFT_SHELL_PLAN.md)

## 1. Summary

Replace CodePi's Electron shell with a native Swift (AppKit) application that hosts the
existing React renderer in a `WKWebView`. The entire main process — Pi subprocess
management, Git and worktree services, the PTY terminal backend, the localhost preview,
state persistence, dialogs, menus, and windows — is rewritten in Swift. The renderer
(~10k lines of React/TypeScript/CSS) is reused unchanged.

This is the "hybrid" path: it removes the bundled Chromium + Node runtime (275 MB of the
current 281 MB app) while changing zero user-facing behavior, because the pixels, the
transcript renderer, xterm.js, and Shiki all keep running exactly as they do today.

### Goals

- App bundle ≤ 25 MB; memory footprint reduced by roughly the weight of one Chromium.
- **Feature parity is absolute**: every method of the `CodePiApi` contract behaves
  identically; the renderer cannot tell it is not running in Electron.
- Same state files, same Pi sessions, same `~/Library/Application Support/CodePi`
  directory — upgrading is seamless and downgrading back to the Electron build stays
  possible until cutover.
- Keep the Electron build working in-tree until the Swift shell passes the full parity
  checklist.

### Non-goals

- No renderer redesign, no SwiftUI rewrite of the UI, no visual changes.
- No Windows/Linux path (the Electron target remains the fallback if that ever matters).
- No new features during the port (feature freeze on `src/main` applies; bug fixes land
  in both shells).

## 2. Decision record

| Option | Verdict | Reason |
| --- | --- | --- |
| Stay on Electron | Rejected by product goal | 275 MB Chromium floor; already minimized (asar 3.4 MB). |
| Full native SwiftUI rewrite | Deferred | 15–25k lines, and true parity is asymptotic (Shiki-grade highlighting, xterm.js maturity). Revisit after the Swift core exists. |
| Tauri | Rejected | Same architecture as this design but adds a Rust toolchain; a Swift shell keeps the project macOS-idiomatic and dependency-light. |
| **Swift shell + WKWebView (this design)** | **Chosen** | ~25–30% of the full-rewrite effort, ~90% of the size/memory win, zero feature risk in the renderer. |

Key enabler: the renderer touches the outside world exclusively through `window.codePi`
(`src/shared/contracts.ts`, 53 request methods + 5 event streams) and was explicitly
designed so the shell can change "without changing the renderer contract" (README).

## 3. Target architecture

```text
React renderer (unchanged, built by Vite)
        │  window.codePi — same typed API
        ▼
bridge shim (TypeScript, ~200 lines, injected as WKUserScript)
        │  webkit.messageHandlers.codepi.postMessage / window.__codepiDispatch
        ▼
WKScriptMessageHandlerWithReply (Swift)
        │  validated, Codable-decoded requests
        ▼
Swift application core
  ├─ AppState / StateStore            (state.json v2, atomic writes)
  ├─ PiProcessManager ── PiRpcClient × open thread ── pi --mode rpc
  ├─ GitService / WorktreeService     (git CLI via Process)
  ├─ PtyService                       (openpty + termios, feeds xterm.js)
  ├─ PreviewController                (second WKWebView, overlay bounds from renderer)
  ├─ AttachmentService / ExportService / SearchService / WorkspaceService
  └─ Windows, NSMenu, dialogs, theme, lifecycle
```

The renderer is served from the app bundle through a custom URL scheme
(`codepi://app/`) implemented with `WKURLSchemeHandler` — not `file://` — so the page
has a stable origin, `fetch` and `localStorage` work normally, and the same
"expected origin only" boundary check that `trustedSender` performs today carries over.
In development the shell loads the Vite dev server URL instead, mirroring the current
`ELECTRON_RENDERER_URL` flow.

## 4. The bridge

### 4.1 Requests (renderer → Swift)

`ipcRenderer.invoke` maps 1:1 onto `WKScriptMessageHandlerWithReply` (macOS 11+), which
returns a JavaScript `Promise` natively — same async semantics the renderer already
expects, including rejections carrying `Error` messages.

The shim (`src/bridge/codepi-shim.ts`) implements the `CodePiApi` interface and is
**type-checked against `contracts.ts`**, so any drift between shell and renderer is a
compile error. It is bundled to a self-contained IIFE and injected at
`atDocumentStart`, exactly like the preload today. Message format:

```json
{ "channel": "codepi:open-thread", "args": ["<threadId>"] }
```

Channel names are reused verbatim from `src/shared/ipc-channels.ts`. On the Swift side a
single `BridgeRouter` decodes the envelope, dispatches to a handler registry (one entry
per channel, mirroring `handle(...)` in `src/main/index.ts`), and re-encodes the result
with `JSONEncoder`. Unknown channels, malformed payloads, and calls from any frame other
than the main frame of an app-owned web view are rejected — the same validation posture
as `validation.ts` + `trustedSender`.

### 4.2 Events (Swift → renderer)

The five push channels (`threadEvent`, `terminalEvent`, `previewEvent`, `menuAction`,
`themeChanged`) are delivered by evaluating
`window.__codepiDispatch(channel, payloadJSON)` on the main web view. The shim fans out
to listeners registered through the unchanged `onThreadEvent(...)`-style subscription
methods (each returns its unsubscribe closure, as today).

Throughput: thread streaming (text deltas) and PTY output are the hot paths. The
dispatcher coalesces per channel on a ~16 ms tick and delivers arrays of events; the
shim unrolls them in order. `terminal data` events for one terminal are concatenated
during coalescing. This matches or beats Electron IPC message rates in practice and is
the one place the bridge is *not* a mechanical translation — it gets a dedicated
throughput test (see §10).

### 4.3 Contract typing across languages

`contracts.ts` stays the single source of truth. Swift mirrors it with `Codable` structs
in `Sources/CodePiKit/Contracts/`. Drift protection: a shared fixture suite —
JSON files under `tests/fixtures/contracts/` round-tripped by both Vitest (decode →
type-check) and XCTest (decode → re-encode → byte-compare) — added to `npm run check`
and the Xcode test plan.

## 5. Module port map

| Current (`src/main`) | LOC | Swift component | Notes / risk |
| --- | --- | --- | --- |
| `index.ts` (wiring, windows, menu, IPC) | 1160 | `AppDelegate`, `BridgeRouter`, `WindowController`s | Mechanical; largest file but mostly registration code. |
| `pi-rpc.ts` | 1056 | `PiRpcClient` (actor) | `Process` + pipes; NDJSON via `AsyncLineSequence` with partial-record buffering; request-id correlation. Port the existing unit tests. Low risk. |
| `pi-capabilities.ts` | 842 | `CapabilityDiscovery` | Pure file scanning + parsing. Low risk. |
| `pi-manager.ts` | 387 | `PiProcessManager` (actor) | Lifecycle, lazy open, per-thread env/cwd, crash → thread error events. Low risk. |
| `git-service.ts` | 347 | `GitService` | Same `git` argument arrays via `Process`; no shell interpolation. Low risk. |
| `thread-library.ts` | 345 | `ThreadLibrary` | Metadata updates, usage ledger aggregation. Trivial. |
| `search-service.ts` | 344 | `TranscriptSearchService` | JSONL scanning. Low risk. |
| `state-store.ts` | 309 | `StateStore` | Codable + atomic replace (`FileManager.replaceItemAt`); v1→v2 migration logic ported as-is. Low risk. |
| `sessions.ts` | 306 | `SessionStore` | Header scanning, branch/duplicate cloning. Low risk. |
| `terminal-service.ts` + `terminal-platform.ts` | 328 | `PtyService` | `openpty(3)`, `tcsetattr`, `TIOCSWINSZ`, login-shell spawn. **Medium risk** — replaces node-pty; needs a focused soak test. |
| `preview-service.ts` | 275 | `PreviewController` | Second `WKWebView` overlaid at renderer-reported bounds (same pattern as today's `WebContentsView`). Loopback-only policy, popup/download/permission blocking via `WKUIDelegate`/`WKNavigationDelegate`. Low risk. |
| `export-service.ts` | 247 | `ExportService` | String generation; `NSSavePanel`. Low risk. |
| `workspace-service.ts` | 221 | `WorkspaceService` | Directory walking with the same skip rules and 2 MB preview cap. Trivial. |
| `attachment-service.ts` + `validation.ts` | 307 | `AttachmentService`, `Validation` | `NSOpenPanel`; same count/size limits revalidated in Swift. See §7.4 for drag-and-drop. |
| `pi-validation.ts`, `thread-path.ts`, `platform.ts` | 137 | small helpers | Trivial. |

The preload (`src/preload`, 72 lines) is replaced by the bridge shim; the renderer and
`src/shared` are untouched.

## 6. Windows, chrome, and theme

- **Main window**: `NSWindow` with `.fullSizeContentView`, `titlebarAppearsTransparent`,
  hidden title, traffic lights repositioned to (20, 18) — the current `hiddenInset`
  look. Sidebar vibrancy: an `NSVisualEffectView` (`.sidebar` material) pinned behind a
  transparent web view (`underPageBackgroundColor = .clear`, `drawsBackground = false`);
  the renderer's translucent `--sidebar` background continues to show it through.
- **Settings window**: frameless compact `NSWindow` hosting the same bundle at
  `codepi://app/settings` (the route the settings renderer already uses), vibrancy
  `.underWindow`.
- **Menu**: native `NSMenu` reproducing today's template (About, Settings ⌘, ·
  File → New Thread ⌘N / New Project ⇧⌘N · Edit standard · Window). Items emit
  `menuAction` bridge events; in-page shortcuts (⌘K, ⌘Enter, Esc…) live in the renderer
  and are unaffected.
- **Theme**: `effectiveAppearance` KVO → `themeChanged` events; the settings override
  sets `NSApp.appearance`. Same semantics as `nativeTheme`.
- **Lifecycle**: `applicationShouldTerminate` performs today's `before-quit` cleanup
  (terminate every Pi subprocess and PTY, flush state) and then replies
  `.terminateNow`. macOS launch services already enforce single-instance for app
  bundles, which replaces Electron's lock.

## 7. Subsystem notes

### 7.1 Pi RPC

`PiRpcClient` owns one `Process` per open thread (`pi --mode rpc`, cwd = project dir or
worktree, env = settings env over inherited env — inheriting the user's login `PATH`
requires resolving the shell environment once at startup, as GUI apps don't get it for
free; reuse the existing `piPath` setting as the primary mechanism). Stdout is consumed
as an `AsyncLineSequence` with the same partial-final-line tolerance as the current
decoder; records are normalized into the same typed `ThreadEvent` union before crossing
the bridge. Crash and malformed-record handling produce recoverable thread errors, never
app termination.

### 7.2 PTY terminal

`PtyService` replaces node-pty: `openpty()`, set window size, fork/exec the user's shell
as a login shell in the thread cwd (same shell-resolution rules as
`terminal-platform.ts`), master fd read via `DispatchSourceRead` → coalesced
`terminal data` events; `writeTerminal` writes to the master; `resizeTerminal` issues
`TIOCSWINSZ`; close/archive/trash/quit lifecycle identical to today. xterm.js stays the
emulator, so escape-sequence fidelity is not at risk — only the ~200-line PTY plumbing
is new, and it gets a soak test (vim, htop, long scrollback, resize storms).

### 7.3 Preview

Today the preview is already a native view overlaid on the renderer with bounds reported
by a `ResizeObserver` (`setPreviewBounds`). The Swift shell keeps the identical
mechanism with a second `WKWebView` in a separate, non-persistent
`WKWebsiteDataStore`. The policy layer ports directly: loopback hosts only, `http(s)`
only, no credentials in URLs, popups denied, downloads denied, permission prompts
denied, target=_blank → deny. `previewAction` maps to goBack/goForward/reload;
`PreviewEvent.state` derives from navigation delegate callbacks and KVO on
`title`/`canGoBack`/`canGoForward`/`isLoading`.

### 7.4 Attachments and drag-and-drop

Picker and paste flows are mechanical ports (NSOpenPanel; clipboard images arrive via
the renderer as base64 data URLs exactly as today). **File drag-and-drop is the one
behavior WKWebView does not give us for free**: dropped files reach the DOM without
filesystem paths. Fix: the shell registers a drop target on the window's content view
for `NSFilenamesPboardType`; on drop over the composer region it forwards
`{ paths }` through a bridge event the shim exposes; DOM drop remains the fallback for
in-page drags. This is called out as an explicit parity-checklist item with its own
test.

### 7.5 State, settings, and data compatibility

Same directory (`~/Library/Application Support/CodePi`), same `state.json` v2 schema,
same atomic-replace strategy, same v1 backup behavior, same Pi-owned session JSONL
files. The Swift shell reuses the Electron bundle identifier (`works.earendil.codepi`)
at release so TCC folder-access grants survive the swap. Development builds use
`works.earendil.codepi.dev` **and** a `CODEPI_STATE_DIR` override pointed at a scratch
directory — two shells must never write one `state.json` concurrently.

Renderer `localStorage` (pane widths, cosmetic prefs) does not migrate across the
origin change from `file://` to `codepi://`; acceptable, documented in release notes.

Settings env values remain in `state.json` for now (same MVP posture as today);
Keychain migration is a listed follow-up, not part of the port.

## 8. Security model mapping

| Electron today | Swift shell |
| --- | --- |
| `contextIsolation`, `sandbox`, no Node in renderer | WKWebView content process is Apple-sandboxed; no bridge method exposes raw FS/exec. |
| Allowlisted invoke channels | `BridgeRouter` registry; unknown channel → rejected. |
| `trustedSender` origin/frame checks | Main-frame-only + app-owned-webview-only + `codepi://app` origin check per message. |
| Renderer input revalidated in main | Same validators ported to Swift; renderer remains untrusted. |
| Preview isolation (separate WebContents, blocked popups/permissions) | Separate `WKWebView` + ephemeral data store + delegate-level denies. |
| No shell interpolation for git/pi | `Process` argument arrays only. |
| Hardened runtime, signed | Same, plus App Sandbox is **not** adopted (the app legitimately spawns arbitrary dev tools; matches current entitlement posture). |

## 9. Build, packaging, repo layout

- `macos/` — XcodeGen `project.yml` (reviewable, no `.xcodeproj` churn), targets:
  `CodePi` (app), `CodePiKit` (services library), `CodePiKitTests`.
- Renderer: `npm run build:web` produces `out/web/` with plain Vite (the existing
  renderer config minus Electron plumbing); the Xcode build copies it into
  `CodePi.app/Contents/Resources/web/` as a build phase. The bridge shim compiles in the
  same step.
- Distribution: `xcodebuild archive` + Developer ID signing + `notarytool`; DMG via
  `create-dmg`. Size target ≤ 25 MB (expected ~12–18 MB).
- CI: existing `npm run check` unchanged; new job runs `xcodegen`, `xcodebuild test`,
  and an archive smoke build on `macos-14`.
- Deployment target: macOS 12 (unchanged; every API used is available on 12).

## 10. Testing strategy

1. **Ported unit tests**: `pi-rpc`, `state-store`, `sessions`, `validation`,
   `thread-library` test suites re-expressed in XCTest against the same fixtures.
2. **Contract fixtures** (§4.3) guard TS↔Swift codec drift in both CIs.
3. **Fake Pi**: a small script speaking the RPC protocol (deterministic scripted
   replies, crash/malformed modes) drives integration tests of
   `PiProcessManager` + bridge end-to-end without network or API keys.
4. **Throughput tests**: PTY flood (`yes`, `cat` of a large file) and streaming-delta
   flood through the coalescing dispatcher, asserting ordering and latency budgets.
5. **Parity checklist** (in the plan document): every `CodePiApi` method and event has a
   manual or automated check before the phase that ships it is called done.
6. Existing Vitest suite continues to cover renderer/shared logic unchanged.

## 11. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| PTY edge cases vs node-pty (job control, flow control, exotic shells) | Terminal glitches | Smallest surface (~200 lines); soak tests; keep `terminal-platform.ts` semantics; xterm.js unchanged. |
| Bridge throughput under streaming + terminal load | UI jank | Coalesced batch dispatch (§4.2); measured budget tests; worst case: move terminal data to a local WebSocket (design allows swapping transport behind the shim). |
| Drag-and-drop path fidelity (§7.4) | Feature regression | Native drop target + dedicated checklist item. |
| GUI-app environment (PATH) differs from terminal | `pi`/`git` not found | Existing `piPath` setting + one-time login-shell env resolution + onboarding validation flow already handles this UX. |
| Two shells writing one state file during development | Data corruption | Dev bundle id + `CODEPI_STATE_DIR`; single-writer rule documented; release cutover is atomic. |
| WKWebView quirks (clipboard, focus, IME) | Papercuts | Phase 0 spike explicitly exercises paste-image, IME composition, and focus traversal before further investment. |
| Contract drift during long port | Silent breakage | Shim type-checked against `contracts.ts`; fixture round-trips in both CIs; feature freeze on `src/main`. |

## 12. Open questions (to resolve during Phase 0)

1. Login-shell environment capture: adopt the one-shot `zsh -lic env` snapshot at first
   launch, or rely purely on explicit settings? (Leaning: snapshot, cached, refresh
   button in Settings.)
2. Ship the bridge shim inside `index.html` of the web build vs `WKUserScript`
   injection? (Leaning: `WKUserScript` to keep the web build shell-agnostic.)
3. Sparkle auto-updates at cutover or stay with manual GitHub releases initially?
   (Leaning: manual first; Sparkle is a follow-up.)
