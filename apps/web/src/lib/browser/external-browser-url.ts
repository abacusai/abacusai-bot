/** A host-local address would open a different server on the user's computer. */
export const externalBrowserUrl = (raw?: string): string | null => {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || !host.includes('.') && !host.startsWith('[')
    ) return null;
    if (host.startsWith('[')) {
      // IPv4-mapped addresses and local IPv6 are host-only too.
      if (/^\[(?:::|::1|::ffff:.*|f[cd].*|fe[89ab].*)\]$/.test(host)) return null;
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a === 169 && b === 254 ||
          a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
          a === 100 && b >= 64 && b <= 127 || a >= 224) return null;
    }
    return url.href;
  } catch {
    return null;
  }
};
