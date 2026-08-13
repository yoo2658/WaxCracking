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
uniform vec2 projectionScale; // source photo's own half-width/half-height, not the shape's silhouette — see wax-material.js's setProjectionScale
uniform float hazeAmount;
uniform float sparkleAmount;
// 0 only for "왁뿌볼"'s outer shell (see wax-material.js's SHELL_LOOK.waxbbuShell)
// — turns off every crack-line/hole effect below so this skin stays a plain,
// always-intact dome no matter how much crackDamage/holeMask have actually
// risen underneath (that's now rendered on the CORE instead — see
// CORE_FRAGMENT_COLOR). 1 everywhere else leaves this file's behavior unchanged.
uniform float crackVisible;
// 0..1, tracking OVERALL remaining wax (main.js), not this vertex's own
// click damage — clay/slime only (crackVisible gates it off for waxbbuShell
// too, same as the rest of this file) — see SHELL_FRAGMENT_COLOR's own doc
// comment further down.
uniform float shellCellRevealProgress;
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
// A fresh, never-yet-broken wax now cracks a little from the very first
// instant of a press, same as any later one (see pointer-interaction.js) —
// the dramatic payoff withheld until FIRST_BREAK_HOLD_SECONDS is the actual
// hole/fragment/wide crack burst (deformable-mesh.js's _checkBreak), not the
// crack line's visibility itself.
export const SHELL_FRAGMENT_COLOR = `#include <color_fragment>
// crackVisible is a UNIFORM (same for the whole draw call, not per-fragment
// — 0 only for "왁뿌볼"'s outer shell, SHELL_LOOK.waxbbuShell) — a real
// branch here lets the GPU skip this 27-iteration Voronoi call outright for
// that shell instead of computing it on every fragment and multiplying the
// result by 0 (2026-08-11/21_Check.md). Since 왁뿌볼's outer bubble stays on
// screen the whole time that mode is active, this was a standing cost paid
// for an effect that shell never actually shows.
float crack = 0.0;
if (crackVisible > 0.5) {
  vec2 waxVoronoiSample = waxVoronoi(vObjectPosition * crackCellFrequency);
  float edgeDist = waxVoronoiSample.y - waxVoronoiSample.x;
  float crackLine = 1.0 - smoothstep(0.0, 0.09, edgeDist);
  float crackSpread = smoothstep(0.0, 0.3, vCrackDamage);
  crack = crackLine * crackSpread * (1.0 - vHoleMask);
}

vec2 hazeUv = clamp(vObjectPosition.xy / projectionScale * 0.5 + 0.5, 0.0, 1.0);
vec4 hazeSample = texture2D(coreMap, hazeUv);
// A transparent PNG's "invisible" pixels still store SOME rgb (whatever the
// authoring tool happened to leave there — often black, or white if the
// photo started life on a white background that got keyed to alpha 0) —
// sampling .rgb alone leaked that hidden color once the photo's own true
// scale (see projectionScale's doc comment) started legitimately reaching
// those pixels near the silhouette's edge. Blending toward the same neutral
// gray the app already shows before any photo/color is chosen keeps that
// hidden color from ever surfacing, without inventing a new "border" look.
vec3 hazeColor = mix(vec3(0.706), hazeSample.rgb, hazeSample.a);
float marble = waxMarbleNoise(vObjectPosition * 1.6);
float haze = clamp(hazeAmount * (0.6 + 0.5 * marble), 0.0, 1.0);

vec3 hazyWax = mix(waxColor, hazeColor, haze);
// The crack line itself shows the core color straight through the gap
// (sharper than the blurry haze), darkened slightly at its very edge for
// depth, and its alpha drops hard — a real split, not a tint.
diffuseColor.rgb = mix(hazyWax, hazeColor, crack) * mix(1.0, 0.85, crack);

// Granular sparkle (sand wax type only — sparkleAmount is a uniform, 0 for
// every other type). Same real-branch skip as crackVisible above: the other
// seven wax types were paying this 27-iteration Voronoi call every fragment
// for a result that only ever got multiplied by 0 (2026-08-11/21_Check.md).
// A grain grid much finer than the crack network, built from the same
// jittered-feature Voronoi as the crack lines (waxVoronoiCell) so grains
// read as organic blobs, not an axis-aligned grid. grainHeight (reused
// below, in the normal chunk, to actually bump the shading normal — not just
// tint color; declared here even when sparkleAmount is 0 so that chunk still
// compiles, just stays 0) peaks at 1 in the middle of each grain and falls to
// 0 at its edge, like a scattered pile of granules stuck to the surface. A
// small minority of grains additionally hash to a randomly-hued fleck — a
// fixed per-grain property, not view-gated (real mica flecks read as
// colorful under any lighting). What DOES change with view/light angle is
// how much those same grains actually catch the light: SHELL_FRAGMENT_ROUGHNESS
// (below) drops roughness sharply on exactly those texels, so the real
// per-pixel PBR specular pass produces the moving "sparkle", not a
// hand-rolled facing term here.
float grainHeight = 0.0;
float sparkleGlint = 0.0;
if (sparkleAmount > 0.0) {
  vec4 grainSample = waxVoronoiCell(vObjectPosition * 30.0);
  grainHeight = 1.0 - clamp(grainSample.w, 0.0, 1.0);
  vec3 grainHash = waxHash3(grainSample.xyz);
  float isGlintGrain = step(0.94, grainHash.x); // ~6% of grains
  vec3 glintHue = 0.5 + 0.5 * cos(6.28318 * (grainHash.z + vec3(0.0, 0.33, 0.67)));
  sparkleGlint = isGlintGrain * sparkleAmount;
  diffuseColor.rgb = mix(diffuseColor.rgb, glintHue, sparkleGlint * 0.55);
  // Grain bumps also read very slightly darker/lighter by height even where
  // they're not a colored glint, so the granular texture still shows under
  // flat lighting, not just wherever a light happens to catch a bump.
  diffuseColor.rgb *= mix(1.0, 0.92 + 0.16 * grainHeight, sparkleAmount);
}

// Multiplied by the material's own opacity uniform (already in scope from
// the standard common/color_fragment chunks re-included above) — without
// this, a real material.opacity below 1 (see wax-material.js's waxbbuShell,
// which needs a genuinely translucent skin) was silently ignored everywhere
// except right at a crack line, since this line used to just overwrite
// diffuseColor.a outright.
diffuseColor.a = (1.0 - crack * 0.9) * opacity;

// 클레이/슬라임 only (crackVisible is 0 for waxbbuShell, making this a no-op
// there — that shell never shows any of this, by design — so the same
// real-branch skip as above saves this 27-iteration Voronoi call too for
// that shell specifically). Reuses the SAME Voronoi cell partition the
// crack lines above already draw (same crackCellFrequency) — hashes each
// cell's own identity to a fixed threshold in 0..1, and discards that WHOLE
// cell (revealing the — already opaque — core straight through, exactly
// like a real local break already does) once OVERALL remaining wax crosses
// it, regardless of whether THIS spot was ever actually clicked. Higher
// overall damage -> more scattered cells across the WHOLE shell have
// crossed their own threshold, reading as wax visibly flaking away
// everywhere, not just where you're pressing.
bool shellCellRevealed = false;
if (crackVisible > 0.5) {
  vec4 shellCell = waxVoronoiCell(vObjectPosition * crackCellFrequency);
  float shellCellThreshold = waxHash3(shellCell.xyz).y;
  shellCellRevealed = shellCellThreshold < shellCellRevealProgress;
}

if ((vHoleMask > 0.5 && crackVisible > 0.5) || shellCellRevealed) discard;
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
// Shares the SAME per-vertex data the shell's own crack lines read (see
// SHELL_VERTEX_COMMON) — added to the core geometry too (deformable-mesh.js)
// purely so "왁뿌볼" mode can grow its OWN crack-line/hole network here (see
// CORE_FRAGMENT_COLOR); a no-op varying for clay/slime, where
// innerCrackVisible stays 0.
attribute float crackDamage;
attribute float holeMask;
varying float vCrackDamage;
varying float vHoleMask;
`;

