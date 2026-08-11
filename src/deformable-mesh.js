import * as THREE from 'three';

// JS port of shaders/wax-crack-chunks.js's waxHash3/waxVoronoiCell — kept
// numerically identical (same hash constants, same 3x3x3 feature search) so
// that a vertex's cell membership computed here on the CPU exactly matches
// what the GPU shader draws for that same spot. Used only to precompute
// cellRevealThreshold per vertex (see the constructor) — the mechanism that
// keeps the "왁스가 여기저기 사라지는" global reveal effect (see
// getRemainingWaxRatio's own doc comment) consistent between what's visibly
// shown and what "남은 왁스 %"/click-targeting actually treat as gone.
function waxHash3(x, y, z) {
  const hx = x * 127.1 + y * 311.7 + z * 74.7;
  const hy = x * 269.5 + y * 183.3 + z * 246.1;
  const hz = x * 113.5 + y * 271.9 + z * 124.6;
  return [fractSin(hx), fractSin(hy), fractSin(hz)];
}

function fractSin(v) {
  const s = Math.sin(v) * 43758.5453123;
  return s - Math.floor(s);
}

/** Returns [cellX, cellY, cellZ] — the integer coordinate of the Voronoi feature point nearest to (px, py, pz), matching waxVoronoiCell's `bestCell`. */
function waxVoronoiCellId(px, py, pz) {
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  const cz = Math.floor(pz);
  const lx = px - cx;
  const ly = py - cy;
  const lz = pz - cz;
  let best = Infinity;
  let bestX = cx;
  let bestY = cy;
  let bestZ = cz;
  for (let k = -1; k <= 1; k++) {
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const hx = cx + i;
        const hy = cy + j;
        const hz = cz + k;
        const h = waxHash3(hx, hy, hz);
        const fx = i + h[0];
        const fy = j + h[1];
        const fz = k + h[2];
        const dx = fx - lx;
        const dy = fy - ly;
        const dz = fz - lz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < best) {
          best = d;
          bestX = hx;
          bestY = hy;
          bestZ = hz;
        }
      }
    }
  }
  return [bestX, bestY, bestZ];
}

// Fixed (not dynamically growing — see cellRevealThreshold's doc comment on
// why it must stay in lockstep with the shader) — matches wax-material.js's
// own crackCellFrequency default of 3.2 for both core and shell.
const CELL_REVEAL_FREQUENCY = 3.2;

// Angular grid resolution for the containment system (see
// getRadialRadiusGrid/buildContainmentFromGrid) — coarse enough that a
// typical shell (~2500 vertices) leaves several samples in every cell (no
// gaps after the neighbor-min blur), fine enough to localize a dent to
// roughly its own footprint instead of one pressed spot affecting the
// entire opposite side of the shape. Both the grid's own build and every
// later query go through the SAME binning function below, so a queried cell
// always lines up with the cell it was actually built from.
const CONTAINMENT_GRID_LAT_BINS = 18;
const CONTAINMENT_GRID_LON_BINS = 36;

/**
 * Buckets a direction from the origin (need not be normalized — only its
 * angle matters) into one lat/lon grid cell index, 0 ..
 * CONTAINMENT_GRID_LAT_BINS*CONTAINMENT_GRID_LON_BINS-1. Shared by
 * getRadialRadiusGrid (building, from the shell's own live vertex
 * directions) and buildContainmentFromGrid (querying, from the core's own
 * rest vertex directions) so both always agree on cell boundaries.
 */
function containmentBinIndex(x, y, z) {
  const len = Math.sqrt(x * x + y * y + z * z) || 1;
  const lat = Math.acos(Math.min(1, Math.max(-1, y / len))); // 0 (north pole) .. PI (south pole)
  const lon = Math.atan2(z, x); // -PI .. PI
  let latBin = Math.floor((lat / Math.PI) * CONTAINMENT_GRID_LAT_BINS);
  if (latBin >= CONTAINMENT_GRID_LAT_BINS) latBin = CONTAINMENT_GRID_LAT_BINS - 1;
  let lonBin = Math.floor(((lon + Math.PI) / (Math.PI * 2)) * CONTAINMENT_GRID_LON_BINS);
  if (lonBin < 0) lonBin = 0;
  else if (lonBin >= CONTAINMENT_GRID_LON_BINS) lonBin = CONTAINMENT_GRID_LON_BINS - 1;
  return latBin * CONTAINMENT_GRID_LON_BINS + lonBin;
}

// Displacement/thickness constants below are expressed relative to
// `thicknessAxis` (see constructor), not `radius` — see 2026-08-05/02_Plan.md.
// thicknessAxis is min(2*radius, localDepth): for a sphere that's exactly
// the diameter (2*radius), so these ratios were derived by halving the old
// radius-relative constants (e.g. 0.32 of radius == 0.16 of diameter) —
// the sphere's actual behavior is unchanged. For a flat/thin custom shape,
// localDepth (its real front-to-back thickness) is far smaller than its
// bounding-sphere diameter, so thicknessAxis correctly shrinks to that real
// thickness instead of letting a wide-but-thin shape poke itself through.
const MAX_PLASTIC_DISPLACEMENT_RATIO = 0.16;
const POKE_DEPTH_RATIO_OF_MAX = 0.72; // poke depth relative to maxDisplacement, kept < 1 so thin shapes don't punch through
const CRACK_RATE_PER_HIT = 0.55;
// Per-mode spring-back speed (lower = slower) — keyed by materialMode, see
// update(). "왁뿌볼" asked for a distinctly slower, lazier return to its rest
// shape than slime's own snappier squish, not just a reuse of slime's number.
const ELASTIC_DECAY_LAMBDA = { slime: 2.6, waxbbu: 0.6 };
const DEFAULT_ELASTIC_DECAY_LAMBDA = 2.6;
const BREAK_DAMAGE_THRESHOLD = 0.5; // crackDamage level (post-first-break) at which a chunk actually pops loose — reached by roughly two full-strength pokes at the same spot, continuous hold or separate taps alike. Halved from 0.95 to match MIN/MAX_HOLD_STRENGTH also being halved in pointer-interaction.js — otherwise the same "about two pokes" would've needed roughly twice as many now that each poke applies half the force.
// Both below are ratios of influenceRadius (the poke's own footprint scale),
// NOT of the whole shape's radius — they used to be radius-relative (0.7 and
// 0.18 of radius), which is harmless on a sphere (influenceRadius is a fixed
// 0.5 of radius there, so these values were simply rescaled by /0.5 to land
// on the exact same numbers) but badly wrong on a compact custom shape: a
// face-shaped custom shape's `radius` is set by its overall silhouette size, so
// "0.7 of radius" could cover a huge fraction of a small, compact face in
// one break. influenceRadius already accounts for that (see constructor —
// it's additionally capped by minFeatureRadius for tightly curved shapes),
// so tying the hole/crack/fragment spread to it instead means a break's
// visible size actually tracks "how big is a single press", not "how big is
// the whole object" — reported directly: a single hit on a face-shaped photo
// was cracking/revealing most of the visible face.
const HOLE_RADIUS_RATIO = 1.4; // = old 0.7-of-radius, rebased to influenceRadius (0.7 / 0.5) — see comment above
const FRAGMENT_RADIUS_RATIO = 0.36; // = old 0.18-of-radius, rebased the same way (0.18 / 0.5) — deliberately much smaller than HOLE_RADIUS_RATIO, since a huge chunk flying off every hit read as excessive
export const FIRST_BREAK_HOLD_SECONDS = 1.5; // a pristine, never-yet-broken wax needs one sustained press this long before its first dramatic break (wide crack burst + hole + fragment) — it still dents and cracks a little from the very first instant of any press, same as later ones, this just withholds the big payoff
const FIRST_BREAK_CRACK_SPREAD_MULTIPLIER = 1.25; // the payoff for that first sustained press is a wide crack network radiating outward — the actual hole/fragment stay normal-sized so the wax doesn't look like it vanished over a huge area. Halved from 2.5 per feedback that the crack spread felt too wide.
const REGULAR_BREAK_CRACK_SPREAD_MULTIPLIER = 0.9; // every later break also gets a modest crack-spread halo around its hole — without this, a regular break only had whatever crackDamage the poke() hits themselves happened to leave nearby (a much smaller radius), so the area around a fresh hole looked almost uncracked.

const SHELL_THICKNESS_RATIO = 0.035; // ONE LAYER's wax coating thickness, as a fraction of thicknessAxis (was 0.07 of radius — same halving as MAX_PLASTIC_DISPLACEMENT_RATIO above). A shape with more than one shell layer (크루아상 — see layerCount) stacks this many times over, so its TOTAL coating reads noticeably thicker without this per-layer number itself changing.
// How far inside the core's own surface the innermost "filling" mesh sits
// (see fillingMesh) — only ever matters for "왁뿌볼", whose core/wax layer
// can genuinely discard a hole open: without something solid just behind it,
// a fully-broken spot showed straight through to the empty scene/floor.
// Small and constant (not thickness-safety-clamped like the shell, since
// filling is meant to always exist everywhere, never narrow to 0).
const FILLING_INSET_RATIO = 0.02;

// How much of a silhouette's local clearance (see geometries.js's
// computeShellClearance) the wax shell is allowed to actually use as
// thickness there. Below 1 so even the narrowest spot the shell reaches into
// still leaves a visible gap between its two sides, instead of letting them
// just barely touch (which read as flickery, not solid). Raised from 0.6 —
// a custom (photo-based) shape's shell looked noticeably thinner than the
// plain sphere's, since the sphere's own clearance is Infinity (this ratio
// never applies to it at all) while a custom shape's real local clearance
// clamps it down almost everywhere, not just at genuinely narrow spots.
const SHELL_CLEARANCE_SAFETY_RATIO = 0.8;

// How far a poke's footprint/depth are allowed to reach relative to
// minFeatureRadius (the tightest local curvature anywhere on the shape — see
// constructor) — both influenceRadiusRim/maxDisplacementRim are ALSO capped
// by Math.min(..., influenceRadiusFlat/maxDisplacementFlat) in the
// constructor, so raising these ratios can only ever bring the rim's own
// limit UP TO the flat cap's already-sphere-matching limit, never past it.
// Raised well past 1 on purpose (reported directly: complex silhouettes —
// lots of rim relative to open flat area — felt noticeably stiffer than a
// sphere, since a sphere never hits this branch at all) so the rim ends up
// AT that flat ceiling for ordinary shapes instead of well below it; only an
// extremely thin sliver (minFeatureRadius near 0) would still end up
// clamped below the ceiling, as a last-resort backstop rather than the
// everyday case. This does reopen some risk of a poke folding a very tight
// bevel — the ratio was originally this low specifically to prevent that —
// but the mesh is now a single truly-connected surface (see 07_Do.md's
// position-only weld), so the realistic downside of overshooting here is a
// visible crease/fold at that one spot, not the disconnected-mesh tearing
// (front and back visibly pulling apart, exposing whatever's behind) that
// this ratio originally guarded against — see 2026-08-05/19_Plan.md.
const RIM_INFLUENCE_SAFETY_RATIO = 3;
const RIM_DISPLACEMENT_SAFETY_RATIO = 3;

