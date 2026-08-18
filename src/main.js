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
  setCroissantLayerLook,
  setFillingMix,
  setCellReveal,
  setShellCellReveal,
} from './wax-material.js';
import { PointerInteraction } from './pointer-interaction.js';
import { FragmentSystem } from './fragments.js';
import { loadPhotoTexture, loadPhotoTextureFromSavedThumbnail, makeSaveThumbnail, makeColorTexture } from './texture-loader.js';
import { playMaterialSound, playWaxbbuSound, playFirstAttemptCrackSound, setMasterVolume } from './audio.js';
import {
  initUI,
  showToast,
  updateWaxProgress,
  updateDailyBreakCount,
  showCompletionBanner,
  hideCompletionBanner,
  setColorPickerValue,
  setWaxTypeSectionVisible,
  setActiveButton,
  setPhotoUIState,
  renderSavedWaxList,
  hideSaveListPanel,
} from './ui.js';
import { applyPressAnticipation } from './camera-effects.js';
import { randomPastelColor, randomWaxType } from './random-wax.js';
import { getTodayBreakCount, recordBreak } from './daily-count.js';
import { getSavedWaxes, saveWax, deleteSavedWax, MAX_SAVED_WAXES } from './saved-waxes.js';

const canvas = document.getElementById('scene-canvas');
const { renderer, scene, camera, controls, groundY, ground } = createScene(canvas);
const baseFov = camera.fov;

const coreMaterial = createCoreMaterial();
const shellMaterial = createShellMaterial();
const fillingMaterial = createFillingMaterial();
// 크루아상("여러 겹 둘러싼" 왁스 — 2026-08-07/15_Plan.md)의 셸 스택 겹 수 —
// 바꾸고 싶으면 이 숫자만 바꾸면 됨(색 그라디언트도 setCroissantLayerLook이
// 알아서 이 개수만큼 다시 나눠 계산함). 인덱스 0 = 가장 바깥(가장 먼저
// 부서짐) — deformable-mesh.js의 layerCount/레이어 배열과 순서가 정확히
// 같아야 함. 사용자가 고를 수 있는 값이 아니라 한 번 정해진 색/광택 그대로
// 계속 쓰이므로, 여기서 딱 한 번만 적용하고 이후 다시 건드리지 않음 — 다른
// 왁스 종류들처럼 setShellLook을 매번 재호출하는 shellMaterial과 다른 점.
const CROISSANT_LAYER_COUNT = 5;
const croissantShellMaterials = Array.from({ length: CROISSANT_LAYER_COUNT }, (_, layerIndex) => {
  const material = createShellMaterial();
  setCroissantLayerLook(material, layerIndex, CROISSANT_LAYER_COUNT);
  return material;
});
const fragments = new FragmentSystem(scene, groundY);
let currentMaterialMode = 'clay';
let currentWaxType = 'basic';
// Tracked for "왁뿌볼"'s filling color-mix effect (see tick()/setFillingMix)
// — set to the real initial color right after initUI() returns, below.
let currentColorHex;
let usingPhotoTexture = false; // true once an uploaded photo (not the flat color picker) is the current texture
let isCustomShape = false; // true once a transparent-background photo has swapped the shape away from the default sphere
let currentSilhouette = null; // the custom shape's own source silhouette, kept around so switching material mode can rebuild it (see CompositeWaxbbuMesh) without re-uploading the photo
// 내 왁뿌 저장(27_Plan.md)이 썸네일을 만들 때 필요 — texture.image로도 접근
// 가능하지만, "지금 사진 텍스처를 쓰고 있는가"와 "그 원본 이미지가 뭔가"를
// 한 곳(applyPhotoResult)에서만 같이 관리하는 게 더 명확함. 사진이 아니라
// 색을 쓰는 순간(applyColorChange) 항상 null로 비움.
let currentPhotoImage = null;

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
    const shellDeform = new DeformableMesh(buildSphereGeometry(WAXBBU_BUBBLE_RADIUS_SCALE), coreMaterial, [shellMaterial], fillingMaterial);
    const coreDeform = new DeformableMesh(geometry, coreMaterial, [shellMaterial], fillingMaterial);
    // CompositeWaxbbuMesh's own constructor sets each half's materialMode
    // and the core's containmentRadius itself — see its own doc comments.
    return new CompositeWaxbbuMesh(shellDeform, coreDeform);
  }
  // 크루아상(여러 겹)은 왁뿌볼과 함께 쓸 수 없음 — composite-waxbbu-mesh.js는
  // 항상 셸 1장짜리 독립 구조를 요구함(위 분기). onMaterialChange/
  // onWaxTypeChange가 이 조합이 바뀔 때마다 항상 다시 지어주므로, 여기서는
  // "지금 이 순간" 기준으로만 몇 장 쌓을지 고르면 됨.
  const shellMaterials = currentMaterialMode !== 'waxbbu' && currentWaxType === 'croissant' ? croissantShellMaterials : [shellMaterial];
  const deform = new DeformableMesh(geometry, coreMaterial, shellMaterials, fillingMaterial);
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

