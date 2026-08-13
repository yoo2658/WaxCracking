// 오늘 부순 왁스 개수 — 서버가 없는 프로젝트라 이 브라우저의 localStorage에만
// 남는 아주 가벼운 기록. main.js가 완파(잔여 10% 이하) 문턱을 넘을 때마다
// recordBreak()을 부르고, ui.js가 그 개수를 화면에 표시.

const STORAGE_KEY = 'waxcracking:dailyBreakCount';

// 로컬(사용자) 자정 기준으로 날짜가 바뀌게 — UTC 기준이면 한국 시간대에서는
// 오전 9시에 바뀌어버려 "오늘"이라는 말과 어긋난다.
function todayKey() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.count === 'number' && typeof parsed.date === 'string') return parsed;
  } catch {
    // 시크릿 모드/저장공간 제한 등으로 localStorage 자체가 막혀 있을 수 있음 —
    // 이 기록은 있으면 좋은 부가 기능이지 핵심 기능이 아니므로, 에러로 앱
    // 전체를 막지 않고 조용히 "기록 없음"으로 넘어간다.
  }
  return null;
}

function writeStored(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 위와 같은 이유로 조용히 무시.
  }
}

/** 오늘 지금까지 부순 개수 — 날짜가 바뀌었으면(자정이 지났으면) 0부터 다시. */
export function getTodayBreakCount() {
  const stored = readStored();
  return stored && stored.date === todayKey() ? stored.count : 0;
}

/** 완파 한 번을 기록 — 갱신된 오늘 개수를 반환(화면에 바로 반영하기 편하게). */
export function recordBreak() {
  const today = todayKey();
  const stored = readStored();
  const count = (stored && stored.date === today ? stored.count : 0) + 1;
  writeStored({ date: today, count });
  return count;
}
