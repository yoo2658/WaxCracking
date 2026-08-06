import { createScene, setSceneTheme } from './scene.js';
import { buildSphereGeometry, buildImageGeometry } from './geometries.js';
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
import { playMaterialSound, playFirstAttemptCrackSound, setMasterVolume } from './audio.js';
import { initUI, showToast, updateWaxProgress, showCompletionBanner, hideCompletionBanner } from './ui.js';
import { applyPressAnticipation } from './camera-effects.js';

const canvas = document.getElementById('scene-canvas');
const { renderer, scene, camera, controls, groundY, ground } = createScene(canvas);
const baseFov = camera.fov;

const coreMaterial = createCoreMaterial();
const shellMaterial = createShellMaterial();
const fragments = new FragmentSystem(scene, groundY);
let currentMaterialMode = 'clay';
let currentWaxType = 'basic';
let isCustomShape = false; // true once a transparent-background photo has swapped the shape away from the default sphere

// "완파" tracking for the current wax only — restarted whenever a fresh,
// undamaged wax appears (explicit reset, or a shape rebuild — both always
// start from a fully-intact holeMask). completionShown guards
// showCompletionBanner so it fires exactly once per wax as it crosses the
// <=10%-remaining line, not every frame for as long as it stays below that.
// waxStartTime stays null until the player's first real press on THIS wax
// (see onPressStart below) — the "X.X초 걸림" summary should measure only
// active time spent trying to break it, not idle/rotate-only time spent
// looking at it before ever touching it.
let waxStartTime = null;
let clickCount = 0;
let completionShown = false;
function startNewWaxTracking() {
  waxStartTime = null;
  clickCount = 0;
  completionShown = false;
  updateWaxProgress(1);
  // A still-lingering popup from the PREVIOUS wax (not yet auto-dismissed or
  // clicked away) would otherwise keep showing that old wax's time/clicks
  // on top of the fresh one.
  hideCompletionBanner();
}

let deformable = new DeformableMesh(buildSphereGeometry(), coreMaterial, shellMaterial);
deformable.setMaterialMode(currentMaterialMode);
setCoreMaterialMode(coreMaterial, currentMaterialMode);
setShellLook(shellMaterial, 'basic');
setProjectionScale(coreMaterial, shellMaterial, deformable.imageFrameHalfExtent);
scene.add(deformable.coreMesh);
scene.add(deformable.mesh);

/** Disposes the current shape and replaces it with a new one built from `geometry`, wired to the same core/shell materials and material mode. pointerInteraction/tick reference `deformable` through a closure, so they automatically pick up the new instance without any extra wiring. */
function rebuildShape(geometry) {
  scene.remove(deformable.coreMesh);
  scene.remove(deformable.mesh);
  deformable.dispose();

  deformable = new DeformableMesh(geometry, coreMaterial, shellMaterial);
  deformable.setMaterialMode(currentMaterialMode);
  scene.add(deformable.coreMesh);
  scene.add(deformable.mesh);
  setProjectionScale(coreMaterial, shellMaterial, deformable.imageFrameHalfExtent);
  startNewWaxTracking();
}

let pressAnticipation = 0;

// After a few taps that let go before a fresh wax's first dramatic break,
// nudge the player toward holding it down instead of just clicking.
const SHORT_TAP_HINT_THRESHOLD = 3;
let shortTapCount = 0;

const COMPLETION_REMAINING_THRESHOLD = 0.1; // "부수기 완료" fires once remaining wax drops to <=10%

const pointerInteraction = new PointerInteraction({
  renderer,
  camera,
  getActiveMesh: () => deformable,
  onPoke: (strength, isFirstBreak = false) => playMaterialSound(currentMaterialMode, currentWaxType, strength, isFirstBreak),
  onFragmentPop: (point, normal, radius) => {
    fragments.spawn(point, normal, shellMaterial.userData.waxUniforms.waxColor.value, radius);
  },
  // x is only ever passed as null to mean "hide/reset" (release, drag, or the
  // break itself) — see pointer-interaction.js. The screen coordinates
  // (x, y) aren't needed here since this drives a camera effect, not
  // something positioned on screen.
  onPressProgress: (x, y, progress) => {
    pressAnticipation = x === null ? 0 : progress;
  },
  onShortTap: () => {
    shortTapCount += 1;
    if (shortTapCount >= SHORT_TAP_HINT_THRESHOLD) {
      showToast('강하게 눌러서 왁스를 깨주세요.');
      shortTapCount = 0;
    }
  },
  onCrackAttempt: () => playFirstAttemptCrackSound(),
  onPressStart: () => {
    clickCount += 1;
    // The 0->1 transition is this wax's first real press (provisionally —
    // onPressCancel below undoes it if this turns out to be a camera-rotate
    // drag instead), so that's the moment the elapsed-time clock starts.
    if (clickCount === 1) {
      waxStartTime = performance.now();
    }
  },
  onPressCancel: () => {
    clickCount -= 1;
    if (clickCount === 0) {
      waxStartTime = null; // that provisional first press was actually a rotate — no real press has happened yet
    }
  },
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
    const { texture, silhouette } = await loadPhotoTexture(file);
    setCoreTexture(coreMaterial, shellMaterial, texture);
    if (silhouette) {
      rebuildShape(buildImageGeometry(silhouette));
      isCustomShape = true;
    } else if (isCustomShape) {
      // Swapped in an opaque photo/color while a custom shape was active — back to the plain sphere.
      rebuildShape(buildSphereGeometry());
      isCustomShape = false;
    }
    requestRender();
  },
  onPhotoRemove: () => {
    if (isCustomShape) {
      rebuildShape(buildSphereGeometry());
      isCustomShape = false;
      requestRender();
    }
  },
  onReset: () => {
    deformable.reset();
    fragments.reset();
    shortTapCount = 0;
    startNewWaxTracking();
    requestRender();
  },
  onVolumeChange: (volume) => setMasterVolume(volume),
  onThemeChange: (theme) => {
    setSceneTheme(scene, ground, theme);
    requestRender();
  },
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
  // reuse that instead of redrawing on every tick regardless.
  const meshChanged = deformable.update(dt);
  if (meshChanged) {
    const remainingRatio = deformable.getRemainingWaxRatio();
    updateWaxProgress(remainingRatio);
    if (!completionShown && remainingRatio <= COMPLETION_REMAINING_THRESHOLD) {
      completionShown = true;
      showCompletionBanner((now - waxStartTime) / 1000, clickCount);
    }
  }
  const fragmentsAnimating = fragments.update(dt);
  const cameraChanged = controls.update();
  // Applied after controls.update() so OrbitControls' own damped position
  // isn't immediately overwritten by this frame's shake offset.
  const pressEffectActive = applyPressAnticipation(camera, baseFov, pressAnticipation, dt);

  if (meshChanged || fragmentsAnimating || cameraChanged || pressEffectActive || needsExtraRender) {
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
