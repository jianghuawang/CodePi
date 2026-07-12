# Changelog

All notable user-facing changes to CodePi are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases
follow semantic versioning.

## [Unreleased]

## [0.3.0] - 2026-07-12

### Added

- Automatic thread titles: a thread still named "New thread" takes its title
  from the first prompt sent, and the name syncs into Pi's session.
- Drag-to-resize layout: the app sidebar, the workspace panel, and the file
  list inside Files can all be resized; widths persist and a double-click on
  a divider restores the default.
- Experimental native Swift shell (SwiftPM package under `macos/`, ~4 MB app)
  implementing the full renderer bridge contract: state and thread library,
  Pi RPC streaming, git and isolated worktrees, a native PTY terminal,
  workspace files, transcript search, Markdown/HTML export, the localhost
  preview, and per-thread extensions/skills. See
  `docs/SWIFT_SHELL_DESIGN.md` and `docs/SWIFT_SHELL_PLAN.md`; the Electron
  app remains the supported build until the cutover checklist completes.

### Changed

- The installed Electron app shrank from ~330 MB to ~280 MB: bundled
  JavaScript dependencies are no longer packaged a second time inside
  `app.asar`.
- The workspace file preview and dock chrome now match the application
  background in both light and dark themes.

## [0.2.0] - 2026-07-11

### Added

- Per-thread extensions and skills, context attachments, prompt templates, and
  Pi command discovery.
- Usage dashboard, workspace file viewer, integrated terminal, and localhost
  app preview.
- Thread pinning, archiving, tags, Trash, duplication, export, and transcript
  search.
- Git changes review, isolated worktrees, session history, and branch-from-
  history workflows.

### Changed

- New threads now use the current project branch unless worktree isolation is
  explicitly enabled.
- Integrated terminal colors now follow the active CodePi theme.
- Added a single contributor check covering linting, tests, type checking, and
  production bundling.
- Added community, security, support, contribution, and release documentation.

### Fixed

- Preserved integrated terminal sessions while navigating between threads.
- Prevented composer drafts, attachments, Git changes, and thread-local UI from
  leaking across thread switches.
- Aligned user labels with their message bubbles and corrected virtualized
  transcript spacing between user and Pi messages.
- Preserved intentional repeated prompts and rejected corrupt session records
  instead of silently discarding transcript data.
- Cleaned up renderer-owned terminals and previews after window crashes or
  closure, and surfaced state persistence and export failures.

## [0.1.0]

### Added

- Initial macOS MVP with projects, Pi RPC threads, streamed conversations, and
  Git review.

[Unreleased]: https://github.com/jianghuawang/CodePi/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jianghuawang/CodePi/releases/tag/v0.2.0
