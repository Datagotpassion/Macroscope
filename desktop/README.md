# PlateScope Desktop (Electron)

A native Windows app that wraps the PlateScope React UI and talks to the Pi
over the network. Unlike the browser (served over `http://` from the Pi), the
desktop app runs the UI in a **secure local context**, so it gets:

- **Native folder saving** — pick a real folder; captures write straight to disk
  (no download prompts, no `http` secure-context limitation).
- A **Pi-address / connection** setting (Settings panel).
- The foundation for PC-side change tracking, USB auto-connect, and
  auto-imaging on connect (next iterations).

The Pi keeps running its server exactly as before — the desktop app is just a
nicer client. Nothing on the Pi changes.

## Run it (dev / unpackaged)

Requires Node.js + npm on the PC.

```bash
cd desktop
npm install
npm start          # builds the frontend, then launches the app
```

On first launch it targets `http://raspberrypi.local:8000`. If your Pi is at a
different address, change it in **Settings → Connection** (or set the
`PLATESCOPE_API` env var before launching).

`npm run start:fast` skips rebuilding the frontend (use after the first build).

## Build a Windows installer

```bash
cd desktop
npm run dist       # outputs an installer under desktop/release/
```

This bundles the built frontend (`frontend/dist`) into the app via
`extraResources`, so the installed app is self-contained.

## How it connects

- The frontend's API base is configurable (`frontend/src/api.js`). In the
  desktop app, `preload.js` injects `window.desktop.defaultApiBase`; the UI uses
  that (or whatever you set in Settings) for all `/api` + `/ws` calls.
- The Pi's FastAPI already allows cross-origin requests, so the local app can
  call it directly.
- Native saving is exposed via `window.desktop.chooseFolder()` /
  `saveImage()` (see `preload.js` / `main.js`); `LocalSave.jsx` uses them when
  present, and falls back to the File System Access API or download in a plain
  browser.
