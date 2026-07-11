# CodePi

CodePi is a macOS-first desktop command center for the [Pi coding agent](https://github.com/badlogic/pi-mono). It runs one isolated Pi RPC subprocess per thread, keeps multiple agents active in parallel, renders their streaming work as a native-feeling conversation, and adds a Codex-style Git changes review surface.

> MVP status: macOS only. Platform checks and process-launch details are isolated so Windows and Linux support can be added without changing the renderer contract.

## Prerequisites

- macOS on Apple silicon
- Node.js 22.12 or newer
- Git for changes and worktree features
- Pi on `PATH`

Install Pi if needed:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```

CodePi validates the configured binary on launch. If it cannot run `<binary> --version`, the app opens an onboarding screen instead of failing. A custom binary path and provider environment variables can be set in Settings.

## Run locally

```bash
npm install
npm run dev
```

Build the production bundles and verify types:

```bash
npm run build
```

Create an Apple-silicon `.app` and `.dmg` in `release/`:

```bash
npm run dist:mac
```

`electron-builder` automatically uses an available macOS signing identity. With no identity installed it still creates an unsigned local build. Hardened runtime is enabled; notarization is left to the release environment when Apple credentials are present.

Run the protocol framing tests:

```bash
npm test
```

## Using CodePi

1. Add a project with the folder button or **File → New Project** (`⌘⇧N`).
2. Create a thread with the plus button or **File → New Thread** (`⌘N`).
3. For Git projects, leave **Run in isolated worktree** enabled to work on a dedicated `pi/<thread-id>` branch under `.pi-gui/worktrees/`.
4. Choose the active model and thinking level from the controls directly below the message field.
5. Send with `⌘Enter`. While Pi is running this becomes a steering message. Use `⌥Enter` to queue a follow-up for after Pi settles, and `Esc` to abort.
6. Open **Changes** to inspect diffs, stage files, commit, push, or apply a worktree branch back to the main checkout.
7. Open **History** to inspect Pi’s append-only session tree and branch an earlier user message into a new CodePi thread.

Pi sessions remain Pi-owned JSONL files. CodePi stores only project/thread metadata, window bounds, and settings in its own `app.getPath('userData')` state file. On launch it scans Pi session headers for the project working directories and restores sessions that were created outside the current app state as well.

## Architecture

CodePi has a deliberately narrow privilege boundary:

```text
React renderer (sandboxed)
        │ typed invoke/event API
        ▼
contextBridge preload
        │ allowlisted IPC only
        ▼
Electron main process
  ├─ app/window/menu/state lifecycle
  ├─ project, Git, and worktree services
  └─ ThreadManager
       └─ PiRpcClient × thread
            └─ pi --mode rpc (cwd = thread working directory)
```

### Main process

The main process owns every privileged operation: child processes, filesystem access, folder dialogs, Git, worktrees, application state, native theme control, and opening external editors. Renderer-provided identifiers and paths are resolved against known project/thread records before use. Git and Pi commands use argument arrays rather than an interpolated shell.

The primary window uses `titleBarStyle: 'hiddenInset'`, macOS traffic-light positioning, and sidebar vibrancy. The renderer paints the 260 px sidebar transparent and the content pane opaque. Settings opens in a separate compact frameless window. The macOS application menu supplies About, Settings, File, Edit, and Window commands.

### Preload

The preload exposes `window.codePi`, a typed, allowlisted API built with `contextBridge`. Windows use:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`

No Node, Electron, filesystem, process, or Git primitives are exposed to React, and the deprecated remote module is not used.

### Renderer

The React renderer owns presentation and ephemeral view state only. It uses system typography and CSS variables for native light/dark appearance, follows `nativeTheme` unless overridden, virtualizes long transcripts, sanitizes rendered Markdown with DOMPurify, and highlights code lazily with Shiki. Tool execution cards update from Pi’s accumulated output records and can be collapsed independently.

### RPC lifecycle

`PiRpcClient` spawns the configured Pi binary as:

```text
pi --mode rpc [--session <session-file>] [--model <provider/model>]
```

Each process receives its thread working directory as `cwd` and a merged copy of the configured provider environment. Commands and responses are correlated with request IDs. Events are normalized before crossing IPC.

Framing follows Pi’s RPC contract exactly: stdout is decoded incrementally and split on LF (`\n`) only. A trailing CR is accepted, while Unicode line/paragraph separators inside JSON strings remain part of the record. Node’s `readline` module is intentionally not used. CodePi derives an internal settled boundary only after `agent_end` remains stable; documented retry and compaction continuation events (or a new `agent_start`) cancel the pending settlement so the UI does not declare the thread idle between automatic runs.

CodePi maps the documented RPC operations directly:

- normal prompt: `prompt`
- live steering: `steer`
- deferred follow-up: `follow_up`
- cancellation: `abort`
- model menu: `get_available_models` and `set_model`
- thinking level: `set_thinking_level` (`off`, `minimal`, `low`, `medium`, `high`, or `xhigh`)
- history: Pi session JSONL state, cloned into a new ancestry-preserving session when branching
- transcript/session recovery: `get_state` and `get_messages`
- token and cost footer: assistant usage and `get_session_stats`

Unexpected stderr, malformed JSON, a rejected command, and child exit are surfaced as thread errors. A Pi crash never terminates Electron; Restart creates a fresh subprocess against the same session. All child processes are terminated during `before-quit`.

## Worktree behavior

For a Git project, an isolated thread creates:

```text
<project>/.pi-gui/worktrees/<thread-id>
branch: pi/<thread-id>
```

The stored base branch and commit define the Changes comparison and the commit range applied back to the main checkout. Deleting the thread stops Pi first, then removes the worktree and its Pi branch when safe. Non-Git folders silently use the project directory and omit Git-only controls.

## Data and credentials

CodePi state is a JSON file below Electron’s user-data directory. Environment values entered in Settings are exposed only to the dedicated Settings renderer for editing and to newly spawned Pi subprocesses, but this MVP stores them in that JSON file and does not claim Keychain-grade secret storage. The main-window bootstrap is redacted. For long-lived credentials, prefer provider login handled by Pi or environment injection outside CodePi.

Pi’s own configuration and sessions remain under its configured agent directory (normally `~/.pi/agent`). CodePi never mutates an existing session file; branching writes a new Pi-compatible JSONL session containing the selected node’s ancestry and records the parent session path.

## Protocol source

The implementation targets the current upstream [Pi RPC protocol](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md). The former `earendil-works/pi` raw documentation URL now returns 404; the npm package and repository currently resolve to the canonical `badlogic/pi-mono` source tree.
