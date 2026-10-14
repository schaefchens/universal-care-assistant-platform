// The test's simulated browser decrypts Web Push payloads with http_ece (the RFC 8188/8291 code web-push uses).
declare module 'http_ece' {
  import type { ECDH } from 'node:crypto';
  const ece: { decrypt(buffer: Buffer, params: { version: 'aes128gcm'; privateKey: ECDH; authSecret: string }): Buffer };
  export default ece;
}
