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

const SHELL_THICKNESS_RATIO = 0.035; // wax coating thickness, as a fraction of thicknessAxis (was 0.07 of radius — same halving as MAX_PLASTIC_DISPLACEMENT_RATIO above)
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

/**
 * Owns two welded, indexed, vertex-corresponding geometries built from the
 * same base shape:
 *  - the CORE (slime/clay/왁뿌볼): sits inset beneath the surface by
 *    shellThickness, carries the actual plastic (permanent, clay) and
 *    elastic (transient, slime and 왁뿌볼 — see _isElastic) displacement, and
 *    is textured with the user's photo/color in wax-material.js's core
 *    material. It also reads crackDamage (shared with the shell's own copy,
 *    see the constructor), but only 왁뿌볼 actually acts on it (blending
 *    toward a slime tint as damage rises) — for clay/slime that read is a
 *    harmless no-op, so "core has no idea cracks exist" still holds for them.
 *  - the SHELL (wax): every frame, rebuilt as the core's position plus a
 *    constant shellThickness along the outward direction (so it can never be
 *    poked through by a large dent or bulge — a thin coating stays exactly
 *    that thin everywhere), collapsing to 0 right where a hole has broken
 *    through. It renders the crack/grout pattern and discards its own
 *    fragments there (see shaders/wax-crack-chunks.js), so what shows through
 *    a hole is the real core mesh — an opaque, depth-correct surface —
 *    rather than a blended texture on the same skin.
 *
 * crackDamage (cosmetic crack growth, 0-1 per vertex) and holeMask (a spot
 * where a chunk has actually broken off and fallen) live on the shell only.
 * A break is triggered per-poke by _checkBreak: normally once crackDamage at
 * the poked spot crosses BREAK_DAMAGE_THRESHOLD (roughly two full-strength
 * pokes there, whether from separate taps or one continuous hold — see
 * poke()), but a wax that has never broken at all needs one single
 * sustained FIRST_BREAK_HOLD_SECONDS-long press before its first break,
 * which is rewarded with a much wider crack burst than usual (the actual
 * hole/fragment size is unchanged) — it still visibly dents and cracks a
 * little the whole time it's building up to that, same as any later press.
 *
 * Both meshes are kept at an identity transform (no rotation/translation/
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
  constructor(geometry, coreMaterial, shellMaterial, fillingMaterial) {
    this.materialMode = 'clay'; // 'clay' | 'slime' | 'waxbbu' (see _isElastic below)
    this.containmentRadiusPerVertex = null;

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
    this.shellThickness = thicknessAxis * SHELL_THICKNESS_RATIO;
    this.fillingInset = thicknessAxis * FILLING_INSET_RATIO;

    const shellGeometry = geometry; // outer silhouette, unchanged from the built shape
    const coreGeometry = geometry.clone(); // deep-copies attributes/index — safe to mutate independently
    const fillingGeometry = geometry.clone(); // a third, further-inset copy — see fillingInset above

    const shellPositionAttr = shellGeometry.attributes.position;
    this.vertexCount = shellPositionAttr.count;
    const shellRestPosition = shellPositionAttr.array;

    // Per-vertex ceiling on shellThickness (set by geometries.js, sampling
    // the silhouette's own local-thickness field directly at each vertex's
    // position — see geometries.js's computeShellClearance) — small at a
    // silhouette's narrow/concave spots (between two ears, an armpit, a thin
    // hair spike, ...), large anywhere wide open, including the whole
    // sphere. Without this, the shell's constant outward offset could push
    // both sides of a narrow neck past each other, leaving a gap right there
    // that exposes the core (and whatever photo/color it's showing) —
    // reported directly as "복잡한 경계면은 왁스가 감싸지지 않고 속 재질이
    // 보이는" (see 2026-08-05/14_Plan.md). Precomputed once here (not
    // re-derived every frame in _rebuildPositions()) since shellClearance
    // itself never changes after the shape is built. No curvature-based
    // gating needed — an earlier version of this only trusted shellClearance
    // near the rim (gating by curvatureSafety) because shellClearance itself
    // was unreliable everywhere else; now that it's measured directly per
    // vertex, it's already correctly large in the deep-interior flat-cap
    // case on its own (see 2026-08-05/17_Plan.md).
    const shellClearance = geometry.userData.shellClearance ?? new Float32Array(this.vertexCount).fill(Infinity);
    this.localShellThickness = new Float32Array(this.vertexCount);
    for (let v = 0; v < this.vertexCount; v++) {
      this.localShellThickness[v] = Math.min(this.shellThickness, shellClearance[v] * SHELL_CLEARANCE_SAFETY_RATIO);
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
    const shellNormalAttr = shellGeometry.attributes.normal;
    this.restNormal = new Float32Array(this.vertexCount * 3);
    if (shellNormalAttr) {
      this.restNormal.set(shellNormalAttr.array);
    } else {
      for (let v = 0; v < this.vertexCount; v++) {
        const i3 = v * 3;
        const x = shellRestPosition[i3];
        const y = shellRestPosition[i3 + 1];
        const z = shellRestPosition[i3 + 2];
        const len = Math.sqrt(x * x + y * y + z * z) || 1;
        this.restNormal[i3] = x / len;
        this.restNormal[i3 + 1] = y / len;
        this.restNormal[i3 + 2] = z / len;
      }
    }

    this.restPosition = new Float32Array(this.vertexCount * 3);
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const t = this.localShellThickness[v];
      this.restPosition[i3] = shellRestPosition[i3] - this.restNormal[i3] * t;
      this.restPosition[i3 + 1] = shellRestPosition[i3 + 1] - this.restNormal[i3 + 1] * t;
      this.restPosition[i3 + 2] = shellRestPosition[i3 + 2] - this.restNormal[i3 + 2] * t;
    }
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
    this.globalRevealProgress = 0;

    // Initial rest pose only — _rebuildPositions() recomputes this live every
    // frame from restPosition/restNormal directly, same as it does for shell.
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

    const crackDamage = new Float32Array(this.vertexCount);
    shellGeometry.setAttribute('crackDamage', new THREE.BufferAttribute(crackDamage, 1));
    // Both crackDamage and holeMask are also exposed on the CORE geometry
    // below, backed by these SAME typed arrays — writes in poke()/
    // _boostFieldAt update both attributes' values for free, but each
    // BufferAttribute still needs its own needsUpdate flip to actually
    // re-upload to the GPU (see update()/reset()). Core only acts on either
    // for "왁뿌볼" mode, which grows its own crack-line/hole network from
    // them (see wax-material.js/wax-crack-chunks.js) — a harmless unused
    // varying for clay/slime.
    coreGeometry.setAttribute('crackDamage', new THREE.BufferAttribute(crackDamage, 1));
    this.crackDamage = crackDamage;

    // this.holeMask is the GPU/gameplay-facing array (rendering discard,
    // _checkBreak's guard, getRemainingWaxRatio) — it's the per-vertex MAX of
    // _localHoleMask (written ONLY by real local breaks, see _boostHoleAt)
    // and the global cell-reveal condition (cellRevealThreshold vs
    // globalRevealProgress, merged in by _applyGlobalReveal every frame).
    // _localHoleMask is kept separate specifically so the global reveal's
    // own progress can be driven by "how much has ACTUALLY broken locally"
    // without it being circular (globally-revealed cells feeding back into
    // how many MORE cells get revealed).
    const holeMask = new Float32Array(this.vertexCount);
    shellGeometry.setAttribute('holeMask', new THREE.BufferAttribute(holeMask, 1));
    coreGeometry.setAttribute('holeMask', new THREE.BufferAttribute(holeMask, 1));
    this.holeMask = holeMask;
    this._localHoleMask = new Float32Array(this.vertexCount);

    this.coreGeometry = coreGeometry;
    this.shellGeometry = shellGeometry;
    this.fillingGeometry = fillingGeometry;

    this.coreMesh = new THREE.Mesh(coreGeometry, coreMaterial);
    this.coreMesh.matrixAutoUpdate = false;
    this.mesh = new THREE.Mesh(shellGeometry, shellMaterial); // shell — kept as `mesh` for pointer-interaction's bounding-sphere lookup
    this.mesh.matrixAutoUpdate = false;
    // Only ever actually seen through a hole the core discards ("왁뿌볼" —
    // see wax-material.js's createFillingMaterial) — for clay/slime, core has
    // no holes of its own, so this permanently sits fully occluded behind it.
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
   * descriptor ({ point, radius }) the moment a chunk actually breaks loose,
   * or null otherwise — the caller uses this to spawn a falling debris piece
   * and play the break sound in sync, even mid-hold.
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
        const next = this.crackDamage[v] + dentWeight * CRACK_RATE_PER_HIT * strength;
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
   * Decides whether this poke just broke a chunk loose. Guarded by holeMask
   * at the nearest vertex first: once the shell there has already fully
   * opened up, there's no wax left to pop, so pressing on the exposed core
   * underneath never spawns more debris (also what stops the very hole that
   * just opened from immediately re-triggering next frame).
   */
  _checkBreak(pointWorld, normal, nearestIndex, holdSeconds) {
    if (this.holeMask[nearestIndex] > 0.5) return null;

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
      this._boostHoleAt(pointWorld, normal, influenceRadius * HOLE_RADIUS_RATIO);
      return { point: pointWorld.clone(), radius: influenceRadius * FRAGMENT_RADIUS_RATIO, isFirstBreak: true };
    }

    if (this.crackDamage[nearestIndex] < BREAK_DAMAGE_THRESHOLD) return null;
    this._boostCrackAt(pointWorld, normal, influenceRadius * HOLE_RADIUS_RATIO * REGULAR_BREAK_CRACK_SPREAD_MULTIPLIER);
    this._boostHoleAt(pointWorld, normal, influenceRadius * HOLE_RADIUS_RATIO);
    return { point: pointWorld.clone(), radius: influenceRadius * FRAGMENT_RADIUS_RATIO, isFirstBreak: false };
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
   */
  _boostFieldAt(field, pointWorld, normal, radius) {
    const rest = this.restPosition;
    const restNormal = this.restNormal;
    const radiusSq = radius * radius;
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const dx = rest[i3] - pointWorld.x;
      const dy = rest[i3 + 1] - pointWorld.y;
      const dz = rest[i3 + 2] - pointWorld.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq >= radiusSq) continue;
      const alignDot = restNormal[i3] * normal.x + restNormal[i3 + 1] * normal.y + restNormal[i3 + 2] * normal.z;
      const alignWeight = THREE.MathUtils.smoothstep(alignDot, NORMAL_ALIGN_GATE_START, NORMAL_ALIGN_GATE_END);
      if (alignWeight <= 0) continue;
      const dist = Math.sqrt(distSq);
      const weight = THREE.MathUtils.smoothstep(radius - dist, 0, radius) * alignWeight;
      field[v] = Math.max(field[v], weight);
    }
    this._dirtyAttributes = true;
  }

  /** Widens the visible crack network around a point without opening an actual hole — used for the first break's dramatic-but-not-empty payoff. */
  _boostCrackAt(pointWorld, normal, radius) {
    this._boostFieldAt(this.crackDamage, pointWorld, normal, radius);
  }

  /** Marks the spot a chunk just fell off of as a clean hole — no crack cosmetics there, and the shader discards it so what's underneath shows through. Writes to _localHoleMask, NOT the GPU-facing holeMask directly — see that field's own doc comment; update()'s _applyGlobalReveal merges the two every frame. */
  _boostHoleAt(pointWorld, normal, radius) {
    this._boostFieldAt(this._localHoleMask, pointWorld, normal, radius);
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
    if (this._dirtyAttributes && this._applyGlobalReveal()) {
      needsPositionRebuild = true;
    }

    if (needsPositionRebuild) {
      this._rebuildPositions();
    }

    if (this._dirtyAttributes) {
      this.shellGeometry.attributes.crackDamage.needsUpdate = true;
      this.shellGeometry.attributes.holeMask.needsUpdate = true;
      this.coreGeometry.attributes.crackDamage.needsUpdate = true;
      this.coreGeometry.attributes.holeMask.needsUpdate = true;
      this._dirtyAttributes = false;
    }

    this._dirtyPosition = false;
    return needsPositionRebuild;
  }

  /**
   * Merges the "왁스가 여기저기 사라지는" global reveal into the real,
   * GPU/gameplay-facing holeMask (see that field's own doc comment) — a
   * vertex becomes gone there the moment EITHER a real local break covers it
   * (_localHoleMask) OR its own fixed cellRevealThreshold is crossed by
   * globalRevealProgress, which is itself driven by getLocalRemainingRatio()
   * — LOCAL-only progress, so revealing more cells here can never feed back
   * into revealing even more (no runaway cascade). Returns true if any
   * vertex's merged value actually changed this call.
   */
  _applyGlobalReveal() {
    this.globalRevealProgress = 1 - this.getLocalRemainingRatio();
    const threshold = this.cellRevealThreshold;
    const local = this._localHoleMask;
    const hole = this.holeMask;
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

  _rebuildPositions() {
    const corePos = this.coreGeometry.attributes.position.array;
    const shellPos = this.shellGeometry.attributes.position.array;
    const fillingPos = this.fillingGeometry.attributes.position.array;
    const rest = this.restPosition;
    const restNormal = this.restNormal;
    const plastic = this.plasticOffset;
    const elastic = this.elasticSnapshot;
    const decay = this.elasticDecay;
    const localShellThickness = this.localShellThickness;
    const fillingInset = this.fillingInset;
    const holeMask = this.holeMask;
    // "왁뿌볼"'s outer skin never opens a hole — see wax-material.js's
    // SHELL_LOOK.waxbbuShell — so unlike clay/slime, its gap shouldn't
    // collapse toward the core wherever the INNER wax underneath has
    // actually broken; it stays a constant, smooth, always-intact thickness
    // regardless of holeMask.
    const holeAffectsGap = this.materialMode !== 'waxbbu';

    // The shell is always defined AS the core's own surface plus a constant
    // outward gap (shrinking to 0 exactly at a hole, except for "왁뿌볼" —
    // see holeAffectsGap above) — never as an independently-blended rest
    // shape. That guarantees the coating can never be poked through by a big
    // dent or bulge, however far the core moves: it's not "how much does the
    // shell follow", it's "the shell IS wherever the core is, plus a thin
    // skin" (that skin's own thickness already narrowed per-vertex at any
    // tight/concave spot — see localShellThickness in the constructor).
    const containmentRadiusPerVertex = this.containmentRadiusPerVertex;
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const gap = holeAffectsGap ? localShellThickness[v] * (1 - holeMask[v]) : localShellThickness[v];

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
      shellPos[i3] = cx + restNormal[i3] * gap;
      shellPos[i3 + 1] = cy + restNormal[i3 + 1] * gap;
      shellPos[i3 + 2] = cz + restNormal[i3 + 2] * gap;
      fillingPos[i3] = cx - restNormal[i3] * fillingInset;
      fillingPos[i3 + 1] = cy - restNormal[i3 + 1] * fillingInset;
      fillingPos[i3 + 2] = cz - restNormal[i3 + 2] * fillingInset;
    }

    this.coreGeometry.attributes.position.needsUpdate = true;
    this.shellGeometry.attributes.position.needsUpdate = true;
    this.fillingGeometry.attributes.position.needsUpdate = true;
    this.coreGeometry.computeVertexNormals();
    this.shellGeometry.computeVertexNormals();
    this.fillingGeometry.computeVertexNormals();
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
   * Reads the MERGED holeMask (local breaks + global cell reveal — see that
   * field's own doc comment), so this now correctly reaches 0% once
   * everything visible is gone even if a lot of it disappeared via the
   * global reveal rather than a real local break — it used to only track
   * local breaks, which left this stuck showing wax "remaining" long after
   * it had visibly all flaked away, and let clicking an already-visually-
   * empty spot still register as a break (see _checkBreak's holeMask guard).
   */
  getRemainingWaxRatio() {
    let remainingCount = 0;
    for (let v = 0; v < this.vertexCount; v++) {
      if (this.holeMask[v] <= 0.5) remainingCount++;
    }
    return remainingCount / this.vertexCount;
  }

  /**
   * Buckets this mesh's own shell into a lat/lon grid (see
   * containmentBinIndex), each cell holding the CURRENT (this frame's,
   * already-dented) shortest distance from the origin among every shell
   * vertex whose LIVE position falls in that cell — used by
   * composite-waxbbu-mesh.js (via buildContainmentFromGrid below) as a
   * per-direction containment boundary for the wax inside it. Reads the
   * LIVE surface, not this.radius (the NOMINAL, undeformed one): while the
   * bubble is actively dented inward at the press point, its real surface
   * there sits well inside its own nominal radius.
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

  /** LOCAL-only remaining ratio — counts only real, click-driven breaks (_localHoleMask), blind to the global reveal. Exists purely to safely DRIVE globalRevealProgress in _applyGlobalReveal without creating a feedback loop with getRemainingWaxRatio's own (merged) result. */
  getLocalRemainingRatio() {
    let remainingCount = 0;
    for (let v = 0; v < this.vertexCount; v++) {
      if (this._localHoleMask[v] <= 0.5) remainingCount++;
    }
    return remainingCount / this.vertexCount;
  }

  /** Restores a pristine, uncracked wax shape. */
  reset() {
    this.plasticOffset.fill(0);
    this.elasticSnapshot.fill(0);
    this.elasticDecay = 0;
    this._elasticHeld = false;
    this.crackDamage.fill(0);
    this.holeMask.fill(0);
    this._localHoleMask.fill(0);
    this.globalRevealProgress = 0;
    this.hasBrokenOnce = false;
    this._rebuildPositions();
    this.shellGeometry.attributes.crackDamage.needsUpdate = true;
    this.shellGeometry.attributes.holeMask.needsUpdate = true;
    this.coreGeometry.attributes.crackDamage.needsUpdate = true;
    this.coreGeometry.attributes.holeMask.needsUpdate = true;
  }

  dispose() {
    this.coreGeometry.dispose();
    this.shellGeometry.dispose();
    this.fillingGeometry.dispose();
  }
}
