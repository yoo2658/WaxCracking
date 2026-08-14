// 내 왁뿌 저장(2026-08-11/27_Plan.md) — 브라우저 localStorage에만 남는 이름 붙은
// 저장 목록, 최대 MAX_SAVED_WAXES개. 서버 없음(daily-count.js/random-wax.js와
// 같은 방향) — 사진이 있는 저장은 texture-loader.js의 makeSaveThumbnail이 만든
// 작은 썸네일만 담아서, 여러 개 저장해도 저장 공간을 크게 안 씀.

const STORAGE_KEY = 'waxcracking:savedWaxes';
export const MAX_SAVED_WAXES = 10;

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // 시크릿 모드/저장공간 제한 등으로 localStorage 자체가 막혀 있을 수 있음 —
    // 이 기능은 있으면 좋은 부가 기능이지 핵심 기능이 아니므로, 조용히 빈
    // 목록으로 넘어간다(에러로 앱 전체를 막을 이유가 없음).
    return [];
  }
}

function writeAll(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 위와 같은 이유로 조용히 무시.
  }
}

/** 지금까지 저장된 전체 목록 — 오래된 순(먼저 저장한 게 앞). */
export function getSavedWaxes() {
  return readAll();
}

/**
 * 새 항목을 추가하고 갱신된 전체 목록을 반환 — 이미 MAX_SAVED_WAXES개 꽉 차
 * 있으면 아무것도 안 하고 null을 반환(호출부가 "가득 찼다" 안내를 띄움).
 * color/photoThumbnail은 둘 중 하나만 채워짐(사진 등록 여부에 따라).
 */
export function saveWax({ name, materialMode, waxType, color, photoThumbnail }) {
  const list = readAll();
  if (list.length >= MAX_SAVED_WAXES) return null;
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    materialMode,
    waxType,
    color: color ?? null,
    photoThumbnail: photoThumbnail ?? null,
    createdAt: Date.now(),
  };
  list.push(entry);
  writeAll(list);
  return list;
}

/** 갱신된 전체 목록을 반환(찾는 id가 없어도 그냥 원래 목록 그대로 반환). */
export function deleteSavedWax(id) {
  const list = readAll().filter((item) => item.id !== id);
  writeAll(list);
  return list;
}
