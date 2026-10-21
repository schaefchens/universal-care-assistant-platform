// Baileys imports sharp (or jimp) only to make thumbnails of images it sends, and catches a failed import
// (lib/Utils/messages-media.js), so without either it runs and makes no thumbnails. npm installs a required peer by
// itself; this workspace package satisfies it instead of sharp's native code (docs/plan-m3.md, K0).
throw new Error('sharp is not part of UCAP');
