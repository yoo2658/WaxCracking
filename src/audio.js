// Plays recorded sound effects: a crisp crack for clay, a wet squish for
// slime. Loaded via plain HTMLAudioElement (not fetch/decodeAudioData) so it
// keeps working when the app is opened straight off disk via file:// —
// fetch()/XHR are blocked by CORS for local files in Chromium, but <audio>'s
// own media pipeline is not. Each play clones the template element so rapid
// repeated clicks layer/restart cleanly instead of cutting each other off.

// Both materials' one-time first break (the dramatic 2-second-hold payoff)
// gets its own distinct sample; every other break/tap picks randomly from a
// pool so repeated cracking/squishing doesn't sound identical every time.
const CLAY_FIRST_BREAK_SOUND = 'sounds/freesound_community-breaking-frozen-celery-76261_[cut_1sec] (3).mp3';
const CLAY_SOUND_POOL = [
  'sounds/freesound_community-breaking-frozen-celery-76261_[cut_0sec].mp3',
  'sounds/freesound_community-breaking-frozen-celery-76261_[cut_1sec] (1).mp3',
  'sounds/freesound_community-breaking-frozen-celery-76261_[cut_1sec] (2).mp3',
  'sounds/freesound_community-breaking-frozen-celery-76261_[cut_1sec] (4).mp3',
  'sounds/freesound_community-breaking-frozen-celery-76261_[cut_1sec].mp3',
];

const SLIME_FIRST_BREAK_SOUND = 'sounds/floraphonic-slime-squish-5.mp3';
const SLIME_SOUND_POOL = [
  'sounds/freesound_community-slime-2-30099_[cut_0sec] (1).mp3',
  'sounds/freesound_community-slime-2-30099_[cut_1sec] (1).mp3',
  'sounds/freesound_community-slime-2-30099_[cut_1sec] (2).mp3',
  'sounds/freesound_community-slime-2-30099_[cut_1sec] (4).mp3',
  'sounds/freesound_community-slime-2-30099_[cut_1sec] (5).mp3',
  'sounds/freesound_community-slime-2-30099_[cut_1sec] (6).mp3',
  'sounds/freesound_community-slime-2-30099_[cut_1sec] (7).mp3',
  'sounds/freesound_community-slime-2-30099_[cut_1sec].mp3',
];

// Wax types are shell-look overlays (see wax-material.js), independent of the
// clay/slime press physics above — each one's crunch sample layers ON TOP of
// whichever material sound just played, rather than replacing it, so e.g. a
// chocolate-coated slime still sounds like slime underneath a chocolate crunch.
const WAX_TYPE_SOUND = {
  chocolate: {
    firstBreak: 'sounds/freesound_community-chocolate-crunching-83286_[cut_1sec].mp3',
    pool: [
      'sounds/freesound_community-chocolate-crunching-83286_[cut_0sec].mp3',
      'sounds/freesound_community-chocolate-crunching-83286_[cut_0sec] (1).mp3',
    ],
  },
  sand: {
    firstBreak: 'sounds/saboteurcomics-crunching-404615_[cut_0sec] (1).mp3',
    pool: [
      'sounds/saboteurcomics-crunching-404615_[cut_1sec] (1).mp3',
      'sounds/saboteurcomics-crunching-404615_[cut_1sec] (2).mp3',
      'sounds/saboteurcomics-crunching-404615_[cut_1sec].mp3',
    ],
  },
};

// Played on every pointerdown while a wax hasn't broken once yet — an
// audible "hairline crack" cue for each attempt at building up to the first
// dramatic break, not just the break itself (which already has its own
// sound via playMaterialSound below). Already trimmed to ~1 second by the
// source file itself, so no explicit stop/fade logic is needed — it simply
// finishes on its own well before (or right around) the earliest a first
// break could land.
const FIRST_ATTEMPT_CRACK_SOUND = 'sounds/freesound_community-bamboocracking-78192_[cut_1sec].mp3';

const templates = {};
let masterVolume = 1;

function templateForSrc(src) {
  if (!templates[src]) {
    const audio = new Audio(src);
    audio.preload = 'auto';
    templates[src] = audio;
  }
  return templates[src];
}

function playOne(src, strength) {
  const template = templateForSrc(src);
  const clone = template.cloneNode();
  clone.volume = Math.min(1, 0.75 + (strength - 1) * 0.18) * masterVolume;
  clone.play().catch(() => {}); // ignore autoplay-policy rejections; this always fires from a real click
}

/** volume is 0..1, set from the UI's volume slider. */
export function setMasterVolume(volume) {
  masterVolume = Math.min(1, Math.max(0, volume));
}

/** Called from pointer-interaction.js on every pointerdown while the current wax hasn't broken once yet — see FIRST_ATTEMPT_CRACK_SOUND above. */
export function playFirstAttemptCrackSound() {
  if (masterVolume <= 0) return;
  playOne(FIRST_ATTEMPT_CRACK_SOUND, 1);
}

/**
 * strength (>=1, from how long the click was held) makes a harder hit sound
 * slightly louder. isFirstBreak plays the dedicated first-crack sample
 * instead of a random pick from the regular pool — same pattern for both
 * materials. waxType layers an additional shell-specific sample on top (see
 * WAX_TYPE_SOUND) when the current wax type has one — "basic" doesn't.
 */
export function playMaterialSound(materialMode, waxType, strength = 1, isFirstBreak = false) {
  if (masterVolume <= 0) return;

  const [firstBreakSound, pool] = materialMode === 'clay' ? [CLAY_FIRST_BREAK_SOUND, CLAY_SOUND_POOL] : [SLIME_FIRST_BREAK_SOUND, SLIME_SOUND_POOL];
  playOne(isFirstBreak ? firstBreakSound : pool[Math.floor(Math.random() * pool.length)], strength);

  const waxTypeSound = WAX_TYPE_SOUND[waxType];
  if (waxTypeSound) {
    const src = isFirstBreak
      ? waxTypeSound.firstBreak
      : waxTypeSound.pool[Math.floor(Math.random() * waxTypeSound.pool.length)];
    playOne(src, strength);
  }
}
