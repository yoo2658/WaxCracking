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
  const photoNameLabel = document.getElementById('photo-name');
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
      await onPhotoChange(file);
      photoNameLabel.textContent = `사진: ${file.name}`;
      removePhotoButton.disabled = false;
      colorPicker.disabled = true;
    } finally {
      photoInput.disabled = false;
    }
  });

  removePhotoButton.addEventListener('click', () => {
    photoInput.value = '';
    photoNameLabel.textContent = '';
    removePhotoButton.disabled = true;
    colorPicker.disabled = false;
    onPhotoRemove();
    onColorChange(colorPicker.value);
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
