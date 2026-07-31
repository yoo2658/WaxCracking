import * as THREE from 'three';

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
        resolve(texture);
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
