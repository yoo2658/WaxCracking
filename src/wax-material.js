import * as THREE from 'three';
import {
  SHELL_VERTEX_COMMON,
  SHELL_VERTEX_BEGIN,
  SHELL_FRAGMENT_COMMON,
  SHELL_FRAGMENT_COLOR,
  SHELL_FRAGMENT_ROUGHNESS,
  SHELL_NORMAL_MAPS,
  CORE_VERTEX_COMMON,
  CORE_VERTEX_BEGIN,
  CORE_FRAGMENT_COMMON,
  CORE_FRAGMENT_COLOR,
} from './shaders/wax-crack-chunks.js';

function makeDefaultCoreTexture() {
  const texture = new THREE.DataTexture(new Uint8Array([180, 180, 180, 255]), 1, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

// DoubleSide on both materials below: our generated geometry (an
// IcosahedronGeometry run through mergeVertices) has proven unreliable for
// exact-triangle raycasting under FrontSide even though it renders correctly
// (see pointer-interaction.js, which avoids that raycast entirely) —
// DoubleSide costs nothing visually for a closed solid always viewed from
// outside and removes any residual risk of the same winding quirk showing up
// as a rendering gap.

/**
 * The wax shell: a permanent Voronoi "plate" network fades in as visible
 * branching crack lines near a click (crackDamage), each one a genuine alpha
 * gap the core shows through — a real split, not a drawn-on tint — and
 * outright `discard`s wherever a chunk has actually broken off and fallen
 * (holeMask) — see shaders/wax-crack-chunks.js. A low-frequency "haze" always
 * blends a soft, blurry hint of the core's color into the wax everywhere
 * (frosted-translucent look) — deliberately blurrier and fainter than the
 * sharp crack lines, so it never substitutes for actually pressing on it.
 */
export function createShellMaterial() {
  const uniforms = {
    waxColor: { value: new THREE.Color(0xf7f2e6) },
    crackCellFrequency: { value: 3.2 },
    waxRoughnessBase: { value: 0.38 },
    coreMap: { value: makeDefaultCoreTexture() },
    projectionScale: { value: new THREE.Vector2(1, 1) },
    hazeAmount: { value: 0.45 },
    sparkleAmount: { value: 0 },
    // Only 0 for waxbbuShell (see SHELL_LOOK) — turns off this material's own
    // crack-line/hole rendering so "왁뿌볼"'s outer skin never shows either,
    // regardless of the real (shared) crackDamage/holeMask values rising
    // underneath as the core actually breaks.
    crackVisible: { value: 1 },
    // Clay/slime only — see setShellCellReveal below.
    shellCellRevealProgress: { value: 0 },
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: uniforms.waxRoughnessBase.value,
    metalness: 0.0,
    clearcoat: 0.35,
    clearcoatRoughness: 0.4,
    side: THREE.DoubleSide,
    // Crack lines dip alpha (see SHELL_FRAGMENT_COLOR) so each one reads as
    // an actual split with the core visible through the gap, not just a dark
    // mark. A full hole still uses `discard`, not alpha, so it stays a clean
    // cutout rather than a soft fade.
    transparent: true,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', SHELL_VERTEX_COMMON)
      .replace('#include <begin_vertex>', SHELL_VERTEX_BEGIN);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', SHELL_FRAGMENT_COMMON)
      .replace('#include <color_fragment>', SHELL_FRAGMENT_COLOR)
      .replace('#include <roughnessmap_fragment>', SHELL_FRAGMENT_ROUGHNESS)
      .replace('#include <normal_fragment_maps>', SHELL_NORMAL_MAPS);
  };

  material.userData.waxUniforms = uniforms;
  return material;
}

/**
 * The inner slime/squishy core: shows the user's photo/color via a front
 * projection. No crack/hole concept at all — it's just the plain surface of
 * the material inside the wax.
 */
export function createCoreMaterial() {
  const uniforms = {
    coreMap: { value: makeDefaultCoreTexture() },
    projectionScale: { value: new THREE.Vector2(1, 1) },
    // Only nonzero for "왁뿌볼" (see CORE_LOOK.waxbbu below): grows the SAME
    // kind of crack-line/hole network the shell normally shows (see
    // shaders/wax-crack-chunks.js) darkening the user's own photo/color —
    // for this mode ONLY, that visual moves down onto the core (what's
    // really "the wax", still the user's own chosen color/photo, same as
    // clay/slime), while the shell above it stays a plain, always-intact
    // translucent dome (see SHELL_LOOK.waxbbuShell's own crackVisible gate)
    // — so what visibly cracks and opens up is "the wax inside", seen
    // through the shell's translucency, never the shell itself. Once a
    // hole actually opens, DeformableMesh's fillingMesh (a plain, always-
    // opaque white layer just inside the core) shows through it instead of
    // empty space. 0 for clay/slime leaves all of this a no-op.
    innerCrackVisible: { value: 0 },
    crackCellFrequency: { value: 3.2 },
    // "왁뿌볼" only — see setCellReveal below.
    cellRevealProgress: { value: 0 },
    cellRevealColor: { value: new THREE.Color(FILLING_BASE_COLOR) },
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0.0,
    clearcoat: 0.15,
    clearcoatRoughness: 0.5,
    side: THREE.DoubleSide,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', CORE_VERTEX_COMMON)
      .replace('#include <begin_vertex>', CORE_VERTEX_BEGIN);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', CORE_FRAGMENT_COMMON)
      .replace('#include <color_fragment>', CORE_FRAGMENT_COLOR);
  };

  material.userData.waxUniforms = uniforms;
  return material;
}

const FILLING_BASE_COLOR = 0xf5f0e6;

/**
 * The innermost "filling" — a plain white solid, always fully opaque, no
 * texture/crack/hole logic of its own at all. Sits just inside the core (see
 * DeformableMesh's fillingMesh/fillingInset), permanently occluded by core
 * wherever core is intact and only ever seen through core's own holes —
 * for clay/slime that never happens (core has no holes of its own), so this
 * is purely a "왁뿌볼" thing: without it, breaking all the way through the
 * wax layer left literally nothing behind it, showing the empty scene/floor
 * straight through both layers.
 */
export function createFillingMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: FILLING_BASE_COLOR,
    roughness: 0.5,
    metalness: 0,
    clearcoat: 0.1,
    clearcoatRoughness: 0.5,
    side: THREE.FrontSide,
  });
}

