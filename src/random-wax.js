// "랜덤 왁뿌" 버튼(main.js) — 누를 때마다 완전히 새로운 파스텔 색 + 왁스 종류를
// 뽑음. 하루종일 같은 값이어야 했던 "오늘의 왁스"(날짜 시드 고정)와 달리 매번
// 새로 뽑아야 하므로 시드/해시가 필요 없이 그냥 Math.random()을 직접 씀.

// 8종 전부 포함 — 크루아상도 코어(다 뚫었을 때 보이는 속)는 색 피커 색을
// 그대로 받으므로(크러스트 자체 색만 고정) 완전히 안 보이는 건 아님.
const WAX_TYPES = ['basic', 'chocolate', 'sand', 'butter', 'strawberry', 'grape', 'milk', 'croissant'];

// 파스텔 톤 유지 — 색상(hue)만 매번 자유롭게, 채도/명도는 좁은 파스텔 대역 안으로.
const PASTEL_SATURATION_RANGE = [0.45, 0.65];
const PASTEL_LIGHTNESS_RANGE = [0.78, 0.88];

function randomInRange([min, max]) {
  return min + Math.random() * (max - min);
}

/** h: 0..360, s/l: 0..1 → "#rrggbb". */
function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** 파스텔 범위 안에서 매번 새로운 색 하나. */
export function randomPastelColor() {
  const hue = Math.floor(Math.random() * 360);
  return hslToHex(hue, randomInRange(PASTEL_SATURATION_RANGE), randomInRange(PASTEL_LIGHTNESS_RANGE));
}

/** 8종 왁스 종류 중 하나. */
export function randomWaxType() {
  return WAX_TYPES[Math.floor(Math.random() * WAX_TYPES.length)];
}
