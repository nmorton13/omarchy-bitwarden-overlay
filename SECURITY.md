# Security policy

## Supported versions

Security fixes are made to the current source version on the default branch. There are no published releases or supported older versions yet.

## Reporting a vulnerability

Do not include vault exports, passwords, session keys, or real account data in a report. If this project is hosted on GitHub, repository administrators can enable private reporting in **Settings → Security → Private vulnerability reporting**. Once enabled, use GitHub's **Report a vulnerability** action on the repository's Security tab to send details privately as a draft security advisory. Private vulnerability reporting is enabled for this project's GitHub repository. Use GitHub's **Report a vulnerability** action on the repository's Security tab to send a private report as a draft security advisory. Do not post sensitive exploit details publicly if private reporting is unavailable.

## Scope and limitations

The plugin is a local overlay around the Bitwarden CLI. It does not protect against a compromised user account, other processes running as the same user, root, a malicious `bw`/`wl-copy`/`wl-paste` executable or PATH, memory inspection, swap, core dumps, or clipboard managers that retain clipboard history. Clipboard expiry is a best-effort comparison followed by clearing and is subject to races and compositor/manager behavior. Closing the overlay clears its local state and requests CLI locking, but CLI cleanup may fail; the local overlay remains locked regardless.

Please use synthetic data for security testing and report only the minimum details needed to reproduce an issue.
