import { createScene } from './scene.js';
import { buildSphereGeometry } from './geometries.js';
import { DeformableMesh } from './deformable-mesh.js';
import { createCoreMaterial, createShellMaterial, setCoreTexture, setProjectionScale } from './wax-material.js';
import { PointerInteraction } from './pointer-interaction.js';
import { FragmentSystem } from './fragments.js';
import { loadPhotoTexture, makeColorTexture } from './texture-loader.js';
import { playMaterialSound, setMasterVolume } from './audio.js';
import { initUI } from './ui.js';

const canvas = document.getElementById('scene-canvas');
const { renderer, scene, camera, controls, groundY } = createScene(canvas);

const coreMaterial = createCoreMaterial();
const shellMaterial = createShellMaterial();
const fragments = new FragmentSystem(scene, groundY);
let currentMaterialMode = 'clay';

const deformable = new DeformableMesh(buildSphereGeometry(), coreMaterial, shellMaterial);
deformable.setMaterialMode(currentMaterialMode);
setProjectionScale(coreMaterial, shellMaterial, deformable.radius);
scene.add(deformable.coreMesh);
scene.add(deformable.mesh);

const pointerInteraction = new PointerInteraction({
  renderer,
  camera,
  getActiveMesh: () => deformable,
  onPoke: (strength, isFirstBreak = false) => playMaterialSound(currentMaterialMode, strength, isFirstBreak),
  onFragmentPop: (point, normal, radius) => {
    fragments.spawn(point, normal, shellMaterial.userData.waxUniforms.waxColor.value, radius);
  },
});

const { initialColor } = initUI({
  onMaterialChange: (mode) => {
    currentMaterialMode = mode;
    deformable.setMaterialMode(mode);
  },
  onColorChange: (hex) => {
    setCoreTexture(coreMaterial, shellMaterial, makeColorTexture(hex));
  },
  onPhotoChange: async (file) => {
    const texture = await loadPhotoTexture(file);
    setCoreTexture(coreMaterial, shellMaterial, texture);
  },
  onPhotoRemove: () => {},
  onReset: () => {
    deformable.reset();
    fragments.reset();
  },
  onVolumeChange: (volume) => setMasterVolume(volume),
});

setCoreTexture(coreMaterial, shellMaterial, makeColorTexture(initialColor));

let lastTime = performance.now();
function tick() {
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  pointerInteraction.update();
  deformable.update(dt);
  fragments.update(dt);
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
