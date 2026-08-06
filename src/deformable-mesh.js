import * as THREE from 'three';

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
const ELASTIC_DECAY_LAMBDA = 2.6; // lower = slower, gooier slime spring-back
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

// How much of a silhouette's local clearance (see geometries.js's
// computeShellClearance) the wax shell is allowed to actually use as
// thickness there. Well below 1 so even the narrowest spot the shell
// reaches into still leaves a visible gap between its two sides, instead of
// letting them just barely touch (which read as flickery, not solid).
const SHELL_CLEARANCE_SAFETY_RATIO = 0.6;

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
 *  - the CORE (slime/clay): sits inset beneath the surface by
 *    shellThickness, carries the actual plastic (permanent, clay) and
 *    elastic (transient, slime) displacement, and is textured with the
 *    user's photo/color in wax-material.js's core material. It has no idea
 *    cracks exist.
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
  constructor(geometry, coreMaterial, shellMaterial) {
    this.materialMode = 'clay'; // 'clay' | 'slime'

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

    const shellGeometry = geometry; // outer silhouette, unchanged from the built shape
    const coreGeometry = geometry.clone(); // deep-copies attributes/index — safe to mutate independently

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

    this.plasticOffset = new Float32Array(this.vertexCount * 3);
    this.elasticSnapshot = new Float32Array(this.vertexCount * 3);
    this.elasticDecay = 0;
    this._elasticHeld = false;

    const crackDamage = new Float32Array(this.vertexCount);
    shellGeometry.setAttribute('crackDamage', new THREE.BufferAttribute(crackDamage, 1));
    this.crackDamage = crackDamage;

    const holeMask = new Float32Array(this.vertexCount);
    shellGeometry.setAttribute('holeMask', new THREE.BufferAttribute(holeMask, 1));
    this.holeMask = holeMask;

    this.coreGeometry = coreGeometry;
    this.shellGeometry = shellGeometry;

    this.coreMesh = new THREE.Mesh(coreGeometry, coreMaterial);
    this.coreMesh.matrixAutoUpdate = false;
    this.mesh = new THREE.Mesh(shellGeometry, shellMaterial); // shell — kept as `mesh` for pointer-interaction's bounding-sphere lookup
    this.mesh.matrixAutoUpdate = false;

    this._dirtyPosition = false;
    this._dirtyAttributes = false;
    this.hasBrokenOnce = false; // a pristine wax needs one sustained FIRST_BREAK_HOLD_SECONDS press before its first dramatic break (see FIRST_BREAK_HOLD_SECONDS above)
  }

  setMaterialMode(mode) {
    this.materialMode = mode;
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

  /** Same blend as _influenceRadiusFor, for the permanent-displacement limit — shared by poke() and _clampPlastic(). */
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
    const target = this.materialMode === 'slime' ? this.elasticSnapshot : this.plasticOffset;
    const pushX = -normal.x;
    const pushY = -normal.y;
    const pushZ = -normal.z;

    if (this.materialMode === 'slime') {
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

    if (this.materialMode !== 'slime') {
      this._clampPlastic();
    }

    this._dirtyPosition = true;
    this._dirtyAttributes = true;

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

  /** Marks the spot a chunk just fell off of as a clean hole in the shell — no crack cosmetics there, and the shell fragment shader discards it so the core shows through. */
  _boostHoleAt(pointWorld, normal, radius) {
    this._boostFieldAt(this.holeMask, pointWorld, normal, radius);
  }

  /** Clamps each vertex's permanent (clay) displacement to ITS OWN safe limit — a single shape-wide clamp would either let a rim vertex fold (if set to the generous flat limit) or needlessly flatten a legitimately deep flat-cap dent (if set to the tight rim limit) just because some OTHER vertex elsewhere happens to be poked next. */
  _clampPlastic() {
    const plastic = this.plasticOffset;
    const curvatureSafety = this.curvatureSafety;
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const max = this._maxDisplacementFor(curvatureSafety[v]);
      const lenSq = plastic[i3] * plastic[i3] + plastic[i3 + 1] * plastic[i3 + 1] + plastic[i3 + 2] * plastic[i3 + 2];
      if (lenSq > max * max) {
        // sqrt deferred until here — the overwhelming majority of vertices
        // at any given moment are well under their own limit and never
        // reach this branch, so most of the loop is just the cheap lenSq
        // compare above.
        const s = max / Math.sqrt(lenSq);
        plastic[i3] *= s;
        plastic[i3 + 1] *= s;
        plastic[i3 + 2] *= s;
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
      this.elasticDecay = THREE.MathUtils.damp(this.elasticDecay, 0, ELASTIC_DECAY_LAMBDA, dt);
      if (this.elasticDecay < 0.002) {
        this.elasticDecay = 0;
        this.elasticSnapshot.fill(0); // clear stale raw offsets so the next press starts clean, not with an instant pop back to old history
      }
      needsPositionRebuild = true;
    }

    if (needsPositionRebuild) {
      this._rebuildPositions();
    }

    if (this._dirtyAttributes) {
      this.shellGeometry.attributes.crackDamage.needsUpdate = true;
      this.shellGeometry.attributes.holeMask.needsUpdate = true;
      this._dirtyAttributes = false;
    }

    this._dirtyPosition = false;
    return needsPositionRebuild;
  }

  _rebuildPositions() {
    const corePos = this.coreGeometry.attributes.position.array;
    const shellPos = this.shellGeometry.attributes.position.array;
    const rest = this.restPosition;
    const restNormal = this.restNormal;
    const plastic = this.plasticOffset;
    const elastic = this.elasticSnapshot;
    const decay = this.elasticDecay;
    const localShellThickness = this.localShellThickness;
    const holeMask = this.holeMask;

    // The shell is always defined AS the core's own surface plus a constant
    // outward gap (shrinking to 0 exactly at a hole) — never as an
    // independently-blended rest shape. That guarantees the coating can
    // never be poked through by a big dent or bulge, however far the core
    // moves: it's not "how much does the shell follow", it's "the shell IS
    // wherever the core is, plus a thin skin" (that skin's own thickness
    // already narrowed per-vertex at any tight/concave spot — see
    // localShellThickness in the constructor).
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const gap = localShellThickness[v] * (1 - holeMask[v]);
      for (let k = 0; k < 3; k++) {
        const idx = i3 + k;
        const corePosition = rest[idx] + plastic[idx] + elastic[idx] * decay;
        corePos[idx] = corePosition;
        shellPos[idx] = corePosition + restNormal[idx] * gap;
      }
    }

    this.coreGeometry.attributes.position.needsUpdate = true;
    this.shellGeometry.attributes.position.needsUpdate = true;
    this.coreGeometry.computeVertexNormals();
    this.shellGeometry.computeVertexNormals();
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
   */
  getRemainingWaxRatio() {
    let remainingCount = 0;
    for (let v = 0; v < this.vertexCount; v++) {
      if (this.holeMask[v] <= 0.5) remainingCount++;
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
    this.hasBrokenOnce = false;
    this._rebuildPositions();
    this.shellGeometry.attributes.crackDamage.needsUpdate = true;
    this.shellGeometry.attributes.holeMask.needsUpdate = true;
  }

  dispose() {
    this.coreGeometry.dispose();
    this.shellGeometry.dispose();
  }
}
