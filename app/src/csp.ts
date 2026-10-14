/**
 * The app's Content Security Policy (docs/plan.md, "App shell rules": CSP and Trusted Types; Appendix J UI-08). The
 * build puts it into index.html (vite.config.ts), so the Capacitor app and any static host serve it; Vite's dev
 * server goes without it, because its React refresh runs inline.
 *
 * Scripts come only from the app itself, never inline or from strings, and only the "ucap" policy (trusted.ts) may
 * make a script URL. The server's address is chosen at setup, never at build time, so requests and media may go to
 * any HTTPS origin, and in development to this computer over plain HTTP (as normaliseServerUrl allows it).
 */
const LOCAL = ['localhost', '127.0.0.1', '10.0.2.2'];
const local = (scheme: string) => LOCAL.map((host) => `${scheme}://${host}:*`);

/**
 * The one style the app's libraries put inline: React Aria's touch-action for pressable elements, so a tap is never
 * held back for a double-tap zoom. Allowed by its hash, so nothing else inline is; the test reads the installed React
 * Aria and fails when an update changes the text.
 */
export const REACT_ARIA_STYLE = '@layer {\n  [data-react-aria-pressable] {\n    touch-action: pan-x pan-y pinch-zoom;\n  }\n}';
export const REACT_ARIA_STYLE_HASH = 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o=';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  `style-src 'self' '${REACT_ARIA_STYLE_HASH}'`,
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  `media-src 'self' blob: data: https: ${local('http').join(' ')}`,
  `connect-src 'self' https: wss: ${[...local('http'), ...local('ws')].join(' ')}`,
  "worker-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
  'trusted-types ucap',
].join('; ');
