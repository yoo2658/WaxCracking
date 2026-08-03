// GLSL injected into MeshPhysicalMaterial via onBeforeCompile. Chunk names
// (`color_fragment`, `roughnessmap_fragment`, `begin_vertex`, `beginnormal_vertex`,
// `common`) were confirmed against the installed three@0.185.1 source before
// writing this — they are the actual seams Three.js exposes, not guesses.
//
// Two fully separate materials use these chunks:
//  - SHELL (the wax coating): a permanent Voronoi "plate" network fades in
//    as visible branching crack lines near a click (crackDamage) — a real
//    split, not just a tint — and each crack line is also a genuine alpha
//    gap, so the core shows through it directly. `discard`s outright once a
//    chunk has actually broken off and fallen (holeMask past a threshold),
//    which is a separate, rarer event (see deformable-mesh.js) — that's a
//    clean cutout, not a fade. Because both are real geometry-level effects
//    (alpha gap / discard) rather than a texture swap, what shows through is
//    the CORE mesh — a separate, opaque, depth-correct surface. The shell
//    also blends in a low-frequency, blurry "haze" hint of the core's color
//    everywhere (frosted-translucent look, present even before any click) —
//    a soft, smoothly-varying tint with no hard edges, deliberately distinct
//    from the sharp crack lines.
//  - CORE (the slime/squishy inside): renders the user's photo/color via a
//    front projection. It has no idea cracks exist.

export const SHELL_VERTEX_COMMON = `#include <common>
attribute float crackDamage;
attribute float holeMask;
varying float vCrackDamage;
varying float vHoleMask;
varying vec3 vObjectPosition;
`;

export const SHELL_VERTEX_BEGIN = `#include <begin_vertex>
vCrackDamage = crackDamage;
vHoleMask = holeMask;
vObjectPosition = transformed;
`;

const NOISE = `
vec3 waxHash3(vec3 p){
  p = vec3(
    dot(p, vec3(127.1, 311.7, 74.7)),
    dot(p, vec3(269.5, 183.3, 246.1)),
    dot(p, vec3(113.5, 271.9, 124.6))
  );
  return fract(sin(p) * 43758.5453123);
}

// (nearest distance, second-nearest distance) — the gap between them traces
// the cell boundary network used for the crack lines.
vec2 waxVoronoi(vec3 p){
  vec3 cellIndex = floor(p);
  vec3 localPos = p - cellIndex;

  float f1 = 8.0;
  float f2 = 8.0;

  for (int k = -1; k <= 1; k++) {
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec3 offset = vec3(float(i), float(j), float(k));
        vec3 h = waxHash3(cellIndex + offset);
        vec3 featurePoint = offset + h;
        float d = length(featurePoint - localPos);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
  }

  return vec2(f1, f2);
}

// Like waxVoronoi, but also returns the winning feature's own cell coordinate
// (xyz) alongside its distance (w) — used for the sand wax type's granular
// look, where each grain needs one stable identity shared by both its bump
// height and its sparkle color, not just a boundary distance.
vec4 waxVoronoiCell(vec3 p){
  vec3 cellIndex = floor(p);
  vec3 localPos = p - cellIndex;

  float f1 = 8.0;
  vec3 bestCell = cellIndex;

  for (int k = -1; k <= 1; k++) {
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec3 offset = vec3(float(i), float(j), float(k));
        vec3 h = waxHash3(cellIndex + offset);
        vec3 featurePoint = offset + h;
        float d = length(featurePoint - localPos);
        if (d < f1) {
          f1 = d;
          bestCell = cellIndex + offset;
        }
      }
    }
  }

  return vec4(bestCell, f1);
}

// Coarse trilinear value-noise, reusing the same hash, for organic haze marbling.
float waxMarbleNoise(vec3 p){
  vec3 cellIndex = floor(p);
  vec3 localPos = fract(p);
  float total = 0.0;
  for (int k = 0; k <= 1; k++) {
    for (int j = 0; j <= 1; j++) {
      for (int i = 0; i <= 1; i++) {
        vec3 offset = vec3(float(i), float(j), float(k));
        float h = waxHash3(cellIndex + offset).x;
        vec3 w = vec3(1.0) - abs(localPos - offset);
        total += h * max(w.x, 0.0) * max(w.y, 0.0) * max(w.z, 0.0);
      }
    }
  }
  return total;
}
`;

