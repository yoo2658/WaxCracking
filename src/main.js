import { createScene, setSceneTheme } from './scene.js';
import { buildSphereGeometry, buildImageGeometry } from './geometries.js';
import { DeformableMesh } from './deformable-mesh.js';
import { CompositeWaxbbuMesh } from './composite-waxbbu-mesh.js';
import {
  createCoreMaterial,
  createShellMaterial,
  createFillingMaterial,
  setCoreTexture,
  setProjectionScale,
  setCoreMaterialMode,
  setShellLook,
  setFillingMix,
  setCellReveal,
  setShellCellReveal,
} from './wax-material.js';
import { PointerInteraction } from './pointer-interaction.js';
import { FragmentSystem } from './fragments.js';
import { loadPhotoTexture, makeColorTexture } from './texture-loader.js';
import { playMaterialSound, playWaxbbuSound, playFirstAttemptCrackSound, setMasterVolume } from './audio.js';
import { initUI, showToast, updateWaxProgress, showCompletionBanner, hideCompletionBanner } from './ui.js';
import { applyPressAnticipation } from './camera-effects.js';

const canvas = document.getElementById('scene-canvas');
const { renderer, scene, camera, controls, groundY, ground } = createScene(canvas);
const baseFov = camera.fov;

const coreMaterial = createCoreMaterial();
const shellMaterial = createShellMaterial();
const fillingMaterial = createFillingMaterial();
const fragments = new FragmentSystem(scene, groundY);
let currentMaterialMode = 'clay';
let currentWaxType = 'basic';
// Tracked for "왁뿌볼"'s filling color-mix effect (see tick()/setFillingMix)
// — set to the real initial color right after initUI() returns, below.
let currentColorHex;
let usingPhotoTexture = false; // true once an uploaded photo (not the flat color picker) is the current texture
let isCustomShape = false; // true once a transparent-background photo has swapped the shape away from the default sphere
let currentSilhouette = null; // the custom shape's own source silhouette, kept around so switching material mode can rebuild it (see CompositeWaxbbuMesh) without re-uploading the photo

// "왁뿌볼" + a custom shape only — how much bigger than the wax itself the
// outer rubber bubble sits (see composite-waxbbu-mesh.js) — still a visible
// gap (see 09_Plan.md's reference image), just tighter than an earlier,
// looser value per feedback that the bubble read as too big.
const WAXBBU_BUBBLE_RADIUS_SCALE = 1.15;

/**
 * Builds whichever DeformableMesh structure the CURRENT mode + shape calls
 * for. "왁뿌볼" + a custom (photo) shape gets the two-instance composite so
 * its outer shell can stay a plain sphere while the wax itself follows the
 * photo's silhouette (see composite-waxbbu-mesh.js, which also owns keeping
 * the wax contained inside that bubble); every other combination — any mode
 * + the default sphere, or clay/slime + a custom shape (which already looks
 * fine wearing the photo shape as its own shell too) — keeps the existing
 * single shared-topology shell+core+filling.
 */
function buildDeformable(geometry, isCustom) {
  if (currentMaterialMode === 'waxbbu' && isCustom) {
    const shellDeform = new DeformableMesh(buildSphereGeometry(WAXBBU_BUBBLE_RADIUS_SCALE), coreMaterial, shellMaterial, fillingMaterial);
    const coreDeform = new DeformableMesh(geometry, coreMaterial, shellMaterial, fillingMaterial);
    // CompositeWaxbbuMesh's own constructor sets each half's materialMode
    // and the core's containmentRadius itself — see its own doc comments.
    return new CompositeWaxbbuMesh(shellDeform, coreDeform);
  }
  const deform = new DeformableMesh(geometry, coreMaterial, shellMaterial, fillingMaterial);
  deform.setMaterialMode(currentMaterialMode);
  return deform;
}

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
  // The reveal/tint uniforms (filling color, global reveal progress) only
  // ever get refreshed from tick()'s meshChanged branch — but a reset/
  // rebuild doesn't actually set _dirtyPosition (deformable.reset()/the new
  // DeformableMesh already rebuilt everything directly), so meshChanged
  // stays false on this exact frame and that branch never ran. Without
  // this, a wax reset while already cracked still LOOKED cracked even
  // though crackDamage/holeMask were already back to pristine.
  // deformable.reset()/the new DeformableMesh both run before this, so
  // globalRevealProgress is already 0 by the time this reads it.
  setFillingMix(fillingMaterial, currentColorHex, 0);
  setCellReveal(coreMaterial, fillingMaterial, deformable.globalRevealProgress);
  setShellCellReveal(shellMaterial, deformable.globalRevealProgress);
}

