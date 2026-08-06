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
}) {
  wireButtonGroup('waxType', onWaxTypeChange);
  wireButtonGroup('material', onMaterialChange);
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

  // A tap anywhere on the completion banner dismisses it immediately,
  // instead of only ever fading out on its own timer.
  document.getElementById('completion-banner').addEventListener('click', hideCompletionBanner);

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

/** Updates the always-visible "남은 왁스 n%" readout. `ratio` is 0-1 (see deformable-mesh.js's getRemainingWaxRatio) — rounded to a whole percent since this updates continuously and decimal places would just flicker. */
export function updateWaxProgress(ratio) {
  const value = document.getElementById('wax-progress-value');
  value.textContent = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
}

const COMPLETION_DURATION_MS = 4500;
let completionTimeoutId = null;

export function hideCompletionBanner() {
  document.getElementById('completion-banner').classList.remove('visible');
  if (completionTimeoutId) {
    clearTimeout(completionTimeoutId);
    completionTimeoutId = null;
  }
}

/** Shows the one-off "부수기 완료!" summary once a wax drops to <=10% remaining (see main.js) — self-dismissing like showToast after COMPLETION_DURATION_MS, but a click anywhere on it dismisses it immediately too (see initUI wiring its click listener once, below). */
export function showCompletionBanner(seconds, clicks) {
  const banner = document.getElementById('completion-banner');
  document.getElementById('completion-time').textContent = `${seconds.toFixed(1)}초 걸림`;
  document.getElementById('completion-clicks').textContent = `${clicks}회 누름`;
  banner.classList.add('visible');

  if (completionTimeoutId) clearTimeout(completionTimeoutId);
  completionTimeoutId = setTimeout(hideCompletionBanner, COMPLETION_DURATION_MS);
}