// A poke only affects vertices whose rest-normal roughly agrees with the
// clicked point's own normal — vertices facing away (dot below the low end)
// get zero weight, vertices facing the same way (dot above the high end)
// get full weight, smoothly in between. Without this, "nearby in raw 3D
// distance" was the only test poke() used to decide what to dent/crack — on
// a sphere that's harmless (everything within influenceRadius already faces
// a similar way; the closest point on the far side is a full diameter away,
// well outside range), but on a thin flat shape the point directly behind a
// click, on the OPPOSITE face, can be just as "close" as points actually
// next to it on the SAME face — which is what let a single press dent/crack/
// even break through both faces at once (see 02_Plan.md's problem A).
const NORMAL_ALIGN_GATE_START = -0.1;
const NORMAL_ALIGN_GATE_END = 0.3;

// The "poke" displacement is a signed radial field, not a pure dent: a center
// lobe pushes inward (the finger dent) while a ring just outside it pushes
// outward along each vertex's own normal (displaced material bulging to the
// side) so repeated presses redistribute volume instead of just shrinking the
// whole shape. Ratios are relative to influenceRadius (the dent's own footprint).
const BULGE_RISE_START_RATIO = 0.6;
const BULGE_PEAK_RATIO = 1.0;
const BULGE_OUTER_RATIO = 1.6;
const BULGE_STRENGTH = 0.5;

// How much tougher a multi-layer wax (크루아상 — see layerCount) is to break
// at any one spot than a normal single-layer one — NOT tied to layerCount
// itself (an earlier version used 1/layerCount directly, making a 5-layer
// 크루아상 a full 5x tougher, which read as far too much effort per break —
// "크루아상 왁스 부수는 힘이 조금 덜 들면 좋겠어... 지금 손가락이 너무
// 아파"). Requested range was "일반 왁스의 1~2배" (1-2x a normal wax); 1.5
// sits in the middle. Only ever read for layerCount > 1 — see
// crackRateMultiplier below — so this number alone controls toughness,
// independent of however many layers 크루아상 happens to have.
const MULTI_LAYER_TOUGHNESS_MULTIPLIER = 1.5;

// How many fragments a single broken LAYER contributes when every layer
// pops at once (see _checkBreak) — weighted toward the outermost layer
// ("겉 왁스가 제일 많이"), tapering down toward the innermost one, right
// against the core ("가장 중심에 가까운 왁스는 조금") — a real multi-layer
// wax's thin, brittle outer crust shatters into far more pieces than its
// softer, better-protected inner coats. Always exactly 1 for layerCount 1
// (every non-크루아상 type) — see fragmentCountForLayer — unchanged from
// before this existed.
const LAYER_FRAGMENT_COUNT_OUTERMOST = 6;
const LAYER_FRAGMENT_COUNT_INNERMOST = 1;

/** See LAYER_FRAGMENT_COUNT_OUTERMOST/INNERMOST's own comment — linearly tapers between them across the layer stack, index 0 = outermost. */
function fragmentCountForLayer(layerIndex, layerCount) {
  if (layerCount <= 1) return 1;
  const t = layerIndex / (layerCount - 1); // 0 at outermost, 1 at innermost
  return Math.round(THREE.MathUtils.lerp(LAYER_FRAGMENT_COUNT_OUTERMOST, LAYER_FRAGMENT_COUNT_INNERMOST, t));
}

// How much WIDER a single break's hole is on the outermost layer than on
// the innermost one ("겉면이 제일 많이 떨어지고, 안쪽으로 갈수록 조금씩만
// 떨어진다") — a real layered wax's thin, brittle crust chips away over a
// noticeably bigger area per hit than its softer inner coats do at that
// same spot, so over many breaks the outer coat ends up mostly gone while
// the inner ones still cover more of what's left. Reuses the exact same
// linear taper shape as fragmentCountForLayer, just for a different
// quantity. 1 (no change) for layerCount 1 — every non-크루아상 type.
const LAYER_HOLE_RADIUS_MULTIPLIER_OUTERMOST = 1.4;
const LAYER_HOLE_RADIUS_MULTIPLIER_INNERMOST = 0.65;

function holeRadiusMultiplierForLayer(layerIndex, layerCount) {
  if (layerCount <= 1) return 1;
  const t = layerIndex / (layerCount - 1);
  return THREE.MathUtils.lerp(LAYER_HOLE_RADIUS_MULTIPLIER_OUTERMOST, LAYER_HOLE_RADIUS_MULTIPLIER_INNERMOST, t);
}

/**
 * Same as holeRadiusMultiplierForLayer, except once remainingRatio drops
 * below CLEANUP_REMAINING_THRESHOLD, blends the result back toward the
 * OUTERMOST layer's own (widest) multiplier as remainingRatio nears 0 — see
 * that constant's own comment for why. remainingRatio isn't looked up in
 * here (the caller already needs it for other decisions too — see
 * _checkBreak — so it's just passed in to avoid computing it twice).
 */
function effectiveHoleRadiusMultiplierForLayer(layerIndex, layerCount, remainingRatio) {
  const base = holeRadiusMultiplierForLayer(layerIndex, layerCount);
  if (layerCount <= 1 || remainingRatio >= CLEANUP_REMAINING_THRESHOLD) return base;
  const cleanupT = 1 - remainingRatio / CLEANUP_REMAINING_THRESHOLD; // 0 at the threshold, 1 once remaining hits 0
  return THREE.MathUtils.lerp(base, LAYER_HOLE_RADIUS_MULTIPLIER_OUTERMOST, cleanupT);
}

// How jagged/irregular a freshly-opened hole's edge is, as a fraction of its
// own radius — 0 would be a perfectly smooth circular cutout (the shape
// every break used to come out as, regardless of where it landed — "뚫린
// 모양이 똑같다"). A fresh random seed each break (see _boostFieldAt) means
// no two holes end up looking the same even at the same influenceRadius.
// Only applied to hole edges, not crack-line spread (_boostCrackAt) — the
// crack network already reads as organic via the shader's own Voronoi
// pattern regardless of crackDamage's own (still smooth) boundary shape.
const HOLE_EDGE_JITTER = 0.35;

// 크루아상 only (a no-op for layerCount 1 — see _checkBreak). Once hardly
// any wax is left, a break stops popping the usual big multi-layer burst of
// debris (fragmentCountForLayer's 6/4/1 spread) and instead drops just ONE
// fragment, in the INNERMOST layer's own color — "그 때부턴 제일 안쪽 면
// 색깔의 파편만 하나씩". Kept in lockstep with main.js's own
// CROISSANT_LOW_SOUND_THRESHOLD (also 0.15) so the sound and the visuals
// both calm down together once there's plausibly almost nothing left to be
// cracking off in big colorful chunks.
const LOW_FRAGMENT_REMAINING_THRESHOLD = 0.15;

// 크루아상 only (a no-op for layerCount 1). The outermost layer's hole
// always opens far WIDER than the innermost one's (see
// holeRadiusMultiplierForLayer — "겉면이 제일 많이 떨어지고, 안쪽으로 갈수록
// 조금씩만") — great for how a single break looks, but across MANY separate
// breaks scattered/re-pressed over a wide area, it also means the
// innermost (palest) layer's own narrow radius can end up never quite
// overlapping between two nearby-but-not-identical presses, leaving a
// small, disproportionately pale sliver of it stranded there indefinitely
// — confirmed directly: "남은 왁스 0%"인데도 화면에는 계속 흰 조각이 남아
//있었음, from multiple camera angles, ruling out a falling fragment. Below
// this remaining-ratio threshold, every layer's own radius progressively
// widens BACK toward the outermost layer's own (widest) value as remaining
// approaches 0 — closing that gap exactly when it matters (finishing off
// the last little bit) while leaving the full terraced-radius effect
// completely untouched everywhere above this threshold, where remaining
// presses still have plenty of nearby fresh material to reach normally.
const CLEANUP_REMAINING_THRESHOLD = 0.2;

// 크루아상 only (a no-op for layerCount 1). CLEANUP_REMAINING_THRESHOLD's
// own radius-widening still isn't a GUARANTEE — it only helps a break that
// actually lands near a stranded sliver, and a sliver can end up anywhere
// on the whole shape, not necessarily wherever the player happens to be
// clicking next. Confirmed directly: even with that fix active, hammering
// broadly for a long time still left a handful of vertices (concentrated
// in the innermost 1-2 layers specifically, matching the mechanism exactly)
// stuck below display-rounds-to-0%, so pressing "anywhere" didn't always
// finish it off, and the few still-real breaks that DID land nearby enough
// read as "파편이 조금씩 계속 나온다"/"어딜 눌러도 안 떨어지는 조각이 있다".
// Below this (much lower) threshold, the NEXT valid break — wherever it
// lands — sweeps EVERY layer open EVERYWHERE at once (see
// _sweepAllLayersOpen), not just its own local footprint: once this close
// to done, one more real hit anywhere finishes the whole thing outright,
// so no scattered leftover sliver can ever survive to be display-"0%"
// while something genuinely still remains.
const FINAL_SWEEP_REMAINING_THRESHOLD = 0.05;

