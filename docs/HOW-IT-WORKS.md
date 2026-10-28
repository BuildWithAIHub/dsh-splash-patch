# How it works

## Patch shape

The patched `app.asar` gets three entries:

| Entry | Change |
|---|---|
| `lib/main.js` | A separate frameless fullscreen `BrowserWindow` plays the clip; the hidden main window loads the real app page in parallel; the workspace page is only shown after the splash reports `done`/`skip`; IPC handlers for the animation plugin's fullscreen requests. |
| `lib/preload-app.cjs` | Exposes `__DSH_BOOT_FULLSCREEN__` and `__DSH_BOOT_SPLASH__` to the local app document only. |
| `renderer/boot-splash.html` | The splash page itself (inline CSS/JS, no external assets). |

The archive is not rebuilt: the original data section is copied byte for byte and only
the changed/added files are appended, with their header entries (size, offset, SHA-256
integrity) rewritten. That keeps every other byte of the installation identical.

## Why a launcher and a watchdog

DSH auto-updates by downloading an installer and replacing the application directory,
which restores the original `app.asar`. Nothing inside the archive can survive that, so
the patch has to be re-applied from outside:

- **launcher** (`launch\launch-dsh.vbs` -> `launch-dsh.ps1`) runs the patcher before
  starting DSH; this is the primary guarantee.
- **watchdog** (scheduled task) runs the patcher when DSH is *not* running; it repairs
  installations that were updated and then opened by other means.

The patcher is idempotent: an already patched archive is reported as `already` and not
touched.

## Safety rules

- Only writes when DSH is not running (launcher and watchdog both check).
- The patched sources are parsed with `node --check` before the archive is written.
- Anchors are literal code fragments. If a DSH update changes them, the patcher
  reports `unsupported` and writes nothing - a partially patched archive is never left
  behind.
- A pristine backup is kept in `state\app.asar.unpatched.bak` (first write only).
- The splash page has its own 20 s fallback and the desktop patch a 30 s hard fallback,
  so a broken video can never hold the app.