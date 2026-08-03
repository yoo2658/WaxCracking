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

/** volume is 0..1, set from the UI's volume slider. */
export function setMasterVolume(volume) {
  masterVolume = Math.min(1, Math.max(0, volume));
}

/**
 * strength (>=1, from how long the click was held) makes a harder hit sound
 * slightly louder. isFirstBreak plays the dedicated first-crack sample
 * instead of a random pick from the regular pool — same pattern for both
 * materials.
 */
export function playMaterialSound(materialMode, strength = 1, isFirstBreak = false) {
  if (masterVolume <= 0) return;

  const [firstBreakSound, pool] = materialMode === 'clay' ? [CLAY_FIRST_BREAK_SOUND, CLAY_SOUND_POOL] : [SLIME_FIRST_BREAK_SOUND, SLIME_SOUND_POOL];
  const src = isFirstBreak ? firstBreakSound : pool[Math.floor(Math.random() * pool.length)];

  const template = templateForSrc(src);
  const clone = template.cloneNode();
  clone.volume = Math.min(1, 0.75 + (strength - 1) * 0.18) * masterVolume;
  clone.play().catch(() => {}); // ignore autoplay-policy rejections; this always fires from a real click
}
