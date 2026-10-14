import type { CapacitorConfig } from '@capacitor/cli';

const release = process.env.UCAP_RELEASE === '1';

const config: CapacitorConfig = {
  appId: 'de.schaefchens.ucap',
  appName: 'UCAP',
  webDir: 'dist',
  // https://localhost: a secure context, which WebCrypto, the microphone and service workers need.
  server: { androidScheme: 'https', hostname: 'localhost' },
  android: {
    allowMixedContent: false,
    // chrome://inspect for development builds only.
    webContentsDebuggingEnabled: !release,
  },
  plugins: {
    // Off: it base64-encodes binary bodies and does not honour AbortSignal (lookup, bible-assistant).
    CapacitorHttp: { enabled: false },
  },
};

export default config;
