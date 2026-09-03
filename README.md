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
2. The helper uses the official [`nomorepass`](https://www.npmjs.com/package/nomorepass)
   Node library to get a ticket from `api.nomorepass.com` and prints the QR
   payload as a JSON event on stdout.
3. The overlay renders the payload with `qrencode` and waits.
4. You scan the QR with the NoMorePass app (Android/iOS) and approve the send.
5. The helper receives the credential (the password travels AES-encrypted
   against a random one-shot token), prints a `credentials` event, and the
   overlay pipes the secret into `wl-copy` through the process environment —
   it never appears on a command line.

## Requirements

- Omarchy (Quickshell-based shell) — this is an Omarchy plugin
- `node` — resolved from `PATH`; well-known locations (mise, nvm) are used as
  fallback. [Node.js](https://nodejs.org)
- `qrencode` and `wl-copy` (`qrencode`, `wl-clipboard` packages) — both ship
  with Omarchy by default

## Install

```sh
omarchy plugin add https://github.com/yoprogramo/omanomorepass.git
```

Plugins install disabled so you can review the code first. Enable with:

```sh
omarchy plugin enable io.github.yoprogramo.omanomorepass
```

## Usage

Summon the overlay (for example from a Hyprland keybinding or the omarchy
menu):

```sh
omarchy-shell shell summon io.github.yoprogramo.omanomorepass '{"site":"github.com","timeout":90}'
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

- **API key**: by default the library's `FREEAPIKEY` is used. To use your own,
  pass `--apikey <key>` to the helper invocation inside `NmpOverlay.qml`
  (`startHelper()`), or export `NMP_APIKEY` in the shell environment.
- **Timeout**: seconds waiting for the scan, default 90 (`timeout` payload key).

## Logs and troubleshooting

Everything the plugin does is logged (redacted — never the password) to:

```
~/.local/state/omarchy/nomorepass.log
```

If a transfer fails, check the tail of that file: `event=qr` with nothing
after means nobody scanned before the timeout; `event=expired` means the
ticket aged out; `helper-stderr: call failed:` lines mean the NMP API was
unreachable. `wl-copy exited code=0` confirms the clipboard write.

Note: Omarchy's clipboard manager keeps a history — the copied password will
appear there. Delete the entry from the clipboard manager if that matters to
you.

## Privacy and security

- The credential is end-to-end encrypted by the NoMorePass protocol; the
  ticket handshake goes through `api.nomorepass.com` (third-party service).
- The secret is never written to disk by this plugin and never appears in
  process arguments. The QR temp file only ever contains the public ticket
  payload and is removed on close.
- Diagnostics logs are redacted.
- The plugin runs unsandboxed inside `omarchy-shell`, like every Omarchy
  plugin. Review the code before enabling it.

## Remove

```sh
omarchy plugin remove io.github.yoprogramo.omanomorepass
```

## License

MIT — see [LICENSE](LICENSE). Bundled npm dependencies keep their own
licenses; `nomorepass` is Apache-2.0.
