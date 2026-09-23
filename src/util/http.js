// Small HTTP helpers — cookie parsing without pulling in cookie-parser.
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function cookieMiddleware(req, _res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  next();
}

export const readCookie = (req, name) => req.cookies?.[name] ?? null;

export function isSecureRequest(req) {
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') return true;
  if (req.headers['x-forwarded-ssl'] === 'on') return true;
  if (req.secure === true) return true;

  // Embedded in a third-party page (hosted preview pane, dashboard iframe):
  // such origins are always https in practice, and a properly cross-site
  // cookie must be SameSite=None; Secure or the browser throws it away.
  if (req.headers['sec-fetch-site'] === 'cross-site') return true;
  return false;
}

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

/** Best-effort browser-platform detection, purely informational for the UI. */
export function platform() {
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID) {
    return { name: 'Railway', region: process.env.RAILWAY_REGION ?? null };
  }
  if (process.env.RENDER || process.env.RENDER_SERVICE_ID) {
    return { name: 'Render', region: process.env.RENDER_REGION ?? null };
  }
  if (process.env.FLY_APP_NAME) return { name: 'Fly.io', region: process.env.FLY_REGION ?? null };
  return { name: 'Local / Docker', region: null };
}

export const hasVolume = () =>
  Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.RENDER_DISK_MOUNT_PATH || process.env.BP_VOLUME_MOUNT);