/**
 * Owns two welded, indexed, vertex-corresponding geometries built from the
 * same base shape:
 *  - the CORE (slime/clay/왁뿌볼): sits inset beneath the surface by the
 *    FULL stacked shell thickness (every layer's own thickness added
 *    together, see layerCount below), carries the actual plastic (permanent,
 *    clay) and elastic (transient, slime and 왁뿌볼 — see _isElastic)
 *    displacement, and is textured with the user's photo/color in
 *    wax-material.js's core material. It also reads crackDamage/holeMask
 *    (shared with the outermost shell layer's own copy, see the
 *    constructor), but only 왁뿌볼 actually acts on it (blending toward a
 *    slime tint as damage rises) — for every other mode that read is a
 *    harmless no-op.
 *  - the SHELL (wax): one or more stacked LAYERS (see layerCount) — every
 *    existing wax type uses exactly one, which behaves identically to the
 *    single shell this class used to have outright; 크루아상 is the only
 *    caller that passes more than one. Every layer, every frame, is rebuilt
 *    as the core's position plus a constant per-layer gap along the outward
 *    direction, stacked innermost-out (see _rebuildPositions) — so a poke
 *    can never punch through the coating by denting/bulging past it, only by
 *    an actual break (see below). Each layer renders its own crack/grout
 *    pattern and discards its own fragments (see shaders/wax-crack-chunks.js),
 *    so what shows through a hole is always a real, depth-correct surface
 *    (the core) rather than a blended texture on the same skin.
 *
 * crackDamage (cosmetic crack growth, 0-1 per vertex) is shared, ONE field
 * for the whole stack — the same as it always was before this class
 * supported more than one layer. holeMask lives per layer, but ALL layers
 * open together at the exact same spot in the exact same call (see
 * _checkBreak) — real multi-layer wax cracks a chunk spanning several coats
 * AT ONCE, not one thin layer at a time ("한 번에 여러 겹이 와다닥 깨져"),
 * confirmed against real 100겹 버터왁스크런치 reference footage: a break
 * there pops several differently-colored layers of debris in one single
 * burst, not a slow one-at-a-time peel. A break is triggered per-poke by
 * _checkBreak: once crackDamage at the poked spot crosses the SAME
 * BREAK_DAMAGE_THRESHOLD as ever (never scaled past crackDamage's own 0..1
 * ceiling — see crackRateMultiplier), it pops every layer AND a fragment per
 * layer, all at once. A 크루아상 spot still takes somewhat more hits than a
 * single-layer wax would ("more force required to break") to GET there, via
 * crackRateMultiplier slowing how fast each hit's damage accumulates
 * instead — by MULTI_LAYER_TOUGHNESS_MULTIPLIER (currently 1.5x), not by how
 * many layers it happens to have (an earlier version scaled by 1/layerCount
 * directly, making a 5-layer 크루아상 a full 5x tougher — far more effort
 * than intended, decoupled from layer count on request). A wax that has
 * never broken AT ALL yet additionally
 * needs one single sustained FIRST_BREAK_HOLD_SECONDS-long press before its
 * first break, rewarded with a much wider crack burst than
 * usual (the actual hole/fragment size is unchanged) — it still visibly
 * dents and cracks a little the whole time it's building up to that, same
 * as any later press.
 *
 * Every mesh is kept at an identity transform (no rotation/translation/
 * scale) for their whole lifetime, so raycast hit points in world space can
 * be used directly as local/object space — no matrix conversion needed. View
 * rotation is handled separately by OrbitControls in scene.js.
 */
export class DeformableMesh {
  /**
   * containmentRadiusPerVertex (default null — a no-op for every existing
   * caller) caps how far EACH vertex's final position can end up from the
   * origin, indexed by that vertex's own direction (see
   * buildContainmentFromGrid) — see _rebuildPositions(). Only ever set for
   * "왁뿌볼" + a custom shape's CORE instance (see composite-waxbbu-mesh.js):
   * once that core deforms plastic (permanent, clay-like — "속에 있는 왁스는
   * 클레이처럼 뭉개지면 좋겠어") instead of its usual elastic spring-back,
   * its accumulated dent/bulge is no longer automatically bounded by a shell
   * that's DERIVED from it (the way the shared-topology single-mesh setup
   * always guaranteed) — the shell is a totally independent sphere here, so
   * nothing stops a deep enough plastic bulge from poking past it without
   * this.
   *
   * Deliberately PER-VERTEX/per-direction, not one shared scalar. An earlier
   * version used a single global value — the shell's one closest-to-origin
   * point, found anywhere across its ENTIRE surface — and clamped every core
   * vertex against that same number. The instant the shell dented deeply at
   * just the one spot being pressed, that global minimum collapsed, and the
   * clamp then shrank the whole core/filling toward the origin, not only the
   * part actually near the press — confirmed directly: pressing anywhere
   * shrank the ENTIRE inner wax ball ("누를 때마다 속에 있는 왁스와 속재질이
   * 엄청 쪼그라드는데"), not just the pressed side. A per-direction cap fixes
   * this: a vertex whose own direction's patch of shell is untouched keeps
   * that patch's own (much larger) radius as its limit, regardless of how
   * dented some unrelated other spot on the shell currently is.
   */
  constructor(geometry, coreMaterial, shellMaterials, fillingMaterial) {
    this.materialMode = 'clay'; // 'clay' | 'slime' | 'waxbbu' (see _isElastic below)
    this.containmentRadiusPerVertex = null;
    // How many wax coats are stacked on top of the core — 1 for every
    // existing wax type (identical to the old single-shell behavior), 3 for
    // 크루아상 (see main.js's buildDeformable). shellMaterials is always an
    // array, one entry per layer, index 0 = OUTERMOST (struck first).
    this.layerCount = shellMaterials.length;
    // See class doc comment — a multi-layer spot should take somewhat more
    // HITS before it lets go, but crackDamage itself is (and must stay)
    // clamped to 0..1 per vertex — the shader's own crackSpread visual reads
    // it on that same 0..1 assumption, and BREAK_DAMAGE_THRESHOLD needs to
    // stay reachable at all (scaling the THRESHOLD up past 1 instead of
    // this, tried first, made it literally unreachable — crackDamage can
    // never exceed 1, so a threshold of e.g. 1.5 for 3 layers never fires,
    // ever, after the very first break). Scaling the ACCUMULATION RATE down
    // instead (see poke()) gets the same toughness within that same 0..1
    // range — by MULTI_LAYER_TOUGHNESS_MULTIPLIER, not by layerCount itself
    // (see that constant's own comment on why). 1 for layerCount 1,
    // unchanged from before layers existed.
    this.crackRateMultiplier = this.layerCount > 1 ? 1 / MULTI_LAYER_TOUGHNESS_MULTIPLIER : 1;

    geometry.computeBoundingSphere();
    this.radius = geometry.boundingSphere.radius;
    // localDepth (set by geometries.js) is this shape's real front-to-back
    // thickness — falls back to a sphere's own diameter if a geometry
    // somehow doesn't provide one. thicknessAxis is the smaller of "overall
    // diameter" and "actual local thickness": for a sphere those are the
    // same number, so nothing changes; for a flat custom shape, localDepth
    // (much smaller than its wide bounding-sphere diameter) correctly wins.
    this.localDepth = geometry.userData.localDepth ?? this.radius * 2;
    const thicknessAxis = Math.min(this.radius * 2, this.localDepth);
    // minFeatureRadius (set by geometries.js) is the tightest local bend
    // anywhere on this shape — a sphere's own radius (uniform curvature), or
    // a custom shape's beveled rim curvature, which can be much tighter than
    // both the radius and thicknessAxis. Neither of those two already guards
    // against this: thicknessAxis only stops a poke from reaching the
    // OPPOSITE face; it says nothing about a poke on the SAME, tightly
    // curved surface displacing neighboring vertices (whose normals point in
    // rapidly different directions right there) past what that curve can
    // absorb without folding the mesh onto itself — exactly the glitchy
    // striping seen when pressing a custom shape's rounded rim. Capping both
    // the footprint and the depth by this value fixes that; falls back to
    // `this.radius` (a sphere's own uniform curvature) if a geometry doesn't
    // provide one, so both caps below are always looser than the existing
    // ones for a sphere — no change to its behavior.
    const minFeatureRadius = geometry.userData.minFeatureRadius ?? this.radius;
    // Two variants instead of one shape-wide value: "flat" is the generous
    // limit (same math as before this fix — thickness/radius-based only),
    // "rim" is the tight, minFeatureRadius-capped limit from the previous
    // fix. Which one actually applies is decided PER VERTEX in poke() (via
    // curvatureSafety below, through _influenceRadiusFor/_maxDisplacementFor),
    // not once for the whole shape — a single global rim-safe clamp stopped
    // the rim from folding, but it also made every press on the flat cap
    // feel weak, not just presses actually near the rim (reported directly —
    // see 2026-08-05/08_Check.md).
    this.influenceRadiusFlat = this.radius * 0.5;
    this.influenceRadiusRim = Math.min(this.influenceRadiusFlat, minFeatureRadius * RIM_INFLUENCE_SAFETY_RATIO);
    this.maxDisplacementFlat = thicknessAxis * MAX_PLASTIC_DISPLACEMENT_RATIO;
    this.maxDisplacementRim = Math.min(this.maxDisplacementFlat, minFeatureRadius * RIM_DISPLACEMENT_SAFETY_RATIO);
    // Per-vertex "how safe is a big displacement here" (1 = flat cap, 0 =
    // tightly curved rim — see geometries.js's computeCurvatureSafety).
    // Falls back to all-1 (always use the generous limit) if a geometry
    // doesn't provide one.
    this.curvatureSafety = geometry.userData.curvatureSafety ?? new Float32Array(geometry.attributes.position.count).fill(1);
    // Half-width/half-height of the source photo's own frame (set by
    // geometries.js), in the same units as `radius` — used to size the
    // front-projected texture to the photo's true scale. Falls back to a
    // square matching `radius` (the old, single-scalar behavior) if a
    // geometry doesn't provide one.
    this.imageFrameHalfExtent = geometry.userData.imageFrameHalfExtent ?? { x: this.radius, y: this.radius };
    // ONE layer's own thickness — see SHELL_THICKNESS_RATIO's own comment on
    // why this number itself doesn't change with layerCount.
    const perLayerThickness = thicknessAxis * SHELL_THICKNESS_RATIO;
    this.fillingInset = thicknessAxis * FILLING_INSET_RATIO;

    const baseGeometry = geometry; // outer (outermost-layer) silhouette, unchanged from the built shape
    const basePositionAttr = baseGeometry.attributes.position;
    this.vertexCount = basePositionAttr.count;
    const baseRestPosition = basePositionAttr.array;

    // Per-vertex ceiling on the shell's TOTAL thickness (every layer added
    // together), set by geometries.js sampling the silhouette's own
    // local-thickness field directly at each vertex's position (see
    // geometries.js's computeShellClearance) — small at a silhouette's
    // narrow/concave spots (between two ears, an armpit, a thin hair
    // spike, ...), large anywhere wide open, including the whole sphere.
    // Without this, the shell's constant outward offset could push both
    // sides of a narrow neck past each other, leaving a gap right there that
    // exposes the core (and whatever photo/color it's showing) — reported
    // directly as "복잡한 경계면은 왁스가 감싸지지 않고 속 재질이 보이는"
    // (see 2026-08-05/14_Plan.md). Precomputed once here (not re-derived
    // every frame in _rebuildPositions()) since shellClearance itself never
    // changes after the shape is built. Clamped on the TOTAL stacked
    // thickness, not any one layer's own share of it — otherwise a narrow
    // custom shape could let a multi-layer 크루아상's OUTERMOST layer cross
    // the opposite side even though each individual layer looked safely
    // thin on its own; every layer then gets an even share of whatever total
    // actually fits (for layerCount 1, this is identical to before).
    const shellClearance = baseGeometry.userData.shellClearance ?? new Float32Array(this.vertexCount).fill(Infinity);
    this.localShellThickness = new Float32Array(this.vertexCount);
    for (let v = 0; v < this.vertexCount; v++) {
      const totalThickness = perLayerThickness * this.layerCount;
      const clampedTotal = Math.min(totalThickness, shellClearance[v] * SHELL_CLEARANCE_SAFETY_RATIO);
      this.localShellThickness[v] = clampedTotal / this.layerCount;
    }

    // The shape's real vertex normals (geometries.js runs every shape through
    // weldAndSmooth(), i.e. merge + computeVertexNormals(), so this attribute
    // always exists). This used to be approximated as "direction from the
    // origin to the vertex" instead, which is only ever equal to the real
    // surface normal for a sphere centered on the origin — on a flat custom
    // shape's front/back faces that approximation points diagonally outward
    // (toward the rim) rather than straight along the shape's own thin axis,
    // which is exactly the kind of mismatch that let the shell/core offset
    // and the poke's push direction drift away from "actually along the
    // surface" (see 2026-08-05/02_Plan.md). No change for a sphere: its real
    // vertex normals already point almost exactly in the origin direction.
    const baseNormalAttr = baseGeometry.attributes.normal;
    this.restNormal = new Float32Array(this.vertexCount * 3);
    if (baseNormalAttr) {
      this.restNormal.set(baseNormalAttr.array);
    } else {
      for (let v = 0; v < this.vertexCount; v++) {
        const i3 = v * 3;
        const x = baseRestPosition[i3];
        const y = baseRestPosition[i3 + 1];
        const z = baseRestPosition[i3 + 2];
        const len = Math.sqrt(x * x + y * y + z * z) || 1;
        this.restNormal[i3] = x / len;
        this.restNormal[i3 + 1] = y / len;
        this.restNormal[i3 + 2] = z / len;
      }
    }

    // The CORE's own rest surface — inset from the base (outermost layer's)
    // silhouette by the FULL stacked shell thickness (every layer's own
    // localShellThickness added together), so the outermost layer's own rest
    // surface lands exactly ON the base silhouette regardless of layerCount
    // — for layerCount 1 this is the exact same single subtraction as
    // before this class supported more than one layer.
    this.restPosition = new Float32Array(this.vertexCount * 3);
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const t = this.localShellThickness[v] * this.layerCount;
      this.restPosition[i3] = baseRestPosition[i3] - this.restNormal[i3] * t;
      this.restPosition[i3 + 1] = baseRestPosition[i3 + 1] - this.restNormal[i3 + 1] * t;
      this.restPosition[i3 + 2] = baseRestPosition[i3 + 2] - this.restNormal[i3 + 2] * t;
    }
    const coreGeometry = baseGeometry.clone(); // deep-copies attributes/index — safe to mutate independently
    coreGeometry.attributes.position.array.set(this.restPosition);
    coreGeometry.attributes.position.needsUpdate = true;
    coreGeometry.computeVertexNormals();