let deformable = buildDeformable(buildSphereGeometry(), false);
setCoreMaterialMode(coreMaterial, currentMaterialMode);
setShellLook(shellMaterial, 'basic');
setProjectionScale(coreMaterial, shellMaterial, deformable.imageFrameHalfExtent);
scene.add(deformable.coreMesh);
scene.add(deformable.mesh);
scene.add(deformable.fillingMesh);

/**
 * Disposes the current shape and replaces it with a new one built from
 * `geometry`, wired to the same core/shell/filling materials and material
 * mode — buildDeformable decides on its own whether that means the usual
 * single structure or "왁뿌볼"'s composite one (isCustom must be accurate
 * either way, since that's what buildDeformable's own choice depends on).
 * pointerInteraction/tick reference `deformable` through a closure, so they
 * automatically pick up the new instance without any extra wiring.
 */
function rebuildShape(geometry, isCustom) {
  scene.remove(deformable.coreMesh);
  scene.remove(deformable.mesh);
  scene.remove(deformable.fillingMesh);
  deformable.dispose();

  deformable = buildDeformable(geometry, isCustom);
  scene.add(deformable.coreMesh);
  scene.add(deformable.mesh);
  scene.add(deformable.fillingMesh);
  setProjectionScale(coreMaterial, shellMaterial, deformable.imageFrameHalfExtent);
  startNewWaxTracking();
}

let pressAnticipation = 0;

// After a few taps that let go before a fresh wax's first dramatic break,
// nudge the player toward holding it down instead of just clicking.
const SHORT_TAP_HINT_THRESHOLD = 3;
let shortTapCount = 0;

const COMPLETION_REMAINING_THRESHOLD = 0.1; // "부수기 완료" fires once remaining wax drops to <=10%
const WAXBBU_LOW_SOUND_THRESHOLD = 0.4; // "왁뿌볼" switches to its lowest (calmer stone-cracking) sound tier once remaining wax drops to <=40%

