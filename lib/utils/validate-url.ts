/**
 * Validates a webhook URL to prevent SSRF attacks.
 * Allows HTTP and HTTPS but blocks private/internal IP ranges.
 */
export function isValidWebhookUrl(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }

  // Only allow http and https schemes
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }

  const hostname = url.hostname.toLowerCase();

  // Block localhost variants
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname === '[::1]'
  ) {
    return false;
  }

  // Block private IP ranges
  // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (
      a === 10 ||                          // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) ||          // 192.168.0.0/16
      (a === 169 && b === 254) ||          // 169.254.0.0/16 (link-local / cloud metadata)
      a === 0 ||                           // 0.0.0.0/8
      a === 127                            // 127.0.0.0/8
    ) {
      return false;
    }
  }

  return true;
}