export const CORE_VERTEX_BEGIN = `#include <begin_vertex>
vObjectPosition = transformed;
vCrackDamage = crackDamage;
vHoleMask = holeMask;
`;

export const CORE_FRAGMENT_COMMON = `#include <common>
varying vec3 vObjectPosition;
varying float vCrackDamage;
varying float vHoleMask;
uniform sampler2D coreMap;
uniform vec2 projectionScale; // source photo's own half-width/half-height, not the shape's silhouette — see wax-material.js's setProjectionScale
// Only nonzero for "왁뿌볼" — see this block's own doc comment below.
uniform float innerCrackVisible;
uniform float crackCellFrequency;
// 0..1, tracking OVERALL remaining wax (main.js), not this vertex's own
// damage — see CORE_FRAGMENT_COLOR's own doc comment on cellRevealProgress.
uniform float cellRevealProgress;
uniform vec3 cellRevealColor;
${NOISE}
`;

// The core texture is front-projected from the object's own XY position (not
// the geometry's native UV unwrap), so an uploaded photo reads correctly when
// the object is viewed from the front instead of looking stretched around a
// sphere/box UV seam.
export const CORE_FRAGMENT_COLOR = `#include <color_fragment>
vec2 coreUv = clamp(vObjectPosition.xy / projectionScale * 0.5 + 0.5, 0.0, 1.0);
vec4 coreSample = texture2D(coreMap, coreUv);
// Same reasoning as the shell's hazeColor above: blend toward the app's own
// neutral "no photo" gray wherever the source is transparent, instead of
// showing whatever rgb happens to be stored under a transparent pixel.
// A transparent PNG's edge/border pixels (alpha=0) also get sampled at any
// side-facing geometry (e.g. a custom shape's beveled rim) that the
// front-projection UV can't meaningfully cover at all — that fallback used
// to be a flat neutral grey (0.706 all channels), which read as a jarring,
// clearly-different patch there rather than a believable continuation of
// the wax. Warmed toward a pale cream tone instead — still not the actual
// photo (a real fix would need the projection to wrap side-facing geometry,
// out of scope here), but far less visually jarring.
vec3 photoColor = mix(vec3(0.85, 0.79, 0.68), coreSample.rgb, coreSample.a);

// "왁뿌볼" only (innerCrackVisible is a UNIFORM, 0 everywhere else) — a real
// branch here skips BOTH 27-iteration Voronoi calls below entirely for
// clay/slime/크루아상's core, instead of always computing them and
// multiplying the result away (2026-08-11/21_Check.md). That core becomes
// visible on every broken-open pixel for every wax type, so this was a real,
// non-trivial standing cost for an effect only 왁뿌볼 ever shows. The wax
// keeps the user's own photo/color — it grows the same style of Voronoi
// crack-line network the shell normally shows (see SHELL_FRAGMENT_COLOR),
// darkening that same color rather than alpha-gapping it, since there's
// nothing further inside to reveal through a growing crack (yet — see
// discard below). Once damage actually crosses the break threshold at a
// vertex (holeMask — same shared field and same 0.5 cutoff the shell used
// to discard at), this DOES discard for real: that's a genuine hole, not a
// tint, revealing DeformableMesh's fillingMesh (a plain white solid layer
// just inside the core) rather than empty space.
//
// The second half — GLOBAL rather than local (cellRevealProgress tracks
// overall remaining wax, not this vertex's own click damage) — is "왁스가
// 점점 투명해지는 게 아니라 (실제 앱처럼) 조각이 통째로 사라지는" way: reuses
// the SAME Voronoi cell partition the crack lines above already draw (same
// crackCellFrequency), hashes each cell's own identity to a fixed, evenly-
// spread threshold in 0..1, and swaps that WHOLE cell over to
// cellRevealColor (the filling's own current color, kept in sync from
// main.js — see wax-material.js's setCellReveal) the moment overall
// progress crosses it. Higher overall progress -> more cells (a growing,
// randomly-scattered fraction of them) have crossed their own threshold,
// so what's left reads as fewer, smaller surviving islands of wax — not a
// uniform color fade.
vec3 baseWax = photoColor;
float cellRevealed = 0.0;
if (innerCrackVisible > 0.5) {
  vec2 innerVoronoi = waxVoronoi(vObjectPosition * crackCellFrequency);
  float innerCrackLine = 1.0 - smoothstep(0.0, 0.09, innerVoronoi.y - innerVoronoi.x);
  float innerCrackSpread = smoothstep(0.0, 0.3, vCrackDamage);
  float innerCrack = innerCrackLine * innerCrackSpread * (1.0 - vHoleMask);
  baseWax = mix(photoColor, photoColor * 0.7, innerCrack);

  vec4 innerCell = waxVoronoiCell(vObjectPosition * crackCellFrequency);
  float cellThreshold = waxHash3(innerCell.xyz).y;
  cellRevealed = step(cellThreshold, cellRevealProgress);
}
diffuseColor.rgb = mix(baseWax, cellRevealColor, cellRevealed);

if (vHoleMask > 0.5 && innerCrackVisible > 0.5) discard;
`;
