import * as THREE from 'three';
import { extractSilhouette } from './silhouette.js';

// A modern phone photo is routinely 3000-4000px+ on a side — uploaded
// straight to the GPU with no resize, that's tens of MB of texture memory
// for a single material, and upload/sampling cost that scales with it. Most
// low/mid-range Android GPUs (and some PC integrated ones) have far less
// texture bandwidth and VRAM headroom than a typical desktop dev machine, so
// this was a standing cost that only really showed up on exactly those
// devices (2026-08-11/21_Check.md, item 2) — never on the machine that built
// it. 1536px is a starting point: comfortably sharp for how large this
// object ever appears on screen, while cutting a typical phone photo's pixel
// count (and texture memory) by roughly 4-8x per side.
const MAX_TEXTURE_DIMENSION = 1536;

/**
 * Draws `image` down onto a canvas capped at MAX_TEXTURE_DIMENSION on its
 * longest side, preserving aspect ratio — returns `image` itself untouched
 * (no extra canvas/draw cost) when it's already small enough.
 */
function resizeForTexture(image) {
  const scale = MAX_TEXTURE_DIMENSION / Math.max(image.width, image.height);
  if (scale >= 1) return image;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Resolves to { texture, silhouette }: texture is always usable as-is;
 * silhouette is null for an ordinary opaque photo (caller should keep/revert
 * to the plain sphere) or an array of {x, y} points (see silhouette.js) when
 * the photo has a transparent background worth tracing a custom shape from.
 */
export function loadPhotoTexture(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('이미지를 불러올 수 없습니다.'));
      image.onload = () => {
        // The texture (what actually reaches the GPU) uses the capped-size
        // version; extractSilhouette below still gets the original — it
        // rasterizes down to its own small internal mask (128px) regardless
        // of input size, so passing it the full photo costs nothing extra
        // and avoids a second, slightly-lossy resize affecting alpha
        // detection.
        const texture = new THREE.Texture(resizeForTexture(image));
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.needsUpdate = true;

        const silhouette = extractSilhouette(image);
        resolve({ texture, silhouette });
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export function makeColorTexture(hexColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = hexColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
