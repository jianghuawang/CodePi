# Changelog

All notable user-facing changes to CodePi are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases
follow semantic versioning.

## [Unreleased]

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
