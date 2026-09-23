// Host / IP validation. This is the SSRF gate: everything the proxy fetches
// goes through resolveTarget() first.
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import { log } from '../log.js';

export class ProxyError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code ?? 'proxy_error';
  }
}

export function isIpLiteral(host) {
  return net.isIP(host.replace(/^\[|\]$/g, '')) !== 0;
}

export function isPrivateIp(ip) {
  const v = ip.replace(/^\[|\]$/g, '');
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(v)) {
    const lc = v.toLowerCase();
    if (lc === '::' || lc === '::1') return true;
    if (lc.startsWith('fe80') || lc.startsWith('fc') || lc.startsWith('fd')) return true;
    if (lc.startsWith('::ffff:')) return isPrivateIp(lc.slice(7));
    if (lc.startsWith('2001:db8') || lc.startsWith('2002')) return true;
    return false;
  }
  return true; // unparseable -> treat as unsafe
}

/**
 * Turn a URL string into a validated { url, host, ip, family } ready to fetch.
 * Throws ProxyError(403) for anything that resolves into private space.
 */
export async function resolveTarget(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new ProxyError(400, 'Invalid URL', 'bad_url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProxyError(400, `Blocked scheme: ${url.protocol}`, 'bad_scheme');
  }

  const host = url.hostname.toLowerCase();

  if (config.blockedHosts.some((b) => host === b || host.endsWith(`.${b}`))) {
    throw new ProxyError(403, `${host} is blocklisted by BLOCKED_HOSTS`, 'blocked_host');
  }

  if (config.allowPrivateHosts) {
    return { url, host, ip: null, family: 0 };
  }

  if (isIpLiteral(host)) {
    if (isPrivateIp(host)) {
      throw new ProxyError(403, `${host} resolves into private address space`, 'private_ip');
    }
    return { url, host, ip: host, family: net.isIP(host.replace(/^\[|\]$/g, '')) };
  }

  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new ProxyError(502, `DNS lookup failed for ${host}: ${err.code ?? err.message}`, 'dns_failure');
  }
  if (!addrs.length) throw new ProxyError(502, `No DNS records for ${host}`, 'dns_empty');

  const bad = addrs.find((a) => isPrivateIp(a.address));
  if (bad) {
    log.warn(`SSRF blocked: ${host} -> ${bad.address}`);
    throw new ProxyError(403, `${host} resolves to a private address`, 'private_ip');
  }

  return { url, host, ip: addrs[0].address, family: addrs[0].family };
}

// Minimal DNS pinning for the platform's fetch (Node's undici keeps its own
// DNS cache, so this is belt-and-braces on the validate step, not a guarantee).
export function hostHeaderFor(port, host) {
  const isDefault = (port === '443' || port === '80' || port === '');
  return isDefault ? host : `${host}:${port}`;
}
