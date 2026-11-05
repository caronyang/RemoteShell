# RemoteShell

A Windows desktop remote terminal application, comparable to Xshell. Supports SSH v2 and Telnet, SFTP file transfer, jump hosts, and a multilingual UI (English / Traditional Chinese).

## Features

- SSH v2 and Telnet connections
- Connection list with groups, search, and tags
- Single-hop jump host (bastion) support
- SFTP dual-pane file transfer with drag-and-drop and a transfer queue (pause/resume/retry)
- Multiple terminal tabs with ANSI 16/256 color and CJK/UTF-8
- English / Traditional Chinese, switched instantly without restart

## System Requirements

- Windows 10/11, 64-bit
- Installer size about 90-130 MB; no external runtime required

> Windows 10 22H2 is verified. Windows 11 is supported by design, but cold start, DPAPI credential storage, and the bundled font chain are **pending verification on a real Windows 11 machine** (not yet PASS).

## First Connection

1. File -> New Connection (Ctrl+Shift+N).
2. Fill host/port and choose authentication: password, password file, or public key.
3. Double-click the connection in the left tree to connect.
4. With an SSH session active, click the SFTP toolbar button (Ctrl+Shift+S) to open the dual-pane transfer view.

## Jump Host Setup

Save the bastion as a normal connection first, then in the target connection's "Jump Host" tab enable jump host and select it. v1 supports a single hop. SFTP transfers use the same tunnel.

## Key Formats

Supported: OpenSSH and PEM (RSA / ECDSA / Ed25519), including passphrase-protected keys.

PuTTY `.ppk` files are not supported directly. Convert with PuTTYgen: Conversions -> Export OpenSSH key.

## Data Location and Security

All data is stored under `%APPDATA%\RemoteShell\`:

- `settings.json`
- `connections.json`
- `known_hosts.json`
- `logs\app-YYYYMMDD.log`

Passwords are encrypted with Windows DPAPI. Only the same Windows user on the same machine can decrypt them; moving to another machine or account requires re-entering credentials.

## Settings

- Max concurrent transfers (default 3, adjustable 1-10)
- Default download folder
- On name conflict: ask / overwrite / auto rename
- After download: open folder / notify
- On close with active connections: ask / disconnect

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+Q | Quick connect |
| Ctrl+Shift+N | New connection |
| Ctrl+Tab / Ctrl+1..9 | Switch tab |
| Ctrl+W | Close current tab |
| Ctrl+Shift+S | Open SFTP |
| Ctrl+Shift+Q | Toggle transfer queue |
| Ctrl+, | Settings |
| Ctrl+Shift+L | Switch language |

## Troubleshooting

- Connection timeout: check network/firewall and the host port.
- Host key changed warning: verify the fingerprint; possible man-in-the-middle.
- Jump host failure: read the failed phase shown in the status bar.
- Garbled Chinese: ensure the remote shell uses a UTF-8 locale (LANG).
- Telnet sessions do not support SFTP (button disabled).

## Build

```powershell
npm ci
npm run dev
npm run build
npm run dist
npm run make:setup
```

Tests: `npm test`; typecheck: `npm run typecheck`; lint: `npm run lint`.

## License

- Electron, React, xterm.js, ssh2: MIT
- Cascadia Mono: SIL Open Font License 1.1 (OFL-1.1); license file included
- Inno Setup: free for commercial use
- Consolas: system fallback only, not bundled

## Known Limitations

- v1 supports single-hop jump hosts only.
- `.ppk` keys must be converted with PuTTYgen.
- Telnet is plaintext and shows a warning.
- Transfer resume follows the implemented SFTP strategy only.
- First launch may take 2-4 seconds (antivirus scan); subsequent launches about 1 second.
- Transfer resume supports only appending to the same file; changed source files are retransferred.