const pointerInteraction = new PointerInteraction({
  renderer,
  camera,
  getActiveMesh: () => deformable,
  // "왁뿌볼" has its own three-tier sound system entirely separate from the
  // clay/slime pool-based one — see audio.js's playWaxbbuSound. isFirstBreak
  // always means 'first' (that dramatic first break can only ever happen
  // once); otherwise the tier just tracks how much wax is left right now.
  onPoke: (strength, isFirstBreak = false) => {
    if (currentMaterialMode === 'waxbbu') {
      const tier = isFirstBreak ? 'first' : deformable.getRemainingWaxRatio() <= WAXBBU_LOW_SOUND_THRESHOLD ? 'low' : 'mid';
      playWaxbbuSound(tier, strength);
      return;
    }
    playMaterialSound(currentMaterialMode, currentWaxType, strength, isFirstBreak);
  },
  onFragmentPop: (point, normal, radius) => {
    // "왁뿌볼" breaks stay sealed inside its rubbery skin (no mess) — skip
    // spawning a piece that visibly pops out and falls, even though the
    // break itself (sound, hasBrokenOnce, holeMask) still happens normally.
    if (currentMaterialMode === 'waxbbu') return;
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
    const modeChanged = mode !== currentMaterialMode;
    currentMaterialMode = mode;
    setCoreMaterialMode(coreMaterial, mode);
    // "왁뿌볼" always wears its own dedicated rubbery-skin look regardless of
    // whatever wax type was last picked — switching back to clay/slime
    // restores that wax type's look exactly as it was. The color/photo
    // picker still applies normally to the wax layer itself either way (see
    // CORE_LOOK.waxbbu) — only the wax-TYPE row (기본/초콜릿/…, which only
    // ever styles the shell) is hidden for this mode, see ui.js.
    setShellLook(shellMaterial, mode === 'waxbbu' ? 'waxbbuShell' : currentWaxType);
    // 클레이/슬라임/왁뿌볼 사이를 오갈 때마다 손상 상태를 들고 다니지 않고 매번
    // 새 왁스로 시작 — 재질별로 부서지는 방식이 서로 달라서(구멍 vs 조각 소멸)
    // 이전 재질의 손상 흔적이 남아있으면 어색해 보인다는 피드백. 이미 선택된
    // 재질을 다시 눌렀을 때는(값이 안 바뀜) 리셋하지 않음.
    if (modeChanged && isCustomShape) {
      // "왁뿌볼" ↔ 다른 재질 전환은 사진 모양에서는 겉면 구조 자체(분리형 vs
      // 기존 단일형, 09_Plan.md)가 달라져야 해서 setMaterialMode만으로는 안
      // 되고 다시 지어야 함 — buildDeformable이 이미 위에서 바뀐
      // currentMaterialMode를 보고 알맞은 구조를 고름. rebuildShape이 이미
      // startNewWaxTracking()을 호출하므로 아래 else 분기의 리셋과 중복되지
      // 않음.
      rebuildShape(buildImageGeometry(currentSilhouette), true);
    } else {
      deformable.setMaterialMode(mode);
      if (modeChanged) {
        deformable.reset();
        fragments.reset();
        shortTapCount = 0;
        startNewWaxTracking();
      }
    }
    requestRender();
  },
  onColorChange: (hex) => {
    currentColorHex = hex;
    usingPhotoTexture = false;
    setCoreTexture(coreMaterial, shellMaterial, makeColorTexture(hex));
    requestRender();
  },
  onPhotoChange: async (file) => {
    const { texture, silhouette } = await loadPhotoTexture(file);
    usingPhotoTexture = true;
    setCoreTexture(coreMaterial, shellMaterial, texture);
    if (silhouette) {
      currentSilhouette = silhouette;
      rebuildShape(buildImageGeometry(silhouette), true);
      isCustomShape = true;
    } else if (isCustomShape) {
      // Swapped in an opaque photo/color while a custom shape was active — back to the plain sphere.
      currentSilhouette = null;
      rebuildShape(buildSphereGeometry(), false);
      isCustomShape = false;
    }
    requestRender();
  },
  onPhotoRemove: () => {
    if (isCustomShape) {
      currentSilhouette = null;
      rebuildShape(buildSphereGeometry(), false);
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

currentColorHex = initialColor;
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
    if (currentMaterialMode === 'waxbbu') {
      // mixAmount 0 for a photo texture keeps the filling at its plain base
      // white (see setFillingMix's own doc comment) — no separate flag needed.
      setFillingMix(fillingMaterial, currentColorHex, usingPhotoTexture ? 0 : 1 - remainingRatio);
      // Reads fillingMaterial.color, so this must run AFTER setFillingMix above.
      // deformable.globalRevealProgress (not remainingRatio here) — see
      // setCellReveal's own doc comment on why it must be this exact,
      // shared-with-the-CPU-side value.
      setCellReveal(coreMaterial, fillingMaterial, deformable.globalRevealProgress);
    } else {
      // Clay/slime's own counterpart — see setShellCellReveal's own doc
      // comment. The shader's crackVisible gate already makes this inert
      // for "왁뿌볼", but skipping the call there too avoids fighting over
      // shellCellRevealProgress with anything else touching this material.
      setShellCellReveal(shellMaterial, deformable.globalRevealProgress);
    }
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
