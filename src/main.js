import { createScene } from './scene.js';
import { buildSphereGeometry } from './geometries.js';
import { DeformableMesh } from './deformable-mesh.js';
import {
  createCoreMaterial,
  createShellMaterial,
  setCoreTexture,
  setProjectionScale,
  setCoreMaterialMode,
  setShellLook,
} from './wax-material.js';
import { PointerInteraction } from './pointer-interaction.js';
import { FragmentSystem } from './fragments.js';
import { loadPhotoTexture, makeColorTexture } from './texture-loader.js';
import { playMaterialSound, setMasterVolume } from './audio.js';
import { initUI, updatePressProgress } from './ui.js';

const canvas = document.getElementById('scene-canvas');
const { renderer, scene, camera, controls, groundY } = createScene(canvas);

const coreMaterial = createCoreMaterial();
const shellMaterial = createShellMaterial();
const fragments = new FragmentSystem(scene, groundY);
let currentMaterialMode = 'clay';
let currentWaxType = 'basic';

const deformable = new DeformableMesh(buildSphereGeometry(), coreMaterial, shellMaterial);
deformable.setMaterialMode(currentMaterialMode);
setCoreMaterialMode(coreMaterial, currentMaterialMode);
setShellLook(shellMaterial, 'basic');
setProjectionScale(coreMaterial, shellMaterial, deformable.radius);
scene.add(deformable.coreMesh);
scene.add(deformable.mesh);

const pointerInteraction = new PointerInteraction({
  renderer,
  camera,
  getActiveMesh: () => deformable,
  onPoke: (strength, isFirstBreak = false) => playMaterialSound(currentMaterialMode, currentWaxType, strength, isFirstBreak),
  onFragmentPop: (point, normal, radius) => {
    fragments.spawn(point, normal, shellMaterial.userData.waxUniforms.waxColor.value, radius);
  },
  onPressProgress: updatePressProgress,
});

// Set once whenever something outside the per-frame animation checks below
// changes the scene (material swap, new texture, reset) — those don't
// otherwise flip any of deformable/fragments/controls' own "did something
// move" flags, so without this the next frame could wrongly skip rendering
// and leave the old look on screen for a moment.
let needsExtraRender = true;
function requestRender() {
  needsExtraRender = true;
}

const { initialColor } = initUI({
  onWaxTypeChange: (waxType) => {
    currentWaxType = waxType;
    setShellLook(shellMaterial, waxType);
    requestRender();
  },
  onMaterialChange: (mode) => {
    currentMaterialMode = mode;
    deformable.setMaterialMode(mode);
    setCoreMaterialMode(coreMaterial, mode);
    requestRender();
  },
  onColorChange: (hex) => {
    setCoreTexture(coreMaterial, shellMaterial, makeColorTexture(hex));
    requestRender();
  },
  onPhotoChange: async (file) => {
    const texture = await loadPhotoTexture(file);
    setCoreTexture(coreMaterial, shellMaterial, texture);
    requestRender();
  },
  onPhotoRemove: () => {},
  onReset: () => {
    deformable.reset();
    fragments.reset();
    requestRender();
  },
  onVolumeChange: (volume) => setMasterVolume(volume),
});

setCoreTexture(coreMaterial, shellMaterial, makeColorTexture(initialColor));

// Leaving this tab open in the background (e.g. while playing something else)
// shouldn't cost anything: fully stop the loop — not just skip rendering,
// stop even requesting frames — whenever the tab isn't visible, and resume
// exactly where dt accounting left off when it becomes visible again.
let lastTime = performance.now();
let animationFrameId = null;

function tick() {
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  pointerInteraction.update();
  // Each already tracks whether it actually changed anything this frame —
  // reuse that instead of redrawing on every tick regardless. A held press
  // during a fresh wax's silent hold-to-break wait, for instance, changes
  // nothing in the 3D scene at all (by design) until it breaks, so there's
  // nothing worth (re-)rendering for as long as the camera isn't moving either.
  const meshChanged = deformable.update(dt);
  const fragmentsAnimating = fragments.update(dt);
  const cameraChanged = controls.update();

  if (meshChanged || fragmentsAnimating || cameraChanged || needsExtraRender) {
    renderer.render(scene, camera);
    needsExtraRender = false;
  }

  animationFrameId = requestAnimationFrame(tick);
}

function stopLoop() {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

function startLoop() {
  if (animationFrameId === null) {
    lastTime = performance.now();
    requestRender(); // repaint once immediately on return, in case anything changed while hidden
    animationFrameId = requestAnimationFrame(tick);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopLoop();
  else startLoop();
});

// scene.js's own resize handler already updates the renderer size and camera
// aspect, but that alone doesn't touch any of meshChanged/fragmentsAnimating/
// cameraChanged — without this, the render-on-demand loop above would just
// keep skipping the render call and leave the OLD frame (wrong size/aspect)
// on screen until some unrelated interaction happened to force one.
window.addEventListener('resize', requestRender);

startLoop();
