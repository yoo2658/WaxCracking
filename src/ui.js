function wireButtonGroup(groupName, onSelect) {
  const buttons = document.querySelectorAll(`[data-group="${groupName}"] button`);
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      onSelect(button.dataset.value);
    });
  });
}

export function initUI({
  onWaxTypeChange,
  onMaterialChange,
  onColorChange,
  onPhotoChange,
  onPhotoRemove,
  onReset,
  onVolumeChange,
  onThemeChange,
  onRandomWax,
  onSaveCurrentWax,
  onSavePhoto,
}) {
  wireButtonGroup('waxType', onWaxTypeChange);
  wireButtonGroup('material', (mode) => {
    setWaxTypeSectionVisible(mode !== 'waxbbu');
    onMaterialChange(mode);
  });
  // "랜덤 왁뿌" — 다른 버튼들처럼 하나의 선택 상태를 유지하는 게 아니라 누를
  // 때마다 재질/왁스종류/색을 전부 새로 뽑는 액션이라 wireButtonGroup(어느 한
  // 값이 계속 .active로 남는 방식)에 안 태우고 그냥 직접 연결 — main.js가
  // 실제로 뽑은 값 쪽 버튼에 .active를 옮겨 붙이는 건 setActiveButton 몫.
  document.getElementById('random-wax-button').addEventListener('click', () => onRandomWax?.());

  // 내 왁뿌 저장(27_Plan.md) — 목록 패널은 help-panel과 같은 열림/닫힘 오버레이
  // 패턴. 이름 입력 칸은 이제 패널을 열면 항상 바로 보임 — 원래는 "+ 지금 왁뿌
  // 저장하기" 버튼을 따로 눌러야 열리는 토글이었는데, "이 버튼은 없어도 될 거
  // 같아"라는 피드백으로 그 버튼 자체를 없애고 항시 노출로 바꿈.
  const saveListPanel = document.getElementById('save-list-panel');
  const saveNameInput = document.getElementById('save-name-input');

  document.getElementById('save-list-button').addEventListener('click', () => {
    saveListPanel.classList.add('visible');
  });
  document.getElementById('save-list-close').addEventListener('click', () => {
    saveListPanel.classList.remove('visible');
  });
  const confirmSaveName = () => {
    const name = saveNameInput.value.trim();
    if (!name) return; // 빈 이름으로는 저장 안 함(별도 안내 없이 그냥 무시 — 텍스트 칸이 그대로 남아있으니 다시 입력하면 됨)
    onSaveCurrentWax?.(name);
    saveNameInput.value = ''; // 저장 즉시 비워서 다음 이름을 바로 이어 입력할 수 있게
  };
  document.getElementById('save-name-confirm').addEventListener('click', confirmSaveName);
  saveNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmSaveName();
  });

  // 사진으로 저장(34_Plan.md) — 지금 3D 장면을 PNG로 캡처해 다운로드하는 실제
  // 동작은 main.js가 다 함(캔버스/렌더러는 여기서 안 건드림), 여기선 "랜덤
  // 왁뿌"처럼 클릭만 그대로 넘겨줌.
  document.getElementById('save-photo-button').addEventListener('click', () => onSavePhoto?.());

  // The theme itself is CSS-only (a data-theme attribute the stylesheet's
  // :root[data-theme="light"] override reacts to) — onThemeChange only
  // exists so main.js can also re-color the 3D canvas background/ground
  // plane, which CSS can't reach.
  wireButtonGroup('theme', (theme) => {
    document.documentElement.dataset.theme = theme;
    onThemeChange?.(theme);
  });

  const colorPicker = document.getElementById('color-picker');
  const photoInput = document.getElementById('photo-input');
  const removePhotoButton = document.getElementById('remove-photo');
  const resetButton = document.getElementById('reset-button');
  const quickResetButton = document.getElementById('quick-reset-button');
  const volumeSlider = document.getElementById('volume-slider');

  colorPicker.addEventListener('input', () => {
    onColorChange(colorPicker.value);
  });

  photoInput.addEventListener('change', async () => {
    const file = photoInput.files?.[0];
    if (!file) return;

    // Transparent-background photos trigger a one-shot silhouette
    // extraction + shape rebuild (see main.js/silhouette.js) — expected to
    // be quick (well under a second) but not instant, so the input is
    // briefly disabled and a toast shown rather than leaving the page
    // looking unresponsive.
    photoInput.disabled = true;
    showToast('모양 만드는 중…');
    try {
      // 사진 제거 버튼 활성화/색 피커 비활성화/파일명 표시는 여기서 직접 안 하고
      // main.js의 applyPhotoResult가 setPhotoUIState로 대신 함 — "내 왁뿌 저장"
      // 불러오기도 똑같이 사진을 적용하는데 그 경로는 여기(change 이벤트)를 안
      // 지나서, 여기서만 하면 그 경로에서는 빠뜨리는 버그가 났었음(사진이 있는
      // 왁뿌를 불러왔는데도 사진 제거 버튼이 계속 비활성 상태로 남는 문제).
      await onPhotoChange(file);
    } finally {
      photoInput.disabled = false;
    }
  });

  removePhotoButton.addEventListener('click', () => {
    photoInput.value = '';
    onPhotoRemove();
    onColorChange(colorPicker.value); // applyColorChange가 setPhotoUIState(false)로 버튼 상태까지 같이 되돌림
  });

  resetButton.addEventListener('click', onReset);
  quickResetButton.addEventListener('click', onReset);

  volumeSlider.addEventListener('input', () => {
    onVolumeChange(Number(volumeSlider.value) / 100);
  });
  onVolumeChange(Number(volumeSlider.value) / 100);

  // The panel covers a lot of a phone-sized screen, blocking taps on the wax
  // underneath it — let it collapse down to just this header/toggle so the
  // rest of the screen is free.
  const uiPanel = document.getElementById('ui');
  const uiToggle = document.getElementById('ui-toggle');
  uiToggle.addEventListener('click', () => {
    const collapsed = uiPanel.classList.toggle('collapsed');
    uiToggle.textContent = collapsed ? '☰' : '✕';
  });

  // Only this dedicated close button dismisses the completion summary — see
  // hideCompletionBanner's own comment for why the banner no longer reacts
  // to taps anywhere on it or fades out on a timer.
  document.getElementById('completion-close').addEventListener('click', hideCompletionBanner);

  // The how-to-play text used to sit permanently at the bottom of the menu —
  // moved behind this on-demand "?" button instead so the menu itself stays
  // short. Same open-via-button/close-via-X pattern as the completion banner.
  const helpPanel = document.getElementById('help-panel');
  document.getElementById('help-button').addEventListener('click', () => {
    helpPanel.classList.add('visible');
  });
  document.getElementById('help-close').addEventListener('click', () => {
    helpPanel.classList.remove('visible');
  });

  return { initialColor: colorPicker.value };
}

