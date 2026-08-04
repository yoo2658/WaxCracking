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
    projectionScale: { value: 1 },
    hazeAmount: { value: 0.45 },
    sparkleAmount: { value: 0 },
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
    projectionScale: { value: 1 },
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

const CORE_LOOK = {
  clay: { transparent: false, opacity: 1, roughness: 0.55, clearcoat: 0.15, clearcoatRoughness: 0.5 },
  slime: { transparent: false, opacity: 1, roughness: 0.28, clearcoat: 0.5, clearcoatRoughness: 0.25 },
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
}

/** Applies a wax-type preset (basic/chocolate/…) to the shell only — leaves the core (clay/slime physics look) and the user's chosen color/photo untouched. */
export function setShellLook(shellMaterial, waxType) {
  const look = SHELL_LOOK[waxType] ?? SHELL_LOOK.basic;
  const uniforms = shellMaterial.userData.waxUniforms;
  uniforms.waxColor.value.set(look.waxColor);
  uniforms.hazeAmount.value = look.hazeAmount;
  uniforms.waxRoughnessBase.value = look.waxRoughnessBase;
  uniforms.sparkleAmount.value = look.sparkleAmount;
  shellMaterial.clearcoat = look.clearcoat;
  shellMaterial.clearcoatRoughness = look.clearcoatRoughness;
}

/** Both materials share the same texture reference — the core renders it directly, the shell only as a blurry haze hint. */
export function setCoreTexture(coreMaterial, shellMaterial, texture) {
  const old = coreMaterial.userData.waxUniforms.coreMap.value;
  coreMaterial.userData.waxUniforms.coreMap.value = texture;
  shellMaterial.userData.waxUniforms.coreMap.value = texture;
  if (old) old.dispose();
}

/** Keeps the front-projected core texture (and its haze hint on the shell) sized to the current shape's silhouette. */
export function setProjectionScale(coreMaterial, shellMaterial, scale) {
  coreMaterial.userData.waxUniforms.projectionScale.value = scale;
  shellMaterial.userData.waxUniforms.projectionScale.value = scale;
}
