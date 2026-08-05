import * as THREE from 'three';
import { extractSilhouette } from './silhouette.js';

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
        const texture = new THREE.Texture(image);
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
