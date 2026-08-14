import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const GROUND_Y = -1.35;

// Matches style.css's --bg/--ground-ish tones for each theme — kept here
// instead of read from CSS since these drive actual THREE.js Color objects
// (the canvas background/ground plane), not anything the stylesheet reaches.
// 예전엔 background/ground가 각각 단색 하나뿐이라 배경이 딱딱하고 밋밋해
// 보인다는 피드백("너무 딱딱하고 안 예뻐보여서") — inner/outer 두 색으로 은은한
// 방사형 그라디언트를 만들어 왁스 뒤가 살짝 밝고 따뜻하게, 가장자리로 갈수록
// 짙게 가라앉도록 바꿈(아래 createGradientTexture). ground는 fog와 같은
// outer 색으로 맞춰서, 바닥 원판의 가장자리(반지름 6)가 배경과 하나로 자연스럽게
// 이어지고 예전처럼 수평선이 뚜렷하게 보이지 않게 함.
// 라이트 테마는 원래 inner/outer 차이가 너무 작아서(0xfff7ee vs 0xdedee8, 명도
// 차이 미미) "라이트모드에선 변화를 느낄 수가 없네"라는 피드백을 받음 — 한 번
// outer를 0xc7c9d6까지 낮췄는데도 스크린샷으로 비교해보니 여전히 티가 잘 안 나서,
// outer를 훨씬 더 눈에 띄게 차갑고 짙은 톤으로 내리고 inner도 더 따뜻하게 올려
// 대비를 확실히 키움. 다크 테마는 이미 잘 보였으므로 그대로 둠.
const SCENE_THEME_COLORS = {
  dark: { inner: 0x3a3848, outer: 0x14151b, ground: 0x17181d },
  light: { inner: 0xfff4e2, outer: 0xa7acc4, ground: 0xa4a9c1 },
};

const BACKGROUND_TEXTURE_SIZE = 512; // 화면 전체를 덮는 단순한 그라디언트라 고해상도가 필요 없음 — 512면 어떤 화면 크기에서도 번지지 않고 매끈함

/**
 * 은은한 방사형 그라디언트를 그린 캔버스를 THREE.CanvasTexture로 반환 —
 * scene.background로 쓰이면(THREE.Color가 아니라 Texture) 카메라가 궤도
 * 회전해도 항상 화면에 고정되어 깔림(3D 공간의 오브젝트가 아니라 화면 배경
 * 그 자체). 매 프레임 다시 계산하는 게 아니라 테마가 바뀔 때만 한 번 새로
 * 그리므로 런타임 비용은 없음.
 */
function createGradientTexture(innerHex, outerHex) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = BACKGROUND_TEXTURE_SIZE;
  const ctx = canvas.getContext('2d');
  const half = BACKGROUND_TEXTURE_SIZE / 2;
  // 캔버스 정사각형의 변까지(half)가 아니라 대각선 모서리까지(half*sqrt(2))
  // 닿도록 반경을 넓힘 — half로 끝나면 안 그래도 화면 중앙(왁스에 가려짐)만
  // inner에 가깝고, 실제로 눈에 보이는 화면 가장자리/모서리는 이미 outer
  // 단색으로 다 뭉개져버려서(canvas gradient는 마지막 스톱 이후로 단색 유지)
  // "그라디언트를 넣었는데 거의 안 보인다"는 문제가 있었음.
  const radius = half * Math.SQRT2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, radius);
  gradient.addColorStop(0, `#${new THREE.Color(innerHex).getHexString()}`);
  gradient.addColorStop(1, `#${new THREE.Color(outerHex).getHexString()}`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, BACKGROUND_TEXTURE_SIZE, BACKGROUND_TEXTURE_SIZE);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const GROUND_ALPHA_TEXTURE_SIZE = 256;
const GROUND_FEATHER_START = 0.55; // 이 반경(0..1, 원판 전체 반지름 기준) 안쪽은 완전히 불투명, 바깥쪽으로 갈수록 투명해짐

/**
 * 중심은 불투명, 가장자리로 갈수록 투명해지는 방사형 알파 텍스처 —
 * 바닥(ground) 원판의 MeshStandardMaterial에 alphaMap으로 씀. CircleGeometry의
 * UV는 정확히 원판 반지름을 UV공간의 반경 0.5에 대응시키므로, 이 텍스처의 반경
 * 1(=캔버스 half)이 원판의 실제 가장자리와 정확히 일치함 — 원판이 실제로는 딱딱
 * 잘린 원인데 안개(fog)만으로는 카메라와 가까운 쪽 가장자리가 여전히 뚜렷한
 * 곡선 테두리로 보이는 문제가 있었음("바닥 원형도 별로 안 예뻐" — 스크린샷으로
 * 직접 확인). 카메라 각도/줌과 무관하게 원판 자체의 가장자리를 부드럽게 없애
 * 그 문제를 근본적으로 해결.
 */
function createGroundAlphaTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = GROUND_ALPHA_TEXTURE_SIZE;
  const ctx = canvas.getContext('2d');
  const half = GROUND_ALPHA_TEXTURE_SIZE / 2;
  const gradient = ctx.createRadialGradient(half, half, half * GROUND_FEATHER_START, half, half, half);
  // three.js의 alphaMap은 텍스처의 알파 채널이 아니라 초록(g) 채널 값을 읽음
  // (alphamap_fragment.glsl.js: diffuseColor.a *= texture2D(alphaMap, uv).g) —
  // 그래서 알파를 0으로 낮추는 게 아니라 색 자체를 흰색→검은색(불투명→투명)으로
  // 바꿔야 함. 처음엔 알파 채널만 낮췄다가 아무 효과가 없어서(g 채널은 계속
  // 255) 이 사실을 알게 됨.
  gradient.addColorStop(0, 'rgb(255, 255, 255)');
  gradient.addColorStop(1, 'rgb(0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, GROUND_ALPHA_TEXTURE_SIZE, GROUND_ALPHA_TEXTURE_SIZE);
  return new THREE.CanvasTexture(canvas);
}

/** Swaps the canvas background gradient, fog color, and ground-plane color between the dark (default) and light UI themes — see ui.js's theme toggle. */
export function setSceneTheme(scene, ground, theme) {
  const colors = SCENE_THEME_COLORS[theme] ?? SCENE_THEME_COLORS.dark;
  scene.background?.dispose?.(); // 이전 테마의 그라디언트 텍스처를 GPU 메모리에서 정리
  scene.background = createGradientTexture(colors.inner, colors.outer);
  scene.fog.color.set(colors.outer);
  ground.material.color.set(colors.ground);
}

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  // near는 OrbitControls의 maxDistance(7)보다 일부러 더 멀게 잡음 — 카메라를
  // 아무리 뒤로 빼도(최대 7) 왁스 자신은 절대 안개에 걸리지 않고(항상 near 밖의
  // "안 흐려짐" 구간), 그보다 먼 바닥 원판(반지름 6)의 가장자리만 서서히 배경
  // 그라디언트의 outer 색과 섞여 예전의 뚜렷한 수평선이 사라지게 함.
  scene.fog = new THREE.Fog(SCENE_THEME_COLORS.dark.outer, 7.5, 13);
  scene.background = createGradientTexture(SCENE_THEME_COLORS.dark.inner, SCENE_THEME_COLORS.dark.outer);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 0.15, 4.4);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const hemi = new THREE.HemisphereLight(0xfff3e0, 0x14161b, 0.7);
  scene.add(hemi);

  // Key/rim lights are attached to the camera (not fixed in world space) so
  // whatever side is currently facing the viewer stays lit as they orbit —
  // the wax object itself never moves, only the camera does, so a
  // world-fixed light would leave the far side dark after rotating away
  // from it. Their target defaults to the origin, which is exactly where
  // the object always sits, so no extra target wiring is needed.
  scene.add(camera);

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(1.5, 2, 2.5);
  camera.add(key);

  const rim = new THREE.DirectionalLight(0xbfd8ff, 0.7);
  rim.position.set(-2, -1, -2.5);
  camera.add(rim);

  // Catches fragments popped off the wax shell so they visibly land somewhere.
  // transparent+alphaMap로 가장자리를 부드럽게 페더링(위 createGroundAlphaTexture) —
  // 안 그러면 원판의 실제 기하학적 경계가 카메라와 가까운 방향에서 뚜렷한 곡선
  // 테두리로 보임(안개는 먼 쪽 경계만 흐릿하게 함).
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(6, 48),
    new THREE.MeshStandardMaterial({
      color: SCENE_THEME_COLORS.dark.ground,
      roughness: 0.95,
      transparent: true,
      alphaMap: createGroundAlphaTexture(),
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = GROUND_Y;
  scene.add(ground);

  // Dragging on the canvas orbits the camera around the (always-static) wax
  // mesh. Clicks are handled separately by PointerInteraction, which only
  // fires on pointerup-with-little-movement, so it never fights this drag.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 2.6;
  controls.maxDistance = 7;
  controls.update();

  function resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  window.addEventListener('resize', resize);
  resize();

  return { renderer, scene, camera, controls, groundY: GROUND_Y, ground };
}