export const SHELL_FRAGMENT_COMMON = `#include <common>
varying float vCrackDamage;
varying float vHoleMask;
varying vec3 vObjectPosition;
uniform vec3 waxColor;
uniform float crackCellFrequency;
uniform float waxRoughnessBase;
uniform sampler2D coreMap;
uniform float projectionScale;
uniform float hazeAmount;
uniform float hasBrokenOnce;
uniform float sparkleAmount;
${NOISE}
`;

// The Voronoi cell network exists everywhere geometrically, but only reads
// as visible cracks near vertices that have actually taken a hit — crackSpread
// fades lines in as damage rises, so a real branching crack visibly grows
// outward from each click instead of the whole shell looking pre-cracked at
// rest. Each crack line is a real alpha gap (not just a dark tint) so the
// core shows straight through the split — that's what makes it read as an
// actual break in the wax rather than a drawn-on line. The haze blend is
// independent and much fainter — a constant, blurry ambient hint, not a
// damage readout.
//
// hasBrokenOnce (0 until the wax's one-time 3-second first break, see
// deformable-mesh.js) hard-gates ALL crack-line visibility: crackDamage
// still silently accumulates underneath during that first press so the
// eventual break isn't computed from nothing, but nothing should be visibly
// cracked or see-through before that first dramatic break actually happens —
// otherwise a fresh, still-intact-looking wax reads as already crumbling
// the instant it's clicked, well before the 3-second payoff.
export const SHELL_FRAGMENT_COLOR = `#include <color_fragment>
vec2 waxVoronoiSample = waxVoronoi(vObjectPosition * crackCellFrequency);
float edgeDist = waxVoronoiSample.y - waxVoronoiSample.x;

float crackLine = 1.0 - smoothstep(0.0, 0.09, edgeDist);
float crackSpread = smoothstep(0.0, 0.3, vCrackDamage) * hasBrokenOnce;
float crack = crackLine * crackSpread * (1.0 - vHoleMask);

vec2 hazeUv = clamp(vObjectPosition.xy / projectionScale * 0.5 + 0.5, 0.0, 1.0);
vec3 hazeColor = texture2D(coreMap, hazeUv).rgb;
float marble = waxMarbleNoise(vObjectPosition * 1.6);
float haze = clamp(hazeAmount * (0.6 + 0.5 * marble), 0.0, 1.0);

vec3 hazyWax = mix(waxColor, hazeColor, haze);
// The crack line itself shows the core color straight through the gap
// (sharper than the blurry haze), darkened slightly at its very edge for
// depth, and its alpha drops hard — a real split, not a tint.
diffuseColor.rgb = mix(hazyWax, hazeColor, crack) * mix(1.0, 0.85, crack);

// Granular sparkle (sand wax type only — sparkleAmount is 0 for every other
// type, so all of this is a no-op elsewhere). A grain grid much finer than
// the crack network, built from the same jittered-feature Voronoi as the
// crack lines (waxVoronoiCell) so grains read as organic blobs, not an
// axis-aligned grid. grainHeight (reused below, in the normal chunk, to
// actually bump the shading normal — not just tint color) peaks at 1 in the
// middle of each grain and falls to 0 at its edge, like a scattered pile of
// granules stuck to the surface. A small minority of grains additionally
// hash to a randomly-hued fleck — a fixed per-grain property, not view-gated
// (real mica flecks read as colorful under any lighting). What DOES change
// with view/light angle is how much those same grains actually catch the
// light: SHELL_FRAGMENT_ROUGHNESS (below) drops roughness sharply on exactly
// those texels, so the real per-pixel PBR specular pass produces the moving
// "sparkle", not a hand-rolled facing term here.
vec4 grainSample = waxVoronoiCell(vObjectPosition * 30.0);
float grainHeight = 1.0 - clamp(grainSample.w, 0.0, 1.0);
vec3 grainHash = waxHash3(grainSample.xyz);
float isGlintGrain = step(0.94, grainHash.x); // ~6% of grains
vec3 glintHue = 0.5 + 0.5 * cos(6.28318 * (grainHash.z + vec3(0.0, 0.33, 0.67)));
float sparkleGlint = isGlintGrain * sparkleAmount;
diffuseColor.rgb = mix(diffuseColor.rgb, glintHue, sparkleGlint * 0.55);
// Grain bumps also read very slightly darker/lighter by height even where
// they're not a colored glint, so the granular texture still shows under
// flat lighting, not just wherever a light happens to catch a bump.
diffuseColor.rgb *= mix(1.0, 0.92 + 0.16 * grainHeight, sparkleAmount);

diffuseColor.a = 1.0 - crack * 0.9;

if (vHoleMask > 0.5) discard;
`;