const fillingBaseColorObj = new THREE.Color(FILLING_BASE_COLOR);
const fillingMixScratch = new THREE.Color();

const FILLING_MIX_TARGET_LIGHTEN = 0.45; // how far the mix TARGET itself sits from the raw wax color toward white — see setFillingMix

/**
 * "왁뿌볼" only, and only when the CURRENT texture is a flat picked color, not
 * an uploaded photo (main.js passes mixAmount=0 for photos, which is a no-op
 * below — no separate flag needed here). As more of the wax has broken
 * overall (mixAmount = 1 - remaining wax ratio, from main.js), the filling's
 * own color shifts from its base white toward the wax's own color — like the
 * broken bits staining what's underneath, "왁스를 부순 만큼 속 색이 왁스 색과
 * 섞이는" — a single material-wide tint shift rather than a per-vertex
 * gradient, since the filling only ever peeks through small holes anyway.
 * The mix TARGET itself is pre-lightened toward white (FILLING_MIX_TARGET_
 * LIGHTEN) — mixing all the way to the raw wax color made the fully-broken
 * filling indistinguishable from the wax itself; staying visibly paler keeps
 * "필링이 남았다" readable even at mixAmount=1.
 */
export function setFillingMix(fillingMaterial, waxColorHex, mixAmount) {
  fillingMixScratch.set(waxColorHex).lerp(fillingBaseColorObj, FILLING_MIX_TARGET_LIGHTEN);
  fillingMaterial.color.copy(fillingBaseColorObj).lerp(fillingMixScratch, mixAmount);
}

/**
 * "왁뿌볼" only — see CORE_FRAGMENT_COLOR's own doc comment on
 * cellRevealProgress/cellRevealColor. Call AFTER setFillingMix so
 * fillingMaterial.color already reflects this frame's mix — cellRevealColor
 * is copied straight from it, so a Voronoi cell that's globally "revealed"
 * shows the exact same color a real hole would reveal there, whether or not
 * a photo is active (unlike setFillingMix's own mixAmount, this progress is
 * NOT gated by usingPhotoTexture — a whole cell disappearing reads fine for
 * a photo too, it's not "mixing colors" the way a tint blend is).
 *
 * globalRevealProgress must be DeformableMesh's own `.globalRevealProgress`
 * (not a plain `1 - remainingRatio` computed here) — crackCellFrequency is
 * fixed (no longer dynamically grows with damage, see deformable-mesh.js's
 * CELL_REVEAL_FREQUENCY) specifically so the GPU's own Voronoi cell lookup
 * here matches DeformableMesh's CPU-side one exactly; feeding in a
 * differently-sourced progress value would make the shown effect disagree
 * with "남은 왁스 %"/click-targeting again, which was the whole bug being
 * fixed by having a single shared source of truth for it.
 */