    // Per-vertex Voronoi-cell hash threshold (0..1) — precomputed once from
    // the REST position (not the live, dented one the shader itself samples;
    // small denting practically never moves a vertex across a whole cell
    // boundary, and a FIXED per-vertex cell assignment for the mesh's whole
    // lifetime avoids any flicker from a vertex nominally switching cells
    // mid-deformation). See getRemainingWaxRatio's own doc comment for how
    // this drives the global reveal without creating a feedback loop.
    // Only meaningful (and only ever read) by _applyGlobalReveal, which is
    // itself only ever invoked for the single-layer case — 크루아상 (layer
    // Count > 1) deliberately skips the whole global-reveal mosaic effect in
    // favor of "때린 자리만 겹겹이 뚫리는" (see class doc comment), so skip
    // the work computing this there too.
    if (this.layerCount === 1) {
      this.cellRevealThreshold = new Float32Array(this.vertexCount);
      for (let v = 0; v < this.vertexCount; v++) {
        const i3 = v * 3;
        const cellId = waxVoronoiCellId(
          this.restPosition[i3] * CELL_REVEAL_FREQUENCY,
          this.restPosition[i3 + 1] * CELL_REVEAL_FREQUENCY,
          this.restPosition[i3 + 2] * CELL_REVEAL_FREQUENCY,
        );
        this.cellRevealThreshold[v] = waxHash3(cellId[0], cellId[1], cellId[2])[1];
      }
    }
    this.globalRevealProgress = 0;

