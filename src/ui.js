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

export function initUI({ onMaterialChange, onColorChange, onPhotoChange, onPhotoRemove, onReset }) {
  wireButtonGroup('material', onMaterialChange);

  const colorPicker = document.getElementById('color-picker');
  const photoInput = document.getElementById('photo-input');
  const removePhotoButton = document.getElementById('remove-photo');
  const photoNameLabel = document.getElementById('photo-name');
  const resetButton = document.getElementById('reset-button');

  colorPicker.addEventListener('input', () => {
    onColorChange(colorPicker.value);
  });

  photoInput.addEventListener('change', async () => {
    const file = photoInput.files?.[0];
    if (!file) return;

    await onPhotoChange(file);

    photoNameLabel.textContent = `사진: ${file.name}`;
    removePhotoButton.disabled = false;
    colorPicker.disabled = true;
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

  // The panel covers a lot of a phone-sized screen, blocking taps on the wax
  // underneath it — let it collapse down to just this header/toggle so the
  // rest of the screen is free.
  const uiPanel = document.getElementById('ui');
  const uiToggle = document.getElementById('ui-toggle');
  uiToggle.addEventListener('click', () => {
    const collapsed = uiPanel.classList.toggle('collapsed');
    uiToggle.textContent = collapsed ? '☰' : '✕';
  });

  return { initialColor: colorPicker.value };
}