export function setCellReveal(coreMaterial, fillingMaterial, globalRevealProgress) {
  const uniforms = coreMaterial.userData.waxUniforms;
  uniforms.cellRevealProgress.value = globalRevealProgress;
  uniforms.cellRevealColor.value.copy(fillingMaterial.color);
}

const CORE_LOOK = {
  clay: { transparent: false, opacity: 1, roughness: 0.55, clearcoat: 0.15, clearcoatRoughness: 0.5, innerCrackVisible: 0 },
  slime: { transparent: false, opacity: 1, roughness: 0.28, clearcoat: 0.5, clearcoatRoughness: 0.25, innerCrackVisible: 0 },
  // "왁뿌볼": the wax that actually cracks/breaks — see innerCrackVisible's
  // own comment above createCoreMaterial. Stays fully opaque (transparent:
  // false) even though it now also uses `discard`: discard works regardless
  // of the transparent flag (it's a fragment-shader instruction, not alpha
  // blending). side: FrontSide (not the usual DoubleSide) for the same
  // reason the shell needed it for waxbbuShell — with DoubleSide, a
  // discarded front-facing pixel on this closed shape just reveals its own
  // back-inside surface at that same screen spot instead of a real gap,
  // hiding every hole/crack completely (confirmed directly: with DoubleSide
  // here, a fully cracked wax rendered as a plain, unbroken dent).
  waxbbu: { transparent: false, opacity: 1, roughness: 0.4, clearcoat: 0.3, clearcoatRoughness: 0.35, innerCrackVisible: 1, side: THREE.FrontSide },
};

// The outer shell's own look, independent of both the clay/slime press
// physics (CORE_LOOK, above) and the user's chosen color/photo (which only
// ever drives the CORE underneath — see setCoreTexture). "basic" is the
// original frosted-translucent wax: a fixed cream tint blended with a hazy
// hint of whatever's inside. "chocolate" turns that haze off entirely
// (hazeAmount: 0) so the shell reads as a fully opaque, uniformly
// chocolate-colored coating — what's inside only shows up once a piece
// actually breaks off, same as any other wax type.
const SHELL_LOOK = {
  basic: {
    waxColor: 0xf7f2e6,
    hazeAmount: 0.45,
    waxRoughnessBase: 0.38,
    clearcoat: 0.35,
    clearcoatRoughness: 0.4,
    sparkleAmount: 0,
  },
  chocolate: {
    waxColor: 0x4a2a17,
    hazeAmount: 0,
    waxRoughnessBase: 0.3,
    clearcoat: 0.6,
    clearcoatRoughness: 0.15,
    sparkleAmount: 0,
  },
  // Matte sandy base, translucent like "basic" (unlike chocolate) so what's
  // inside still hazes through the granular coating, plus a bumpy grain
  // texture and sparkle overlay (see SHELL_FRAGMENT_COLOR/ROUGHNESS/
  // NORMAL_MAPS in wax-crack-chunks.js): grains are actually bumped (not just
  // color-tinted), and a minority flash a random hue and go near-mirror
  // smooth, so they catch specular light like real sugar/sand crystals.
  sand: {
    waxColor: 0xe6d2a0,
    hazeAmount: 0.4,
    waxRoughnessBase: 0.75,
    clearcoat: 0.1,
    clearcoatRoughness: 0.6,
    sparkleAmount: 1,
  },
  // Same opaque-coating structure as "chocolate" (hazeAmount 0 — what's
  // inside only shows once it actually breaks off), just a different
  // color/gloss: butter reads glossy like chocolate, milk reads matte
  // (low clearcoat, higher roughness) instead.
  butter: {
    waxColor: 0xf3e2a0,
    hazeAmount: 0,
    waxRoughnessBase: 0.3,
    clearcoat: 0.6,
    clearcoatRoughness: 0.15,
    sparkleAmount: 0,
  },
  milk: {
    waxColor: 0xf7f1e3,
    hazeAmount: 0,
    waxRoughnessBase: 0.75,
    clearcoat: 0.1,
    clearcoatRoughness: 0.6,
    sparkleAmount: 0,
  },
  // Same translucent structure as "basic" (haze lets a hint of the core
  // through) — just a different tint.
  strawberry: {
    waxColor: 0xf5b8ca,
    hazeAmount: 0.45,
    waxRoughnessBase: 0.38,
    clearcoat: 0.35,
    clearcoatRoughness: 0.4,
    sparkleAmount: 0,
  },
  grape: {
    waxColor: 0xc6db6f,
    hazeAmount: 0.45,
    waxRoughnessBase: 0.38,
    clearcoat: 0.35,
    clearcoatRoughness: 0.4,
    sparkleAmount: 0,
  },
  // The "왁뿌볼" mode's own outer skin look — not selectable from the wax-type
  // row (that row is hidden entirely while this mode is active, see main.js),
  // just applied directly whenever materialMode becomes 'waxbbu'. Fixed
  // ivory, no haze (hazeAmount 0 — the photo/color never reaches this look at
  // all, unlike every other entry above) and crackVisible: 0 turns off the
  // shell's own crack-line/hole rendering entirely (see SHELL_FRAGMENT_COLOR)
  // — this skin never shows a crack itself. What the player actually sees
  // breaking is the CORE underneath (CORE_LOOK.waxbbu), made visible through
  // this shell's real alpha transparency (opacity below), not a haze blend.
  waxbbuShell: {
    waxColor: 0xf7f2e6,
    hazeAmount: 0,
    waxRoughnessBase: 0.35,
    clearcoat: 0.5,
    clearcoatRoughness: 0.25,
    sparkleAmount: 0,
    crackVisible: 0,
    opacity: 0.45,
    // Stays the usual DoubleSide (see this file's top comment) — FrontSide
    // was tried here to avoid a theoretical far/near-face blending glitch,
    // but on a custom (photo-silhouette) shape's beveled side wall it
    // reliably backface-culled the shell's own geometry there (a real,
    // confirmed winding quirk of this project's generated shapes — see the
    // same top comment), letting the raw opaque core show through as a
    // solid white band instead of a translucent one. DoubleSide costs
    // nothing for a shell this thin and fixes that outright.
  },
};