export const SHELL_FRAGMENT_ROUGHNESS = `#include <roughnessmap_fragment>
roughnessFactor = mix(waxRoughnessBase, waxRoughnessBase * 1.3, crack);
roughnessFactor = mix(roughnessFactor, 0.08, sparkleGlint);
`;

// Perturbs the shading normal using the SAME grain height field the color
// pass above computed (grainHeight — a local var, still in scope here since
// three.js splices color_fragment/roughnessmap_fragment/normal_fragment_maps
// into the same main() body in that order), so sand actually reads as a
// bumpy, granular crust under lighting rather than a smooth sphere with flat
// color dots painted on. No texture/UV involved — this differentiates a
// plain procedural height value via screen-space derivatives, the same
// surface-gradient technique three.js's own bump-map support uses, just
// with our height function standing in for a sampled bumpMap texture.
// sparkleAmount is a material-wide uniform (not spatially varying per
// fragment), so branching on it here doesn't break dFdx/dFdy validity.
export const SHELL_NORMAL_MAPS = `#include <normal_fragment_maps>
if (sparkleAmount > 0.0) {
  vec2 dHeight = vec2(dFdx(grainHeight), dFdy(grainHeight));
  vec3 sigmaX = normalize(dFdx(vObjectPosition));
  vec3 sigmaY = normalize(dFdy(vObjectPosition));
  vec3 r1 = cross(sigmaY, normal);
  vec3 r2 = cross(normal, sigmaX);
  float det = dot(sigmaX, r1) * faceDirection;
  vec3 grad = sign(det) * (dHeight.x * r1 + dHeight.y * r2);
  normal = normalize(abs(det) * normal - grad * sparkleAmount * 1.4);
}
`;

export const CORE_VERTEX_COMMON = `#include <common>
varying vec3 vObjectPosition;
`;

export const CORE_VERTEX_BEGIN = `#include <begin_vertex>
vObjectPosition = transformed;
`;

export const CORE_FRAGMENT_COMMON = `#include <common>
varying vec3 vObjectPosition;
uniform sampler2D coreMap;
uniform float projectionScale;
`;

// The core texture is front-projected from the object's own XY position (not
// the geometry's native UV unwrap), so an uploaded photo reads correctly when
// the object is viewed from the front instead of looking stretched around a
// sphere/box UV seam.
export const CORE_FRAGMENT_COLOR = `#include <color_fragment>
vec2 coreUv = clamp(vObjectPosition.xy / projectionScale * 0.5 + 0.5, 0.0, 1.0);
vec4 coreSample = texture2D(coreMap, coreUv);
diffuseColor.rgb = coreSample.rgb;
`;