const TOAST_DURATION_MS = 2600;
let toastTimeoutId = null;

/** Shows a brief, self-dismissing hint at the bottom of the screen. Repeated calls restart the dismiss timer instead of stacking. */
export function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('visible');

  if (toastTimeoutId) clearTimeout(toastTimeoutId);
  toastTimeoutId = setTimeout(() => {
    toast.classList.remove('visible');
    toastTimeoutId = null;
  }, TOAST_DURATION_MS);
}

/** "랜덤 왁뿌" 버튼(main.js)이 색을 대신 골라줄 때, 색 피커의 스와치 자체도
 * 그 색으로 맞춰두기 위한 것 — 안 해두면 피커는 여전히 이전 색을 보여주면서
 * 왁스만 다른 색이 되는 어긋남이 생긴다. */
export function setColorPickerValue(hex) {
  document.getElementById('color-picker').value = hex;
}

/** 사진 텍스처가 실제로 켜져 있는지에 맞춰 "사진 제거" 버튼/색 피커의 활성 여부와
 * 파일명 표시를 한 번에 맞춤 — main.js의 applyPhotoResult(사진 켜짐)/
 * applyColorChange(사진 꺼짐, 색으로 전환) 양쪽이 공유해서 부름. 파일 업로드뿐
 * 아니라 "내 왁뿌 저장" 불러오기도 결국 사진을 켜는 같은 일이라, 한쪽(업로드
 * change 이벤트)에만 이 상태 갱신이 있으면 다른 쪽(불러오기)에서는 빠짐 — 실제로
 * 그렇게 빠져서 "저장된 왁뿌를 불러왔을 때 사진 제거 버튼이 계속 비활성"인
 * 버그가 있었음. */
export function setPhotoUIState(active, label = '') {
  document.getElementById('remove-photo').disabled = !active;
  document.getElementById('color-picker').disabled = active;
  document.getElementById('photo-name').textContent = label;
}