/**
 * Filling only ever needs to be VISIBLE for "왁뿌볼" (a real backdrop
 * revealed through an actual hole — see wax-material.js's
 * createFillingMaterial) — every other mode's core never discards at all,
 * so filling is always meant to stay fully hidden behind it there. Setting
 * this explicitly (rather than leaving THREE's own default — always
 * visible) closes off a real rendering gap otherwise: a single vertex
 * plastically dented very deep by many repeated presses at the exact same
 * spot can stretch its neighboring core triangles enough that tiny gaps
 * open up between them, letting filling's own (visually mismatched,
 * near-white) color peek through even though nothing ever actually
 * discarded — confirmed directly: "전부 부숴서 왁스가 남지 않은 상태에서,
 * 한 군데만 계속 누르면 속이 하얗게 보여" reproduced exactly this way, and
 * hiding filling outright made it disappear completely. Must be re-applied
 * after every buildDeformable() call (a fresh mesh defaults to visible)
 * AND on a plain mode switch that doesn't rebuild anything (see
 * onMaterialChange) — currentMaterialMode is read fresh each call, not
 * captured once.
 */
function syncFillingVisibility() {
  deformable.fillingMesh.visible = currentMaterialMode === 'waxbbu';
}

let deformable = buildDeformable(buildSphereGeometry(), false);
syncFillingVisibility();
setCoreMaterialMode(coreMaterial, currentMaterialMode);
setShellLook(shellMaterial, 'basic');
setProjectionScale(coreMaterial, shellMaterial, deformable.imageFrameHalfExtent);
scene.add(deformable.coreMesh);
for (const shellMesh of deformable.shellMeshes) scene.add(shellMesh);
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
  for (const shellMesh of deformable.shellMeshes) scene.remove(shellMesh);
  scene.remove(deformable.fillingMesh);
  deformable.dispose();

  deformable = buildDeformable(geometry, isCustom);
  syncFillingVisibility();
  scene.add(deformable.coreMesh);
  for (const shellMesh of deformable.shellMeshes) scene.add(shellMesh);
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
const CROISSANT_LOW_SOUND_THRESHOLD = 0.15; // 크루아상이 왁뿌볼의 calmer 사운드 풀로 (3개→2개) 줄어드는 기준 — "왁스가 많이 떨어졌는데도 소리가 큼직한 게 많이 나서 어색". deformable-mesh.js의 LOW_FRAGMENT_REMAINING_THRESHOLD와 항상 같은 값으로 유지 — 그 지점부터 소리와 파편이 같이 차분해짐.

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
    // 크루아상만 해당 — 남은 왁스가 CROISSANT_LOW_SOUND_THRESHOLD 이하로
    // 떨어지면 audio.js가 더 차분한(적은 개수의) 사운드 풀로 바꿈.
    const isCroissantLow = currentWaxType === 'croissant' && !isFirstBreak && deformable.getRemainingWaxRatio() <= CROISSANT_LOW_SOUND_THRESHOLD;
    playMaterialSound(currentMaterialMode, currentWaxType, strength, isFirstBreak, isCroissantLow);
  },
  onFragmentPop: (point, normal, radius, colors) => {
    // "왁뿌볼" breaks stay sealed inside its rubbery skin (no mess) — skip
    // spawning a piece that visibly pops out and falls, even though the
    // break itself (sound, hasBrokenOnce, holeMask) still happens normally.
    if (currentMaterialMode === 'waxbbu') return;
    // colors comes straight from DeformableMesh's _checkBreak — one entry
    // per layer that just broke, ALL of them at once (see class doc
    // comment on why 크루아상 pops its whole 3-coat stack together, not one
    // layer at a time). Every non-크루아상 type just has the single shared
    // shell's own color, so this spawns exactly one fragment, same as
    // before this array existed.
    for (const color of colors) fragments.spawn(point, normal, color, radius);
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

// onColorChange(색 피커)와 "랜덤 왁뿌"(random-wax.js) 둘 다 결국 "코어/셸에
// 이 색을 입힌다"는 같은 일을 하므로 하나로 묶음 — 랜덤 왁뿌가 그 색을 대신
// 고른 것뿐이지, 적용 자체는 사용자가 색 피커를 직접 바꾼 것과 완전히 동일하게
// 처리되어야 함(사진 모드 해제 등).
function applyColorChange(hex) {
  currentColorHex = hex;
  usingPhotoTexture = false;
  currentPhotoImage = null; // 색으로 전환했으니, 저장할 때 더 이상 사진 썸네일을 만들 원본이 없음
  setCoreTexture(coreMaterial, shellMaterial, makeColorTexture(hex));
  setPhotoUIState(false); // 사진 제거 버튼 비활성화 + 색 피커 활성화 + 파일명 표시 지움
  requestRender();
}

// onPhotoChange(파일 업로드)와 내 왁뿌 저장 "불러오기"(loadSavedWax, 아래) 둘 다
// 결국 texture-loader.js가 만들어준 { texture, silhouette }를 화면에 그대로
// 적용하는 같은 일을 하므로 하나로 묶음 — 불러오기는 그 texture/silhouette를
// 파일이 아니라 저장된 썸네일에서 얻어올 뿐, 적용 자체는 완전히 동일. label은
// "사진 제거" 버튼 옆에 보여줄 문구(업로드는 파일명, 불러오기는 저장된 이름) —
// 둘 다 이 함수 하나로 setPhotoUIState까지 같이 처리하므로 호출부에서 버튼
// 상태를 따로 안 맞춰줘도 됨(예전에는 change 이벤트 쪽에만 있어서, 불러오기
// 경로는 사진 제거 버튼이 계속 비활성으로 남는 버그가 있었음).
function applyPhotoResult({ texture, silhouette }, label) {
  usingPhotoTexture = true;
  currentPhotoImage = texture.image; // 다음에 "지금 왁뿌 저장하기"를 누르면 이 이미지로 썸네일을 다시 만듦
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
  setPhotoUIState(true, label);
  requestRender();
}

// wireButtonGroup의 클릭 콜백뿐 아니라 "랜덤 왁뿌"(아래 onRandomWax)도 실제
// 종류/재질 적용 로직을 그대로 재사용해야 해서 이름 붙은 함수로 뺌 — 내용 자체는
// 이전과 동일, 호출 경로만 하나 늘어남.
function applyWaxTypeChange(waxType) {
  // 크루아상은 색만 다른 스킨이 아니라 실제로 셸을 3장 쌓는 별도 구조라
  // (deformable-mesh.js의 layerCount) — 색만 바꿔서는 안 되고, 크루아상으로
  // 들어가거나 나올 때는 구조 자체를 다시 지어야 함. 그 외 모든 종류끼리의
  // 전환(예: 기본→초콜릿)은 지금처럼 색만 바꿈. 왁뿌볼 모드에서는 이 행
  // 자체가 숨겨져 있어(ui.js) 호출되지 않음.
  const layeredChanged = (waxType === 'croissant') !== (currentWaxType === 'croissant');
  currentWaxType = waxType;
  setShellLook(shellMaterial, waxType);
  if (layeredChanged) {
    rebuildShape(isCustomShape ? buildImageGeometry(currentSilhouette) : buildSphereGeometry(), isCustomShape);
  }
  requestRender();
}

function applyMaterialChange(mode) {
  const modeChanged = mode !== currentMaterialMode;
  // 사진 모양에서 왁뿌볼 ↔ 다른 재질 전환은 겉면 구조 자체(분리형 vs 기존
  // 단일형, 09_Plan.md)가 달라져야 하고, 크루아상이 선택된 상태에서 왁뿌볼
  // ↔ 다른 재질 전환은 겹 구조 자체(1장 vs 3장, buildDeformable)가 달라져야
  // 함 — 둘 다 setMaterialMode만으로는 반영이 안 되고 다시 지어야 함.
  const structureChanged = modeChanged && (isCustomShape || currentWaxType === 'croissant');
  currentMaterialMode = mode;
  setCoreMaterialMode(coreMaterial, mode);
  // "왁뿌볼" always wears its own dedicated rubbery-skin look regardless of
  // whatever wax type was last picked — switching back to clay/slime
  // restores that wax type's look exactly as it was. The color/photo
  // picker still applies normally to the wax layer itself either way (see
  // CORE_LOOK.waxbbu) — only the wax-TYPE row (기본/초콜릿/…, which only
  // ever styles the shell) is hidden for this mode, see ui.js/setWaxTypeSectionVisible.
  setShellLook(shellMaterial, mode === 'waxbbu' ? 'waxbbuShell' : currentWaxType);
  // 클레이/슬라임/왁뿌볼 사이를 오갈 때마다 손상 상태를 들고 다니지 않고 매번
  // 새 왁스로 시작 — 재질별로 부서지는 방식이 서로 달라서(구멍 vs 조각 소멸)
  // 이전 재질의 손상 흔적이 남아있으면 어색해 보인다는 피드백. 이미 선택된
  // 재질을 다시 눌렀을 때는(값이 안 바뀜) 리셋하지 않음.
  if (structureChanged) {
    // buildDeformable이 이미 위에서 바뀐 currentMaterialMode를 보고 알맞은
    // 구조(합성/겹 수)를 고름. rebuildShape이 이미 startNewWaxTracking()을
    // 호출하므로 아래 else 분기의 리셋과 중복되지 않음.
    rebuildShape(isCustomShape ? buildImageGeometry(currentSilhouette) : buildSphereGeometry(), isCustomShape);
  } else {
    deformable.setMaterialMode(mode);
    syncFillingVisibility();
    if (modeChanged) {
      deformable.reset();
      fragments.reset();
      shortTapCount = 0;
      startNewWaxTracking();
    }
  }
  requestRender();
}

// 내 왁뿌 저장(27_Plan.md) — 목록이 바뀔 때마다(저장/삭제/시작 시 최초 1회)
// ui.js에 최신 목록을 다시 그려달라고 함. onLoad/onDelete를 매번 새로 넘기는
// 이유: 그때그때의 최신 클로저(이 함수들 자체)를 쓰면 되므로, "한 번 등록해두고
// 계속 재사용"할 별도 상태가 따로 필요 없음.
function refreshSavedWaxList() {
  renderSavedWaxList(getSavedWaxes(), { onLoad: loadSavedWax, onDelete: deleteSavedWaxAndRefresh });
}

async function loadSavedWax(id) {
  const entry = getSavedWaxes().find((item) => item.id === id);
  if (!entry) return; // 목록을 열어둔 다른 탭에서 방금 지워졌거나 하는 극단적인 경우 — 조용히 무시
  if (entry.photoThumbnail) {
    applyPhotoResult(await loadPhotoTextureFromSavedThumbnail(entry.photoThumbnail), `사진: ${entry.name}`);
  } else if (entry.color) {
    setColorPickerValue(entry.color);
    applyColorChange(entry.color);
  }
  applyWaxTypeChange(entry.waxType);
  applyMaterialChange(entry.materialMode);
  setActiveButton('waxType', entry.waxType);
  setActiveButton('material', entry.materialMode);
  setWaxTypeSectionVisible(entry.materialMode !== 'waxbbu');
  // "랜덤 왁뿌"와 같은 이유로 강제 리셋 — 저장해둔 재질/종류가 우연히 지금과
  // 같으면 위 두 함수가 아무 것도 안 바꿔서, 부수던 중이던 왁스가 그대로
  // 남을 수 있음.
  deformable.reset();
  fragments.reset();
  shortTapCount = 0;
  startNewWaxTracking();
  hideSaveListPanel(); // 불러온 뒤엔 목록을 닫아서 바로 왁스가 보이게
  requestRender();
}

function deleteSavedWaxAndRefresh(id) {
  renderSavedWaxList(deleteSavedWax(id), { onLoad: loadSavedWax, onDelete: deleteSavedWaxAndRefresh });
}

// 사진으로 저장(34_Plan.md) — "내 왁뿌 저장"(재질/색/사진 등 설정값을 나중에 앱
// 안에서 다시 불러오기용으로 localStorage에 저장)과는 별개로, 지금 3D 장면
// 자체를 진짜 이미지 파일로 만들어 기기의 일반 다운로드 경로에 내려받음.
// scene.js가 WebGLRenderer를 만들 때 preserveDrawingBuffer를 안 켜뒀음(저사양
// 기기에서 매 프레임 버퍼를 하나 더 유지하는 상시 비용을 늘리고 싶지 않아서) —
// 그래서 render() 직후 같은 동기 실행 흐름 안에서 바로 canvas.toDataURL을
// 불러야 안전하게 읽힘(브라우저가 버퍼를 지우는 건 이 실행이 끝나고 이벤트
// 루프로 돌아간 뒤). 렌더 온디맨드 루프(tick())와 별개로 여기서 직접 한 번 더
// 그리는 이유도 이것 — "지금 이 순간의 화면"을 확실하게 그려두기 위해서.
//
// Blob+URL.createObjectURL이 아니라 dataURL을 쓰는 이유: 카카오톡 인앱브라우저
// (웹뷰 기반이라 원래 파일 다운로드 기능이 없음)가 공식적으로 지원하는 다운로드
// 방식은 서버 응답 헤더(이 프로젝트는 서버가 없어 해당 없음)/`<a download>`
// (안드로이드만)/dataURL(iOS 포함) 세 가지뿐이고, Blob 방식은 그 목록에 없어
// 카카오톡 인앱브라우저에서 실제로 안 됨("카카오톡 브라우저에선 저장하기가 안
// 통함" — 확인 후 dataURL로 교체). toDataURL은 동기 함수라 콜백도 필요 없어짐.
function saveCurrentPhoto() {
  renderer.render(scene, camera);
  const dataUrl = canvas.toDataURL('image/png');
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // 다운로드 폴더로 바로 저장되는 표준적인 방법 — 서버나 파일시스템 API 없이
  // <a download>가 브라우저의 일반 다운로드 동작을 그대로 트리거함. 일부
  // 브라우저는 DOM에 붙어있지 않은 <a>의 click()을 무시할 수 있어 안전하게
  // 잠깐 붙였다 뗌.
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `왁뿌_${stamp}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('사진으로 저장했어요');
}

// "랜덤 왁뿌"(main.js 요청 — 2026-08-11) 대상 3종. 크루아상/waxbbu 조합처럼
// 겉보기엔 안 맞는 조합이 뽑혀도 buildDeformable이 이미 그 경우를 자기 안에서
// 알아서 처리하므로(왁뿌볼은 항상 단일 셸 — main.js의 buildDeformable 참고)
// 여기서 따로 걸러낼 필요는 없음.
const RANDOM_MATERIAL_MODES = ['clay', 'slime', 'waxbbu'];

const { initialColor } = initUI({
  onWaxTypeChange: applyWaxTypeChange,
  onMaterialChange: applyMaterialChange,
  // 재질/왁스종류/색을 전부 새로 뽑아 한 번에 적용 — 사진이 등록된 상태라면
  // (usingPhotoTexture) 색은 그대로 두고 재질/종류만 랜덤. 실제 적용은 위
  // applyWaxTypeChange/applyMaterialChange를 그대로 재사용하고, 버튼 클릭
  // 없이 프로그램적으로 값을 바꾸는 거라 어느 버튼이 실제로 선택됐는지도
  // main.js가 직접 표시해줘야 함(setActiveButton) — wireButtonGroup은 실제
  // 클릭에만 반응하므로 이 경로에선 자동으로 안 따라옴.
  onRandomWax: () => {
    const material = RANDOM_MATERIAL_MODES[Math.floor(Math.random() * RANDOM_MATERIAL_MODES.length)];
    const waxType = randomWaxType();
    if (!usingPhotoTexture) {
      const color = randomPastelColor();
      setColorPickerValue(color);
      applyColorChange(color);
    }
    applyWaxTypeChange(waxType);
    applyMaterialChange(material);
    setActiveButton('waxType', waxType);
    setActiveButton('material', material);
    setWaxTypeSectionVisible(material !== 'waxbbu');
    // applyWaxTypeChange/applyMaterialChange only reset the wax (or rebuild
    // it) when the randomly-picked value actually DIFFERS from what's
    // currently selected — if the random draw happens to land on the same
    // material+type already active, neither one resets anything, so a
    // partway-broken wax stayed exactly as broken (reported directly:
    // "랜덤은 클릭했을 때 초기화가 안 돼"). "랜덤 왁뿌" is meant to always
    // hand over a fresh wax, so force it unconditionally — a no-op (and
    // cheap) on top of a rebuild/reset that already just happened above.
    deformable.reset();
    fragments.reset();
    shortTapCount = 0;
    startNewWaxTracking();
    requestRender();
  },
  onColorChange: applyColorChange,
  onPhotoChange: async (file) => applyPhotoResult(await loadPhotoTexture(file), `사진: ${file.name}`),
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
  // 내 왁뿌 저장(27_Plan.md) — 사진이 등록된 상태라면 색 대신 지금 사진의
  // 작은 썸네일을 저장(usingPhotoTexture && currentPhotoImage 둘 다 있어야
  // 함 — 색만 골랐다면 currentPhotoImage는 항상 null).
  onSaveCurrentWax: (name) => {
    const photoThumbnail = usingPhotoTexture && currentPhotoImage ? makeSaveThumbnail(currentPhotoImage) : null;
    const color = photoThumbnail ? null : currentColorHex;
    const result = saveWax({ name, materialMode: currentMaterialMode, waxType: currentWaxType, color, photoThumbnail });
    if (result === null) {
      showToast(`저장은 최대 ${MAX_SAVED_WAXES}개까지 가능해요 — 하나 지우고 다시 저장해주세요`);
      return;
    }
    renderSavedWaxList(result, { onLoad: loadSavedWax, onDelete: deleteSavedWaxAndRefresh });
  },
  onSavePhoto: saveCurrentPhoto,
});

currentColorHex = initialColor;
setCoreTexture(coreMaterial, shellMaterial, makeColorTexture(initialColor));
updateDailyBreakCount(getTodayBreakCount()); // 새로고침해도 오늘 기록은 이어서 보이게
refreshSavedWaxList(); // 내 왁뿌 저장 목록도 새로고침해도 이어서 보이게

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
    } else if (deformable.layerCount === 1) {
      // Clay/slime's own counterpart — see setShellCellReveal's own doc
      // comment. The shader's crackVisible gate already makes this inert
      // for "왁뿌볼", but skipping the call there too avoids fighting over
      // shellCellRevealProgress with anything else touching this material.
      // 크루아상(layerCount > 1)은 이 전역 소멸 효과 자체를 안 씀(때린
      // 자리만 겹겹이 뚫리는 방식 — 2026-08-07/15_Plan.md) — shellMaterial도
      // 그 상태에서는 화면에 없는(사용되지 않는) 재질이라 건드릴 필요 없음.
      setShellCellReveal(shellMaterial, deformable.globalRevealProgress);
    }
    if (!completionShown && remainingRatio <= COMPLETION_REMAINING_THRESHOLD) {
      completionShown = true;
      showCompletionBanner((now - waxStartTime) / 1000, clickCount);
      updateDailyBreakCount(recordBreak()); // daily-count.js — 오늘 날짜에 없으면 자동으로 1부터
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
