// Pure bot-route helpers. Extracted from bots.js so they can be unit-tested
// directly against the SAME code the route runs — re-implementing them in the
// test would let the route drift without the suite noticing.
//
// validateBotUrl() is an SSRF guard for the meeting URL accepted by POST /bots:
// the URL is later handed to a headless Chromium via Playwright page.goto(), so
// an attacker-controlled URL could make the bot reach internal-only targets
// (localhost, cloud metadata at 169.254.169.254, RFC1918 private ranges, etc.).
//
// The predicate has no Model / Express / Playwright dependency, so it loads
// cleanly in a plain mocha context.

// Reserved / private / loopback / link-local IPv4 ranges that must never be
// reachable by the bot's browser. Each entry is [network, prefixLength].
const RESERVED_IPV4_RANGES = [
    ['0.0.0.0', 8],        // "this" network (0.0.0.0/8) — includes 0.0.0.0 itself
    ['10.0.0.0', 8],       // RFC1918 private
    ['127.0.0.0', 8],      // loopback
    ['169.254.0.0', 16],   // link-local (incl. cloud metadata 169.254.169.254)
    ['172.16.0.0', 12],    // RFC1918 private
    ['192.168.0.0', 16],   // RFC1918 private
];

// Parse a dotted-quad IPv4 literal into a 32-bit unsigned integer, or return
// null if the string is not a strict IPv4 literal (4 octets, each 0-255, no
// leading-zero ambiguity rejected loosely — Number() handles the value range).
function ipv4ToInt(host) {
    const parts = host.split('.');
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        // Reject empty, non-numeric, or out-of-range octets.
        if (!/^\d{1,3}$/.test(part)) return null;
        const n = Number(part);
        if (n > 255) return null;
        value = value * 256 + n;
    }
    return value >>> 0;
}

function isReservedIPv4(host) {
    const ip = ipv4ToInt(host);
    if (ip === null) return false;
    for (const [network, prefix] of RESERVED_IPV4_RANGES) {
        const net = ipv4ToInt(network);
        // Mask of the high `prefix` bits. prefix is 8/12/16 here (never 0/32),
        // so the shift is well-defined.
        const mask = (0xffffffff << (32 - prefix)) >>> 0;
        if ((ip & mask) === (net & mask)) return true;
    }
    return false;
}

// Normalize an IPv6 host: strip the optional [...] brackets the URL parser keeps
// and lowercase it. Returns the bare address text.
function normalizeIPv6(host) {
    let h = host;
    if (h.startsWith('[') && h.endsWith(']')) {
        h = h.slice(1, -1);
    }
    // Drop a zone id (e.g. fe80::1%eth0) before classification.
    const pct = h.indexOf('%');
    if (pct !== -1) h = h.slice(0, pct);
    return h.toLowerCase();
}

function isReservedIPv6(host) {
    const h = normalizeIPv6(host);
    if (!h.includes(':')) return false; // not an IPv6 literal
    if (h === '::1' || h === '::') return true;        // loopback / unspecified
    if (h === '::ffff:0:0') return true;               // edge unspecified mapped
    // IPv4-mapped IPv6 in dotted form (::ffff:a.b.c.d) — classify the IPv4.
    const mappedDotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mappedDotted) return isReservedIPv4(mappedDotted[1]);
    // IPv4-mapped IPv6 in hex form (::ffff:7f00:1) — Node's URL parser collapses
    // ::ffff:127.0.0.1 to this. Decode the two hextets back into an IPv4.
    const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
        const hi = parseInt(mappedHex[1], 16);
        const lo = parseInt(mappedHex[2], 16);
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isReservedIPv4(ipv4);
    }
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 unique-local
    if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) {
        return true; // fe80::/10 link-local
    }
    return false;
}

// Hostnames (DNS names, not IP literals) that obviously resolve to loopback.
// We deliberately do NOT perform async DNS resolution in the request path.
const LOCALHOST_NAMES = new Set([
    'localhost',
    'localhost.localdomain',
    'ip6-localhost',
    'ip6-loopback',
]);

function isLocalhostName(host) {
    const h = host.toLowerCase();
    if (LOCALHOST_NAMES.has(h)) return true;
    // Any *.localhost name is reserved to loopback by RFC 6761.
    if (h.endsWith('.localhost')) return true;
    return false;
}

/**
 * Validate a meeting URL before it is handed to the bot's headless browser.
 *
 * Returns { error, status } on rejection (mirroring the route's error shape),
 * or undefined when the URL is acceptable.
 *
 * Accept rule: scheme is http/https AND the host is neither an obvious
 * localhost name nor a reserved/private/loopback/link-local IP literal.
 * DNS hostnames get the scheme + obvious-localhost check only (no resolution).
 */
function validateBotUrl(url) {
    if (typeof url !== 'string' || url.trim() === '') {
        return { error: 'url must be a non-empty string', status: 400 };
    }

    let parsed;
    try {
        parsed = new URL(url);
    } catch (e) {
        return { error: 'url is not a valid URL', status: 400 };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: 'url scheme must be http or https', status: 400 };
    }

    // URL.hostname drops the port and keeps IPv6 inside brackets.
    const host = parsed.hostname;
    if (!host) {
        return { error: 'url must have a host', status: 400 };
    }

    if (isLocalhostName(host)) {
        return { error: 'url host resolves to a forbidden (loopback) target', status: 400 };
    }

    if (isReservedIPv4(host) || isReservedIPv6(host)) {
        return { error: 'url host points to a reserved/private network address', status: 400 };
    }

    return undefined;
}

module.exports = {
    ipv4ToInt,
    isReservedIPv4,
    isReservedIPv6,
    isLocalhostName,
    validateBotUrl,
};
