# Bitwarden CLI overlay for Omarchy

A small Omarchy Shell overlay that searches Bitwarden login items and copies a username or password to the Wayland clipboard. The backend uses only Node.js built-ins; the Bitwarden CLI and `wl-clipboard` are external runtime dependencies.

## Requirements

- Omarchy Shell with user plugins enabled.
- Node.js 22 or 24 LTS on the Omarchy Shell process `PATH`.
- Bitwarden CLI (`bw`) signed in with `bw login` before use.
- `wl-copy` and `wl-paste` from `wl-clipboard`, plus a Wayland clipboard compositor.

The plugin was checked locally with Omarchy 4.0.3-1, Bitwarden CLI 2026.9.0, Node.js 26.9.0, and Qt 6 `qmlformat`; these are the local verification versions, not additional support promises. The backend uses the documented `bw unlock --passwordfile ... --raw`, `bw list ... --raw`, and `bw get ... --raw` interfaces. Verify compatibility with your installed CLI version before use.

## Install and enable

Install the public plugin directly with Omarchy:

```sh
omarchy plugin add https://github.com/nmorton13/omarchy-bitwarden-overlay.git --enable
omarchy plugin validate ~/.config/omarchy/plugins/nmorton.bitwarden
```

Use `omarchy plugin disable nmorton.bitwarden` to disable it. Do not enable the overlay until `bw` and `wl-clipboard` are installed and available in the shell's `PATH`.

## Use and credential lifecycle

Toggle the overlay with:

```sh
omarchy-shell shell toggle nmorton.bitwarden
```

Enter the master password to unlock, search by item name, username, or URI, press Enter to copy the selected password, Ctrl+U to copy its username, Ctrl+L to lock, and Esc to close. Closing clears local session, item, password, and pending request state immediately and asks the CLI to lock when possible. Explicit local locking behaves the same even while a subprocess is busy; cleanup is queued until that bounded operation exits. A session expires after five minutes while open. There is no plugin-level screen-lock event subscription; close-to-lock and expiry are the supported boundaries.

The unlock password is briefly written to an exclusively-created mode-0600 file in a validated private `XDG_RUNTIME_DIR` directory. The installed CLI documents `--passwordfile` as its password transport and reads the first line; its documented unlock interfaces do not provide an inherited-descriptor/stdin password option. The file and temporary directory are removed on normal completion, timeout, and handled SIGINT/SIGTERM. SIGKILL, power loss, runtime-directory storage characteristics, swap, and process memory are outside that cleanup guarantee. The CLI's `--raw` credential output is passed without trimming or newline normalization; the CLI raw mode writes the value directly when stdout is not a TTY.

The overlay displays item IDs, names, usernames, and first URIs only. Passwords are retrieved on demand and piped to `wl-copy`, not returned to QML. Dynamic text is rendered as plain text. Clipboard clearing runs after 30 seconds only if a separate `wl-paste` read still matches the value copied. This is best effort: another copy can race between comparison and clear, an identical later copy cannot be distinguished, and clipboard managers may retain history despite the sensitive-content hint.

## Threat model

This reduces accidental credential persistence and limits the plugin's exposure surfaces; it is not a boundary against a compromised user account, other same-user processes, root, compromised executables/PATH, memory inspection, swap, or core dumps. Session keys and vault metadata exist temporarily in process memory. See [SECURITY.md](SECURITY.md) for reporting guidance and limitations.

## Development

No npm install is needed. Run:

```sh
node --check backend.mjs
node --test tests/*.test.mjs
qmlformat --normalize Bitwarden.qml > /dev/null
omarchy plugin validate "$PWD"
```

The tests substitute `bw`, `wl-copy`, and `wl-paste` with temporary fixtures and do not access a real vault or desktop clipboard. The QML parser check is source-level syntax validation, not full Quickshell import/type checking or a desktop smoke test.

## License

This project is licensed under the [MIT License](LICENSE).
