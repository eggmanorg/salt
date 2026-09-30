// URL import — pure SSRF/URL helpers (no I/O). The live fetch + DNS resolution
// lives in cloud-functions; this module only holds the classification policy.
export type { ParsedImportUrl, IpClass } from './ssrf.js';
export type { YouTubeVideo } from './youtube.js';
export { parseYouTubeVideo } from './youtube.js';
export {
  parseImportUrl,
  isHttpsScheme,
  hostnameAsIpLiteral,
  classifyIp,
  isPublicIp,
  isIpv4,
  isIpv6,
} from './ssrf.js';
