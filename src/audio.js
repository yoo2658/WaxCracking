// Plays recorded sound effects: a crisp crack for squishy, a wet squish for
// slime. Loaded via plain HTMLAudioElement (not fetch/decodeAudioData) so it
// keeps working when the app is opened straight off disk via file:// —
// fetch()/XHR are blocked by CORS for local files in Chromium, but <audio>'s
// own media pipeline is not. Each play clones the template element so rapid
// repeated clicks layer/restart cleanly instead of cutting each other off.

const SOUND_SOURCES = {
  squishy: 'sounds/freesound_community-breaking-frozen-celery.mp3',
  slime: 'sounds/floraphonic-slime-squish-5.mp3',
};

const templates = {};

function templateFor(materialMode) {
  const src = SOUND_SOURCES[materialMode] ?? SOUND_SOURCES.squishy;
  if (!templates[src]) {
    const audio = new Audio(src);
    audio.preload = 'auto';
    templates[src] = audio;
  }
  return templates[src];
}

/** strength (>=1, from how long the click was held) makes a harder hit sound slightly louder. */
export function playMaterialSound(materialMode, strength = 1) {
  const template = templateFor(materialMode);
  const clone = template.cloneNode();
  clone.volume = Math.min(1, 0.75 + (strength - 1) * 0.18);
  clone.play().catch(() => {}); // ignore autoplay-policy rejections; this always fires from a real click
}
