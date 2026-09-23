# Render Phone Browser — VNC/noVNC

A tiny remote Chromium browser for Render using:

- Xvfb for the virtual display
- Chromium for the browser
- x11vnc for VNC
- noVNC + websockify for browser-based VNC access
- One public Render port

## Deploy on Render

Create a Web Service from this repository and choose Docker + Free.

The service must expose Render's `$PORT`; `start.sh` does that automatically.

Open:

`https://YOUR-SERVICE.onrender.com/vnc.html?autoconnect=true&resize=scale&path=websockify`

You can also open the service root. The websockify/noVNC web server serves the noVNC files directly.

## Recommended environment variables

`VNC_PASSWORD` — optional VNC password. Set this in Render for private use.

`START_URL` — initial Chromium URL. Example: `https://www.google.com`

`SCREEN_WIDTH` — default `390`

`SCREEN_HEIGHT` — default `844`

## Using it

Once noVNC connects, you are controlling the real Chromium instance running inside Render. Use Chromium's own address bar to enter any website address.

This is different from the previous screenshot-control implementation: there is no screenshot polling or synthetic click API. noVNC sends real mouse, keyboard, and pointer events to VNC, which controls the X desktop.

## Security

Set `VNC_PASSWORD`. Without it, anyone who can reach the public Render URL can control the browser. A VNC password alone is not a full application-auth system, so do not use this to access sensitive accounts unless you understand the exposure.

## Notes for Render Free

This is intentionally single-user/single-browser and uses a small 390x844 display. Chromium remains the main resource consumer.