/**
 * Slime's inner material reads as wet/glossy (low roughness, strong
 * clearcoat); clay stays matte. Both are fully opaque — transparency was
 * tried for slime but made the far side of the sphere visible through the
 * near side, which read as a rendering glitch rather than a gel look.
 */
export function setCoreMaterialMode(coreMaterial, mode) {
  const look = CORE_LOOK[mode] ?? CORE_LOOK.clay;
  coreMaterial.transparent = look.transparent;
  coreMaterial.opacity = look.opacity;
  coreMaterial.roughness = look.roughness;
  coreMaterial.clearcoat = look.clearcoat;
  coreMaterial.clearcoatRoughness = look.clearcoatRoughness;
  coreMaterial.userData.waxUniforms.innerCrackVisible.value = look.innerCrackVisible ?? 0;
  coreMaterial.side = look.side ?? THREE.DoubleSide;
}

/** Shared by setShellLook (a named SHELL_LOOK preset) and setCroissantLayerLook (a computed, not-in-that-table look) below — both just need to shove a look object's fields onto a shell material. */
function applyShellLook(shellMaterial, look) {
  const uniforms = shellMaterial.userData.waxUniforms;
  uniforms.waxColor.value.set(look.waxColor);
  uniforms.hazeAmount.value = look.hazeAmount;
  uniforms.waxRoughnessBase.value = look.waxRoughnessBase;
  uniforms.sparkleAmount.value = look.sparkleAmount;
  // crackVisible/opacity/side only ever differ for waxbbuShell — every other
  // look falls back to "fully normal shell" (crack rendering on, fully
  // opaque, DoubleSide) so nothing changes for them.
  uniforms.crackVisible.value = look.crackVisible ?? 1;
  shellMaterial.clearcoat = look.clearcoat;
  shellMaterial.clearcoatRoughness = look.clearcoatRoughness;
  shellMaterial.opacity = look.opacity ?? 1;
  shellMaterial.side = look.side ?? THREE.DoubleSide;
}

/** Applies a wax-type preset (basic/chocolate/…) to the shell only — leaves the core (clay/slime physics look) and the user's chosen color/photo untouched. */
export function setShellLook(shellMaterial, waxType) {
  applyShellLook(shellMaterial, SHELL_LOOK[waxType] ?? SHELL_LOOK.basic);
}

