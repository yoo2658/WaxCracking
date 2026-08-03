import * as THREE from 'three';
import {
  SHELL_VERTEX_COMMON,
  SHELL_VERTEX_BEGIN,
  SHELL_FRAGMENT_COMMON,
  SHELL_FRAGMENT_COLOR,
  SHELL_FRAGMENT_ROUGHNESS,
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
    hasBrokenOnce: { value: 0 },
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
      .replace('#include <roughnessmap_fragment>', SHELL_FRAGMENT_ROUGHNESS);
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