/** "왁뿌볼" has its own fixed shell look (see main.js/wax-material.js) and
 * ignores the wax-type selection entirely, so the row that picks it is
 * hidden rather than left showing options that do nothing. Exported (not
 * just inlined in the material button's own click handler) so main.js's
 * "랜덤 왁뿌" — which can pick 왁뿌볼 without a real click on that button —
 * can keep this in sync too. */
export function setWaxTypeSectionVisible(visible) {
  document.getElementById('wax-type-section').style.display = visible ? '' : 'none';
}

/** Moves the .active highlight to whichever button in `groupName` has this
 * `value` — the same visual result a real click would leave behind. Used by
 * main.js's "랜덤 왁뿌" to keep the 재질/왁스종류 rows honest after it applies
 * a pick programmatically instead of through an actual button click. */
export function setActiveButton(groupName, value) {
  const buttons = document.querySelectorAll(`[data-group="${groupName}"] button`);
  buttons.forEach((b) => b.classList.toggle('active', b.dataset.value === value));
}

/** Updates the always-visible "남은 왁스 n%" readout. `ratio` is 0-1 (see deformable-mesh.js's getRemainingWaxRatio) — shown to one decimal place (requested directly; an earlier version rounded to a whole percent to avoid flicker, but the decimal is wanted now). */
export function updateWaxProgress(ratio) {
  const value = document.getElementById('wax-progress-value');
  value.textContent = (Math.max(0, Math.min(1, ratio)) * 100).toFixed(1);
}

/** Updates the "오늘 부순 왁스 n개" line just below the wax-progress readout — see daily-count.js for where `count` comes from. */
export function updateDailyBreakCount(count) {
  document.getElementById('daily-break-count-value').textContent = count;
}

/** Hides the completion summary — the only way it goes away, now that it no longer fades out on its own timer (that made a stray tap near screen-center, e.g. while still trying to poke the wax, dismiss it near-instantly on mobile) or dismisses on a tap anywhere on it. See #completion-close in index.html/style.css. */
export function hideCompletionBanner() {
  document.getElementById('completion-banner').classList.remove('visible');
}

/** Shows the one-off "부수기 완료!" summary once a wax drops to <=10% remaining (see main.js). Stays up until hideCompletionBanner is called from the close button. */
export function showCompletionBanner(seconds, clicks) {
  const banner = document.getElementById('completion-banner');
  document.getElementById('completion-time').textContent = `${seconds.toFixed(1)}초 걸림`;
  document.getElementById('completion-clicks').textContent = `${clicks}회 누름`;
  banner.classList.add('visible');
}

/**
 * 내 왁뿌 저장 목록(main.js/saved-waxes.js)을 다시 그림 — 목록은 항상 이 함수가
 * 새로 그리는 값들이라, 이름처럼 사용자가 직접 입력한 텍스트도 항상
 * textContent로만 넣음(innerHTML로 넣으면 이름에 HTML을 끼워 넣는 식의 위험이
 * 생길 수 있음).
 */
export function renderSavedWaxList(list, { onLoad, onDelete }) {
  const itemsEl = document.getElementById('save-list-items');
  const emptyEl = document.getElementById('save-list-empty');
  itemsEl.replaceChildren();
  emptyEl.style.display = list.length ? 'none' : '';

  for (const item of list) {
    const li = document.createElement('li');
    li.className = 'save-item';

    const loadButton = document.createElement('button');
    loadButton.type = 'button';
    loadButton.className = 'save-item-load';

    const thumb = document.createElement('span');
    thumb.className = 'save-item-thumb';
    if (item.photoThumbnail) {
      thumb.style.backgroundImage = `url(${item.photoThumbnail})`;
    } else {
      thumb.style.backgroundColor = item.color || '#fefad7';
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'save-item-name';
    nameEl.textContent = item.name;

    loadButton.append(thumb, nameEl);
    loadButton.addEventListener('click', () => onLoad(item.id));

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'save-item-delete';
    deleteButton.setAttribute('aria-label', '삭제');
    deleteButton.textContent = '✕';
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      onDelete(item.id);
    });

    li.append(loadButton, deleteButton);
    itemsEl.appendChild(li);
  }
}

/** main.js의 "내 왁뿌 저장" 목록을 닫음 — loadSavedWax가 불러온 뒤 바로 왁스를 보여주기 위해. */
export function hideSaveListPanel() {
  document.getElementById('save-list-panel').classList.remove('visible');
}
