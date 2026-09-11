# omanomorepass

An [Omarchy](https://omarchy.org/) shell plugin that receives credentials from
the [NoMorePass](https://nomorepass.com) mobile app: it shows a QR code, you
scan it with the phone, and the received password lands directly in the
Wayland clipboard.

```
┌──────────────────────────┐        ┌─────────┐
│  Request ticket from NMP │        │         │
│  Show QR ────────────────┼───────▶│  📱     │
│  Wait for scan…          │◀───────┤ scan    │
│  ✓ Copied to clipboard   │  AES   │ send    │
└──────────────────────────┘        └─────────┘
```

## How it works

1. `NmpOverlay.qml` (Omarchy shell / Quickshell) spawns `nmp-helper.js`.
2. The helper implements the NoMorePass reception protocol using the bundled
   dependencies, validates the ticket from `api.nomorepass.com`, and streams
   the QR URI to `/usr/bin/qrencode` over stdin.
3. Node encodes the bounded PNG in memory and sends an image event to the overlay.
4. You scan the QR with the NoMorePass app (Android/iOS) and approve the send.
5. The helper receives the credential (the password travels AES-encrypted
   against a random one-shot token), prints a `credentials` event, and the
   overlay launches `/usr/bin/wl-copy` directly, writes the bounded secret to
   stdin, closes stdin, and immediately clears its pending secret reference.
   Success is shown only after the clipboard process exits successfully.

## Requirements

- Omarchy (Quickshell-based shell) — this is an Omarchy plugin
- System-managed `/usr/bin/node`, `/usr/bin/qrencode`, and `/usr/bin/wl-copy`
  (`nodejs`, `qrencode`, `wl-clipboard` packages on Arch).
  Executable identities are fixed; PATH, mise, and nvm installations are not used.
  Install the system packages if any required executable is missing.

## Install

```sh
omarchy plugin add https://github.com/yoprogramo/omanomorepass.git
```

Plugins install disabled so you can review the code first. Enable with:

```sh
omarchy plugin enable io.github.yoprogramo.omanomorepass
```

## Usage

Summon the overlay from a Hyprland keybinding, the bar widget, or the shell:

```sh
omarchy-shell shell summon io.github.yoprogramo.omanomorepass '{"site":"github.com","timeout":90}'
```

### Bar widget

The plugin ships a QR-code button for the Omarchy bar (kind `bar-widget`).
Add it with:

```sh
omarchy bar put io.github.yoprogramo.omanomorepass --section right
```

Left click opens the overlay, click again closes it.

### Keybinding example

```lua
-- ~/.config/hypr/bindings.lua
o.bind("SUPER + ALT + P", "NoMorePass",
  "omarchy-shell shell toggle io.github.yoprogramo.omanomorepass '{}'")
```

Both payload keys are optional. Scan the QR with the NoMorePass app and
approve the send; the password is copied to the clipboard and the overlay
closes itself after a few seconds. `Esc` or clicking the backdrop cancels.

IPC surface (also usable with `omarchy-shell shell call <target> <method> <arg>`):

| Method     | Effect                                    |
|------------|-------------------------------------------|
| `open`     | Open with defaults                        |
| `openSite` | Open with a given site, takes JSON string |
| `toggle`   | Open if closed, close if open             |
| `close`    | Close                                     |
| `testCopy` | Diagnostic: copies a fake credential      |

## Configuration

- **API key**: defaults to `FREEAPIKEY`. Export `NMP_APIKEY` in the shell
  environment to override it (maximum 256 UTF-8 bytes).
- **Timeout**: seconds waiting for the scan, default 90, range 1–900
  (`timeout` payload key).
- **Payload limits**: site 256 UTF-8 bytes, ticket 128 ASCII characters,
  QR URI 512 bytes, username 512 bytes, plaintext password 4 KiB,
  encrypted password 5,528 base64 characters, and optional `extra` 4 KiB of
  text (validated then discarded). Unexpected fields, nested values, invalid
  types, and oversized values are rejected before QR rendering or decryption.
- **Output limits**: API responses 64 KiB, PNG 64 KiB, helper lines 96 KiB,
  helper stdout 128 KiB and four events per transfer. The overlay bounds
  arbitrary chunks before retaining partial lines. QR rendering has a
  three-second deadline; clipboard startup/completion has a five-second deadline.

## Logs and troubleshooting

Event names and process exit codes are logged to:

```
~/.local/state/omarchy/nomorepass.log
```

If a transfer fails, check the error shown by the overlay and the event
sequence in that file. `event=expired` means the ticket aged out;
`wl-copy exited code=0` confirms the clipboard write. Raw helper output,
server responses, and child diagnostics are never forwarded to the log.

Note: Omarchy's clipboard manager keeps a history — the copied password will
appear there. Delete the entry from the clipboard manager if that matters to
you.

## Privacy and security

- The credential is end-to-end encrypted by the NoMorePass protocol; the
  ticket handshake goes through `api.nomorepass.com` (third-party service).
- QR URIs contain the ticket and decryption passphrase and must be treated as
  secrets. Neither QR URIs nor credentials are passed in process arguments or
  child environments. They travel over pipes; PNG encoding stays in memory.
- Child processes use fixed system executable paths and allowlisted
  environments, excluding inherited Node hooks and dynamic-loader settings.
- No secret temporary files are created. Pending QML secret references are
  cleared after writing or on failure/cancellation. JavaScript and Qt do not
  guarantee secure memory erasure; this does not protect against a process
  allowed to inspect application memory or the clipboard.
- Diagnostics logs are redacted.
- The plugin runs unsandboxed inside `omarchy-shell`, like every Omarchy
  plugin. Review the code before enabling it.

## Remove

```sh
omarchy plugin remove io.github.yoprogramo.omanomorepass
```

## Tests

Run from the repository root:

```sh
/usr/bin/node tests/security.test.js
/usr/bin/bash tests/run-stdio-smoke.sh
```

The security suite uses a local HTTP server and synthetic credentials. The
headless Quickshell test verifies 4 KiB Unicode stdin delivery, EOF, environment
isolation, and chunk parsing without touching the clipboard or NoMorePass API.

## License

MIT — see [LICENSE](LICENSE). Bundled npm dependencies keep their own
licenses; `nomorepass` is Apache-2.0.