    // Initial rest pose only — _rebuildPositions() recomputes this live every
    // frame from restPosition/restNormal directly, same as it does for shell.
    const fillingGeometry = baseGeometry.clone(); // a third, further-inset copy — see fillingInset above
    const fillingRestPosition = new Float32Array(this.vertexCount * 3);
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      fillingRestPosition[i3] = this.restPosition[i3] - this.restNormal[i3] * this.fillingInset;
      fillingRestPosition[i3 + 1] = this.restPosition[i3 + 1] - this.restNormal[i3 + 1] * this.fillingInset;
      fillingRestPosition[i3 + 2] = this.restPosition[i3 + 2] - this.restNormal[i3 + 2] * this.fillingInset;
    }
    fillingGeometry.attributes.position.array.set(fillingRestPosition);
    fillingGeometry.attributes.position.needsUpdate = true;
    fillingGeometry.computeVertexNormals();

    this.plasticOffset = new Float32Array(this.vertexCount * 3);
    this.elasticSnapshot = new Float32Array(this.vertexCount * 3);
    this.elasticDecay = 0;
    this._elasticHeld = false;

    // crackDamage is ONE shared field for the whole stack (see class doc
    // comment on why — layers open together, not one at a time, so there's
    // no per-layer damage to track separately). Exposed as the SAME
    // BufferAttribute array on every layer's geometry — harmless for the
    // inner layers, which are never actually visible pre-break anyway (the
    // outermost one always fully occludes them until the moment they're all
    // revealed together).
    const crackDamage = new Float32Array(this.vertexCount);
    this.crackDamage = crackDamage;

    // The shell layer stack — see class doc comment on the cumulative gap
    // chain (_rebuildPositions). Index 0 = outermost (struck first), the
    // last index = innermost (right against the core). Every existing wax
    // type passes exactly one shellMaterial (this loop then runs once, with
    // a result identical to the old single-shell setup) — 크루아상 is the
    // only caller that passes more than one (see main.js's buildDeformable).
    this.layers = [];
    for (let k = 0; k < this.layerCount; k++) {
      const layerGeometry = baseGeometry.clone();
      layerGeometry.setAttribute('crackDamage', new THREE.BufferAttribute(crackDamage, 1));

      // holeMask is the GPU/gameplay-facing array (rendering discard,
      // _checkBreak's guard, getRemainingWaxRatio) — for the single-layer
      // case it's the per-vertex MAX of _localHoleMask (written ONLY by real
      // local breaks, see _boostHoleAt) and the global cell-reveal condition
      // (cellRevealThreshold vs globalRevealProgress, merged in by
      // _applyGlobalReveal every frame); _localHoleMask is kept separate
      // there specifically so the global reveal's own progress can be
      // driven by "how much has ACTUALLY broken locally" without it being
      // circular. 크루아상 (layerCount > 1) has no global reveal to merge in
      // at all, so holeMask there is simply THE SAME array as
      // _localHoleMask — _boostHoleAt's writes already ARE the final
      // gameplay-facing state, no separate merge step needed. Each layer
      // still gets its OWN hole arrays (unlike crackDamage above) even
      // though _checkBreak always boosts every layer's together — the gap-
      // collapse math in _rebuildPositions reads each layer's own holeMask
      // independently, and keeping them as genuinely separate arrays (not
      // just separate BufferAttributes over one shared array) is what makes
      // that "always driven together, but never assumed to be the same
      // array" safe to reason about.
      const localHoleMask = new Float32Array(this.vertexCount);
      const holeMask = this.layerCount === 1 ? new Float32Array(this.vertexCount) : localHoleMask;
      layerGeometry.setAttribute('holeMask', new THREE.BufferAttribute(holeMask, 1));

      const shellMaterial = shellMaterials[k];
      const shellMesh = new THREE.Mesh(layerGeometry, shellMaterial);
      shellMesh.matrixAutoUpdate = false;
      // All layers (and the core) sit at the exact same local origin — only
      // their geometry's own radius differs — so THREE's default transparent
      // sort (by object position/bounding-sphere distance to camera) sees
      // every layer at the IDENTICAL sort key and can't tell them apart by
      // depth alone; without this, which layer visually "wins" ends up
      // arbitrary (confirmed directly: the INNERMOST, palest layer rendered
      // on top of the outer ones, showing through as if the outer coats
      // were invisible even though their own colors were verified correct).
      // renderOrder breaks that tie explicitly — innermost drawn first
      // (lowest), outermost drawn last (highest, so it wins) — matching real
      // back-to-front transparency ordering regardless of the tied depth
      // key. A no-op for every existing wax type (layerCount 1 → always 0,
      // THREE's own default).
      shellMesh.renderOrder = this.layerCount - 1 - k;

      this.layers.push({ shellGeometry: layerGeometry, shellMesh, shellMaterial, _localHoleMask: localHoleMask, holeMask });
    }
    // Back-compat single reference for internal use only (getRadialRadiusGrid
    // — 왁뿌볼-only, always layerCount === 1, so "the shell" is unambiguous).
    this.shellGeometry = this.layers[0].shellGeometry;
    this.shellMeshes = this.layers.map((layer) => layer.shellMesh);
    this.mesh = this.shellMeshes[0]; // scene wiring/pointer-interaction's bounding-sphere lookup — see main.js

    this.coreGeometry = coreGeometry;
    // crackDamage/holeMask are ALSO exposed on the CORE geometry, backed by
    // the SAME typed arrays (crackDamage always; holeMask from the outermost
    // layer — see above, every layer's holeMask ends up identical anyway) —
    // writes in poke()/_boostFieldAt update both for free, but each
    // BufferAttribute still needs its own needsUpdate flip to actually
    // re-upload to the GPU (see update()/reset()). Core only acts on either
    // for "왁뿌볼" mode, which grows its own crack-line/hole network from
    // them (see wax-material.js/wax-crack-chunks.js) — a harmless unused
    // varying for every other mode, 크루아상 included (왁뿌볼 never has more
    // than one layer, so "the outermost layer" is the only layer there).
    coreGeometry.setAttribute('crackDamage', new THREE.BufferAttribute(crackDamage, 1));
    coreGeometry.setAttribute('holeMask', new THREE.BufferAttribute(this.layers[0].holeMask, 1));

    this.fillingGeometry = fillingGeometry;

    this.coreMesh = new THREE.Mesh(coreGeometry, coreMaterial);
    this.coreMesh.matrixAutoUpdate = false;
    // Only ever actually seen through a hole the core discards ("왁뿌볼" —
    // see wax-material.js's createFillingMaterial) — for clay/slime/크루아상,
    // core has no holes of its own, so this permanently sits fully occluded
    // behind it.
    this.fillingMesh = new THREE.Mesh(fillingGeometry, fillingMaterial);
    this.fillingMesh.matrixAutoUpdate = false;

    this._dirtyPosition = false;
    this._dirtyAttributes = false;
    this.hasBrokenOnce = false; // a pristine wax needs one sustained FIRST_BREAK_HOLD_SECONDS press before its first dramatic break (see FIRST_BREAK_HOLD_SECONDS above)
  }

  setMaterialMode(mode) {
    this.materialMode = mode;
  }

  /** Both 'slime' and 'waxbbu' spring back to rest (elasticSnapshot) instead of denting permanently (plasticOffset, clay only) — see poke()/update(). */
  _isElastic() {
    return this.materialMode === 'slime' || this.materialMode === 'waxbbu';
  }

  /**
   * Given a rough direction from the origin (e.g. a bounding-sphere hit),
   * returns the actual rest-position vertex most aligned with it (the real
   * point on this shape's surface in that direction) together with its real
   * rest-normal. pointer-interaction.js uses the normal as the poke's push
   * direction — it used to just normalize the point itself (direction from
   * origin), which is only ever correct for a sphere (where "away from
   * center" and "the real surface normal" happen to be the same vector);
   * on a flat custom shape they can differ a lot (e.g. every point on a flat
   * face shares one real normal but has a different origin-direction), so
   * this now returns the actual restNormal instead. Known remaining
   * approximation: the ARGMAX search below still only looks at "closest
   * origin-direction", which on a very thin shape can occasionally prefer a
   * point on the opposite face over the intended one at near-identical
   * angles — deferred the same way the previous cycle deferred it (tune
   * later against real photos rather than pre-solving it now).
   */
  surfacePointTowards(direction) {
    const rest = this.restPosition;
    const dx = direction.x;
    const dy = direction.y;
    const dz = direction.z;
    const dirLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;

    let bestDot = -Infinity;
    let bestIndex = 0;
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const vx = rest[i3];
      const vy = rest[i3 + 1];
      const vz = rest[i3 + 2];
      const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      const dot = (vx * dx + vy * dy + vz * dz) / (vLen * dirLen);
      if (dot > bestDot) {
        bestDot = dot;
        bestIndex = v;
      }
    }

    const i3 = bestIndex * 3;
    const point = new THREE.Vector3(rest[i3], rest[i3 + 1], rest[i3 + 2]);
    const normal = new THREE.Vector3(this.restNormal[i3], this.restNormal[i3 + 1], this.restNormal[i3 + 2]);
    return { point, normal };
  }

  /** The dent-footprint radius to use at a vertex with this curvatureSafety (1 = flat cap, 0 = tight rim) — shared by poke() and _checkBreak() so the flat/rim blend formula lives in one place. */
  _influenceRadiusFor(safety) {
    return THREE.MathUtils.lerp(this.influenceRadiusRim, this.influenceRadiusFlat, safety);
  }

  /** Same blend as _influenceRadiusFor, for the displacement limit — shared by poke() and _clampDisplacement(). */
  _maxDisplacementFor(safety) {
    return THREE.MathUtils.lerp(this.maxDisplacementRim, this.maxDisplacementFlat, safety);
  }

  /**
   * Incremental poke + crack at a clicked point. normal is the outward
   * surface normal at that point; strength scales dent depth, bulge, and
   * crack damage. pointer-interaction.js calls this every frame during a
   * hold, passing only the MARGINAL increase in strength since the last
   * frame (not the cumulative total) — the underlying dent/bulge/crackDamage
   * accumulation is a plain sum, so many small calls add up to exactly the
   * same result as one big call with the total, whether the press was one
   * long hold or several separate taps. holdSeconds is how long the CURRENT
   * continuous press has lasted; it only matters for a wax that has never
   * broken at all yet (see hasBrokenOnce below). Returns a fragment-pop
   * descriptor ({ point, radius, color }) the moment a chunk actually breaks
   * loose, or null otherwise — the caller uses this to spawn a falling
   * debris piece (in that broken layer's own color) and play the break
   * sound in sync, even mid-hold.
   *
   * The dent/bulge displacement itself (plasticOffset/elasticSnapshot) is
   * shared, core-level state — pressing a multi-layer 크루아상 spot
   * compresses the WHOLE stack together, same as pressing anywhere else;
   * layers are purely a shell-surface crack/hole/reveal concept layered on
   * top of that shared dent, not extra independent physics per layer.
   */
  poke(pointWorld, normal, strength = 1, holdSeconds = 0) {
    const rest = this.restPosition;
    const restNormal = this.restNormal;
    const curvatureSafety = this.curvatureSafety;
    // The widest/deepest a poke could EVER reach (the flat-safe limit) —
    // used only to size the vertex-search loop below. Each vertex actually
    // considered gets its OWN dentRadius/depth further down, blended by ITS
    // OWN curvatureSafety — so a single poke whose footprint happens to
    // straddle both the flat cap and the curved rim treats each side
    // correctly instead of picking one shape-wide compromise.
    const bulgeOuterMax = this.influenceRadiusFlat * BULGE_OUTER_RATIO;
    const bulgeOuterMaxSq = bulgeOuterMax * bulgeOuterMax;
    const isElastic = this._isElastic();
    const target = isElastic ? this.elasticSnapshot : this.plasticOffset;
    const pushX = -normal.x;
    const pushY = -normal.y;
    const pushZ = -normal.z;

    if (isElastic) {
      // Only bake in the current decay fraction on the FIRST poke of a fresh
      // hold (fresh press, or resuming mid-bounce right after a release) —
      // _elasticHeld marks a hold as already "caught" so every later frame of
      // the SAME continuous hold skips this, leaving elasticDecay pinned at
      // exactly 1 (see update()) instead of being re-baked/eroded every
      // frame, which previously caused the dent to visibly shrink back even
      // while still being held down.
      if (!this._elasticHeld) {
        const decay = this.elasticDecay;
        if (decay > 0 && decay < 1) {
          for (let i = 0; i < target.length; i++) target[i] *= decay;
        }
        this.elasticDecay = 1;
      }
      this._elasticHeld = true;
    }

    let nearestIndex = 0;
    let nearestDistSq = Infinity;

    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const dx = rest[i3] - pointWorld.x;
      const dy = rest[i3 + 1] - pointWorld.y;
      const dz = rest[i3 + 2] - pointWorld.z;
      // Squared distance only here — the sqrt is deferred below to just the
      // vertices that actually pass both range gates (a small minority of
      // vertexCount for any single poke), since finding a minimum/comparing
      // against a radius works identically on squared values and this loop
      // runs every frame of every hold.
      const distSq = dx * dx + dy * dy + dz * dz;

      // See NORMAL_ALIGN_GATE_* above: a vertex facing away from this poke
      // (e.g. the opposite face of a thin shape, which can be just as close
      // in raw distance as the intended face) is excluded here so it can
      // never register as "nearest", get dented, or accrue crack damage.
      const alignDot = restNormal[i3] * normal.x + restNormal[i3 + 1] * normal.y + restNormal[i3 + 2] * normal.z;
      const alignWeight = THREE.MathUtils.smoothstep(alignDot, NORMAL_ALIGN_GATE_START, NORMAL_ALIGN_GATE_END);

      if (alignWeight > 0 && distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearestIndex = v;
      }
      if (distSq >= bulgeOuterMaxSq || alignWeight <= 0) continue;

      // This vertex's OWN safe limits — flat cap vertices get the generous
      // (sphere-like) values, rim vertices get the tight ones, everything
      // in between blends smoothly. See constructor / geometries.js's
      // computeCurvatureSafety.
      const safety = curvatureSafety[v];
      const dentRadius = this._influenceRadiusFor(safety);
      const depth = this._maxDisplacementFor(safety) * POKE_DEPTH_RATIO_OF_MAX * strength;
      const bulgeRiseStart = dentRadius * BULGE_RISE_START_RATIO;
      const bulgePeak = dentRadius * BULGE_PEAK_RATIO;
      const bulgeOuter = dentRadius * BULGE_OUTER_RATIO;
      if (distSq >= bulgeOuter * bulgeOuter) continue; // outside even this vertex's own (possibly smaller) footprint

      const dist = Math.sqrt(distSq); // only now — needed for the actual falloff shape below, not just a range check

      const dentWeight = THREE.MathUtils.smoothstep(dentRadius - dist, 0, dentRadius) * alignWeight; // already 0 once dist >= dentRadius, no extra guard needed

      let bulgeWeight = 0;
      if (dist > bulgeRiseStart) {
        bulgeWeight =
          dist < bulgePeak
            ? THREE.MathUtils.smoothstep(dist, bulgeRiseStart, bulgePeak)
            : 1 - THREE.MathUtils.smoothstep(dist, bulgePeak, bulgeOuter);
      }
      bulgeWeight *= alignWeight;

      target[i3] += pushX * depth * dentWeight + restNormal[i3] * depth * BULGE_STRENGTH * bulgeWeight;
      target[i3 + 1] += pushY * depth * dentWeight + restNormal[i3 + 1] * depth * BULGE_STRENGTH * bulgeWeight;
      target[i3 + 2] += pushZ * depth * dentWeight + restNormal[i3 + 2] * depth * BULGE_STRENGTH * bulgeWeight;

      if (dentWeight > 0) {
        const next = this.crackDamage[v] + dentWeight * CRACK_RATE_PER_HIT * strength * this.crackRateMultiplier;
        this.crackDamage[v] = next > 1 ? 1 : next;
      }
    }

    this._clampDisplacement(target);

    this._dirtyPosition = true;
    this._dirtyAttributes = true;

    // "왁뿌볼" runs the exact same break logic as clay/slime here (1.5s hold
    // for the first dramatic break, then repeated hits) — the only
    // difference for this mode is what that break actually LOOKS like (the
    // core renders it, the shell never does — see wax-material.js) and that
    // main.js skips spawning a visible falling fragment piece for it.
    return this._checkBreak(pointWorld, normal, nearestIndex, holdSeconds);
  }

  /**
   * Decides whether this poke just broke every remaining layer loose at
   * once (see class doc comment). Guarded by the INNERMOST layer's holeMask
   * at the nearest vertex first — NOT the outermost: since each layer's own
   * hole radius tapers narrower toward the core (see
   * holeRadiusMultiplierForLayer — "겉면이 제일 많이 떨어지고, 안쪽으로
   * 갈수록 조금씩만"), a single break opens a WIDE area on the outermost
   * layer but only a NARROWER area on the innermost one, so plenty of
   * vertices end up with the outer layer already gone while an inner layer
   * is still very much intact right there. Guarding on the outermost layer
   * alone made every one of those spots permanently unbreakable the moment
   * the outer layer opened nearby — confirmed directly: pressing on the
   * "ring" around an already-opened hole did nothing no matter how many
   * times it was hit ("겉면을 한 번 부수면 아무리 눌러도 두 번째와 세 번째가
   * 안 깨지는데"). The innermost layer's own radius is a strict subset of
   * every other layer's for the exact same break (same center, always a
   * smaller radius) — so if IT'S already open somewhere, every other layer
   * there necessarily already is too, making it the correct "truly nothing
   * left to break here" check. For layerCount 1 the outermost and innermost
   * are literally the same one layer, so this is unchanged from before.
   *
   * EXCEPT when finalSweep applies (see FINAL_SWEEP_REMAINING_THRESHOLD):
   * that guard is exactly what a final sweep needs to override — the whole
   * point is finishing off a stray sliver stranded somewhere OTHER than
   * wherever the player is currently pressing, so the click point itself
   * having nothing left to break there can't be a reason to bail out.
   * Confirmed directly: without this override, pressing anywhere ordinary
   * while almost done (which is, definitionally, mostly already-broken
   * ground) tripped this very guard immediately and never even reached the
   * sweep logic below, leaving the stray sliver stranded forever.
   */
  _checkBreak(pointWorld, normal, nearestIndex, holdSeconds) {
    // Computed once (only for 크루아상 — every other type never needs it
    // here) and reused below for the low-remaining fragment color, the
    // low-remaining hole-radius cleanup boost, AND the final-sweep check,
    // instead of calling getRemainingWaxRatio() three times over.
    const remainingRatio = this.layerCount > 1 ? this.getRemainingWaxRatio() : 1;
    // See FINAL_SWEEP_REMAINING_THRESHOLD's own comment — once this close
    // to done, the break about to happen (either branch below) clears
    // EVERYTHING at once instead of just its own local footprint, and can
    // fire from a press ANYWHERE, not just one that lands on still-live
    // material (see this method's own doc comment on the guard below).
    const finalSweep = this.layerCount > 1 && remainingRatio > 0 && remainingRatio <= FINAL_SWEEP_REMAINING_THRESHOLD;

    if (!finalSweep && this.layers[this.layerCount - 1].holeMask[nearestIndex] > 0.5) return null;

    // Every layer pops loose AT ONCE on a break (see below) — the caller
    // spawns one fragment per entry here, all in the same burst, so each
    // layer's own color appears fragmentCountForLayer(k, layerCount) times
    // (more for the outermost, fewer toward the innermost — see that
    // function's own comment). Read directly off each layer's OWN material
    // — for every non-크루아상 type this is just a 1-element array with the
    // single shared shell's own color, unchanged from before. Once almost
    // nothing is left (see LOW_FRAGMENT_REMAINING_THRESHOLD), skip that big
    // multi-color burst in favor of a single innermost-layer-colored piece.
    const innermostColor = this.layers[this.layerCount - 1].shellMaterial.userData.waxUniforms.waxColor.value;
    const colors =
      this.layerCount > 1 && remainingRatio <= LOW_FRAGMENT_REMAINING_THRESHOLD
        ? [innermostColor]
        : this.layers.flatMap((layer, k) => {
            const color = layer.shellMaterial.userData.waxUniforms.waxColor.value;
            return Array(fragmentCountForLayer(k, this.layerCount)).fill(color);
          });

    // Same flat-vs-rim blend as poke() (see _influenceRadiusFor), but by the
    // NEAREST vertex's own curvatureSafety — a break on the flat cap opens a
    // proportionally bigger hole (matching the bigger dent it took to get
    // there), a break near the rim stays conservative, instead of every
    // break everywhere being capped down to the rim-safe size.
    const influenceRadius = this._influenceRadiusFor(this.curvatureSafety[nearestIndex]);

    if (!this.hasBrokenOnce) {
      if (holdSeconds < FIRST_BREAK_HOLD_SECONDS) return null;
      this.hasBrokenOnce = true;
      // The dramatic payoff is a crack network radiating out far wider than
      // an ordinary break — but the actual hole/fragment stay normal-sized,
      // so the wax reads as "it just cracked all over" rather than "a huge
      // chunk of it vanished".
      this._boostCrackAt(pointWorld, normal, influenceRadius * HOLE_RADIUS_RATIO * FIRST_BREAK_CRACK_SPREAD_MULTIPLIER);
      if (finalSweep) {
        this._sweepAllLayersOpen();
      } else {
        this.layers.forEach((layer, k) => {
          const holeRadius = influenceRadius * HOLE_RADIUS_RATIO * effectiveHoleRadiusMultiplierForLayer(k, this.layerCount, remainingRatio);
          this._boostHoleAt(layer, pointWorld, normal, holeRadius);
        });
      }
      return { point: pointWorld.clone(), radius: influenceRadius * FRAGMENT_RADIUS_RATIO, isFirstBreak: true, colors };
    }

    // Same override as the guard above — a final sweep must be able to fire
    // from a fresh press that hasn't built up any crackDamage of its own
    // yet at this exact (already-broken) spot; requiring that would defeat
    // the whole point.
    if (!finalSweep && this.crackDamage[nearestIndex] < BREAK_DAMAGE_THRESHOLD) return null;
    this._boostCrackAt(pointWorld, normal, influenceRadius * HOLE_RADIUS_RATIO * REGULAR_BREAK_CRACK_SPREAD_MULTIPLIER);
    if (finalSweep) {
      this._sweepAllLayersOpen();
    } else {
      this.layers.forEach((layer, k) => {
        const holeRadius = influenceRadius * HOLE_RADIUS_RATIO * effectiveHoleRadiusMultiplierForLayer(k, this.layerCount, remainingRatio);
        this._boostHoleAt(layer, pointWorld, normal, holeRadius);
      });
    }
    return { point: pointWorld.clone(), radius: influenceRadius * FRAGMENT_RADIUS_RATIO, isFirstBreak: false, colors };
  }

  /**
   * See FINAL_SWEEP_REMAINING_THRESHOLD's own comment — opens every layer's
   * hole EVERYWHERE at once (not just near the point that just broke),
   * guaranteeing a multi-layer wax this close to done always finishes
   * completely on the very next real break, wherever it lands, instead of
   * possibly leaving some far-away stranded sliver (see
   * effectiveHoleRadiusMultiplierForLayer's own gap) unreachable by that
   * break's own local radius.
   */
  _sweepAllLayersOpen() {
    for (const layer of this.layers) {
      layer.holeMask.fill(1);
      if (layer._localHoleMask !== layer.holeMask) layer._localHoleMask.fill(1);
    }
    this._dirtyPosition = true;
    this._dirtyAttributes = true;
  }

  /**
   * Shared by _boostCrackAt/_boostHoleAt below, which are otherwise
   * identical aside from which per-vertex field they raise — the only
   * difference is passed in as `field`. Gated by normal alignment (see
   * NORMAL_ALIGN_GATE_* / poke()) so a break on one face of a thin shape
   * can't also crack/hole the opposite face — without it, a chunk breaking
   * off the front could punch straight through to the back, which is
   * exactly the "속이 비어서 반대편이 보이는" symptom this cycle set out to
   * fix. Only breaks fire this (not every frame), but it still defers the
   * sqrt past the cheap squared-distance range check, same as poke().
   *
   * jitterAmount (0 = perfectly smooth/circular, the old and only shape
   * every break used to come out as — "뚫린 모양이 똑같다") randomly
   * perturbs each vertex's effective distance from the click point by up to
   * that fraction, so the resulting boundary comes out jagged/irregular
   * instead of a clean circle. The random seed is freshly rolled EACH CALL
   * (not derived from vertex position alone), so the exact same click point
   * tears a differently-shaped hole from one break to the next, not just a
   * fixed jagged pattern that happens to look different at different
   * points on the shape.
   */
  _boostFieldAt(field, pointWorld, normal, radius, jitterAmount = 0) {
    const rest = this.restPosition;
    const restNormal = this.restNormal;
    // Search a bit wider than the nominal radius so jitter can still bulge
    // the boundary outward past it, not just inward.
    const searchRadius = radius * (1 + jitterAmount);
    const searchRadiusSq = searchRadius * searchRadius;
    const seedX = jitterAmount > 0 ? Math.random() * 1000 : 0;
    const seedY = jitterAmount > 0 ? Math.random() * 1000 : 0;
    const seedZ = jitterAmount > 0 ? Math.random() * 1000 : 0;
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const dx = rest[i3] - pointWorld.x;
      const dy = rest[i3 + 1] - pointWorld.y;
      const dz = rest[i3 + 2] - pointWorld.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq >= searchRadiusSq) continue;
      const alignDot = restNormal[i3] * normal.x + restNormal[i3 + 1] * normal.y + restNormal[i3 + 2] * normal.z;
      const alignWeight = THREE.MathUtils.smoothstep(alignDot, NORMAL_ALIGN_GATE_START, NORMAL_ALIGN_GATE_END);
      if (alignWeight <= 0) continue;
      let dist = Math.sqrt(distSq);
      if (jitterAmount > 0) {
        // Reuses the same hash already used for Voronoi cell IDs above —
        // just need a cheap, well-distributed pseudo-random 0..1 per vertex
        // here, not an actual cell lookup.
        const n = fractSin((rest[i3] + seedX) * 12.9898 + (rest[i3 + 1] + seedY) * 78.233 + (rest[i3 + 2] + seedZ) * 37.719);
        dist *= 1 + (n - 0.5) * 2 * jitterAmount;
      }
      const weight = THREE.MathUtils.smoothstep(radius - dist, 0, radius) * alignWeight;
      field[v] = Math.max(field[v], weight);
    }
    this._dirtyAttributes = true;
  }

  /** Widens the visible crack network around a point, without opening an actual hole — used for the first break's dramatic-but-not-empty payoff. crackDamage is shared across the whole layer stack (see class doc comment), so unlike _boostHoleAt this needs no layer argument. Deliberately NOT jittered (see HOLE_EDGE_JITTER's own comment) — the crack network already reads as organic via the shader's own Voronoi pattern regardless of this field's own (still smooth) boundary shape. */
  _boostCrackAt(pointWorld, normal, radius) {
    this._boostFieldAt(this.crackDamage, pointWorld, normal, radius);
  }

  /** Marks the spot a chunk just fell off of, on ONE layer, as a clean hole — no crack cosmetics there, and the shader discards it so what's underneath (the next layer in, or the core) shows through. Writes to that layer's _localHoleMask, NOT necessarily its GPU-facing holeMask directly — see that field's own doc comment; update()'s _applyGlobalReveal merges the two every frame for the single-layer case (the two are literally the same array for a multi-layer 크루아상, so this already IS the final value there). */
  _boostHoleAt(layer, pointWorld, normal, radius) {
    this._boostFieldAt(layer._localHoleMask, pointWorld, normal, radius, HOLE_EDGE_JITTER);
  }

  /**
   * Clamps each vertex's displacement field to ITS OWN safe limit
   * (_maxDisplacementFor) — a single shape-wide clamp would either let a rim
   * vertex fold (if set to the generous flat limit) or needlessly flatten a
   * legitimately deep flat-cap dent (if set to the tight rim limit) just
   * because some OTHER vertex elsewhere happens to be poked next.
   *
   * Shared by BOTH plasticOffset (clay, permanent) and elasticSnapshot
   * (slime/왁뿌볼, springs back) — elastic needs the exact same ceiling for a
   * related but distinct reason: elasticSnapshot's own "bake in the current
   * decay fraction on a fresh hold" logic (see poke() above) means several
   * SEPARATE presses at the same spot, each starting before the previous one
   * has fully sprung back, keep ADDING more depth on top of whatever's left.
   * Before this was shared, elastic went through poke() completely
   * unclamped, so enough repeated same-spot presses could dent a vertex
   * arbitrarily deep with no limit at all. For the usual single
   * shared-topology mesh that just looked like an extreme (if ugly) dent;
   * for composite-waxbbu-mesh.js's independent bubble+wax structure it was
   * far worse — confirmed directly, 20 repeated same-spot presses caved the
   * bubble's shell in to within 0.02 of the ORIGIN, and since the wax
   * inside is contained relative to the shell's own live radius (see
   * getRadialRadiusGrid), that near-zero radius became the wax's own
   * containment limit in that one direction, visibly tearing it open there
   * even though the wax's own displacement was never itself excessive.
   */
  _clampDisplacement(target) {
    const curvatureSafety = this.curvatureSafety;
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const max = this._maxDisplacementFor(curvatureSafety[v]);
      const lenSq = target[i3] * target[i3] + target[i3 + 1] * target[i3 + 1] + target[i3 + 2] * target[i3 + 2];
      if (lenSq > max * max) {
        // sqrt deferred until here — the overwhelming majority of vertices
        // at any given moment are well under their own limit and never
        // reach this branch, so most of the loop is just the cheap lenSq
        // compare above.
        const s = max / Math.sqrt(lenSq);
        target[i3] *= s;
        target[i3 + 1] *= s;
        target[i3 + 2] *= s;
      }
    }
  }

  /** Advances slime spring-back. Returns true if the geometry needed a GPU upload this frame. */
  update(dt) {
    let needsPositionRebuild = this._dirtyPosition;

    if (this._elasticHeld) {
      // Still being pressed this frame (poke() ran and re-marked this) —
      // stay fully dented, don't spring back yet. Consume the flag so that
      // if poke() isn't called again next frame (released, or handed off to
      // a drag), decay actually starts running from there.
      this._elasticHeld = false;
    } else if (this.elasticDecay > 0) {
      const lambda = ELASTIC_DECAY_LAMBDA[this.materialMode] ?? DEFAULT_ELASTIC_DECAY_LAMBDA;
      this.elasticDecay = THREE.MathUtils.damp(this.elasticDecay, 0, lambda, dt);
      if (this.elasticDecay < 0.002) {
        this.elasticDecay = 0;
        this.elasticSnapshot.fill(0); // clear stale raw offsets so the next press starts clean, not with an instant pop back to old history
      }
      needsPositionRebuild = true;
    }

    // Must run BEFORE the position rebuild below, not after — a merge here
    // can itself change holeMask, which _rebuildPositions() also needs (it
    // drives the shell's own gap collapse for clay/slime — see
    // holeAffectsGap there) to actually reflect a freshly-revealed cell.
    // Only the single-layer case has a global reveal to merge in at all —
    // see cellRevealThreshold's own doc comment.
    if (this.layerCount === 1 && this._dirtyAttributes && this._applyGlobalReveal()) {
      needsPositionRebuild = true;
    }

    if (needsPositionRebuild) {
      this._rebuildPositions();
    }

    if (this._dirtyAttributes) {
      for (const layer of this.layers) {
        layer.shellGeometry.attributes.crackDamage.needsUpdate = true;
        layer.shellGeometry.attributes.holeMask.needsUpdate = true;
      }
      this.coreGeometry.attributes.crackDamage.needsUpdate = true;
      this.coreGeometry.attributes.holeMask.needsUpdate = true;
      this._dirtyAttributes = false;
    }

    this._dirtyPosition = false;
    return needsPositionRebuild;
  }

  /**
   * Merges the "왁스가 여기저기 사라지는" global reveal into the outermost
   * (and, for the single-layer case, only) layer's real, GPU/gameplay-facing
   * holeMask (see that field's own doc comment) — a vertex becomes gone
   * there the moment EITHER a real local break covers it (_localHoleMask) OR
   * its own fixed cellRevealThreshold is crossed by globalRevealProgress,
   * which is itself driven by getLocalRemainingRatio() — LOCAL-only
   * progress, so revealing more cells here can never feed back into
   * revealing even more (no runaway cascade). Returns true if any vertex's
   * merged value actually changed this call. Only ever invoked for
   * layerCount === 1 — see that field's own doc comment on why 크루아상
   * skips this mechanic entirely.
   */
  _applyGlobalReveal() {
    const layer = this.layers[0];
    this.globalRevealProgress = 1 - this.getLocalRemainingRatio();
    const threshold = this.cellRevealThreshold;
    const local = layer._localHoleMask;
    const hole = layer.holeMask;
    const progress = this.globalRevealProgress;
    let changed = false;
    for (let v = 0; v < this.vertexCount; v++) {
      const merged = threshold[v] < progress ? 1 : local[v];
      if (merged !== hole[v]) {
        hole[v] = merged;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Every layer's outer surface = the core's own position, plus that layer's
   * own gap, plus every layer BELOW it (closer to the core)'s own gap too —
   * stacked innermost-out (see class doc comment). Walking the layer array
   * from the innermost index down to 0 while accumulating a running offset
   * builds exactly that: by the time the loop reaches layer k, the running
   * offset already holds every inner layer's contribution, so adding just
   * that one layer's own gap lands exactly on its true outer surface. If
   * layer k's own gap has collapsed to 0 (its hole is open there), its
   * position ends up IDENTICAL to the layer just inside it — flush, with
   * layer k's own fragment shader discarding there (see
   * wax-crack-chunks.js), so what actually shows through is that next layer
   * in (or the bare core, once every layer's gap is 0). For layerCount 1
   * this reduces to exactly the old single "shell = core + one gap" formula.
   */
  _rebuildPositions() {
    const corePos = this.coreGeometry.attributes.position.array;
    const fillingPos = this.fillingGeometry.attributes.position.array;
    const rest = this.restPosition;
    const restNormal = this.restNormal;
    const plastic = this.plasticOffset;
    const elastic = this.elasticSnapshot;
    const decay = this.elasticDecay;
    const localShellThickness = this.localShellThickness;
    const fillingInset = this.fillingInset;
    const layers = this.layers;
    const layerCount = this.layerCount;
    // "왁뿌볼"'s outer skin never opens a hole — see wax-material.js's
    // SHELL_LOOK.waxbbuShell — so unlike clay/slime/크루아상, its gap
    // shouldn't collapse toward the core wherever the INNER wax underneath
    // has actually broken; it stays a constant, smooth, always-intact
    // thickness regardless of holeMask. 왁뿌볼 never has more than one layer,
    // so this only ever matters for that single layer.
    const holeAffectsGap = this.materialMode !== 'waxbbu';

    const containmentRadiusPerVertex = this.containmentRadiusPerVertex;
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;

      let cx = rest[i3] + plastic[i3] + elastic[i3] * decay;
      let cy = rest[i3 + 1] + plastic[i3 + 1] + elastic[i3 + 1] * decay;
      let cz = rest[i3 + 2] + plastic[i3 + 2] + elastic[i3 + 2] * decay;

      // See containmentRadiusPerVertex's own doc comment on the constructor
      // — a no-op for every case except "왁뿌볼" + a custom shape's core.
      // Indexed by vertex (not one shared scalar) — each vertex only ever
      // gets clamped by the shell's OWN current radius in ITS OWN direction.
      if (containmentRadiusPerVertex !== null) {
        const containmentRadius = containmentRadiusPerVertex[v];
        const distSq = cx * cx + cy * cy + cz * cz;
        const radiusSq = containmentRadius * containmentRadius;
        if (distSq > radiusSq) {
          const s = containmentRadius / Math.sqrt(distSq);
          cx *= s;
          cy *= s;
          cz *= s;
        }
      }

      corePos[i3] = cx;
      corePos[i3 + 1] = cy;
      corePos[i3 + 2] = cz;
      fillingPos[i3] = cx - restNormal[i3] * fillingInset;
      fillingPos[i3 + 1] = cy - restNormal[i3 + 1] * fillingInset;
      fillingPos[i3 + 2] = cz - restNormal[i3 + 2] * fillingInset;

      // Stack layers innermost (layerCount-1) outward to outermost (0),
      // accumulating thickness as we go — see this method's own doc comment.
      let cumX = cx;
      let cumY = cy;
      let cumZ = cz;
      for (let k = layerCount - 1; k >= 0; k--) {
        const layer = layers[k];
        const gap = holeAffectsGap ? localShellThickness[v] * (1 - layer.holeMask[v]) : localShellThickness[v];
        cumX += restNormal[i3] * gap;
        cumY += restNormal[i3 + 1] * gap;
        cumZ += restNormal[i3 + 2] * gap;
        const shellPos = layer.shellGeometry.attributes.position.array;
        shellPos[i3] = cumX;
        shellPos[i3 + 1] = cumY;
        shellPos[i3 + 2] = cumZ;
      }
    }

    this.coreGeometry.attributes.position.needsUpdate = true;
    this.fillingGeometry.attributes.position.needsUpdate = true;
    this.coreGeometry.computeVertexNormals();

    // Filling and every shell layer share the CORE's exact topology, offset
    // outward/inward from it by a small constant gap along each vertex's
    // OWN rest normal — geometrically, that means their true surface normal
    // is always extremely close to the core's own at that same vertex (a
    // thin coating barely bends the surface it's wrapped around). Reusing
    // the core's own just-computed normals here — a cheap array copy — for
    // all of them instead of running computeVertexNormals() again per
    // layer (each one an O(vertex count) pass in its own right) cuts what
    // used to be 3-7 full recomputes down to 1 real one, with no visible
    // difference (see 2026-08-07's optimization pass — reported lag with
    // 크루아상's 5 extra shell layers in particular, which used to mean 7
    // separate full recomputes every single deforming frame).
    const coreNormalArray = this.coreGeometry.attributes.normal.array;
    this.fillingGeometry.attributes.normal.array.set(coreNormalArray);
    this.fillingGeometry.attributes.normal.needsUpdate = true;
    for (let k = 0; k < layerCount; k++) {
      const layer = layers[k];
      layer.shellGeometry.attributes.position.needsUpdate = true;
      layer.shellGeometry.attributes.normal.array.set(coreNormalArray);
      layer.shellGeometry.attributes.normal.needsUpdate = true;
    }
  }

  /**
   * How much of the shell is still visible solid wax, 0-1 — 1 for a
   * pristine shape, reaching exactly 0 once every last bit is gone.
   * Deliberately counts vertices past the SAME 0.5 cutoff the shell's own
   * fragment shader discards at (see wax-crack-chunks.js's
   * `if (vHoleMask > 0.5) discard;`), not a plain average of the raw
   * holeMask values — averaging looked "stuck" at a low but nonzero
   * percentage even once every single point had already crossed that
   * discard threshold and the shell had become completely invisible,
   * because holeMask sits anywhere from just-over-0.5 to 1 in a
   * fully-opened area, not pegged at exactly 1 — a plain mean of those
   * never quite reaches 0 even though nothing is left on screen. Counting
   * "past the same line the shader itself discards at" instead means this
   * reaches 0% at exactly the moment the last visible scrap disappears.
   *
   * Averages, across every vertex, WHAT FRACTION of its own layers are
   * still intact (not just whether the outermost one is) — for layerCount 1
   * that's just "is THE layer intact, 0 or 1", identical to the old
   * single-layer formula. Needs to look past the outermost layer alone now
   * that each layer opens over a DIFFERENT radius (see
   * holeRadiusMultiplierForLayer — "겉면이 제일 많이 떨어지고, 안쪽으로
   * 갈수록 조금씩만"): a break leaves plenty of vertices where the outer
   * layer has opened but an inner one is still very much visible and
   * intact right there, so counting "outer open ⟹ 0% left here" made the
   * displayed % drop far faster than what was actually still visibly on
   * screen — confirmed directly from a screenshot showing a clearly
   * still-mostly-intact ball reporting 8% remaining ("아무리 봐도 8%
   * 남은거같지 않은데"). Each layer's own radius is always ⊇ every layer
   * further in for the SAME break (see holeRadiusMultiplierForLayer's own
   * ordering), so "how many of a vertex's layers are intact" is always a
   * clean 0..layerCount count, never something in between two layers that
   * doesn't correspond to a real state.
   */
  getRemainingWaxRatio() {
    let remainingLayerSum = 0;
    for (let v = 0; v < this.vertexCount; v++) {
      for (let k = 0; k < this.layerCount; k++) {
        if (this.layers[k].holeMask[v] <= 0.5) remainingLayerSum++;
      }
    }
    return remainingLayerSum / (this.layerCount * this.vertexCount);
  }

  /**
   * Buckets this mesh's own shell (its OUTERMOST layer — see
   * this.shellGeometry) into a lat/lon grid (see containmentBinIndex), each
   * cell holding the CURRENT (this frame's, already-dented) shortest
   * distance from the origin among every shell vertex whose LIVE position
   * falls in that cell — used by composite-waxbbu-mesh.js (via
   * buildContainmentFromGrid below) as a per-direction containment boundary
   * for the wax inside it. Only ever called for "왁뿌볼" (always
   * layerCount === 1, so "the outermost layer" is unambiguously the whole
   * shell). Reads the LIVE surface, not this.radius (the NOMINAL, undeformed
   * one): while the bubble is actively dented inward at the press point, its
   * real surface there sits well inside its own nominal radius.
   *
   * Deliberately a GRID over the whole shell, not one single global minimum
   * — an earlier version returned just the shell's overall closest-to-origin
   * point and used that ONE number to clamp every core vertex everywhere,
   * which meant denting the shell at one spot shrank the ENTIRE core, not
   * just the part near that spot (see containmentRadiusPerVertex's own doc
   * comment for the exact symptom this caused). Binning by direction instead
   * means a dent at one spot only lowers the cells that dent's own footprint
   * actually touches — everywhere else keeps its own, unrelated (much
   * larger) radius.
   *
   * A one-pass min-with-neighbors blur (longitude wraps around, latitude
   * doesn't) runs afterward for two reasons: it fills in any cell that
   * happened to land zero shell vertices (the shell's ~2500 vertices spread
   * unevenly across CONTAINMENT_GRID_LAT_BINS*CONTAINMENT_GRID_LON_BINS
   * cells, so a few empty ones are expected) by borrowing a neighbor's value
   * instead of leaving it at Infinity — an empty cell defaulting to
   * Infinity would be silently too lenient right where a dent's footprint
   * straddled a cell boundary — and it softens the clamp's own cell-to-cell
   * edges so the contained wax doesn't visibly facet along the grid itself.
   */
  getRadialRadiusGrid() {
    const pos = this.shellGeometry.attributes.position.array;
    const cellCount = CONTAINMENT_GRID_LAT_BINS * CONTAINMENT_GRID_LON_BINS;
    const minDistSq = new Float64Array(cellCount).fill(Infinity);
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const x = pos[i3];
      const y = pos[i3 + 1];
      const z = pos[i3 + 2];
      const distSq = x * x + y * y + z * z;
      const bin = containmentBinIndex(x, y, z);
      if (distSq < minDistSq[bin]) minDistSq[bin] = distSq;
    }

    const grid = new Float32Array(cellCount);
    for (let i = 0; i < cellCount; i++) grid[i] = Math.sqrt(minDistSq[i]);

    const blurred = new Float32Array(cellCount);
    for (let lat = 0; lat < CONTAINMENT_GRID_LAT_BINS; lat++) {
      const rowStart = lat * CONTAINMENT_GRID_LON_BINS;
      for (let lon = 0; lon < CONTAINMENT_GRID_LON_BINS; lon++) {
        const idx = rowStart + lon;
        const lonPrev = rowStart + ((lon - 1 + CONTAINMENT_GRID_LON_BINS) % CONTAINMENT_GRID_LON_BINS);
        const lonNext = rowStart + ((lon + 1) % CONTAINMENT_GRID_LON_BINS);
        let m = Math.min(grid[idx], grid[lonPrev], grid[lonNext]);
        if (lat > 0) m = Math.min(m, grid[idx - CONTAINMENT_GRID_LON_BINS]);
        if (lat < CONTAINMENT_GRID_LAT_BINS - 1) m = Math.min(m, grid[idx + CONTAINMENT_GRID_LON_BINS]);
        blurred[idx] = m;
      }
    }
    return blurred;
  }

  /**
   * Turns a SHELL's own getRadialRadiusGrid() into a per-vertex containment
   * array sized to THIS (the core's) own vertexCount, by binning each of
   * this mesh's own REST vertex directions — not live/deformed ones, so a
   * core vertex's clamp target can't drift to some unrelated shell cell
   * mid-press just because the vertex itself has moved — into that exact
   * same grid. margin (0..1) shrinks every looked-up value so the wax
   * settles comfortably inside the shell's own surface rather than exactly
   * touching it.
   */
  buildContainmentFromGrid(grid, margin = 1) {
    const rest = this.restPosition;
    const result = new Float32Array(this.vertexCount);
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const bin = containmentBinIndex(rest[i3], rest[i3 + 1], rest[i3 + 2]);
      result[v] = grid[bin] * margin;
    }
    return result;
  }

  /** LOCAL-only remaining ratio for the outermost (single, in this case) layer — counts only real, click-driven breaks (_localHoleMask), blind to the global reveal. Exists purely to safely DRIVE globalRevealProgress in _applyGlobalReveal without creating a feedback loop with getRemainingWaxRatio's own (merged) result. Only ever called for layerCount === 1 — see _applyGlobalReveal. */
  getLocalRemainingRatio() {
    let remainingCount = 0;
    const local = this.layers[0]._localHoleMask;
    for (let v = 0; v < this.vertexCount; v++) {
      if (local[v] <= 0.5) remainingCount++;
    }
    return remainingCount / this.vertexCount;
  }

  /** Restores a pristine, uncracked wax shape — the shared crackDamage plus every layer's own hole state. */
  reset() {
    this.plasticOffset.fill(0);
    this.elasticSnapshot.fill(0);
    this.elasticDecay = 0;
    this._elasticHeld = false;
    this.crackDamage.fill(0);
    for (const layer of this.layers) {
      layer.holeMask.fill(0);
      if (layer._localHoleMask !== layer.holeMask) layer._localHoleMask.fill(0);
    }
    this.globalRevealProgress = 0;
    this.hasBrokenOnce = false;
    this._rebuildPositions();
    for (const layer of this.layers) {
      layer.shellGeometry.attributes.crackDamage.needsUpdate = true;
      layer.shellGeometry.attributes.holeMask.needsUpdate = true;
    }
    this.coreGeometry.attributes.crackDamage.needsUpdate = true;
    this.coreGeometry.attributes.holeMask.needsUpdate = true;
  }

  dispose() {
    this.coreGeometry.dispose();
    this.fillingGeometry.dispose();
    for (const layer of this.layers) layer.shellGeometry.dispose();
  }
}