// 크루아상's two ENDPOINT looks — a real crusty golden-brown outside, easing
// into a paler, softer dough right against the core. Every one of
// 크루아상's actual layers (however many there are — see
// deformable-mesh.js's layerCount) gets an evenly-interpolated step between
// these two, computed fresh below rather than hand-picked per layer, so
// changing the LAYER COUNT alone (main.js) automatically re-spaces the
// gradient across however many steps that is, and adjusting either endpoint
// here reshapes every layer's color/gloss consistently instead of needing
// each one hand-edited. Same opaque-coating structure as chocolate/butter
// (hazeAmount 0 — a thick multi-layer coating like this should read as fully
// opaque, only showing what's inside once actually broken through, not
// hazy).
const CROISSANT_OUTER_LOOK = { waxColor: 0xa8631f, waxRoughnessBase: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.2 };
const CROISSANT_INNER_LOOK = { waxColor: 0xf7ecd0, waxRoughnessBase: 0.6, clearcoat: 0.15, clearcoatRoughness: 0.5 };
const croissantColorScratch = new THREE.Color();
const croissantOuterColor = new THREE.Color(CROISSANT_OUTER_LOOK.waxColor);
const croissantInnerColor = new THREE.Color(CROISSANT_INNER_LOOK.waxColor);

/**
 * Applies layer `layerIndex`'s (0 = outermost) own step of the crust→dough
 * gradient to one of 크루아상's shell materials — color AND gloss both
 * interpolated together (a crusty layer should look glossier, a doughy one
 * more matte, not just a different flat color) — see
 * CROISSANT_OUTER_LOOK/INNER_LOOK's own comment. layerCount 1 collapses to
 * the outer look outright (t=0) — never actually hit in practice (크루아상
 * always has more than one layer) but avoids a divide-by-zero.
 */
export function setCroissantLayerLook(shellMaterial, layerIndex, layerCount) {
  const t = layerCount <= 1 ? 0 : layerIndex / (layerCount - 1);
  croissantColorScratch.copy(croissantOuterColor).lerp(croissantInnerColor, t);
  applyShellLook(shellMaterial, {
    waxColor: croissantColorScratch.getHex(),
    hazeAmount: 0,
    waxRoughnessBase: THREE.MathUtils.lerp(CROISSANT_OUTER_LOOK.waxRoughnessBase, CROISSANT_INNER_LOOK.waxRoughnessBase, t),
    clearcoat: THREE.MathUtils.lerp(CROISSANT_OUTER_LOOK.clearcoat, CROISSANT_INNER_LOOK.clearcoat, t),
    clearcoatRoughness: THREE.MathUtils.lerp(CROISSANT_OUTER_LOOK.clearcoatRoughness, CROISSANT_INNER_LOOK.clearcoatRoughness, t),
    sparkleAmount: 0,
  });
}

/**
 * Clay/slime only (see SHELL_FRAGMENT_COLOR's own doc comment on
 * shellCellRevealProgress — crackVisible=0 already makes this inert for
 * "왁뿌볼"'s shell). Makes wax visibly flake away in scattered patches across
 * the WHOLE shell as more of it breaks anywhere, not just a hole exactly
 * where you clicked — "누를수록 왁스가 여기저기 사라지는 효과", requested
 * as a clay/slime counterpart to "왁뿌볼"'s own cell-reveal (see
 * setCellReveal) but reusing the shell's EXISTING opaque-core-reveal
 * discard instead of a filling-color swap, since the core's own color isn't
 * meant to change here.
 */
export function setShellCellReveal(shellMaterial, globalRevealProgress) {
  shellMaterial.userData.waxUniforms.shellCellRevealProgress.value = globalRevealProgress;
}

/** Both materials share the same texture reference — the core renders it directly, the shell only as a blurry haze hint. */
export function setCoreTexture(coreMaterial, shellMaterial, texture) {
  const old = coreMaterial.userData.waxUniforms.coreMap.value;
  coreMaterial.userData.waxUniforms.coreMap.value = texture;
  shellMaterial.userData.waxUniforms.coreMap.value = texture;
  if (old) old.dispose();
}

/** Keeps the front-projected core texture (and its haze hint on the shell) sized to the source photo's own half-width/half-height ({x, y}), not the shape's silhouette — see deformable-mesh.js's imageFrameHalfExtent and 2026-08-05/11_Plan.md for why those two are usually different numbers. */
export function setProjectionScale(coreMaterial, shellMaterial, { x, y }) {
  coreMaterial.userData.waxUniforms.projectionScale.value.set(x, y);
  shellMaterial.userData.waxUniforms.projectionScale.value.set(x, y);
}
