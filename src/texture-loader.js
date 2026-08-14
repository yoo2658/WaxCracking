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
 * Shared by loadPhotoTexture (below, from a File) and
 * loadPhotoTextureFromSavedThumbnail (saved-waxes.js's "불러오기", from an
 * already-in-hand data URL) — both end up with a data URL one way or
 * another, so the actual Image-loading/texture/silhouette work only needs
 * to exist once. Resolves to { texture, silhouette } — see loadPhotoTexture's
 * own doc comment for what each field means.
 */
function loadPhotoTextureFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
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
    image.src = dataUrl;
  });
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
    reader.onload = () => resolve(loadPhotoTextureFromDataUrl(reader.result));
    reader.readAsDataURL(file);
  });
}

/** 내 왁뿌 저장(saved-waxes.js)에서 "불러오기" — 이미 data URL(저장된 썸네일)이
 * 있으니 FileReader 단계 없이 곧장 같은 파이프라인을 태움. */
export function loadPhotoTextureFromSavedThumbnail(dataUrl) {
  return loadPhotoTextureFromDataUrl(dataUrl);
}

// 저장 목록(saved-waxes.js)의 미리보기 + 불러오기 양쪽에 다 쓰는 썸네일 크기 —
// MAX_TEXTURE_DIMENSION보다 훨씬 작게 잡아서 최대 10개를 저장해도 브라우저
// localStorage 한도(보통 5~10MB)에 여유 있게 들어가도록. 목록 미리보기로 쓰기엔
// 이미 충분히 크고, 불러왔을 때 실제 질감으로 써도 심하게 흐려 보이지 않는
// 선에서 균형을 잡은 시작값.
const SAVE_THUMBNAIL_MAX_DIMENSION = 256;

/**
 * 현재 사진(HTMLImageElement 또는 캔버스)을 저장용 정사각 썸네일 data URL로.
 * PNG로 만드는 이유 — 투명 배경 사진(커스텀 모양의 원본)이 저장 후 다시
 * 불러와도 실루엣을 다시 추출할 수 있어야 해서, 알파 채널을 보존해야 함(JPEG는
 * 알파가 없어 투명 배경이 검은색으로 뭉개짐).
 */
export function makeSaveThumbnail(image) {
  const scale = Math.min(1, SAVE_THUMBNAIL_MAX_DIMENSION / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
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
