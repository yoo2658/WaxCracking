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

// butter/milk asked for "초콜릿과 동일한 사운드" — literally the same sample
// references, not a separate duplicate pool. strawberry/grape asked for
// "기본 왁스와 동일한 사운드", which for "basic" means no entry at all here
// (see the lookup in playMaterialSound below) — so they're deliberately left
// unlisted rather than added with empty pools.
WAX_TYPE_SOUND.butter = WAX_TYPE_SOUND.chocolate;
WAX_TYPE_SOUND.milk = WAX_TYPE_SOUND.chocolate;

// "왁뿌볼" (see playWaxbbuSound below): the very first break sounds exactly
// like slime's own first break (SLIME_FIRST_BREAK_SOUND, reused directly —
// no separate sample). Every poke after that always plays a random pick from
// slime's own regular pool (SLIME_SOUND_POOL) as a base layer, PLUS one more
// sample layered on top picked from whichever of these two pools matches how
// much wax is left — "깨진 후 ~ 40%"'s lighter cracking vs. "40% 이하"'s
// heavier, calmer stone-cracking.
const WAXBBU_CRACK_POOL_ABOVE_40 = [
  'sounds/freesound_community-cracking-66624_[cut_1sec].mp3',
  'sounds/freesound_community-cracking-66624_[cut_1sec] (1).mp3',
  'sounds/freesound_community-cracking-66624_[cut_1sec] (2).mp3',
  'sounds/freesound_community-cracking-66624_[cut_1sec] (3).mp3',
  'sounds/freesound_community-cracking-66624_[cut_1sec] (4).mp3',
  'sounds/freesound_community-cracking-66624_[cut_1sec] (5).mp3',
  'sounds/freesound_community-cracking-66624_[cut_1sec] (6).mp3',
];
const WAXBBU_CRACK_POOL_AT_OR_BELOW_40 = [
  'sounds/morganfilm-cracking-stones-calm-168153_[cut_0sec].mp3',
  'sounds/morganfilm-cracking-stones-calm-168153_[cut_1sec] (1).mp3',
  'sounds/morganfilm-cracking-stones-calm-168153_[cut_1sec] (2).mp3',
  'sounds/morganfilm-cracking-stones-calm-168153_[cut_1sec] (3).mp3',
  'sounds/morganfilm-cracking-stones-calm-168153_[cut_1sec] (4).mp3',
  'sounds/morganfilm-cracking-stones-calm-168153_[cut_1sec] (5).mp3',
  'sounds/morganfilm-cracking-stones-calm-168153_[cut_1sec].mp3',
];
// "크루아상" only — both of 왁뿌볼's own crack-sound pools combined into one
// (see playMaterialSound): "왁뿌볼에서 사용한 왁스 사운드 중 랜덤 3개".
// Doesn't distinguish by how much wax is left the way 왁뿌볼 itself does —
// not asked for here, just borrowing the same underlying samples.
const WAXBBU_CRACK_POOL_ALL = [...WAXBBU_CRACK_POOL_ABOVE_40, ...WAXBBU_CRACK_POOL_AT_OR_BELOW_40];

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

/**
 * Plays `count` DISTINCT random picks from `pool` all at once — a proper
 * without-replacement shuffle-and-take, not `count` independent random picks
 * (which could repeat the same sample twice) — "랜덤은 각기 다른 게 나와야
 * 해". Used by 크루아상's layered break sound (see playMaterialSound) so
 * several different crunches genuinely overlap instead of one sample just
 * playing louder over itself. Falls back to every entry (in shuffled order)
 * if the pool has fewer than `count` of them.
 */
function playDistinctRandom(pool, count, strength) {
  const indices = pool.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  for (const idx of indices.slice(0, Math.min(count, pool.length))) playOne(pool[idx], strength);
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
 * WAX_TYPE_SOUND) when the current wax type has one — "basic" doesn't. Not
 * used for "왁뿌볼" at all — see playWaxbbuSound below.
 *
 * "크루아상": the clay/slime sound above plays exactly as normal (including
 * the dramatic first-break sample on isFirstBreak, unchanged) — layered ON
 * TOP of it, either 3 distinct random picks from 왁뿌볼's combined crack-
 * sound pools (WAXBBU_CRACK_POOL_ALL, 4 sounds total) normally, or — once
 * main.js decides isLow (little wax left, see its own
 * CROISSANT_LOW_SOUND_THRESHOLD) — just 2 distinct picks from 왁뿌볼's own
 * CALMER low-remaining pool instead (3 sounds total): "왁스가 많이
 * 떨어졌는데도 소리가 큼직한 게 많이 나서 어색하네" — the full 3-pool layer
 * kept sounding just as big/busy even once there was hardly anything left
 * to be cracking. Replaces (not combined with) any WAX_TYPE_SOUND entry —
 * 크루아상 doesn't have one of its own anyway, but this is its own fixed
 * sound recipe either way, independent of that table.
 */
export function playMaterialSound(materialMode, waxType, strength = 1, isFirstBreak = false, isLow = false) {
  if (masterVolume <= 0) return;

  const [firstBreakSound, pool] = materialMode === 'clay' ? [CLAY_FIRST_BREAK_SOUND, CLAY_SOUND_POOL] : [SLIME_FIRST_BREAK_SOUND, SLIME_SOUND_POOL];
  playOne(isFirstBreak ? firstBreakSound : pool[Math.floor(Math.random() * pool.length)], strength);

  if (waxType === 'croissant') {
    if (isLow) {
      playDistinctRandom(WAXBBU_CRACK_POOL_AT_OR_BELOW_40, 2, strength);
    } else {
      playDistinctRandom(WAXBBU_CRACK_POOL_ALL, 3, strength);
    }
    return;
  }

  const waxTypeSound = WAX_TYPE_SOUND[waxType];
  if (waxTypeSound) {
    const src = isFirstBreak
      ? waxTypeSound.firstBreak
      : waxTypeSound.pool[Math.floor(Math.random() * waxTypeSound.pool.length)];
    playOne(src, strength);
  }
}

/**
 * "왁뿌볼" only. tier is 'first' | 'mid' | 'low' — main.js picks it from
 * isFirstBreak / deformable.getRemainingWaxRatio() (mid: >40% left, low:
 * <=40%). 'first' just plays slime's own first-break sample alone; 'mid'/
 * 'low' always layer a random slime regular-pool pick underneath a random
 * pick from the matching crack pool above.
 */
export function playWaxbbuSound(tier, strength = 1) {
  if (masterVolume <= 0) return;

  if (tier === 'first') {
    playOne(SLIME_FIRST_BREAK_SOUND, strength);
    return;
  }

  playOne(SLIME_SOUND_POOL[Math.floor(Math.random() * SLIME_SOUND_POOL.length)], strength);
  const crackPool = tier === 'low' ? WAXBBU_CRACK_POOL_AT_OR_BELOW_40 : WAXBBU_CRACK_POOL_ABOVE_40;
  playOne(crackPool[Math.floor(Math.random() * crackPool.length)], strength);
}
