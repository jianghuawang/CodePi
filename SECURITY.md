# Security policy

## Supported versions

Security fixes are provided for the latest released minor version of CodePi.
Older versions may be asked to upgrade before a fix is evaluated.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting flow from the repository's **Security** tab.
Include the affected version, reproduction steps, impact, and any suggested
mitigation. You should receive an acknowledgement within seven days.

CodePi launches coding agents and integrated terminals with the permissions of
the current macOS user. Isolated Git worktrees separate source changes; they are
not operating-system sandboxes. Provider environment values are currently
stored in CodePi's local state file, so prefer provider-managed login where
possible and never attach that state file to a public issue.
