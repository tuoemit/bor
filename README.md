# Render Phone Browser

A minimal remote mobile browser for a Render Free web service.

## What it does

- Runs one headless Chromium instance with a 390×844 Android-style viewport.
- Gives you a touch-friendly web panel.
- Tap the live phone screen to click page elements.
- Type text into the focused page from the control panel.
- Back, forward, reload, home, scrolling, and browser reset.
- Optional `APP_PASSWORD` protection.
- Uses JPEG screenshots and a single browser/context to keep memory usage down.

## Deploy on Render

Create a **Web Service** from this repository and choose **Docker**. The included `render.yaml` is also ready for a Blueprint-style deploy.

The container listens on port `10000` and Render proxies it to the public service URL.

### Optional environment variable

`APP_PASSWORD` — optional password protection. When set, the panel asks for the password the first time an API request is made in that browser tab and keeps it in `sessionStorage` for that tab.

## Important free-tier behavior

Render Free web services have 512 MB RAM / 0.1 CPU and can spin down after 15 minutes without inbound traffic. Their local filesystem is ephemeral. Browser cookies/session state therefore only live for the life of the running instance and should not be treated as persistent storage.

This project intentionally does **not** run X11, VNC, noVNC, or a desktop environment. Those components add unnecessary memory/CPU overhead for a phone-sized browser preview.

## Security note

Do not expose this publicly without authentication if the browser will be used to access private accounts. A public instance effectively becomes a remote browsing endpoint.
