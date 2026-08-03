import * as THREE from 'three';

const MAX_PLASTIC_DISPLACEMENT_RATIO = 0.32;
const POKE_DEPTH_RATIO_OF_MAX = 0.72; // poke depth relative to maxDisplacement, kept < 1 so thin shapes don't punch through
const CRACK_RATE_PER_HIT = 0.55;
const ELASTIC_DECAY_LAMBDA = 2.6; // lower = slower, gooier slime spring-back
const BREAK_DAMAGE_THRESHOLD = 0.95; // crackDamage level (post-first-break) at which a chunk actually pops loose — reached by roughly two full-strength pokes at the same spot, continuous hold or separate taps alike
const HOLE_RADIUS_RATIO = 0.7; // how much of the shell opens up per popped chunk. The smoothstep falloff below means the actual visible opening (where the interpolated mask crosses the 0.5 discard threshold) is roughly half of this ratio's radius
const FRAGMENT_RADIUS_RATIO = 0.18; // size of the falling debris shard — deliberately much smaller than HOLE_RADIUS_RATIO, since a huge chunk flying off every hit read as excessive
export const FIRST_BREAK_HOLD_SECONDS = 1.5; // a pristine, never-yet-broken wax needs one sustained press this long before it cracks open at all — like the real first crack of a fresh wax shell
const FIRST_BREAK_CRACK_SPREAD_MULTIPLIER = 2.5; // the payoff for that first sustained press is a dramatically wide crack network radiating outward — the actual hole/fragment stay normal-sized so the wax doesn't look like it vanished over a huge area

const SHELL_THICKNESS_RATIO = 0.07; // wax coating thickness, as a fraction of shape radius

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
 * sustained FIRST_BREAK_HOLD_SECONDS-long press first, rewarded with an
 * oversized first break.
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
    this.influenceRadius = this.radius * 0.5;
    this.maxDisplacement = this.radius * MAX_PLASTIC_DISPLACEMENT_RATIO;
    this.pokeDepth = this.maxDisplacement * POKE_DEPTH_RATIO_OF_MAX;
    this.shellThickness = this.radius * SHELL_THICKNESS_RATIO;

    const shellGeometry = geometry; // outer silhouette, unchanged from the built shape
    const coreGeometry = geometry.clone(); // deep-copies attributes/index — safe to mutate independently

    const shellPositionAttr = shellGeometry.attributes.position;
    this.vertexCount = shellPositionAttr.count;
    const shellRestPosition = shellPositionAttr.array;

    // Direction from the origin to each vertex — exactly the outward surface
    // normal for a sphere centered on the origin, and much simpler/more
    // robust than trusting the mesh's own computed normals (which can be
    // unstable at degenerate triangles on other shapes).
    this.restNormal = new Float32Array(this.vertexCount * 3);
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

    this.restPosition = new Float32Array(this.vertexCount * 3);
    for (let i = 0; i < this.restPosition.length; i++) {
      this.restPosition[i] = shellRestPosition[i] - this.restNormal[i] * this.shellThickness;
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
    this.hasBrokenOnce = false; // a pristine wax needs one sustained 3s press before anything cracks open at all
  }

  setMaterialMode(mode) {
    this.materialMode = mode;
  }

  /**
   * Given a rough direction from the origin (e.g. a bounding-sphere hit),
   * returns the actual rest-position vertex most aligned with it — i.e. the
   * real point on this shape's surface in that direction.
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
    return new THREE.Vector3(rest[i3], rest[i3 + 1], rest[i3 + 2]);
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
    const dentRadius = this.influenceRadius;
    const bulgeRiseStart = dentRadius * BULGE_RISE_START_RATIO;
    const bulgePeak = dentRadius * BULGE_PEAK_RATIO;
    const bulgeOuter = dentRadius * BULGE_OUTER_RATIO;
    const target = this.materialMode === 'slime' ? this.elasticSnapshot : this.plasticOffset;
    const depth = this.pokeDepth * strength;
    const dirX = -normal.x * depth;
    const dirY = -normal.y * depth;
    const dirZ = -normal.z * depth;

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
    let nearestDist = Infinity;

    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const dx = rest[i3] - pointWorld.x;
      const dy = rest[i3 + 1] - pointWorld.y;
      const dz = rest[i3 + 2] - pointWorld.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIndex = v;
      }
      if (dist >= bulgeOuter) continue;

      const dentWeight = dist < dentRadius ? THREE.MathUtils.smoothstep(dentRadius - dist, 0, dentRadius) : 0;

      let bulgeWeight = 0;
      if (dist > bulgeRiseStart) {
        bulgeWeight =
          dist < bulgePeak
            ? THREE.MathUtils.smoothstep(dist, bulgeRiseStart, bulgePeak)
            : 1 - THREE.MathUtils.smoothstep(dist, bulgePeak, bulgeOuter);
      }

      target[i3] += dirX * dentWeight + restNormal[i3] * depth * BULGE_STRENGTH * bulgeWeight;
      target[i3 + 1] += dirY * dentWeight + restNormal[i3 + 1] * depth * BULGE_STRENGTH * bulgeWeight;
      target[i3 + 2] += dirZ * dentWeight + restNormal[i3 + 2] * depth * BULGE_STRENGTH * bulgeWeight;

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

    return this._checkBreak(pointWorld, nearestIndex, holdSeconds);
  }

  /**
   * Decides whether this poke just broke a chunk loose. Guarded by holeMask
   * at the nearest vertex first: once the shell there has already fully
   * opened up, there's no wax left to pop, so pressing on the exposed core
   * underneath never spawns more debris (also what stops the very hole that
   * just opened from immediately re-triggering next frame).
   */
  _checkBreak(pointWorld, nearestIndex, holdSeconds) {
    if (this.holeMask[nearestIndex] > 0.5) return null;

    if (!this.hasBrokenOnce) {
      if (holdSeconds < FIRST_BREAK_HOLD_SECONDS) return null;
      this.hasBrokenOnce = true;
      this.mesh.material.userData.waxUniforms.hasBrokenOnce.value = 1; // un-gates all crack-line visibility in the shell shader
      // The dramatic payoff is a crack network radiating out far wider than
      // an ordinary break — but the actual hole/fragment stay normal-sized,
      // so the wax reads as "it just cracked all over" rather than "a huge
      // chunk of it vanished".
      this._boostCrackAt(pointWorld, this.radius * HOLE_RADIUS_RATIO * FIRST_BREAK_CRACK_SPREAD_MULTIPLIER);
      this._boostHoleAt(pointWorld, this.radius * HOLE_RADIUS_RATIO);
      return { point: pointWorld.clone(), radius: this.radius * FRAGMENT_RADIUS_RATIO, isFirstBreak: true };
    }

    if (this.crackDamage[nearestIndex] < BREAK_DAMAGE_THRESHOLD) return null;
    this._boostHoleAt(pointWorld, this.radius * HOLE_RADIUS_RATIO);
    return { point: pointWorld.clone(), radius: this.radius * FRAGMENT_RADIUS_RATIO, isFirstBreak: false };
  }

  /** Widens the visible crack network around a point without opening an actual hole — used for the first break's dramatic-but-not-empty payoff. */
  _boostCrackAt(pointWorld, radius) {
    const rest = this.restPosition;
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const dx = rest[i3] - pointWorld.x;
      const dy = rest[i3 + 1] - pointWorld.y;
      const dz = rest[i3 + 2] - pointWorld.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist >= radius) continue;
      const weight = THREE.MathUtils.smoothstep(radius - dist, 0, radius);
      this.crackDamage[v] = Math.max(this.crackDamage[v], weight);
    }
    this._dirtyAttributes = true;
  }

  /** Marks the spot a chunk just fell off of as a clean hole in the shell — no crack cosmetics there, and the shell fragment shader discards it so the core shows through. */
  _boostHoleAt(pointWorld, radius) {
    const rest = this.restPosition;
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const dx = rest[i3] - pointWorld.x;
      const dy = rest[i3 + 1] - pointWorld.y;
      const dz = rest[i3 + 2] - pointWorld.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist >= radius) continue;
      const weight = THREE.MathUtils.smoothstep(radius - dist, 0, radius);
      this.holeMask[v] = Math.max(this.holeMask[v], weight);
    }
    this._dirtyAttributes = true;
  }

  _clampPlastic() {
    const plastic = this.plasticOffset;
    const max = this.maxDisplacement;
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const len = Math.sqrt(
        plastic[i3] * plastic[i3] + plastic[i3 + 1] * plastic[i3 + 1] + plastic[i3 + 2] * plastic[i3 + 2],
      );
      if (len > max) {
        const s = max / len;
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
    const thickness = this.shellThickness;
    const holeMask = this.holeMask;

    // The shell is always defined AS the core's own surface plus a constant
    // outward gap (shrinking to 0 exactly at a hole) — never as an
    // independently-blended rest shape. That guarantees the coating can
    // never be poked through by a big dent or bulge, however far the core
    // moves: it's not "how much does the shell follow", it's "the shell IS
    // wherever the core is, plus a thin skin".
    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const gap = thickness * (1 - holeMask[v]);
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

  /** Restores a pristine, uncracked wax shape. */
  reset() {
    this.plasticOffset.fill(0);
    this.elasticSnapshot.fill(0);
    this.elasticDecay = 0;
    this._elasticHeld = false;
    this.crackDamage.fill(0);
    this.holeMask.fill(0);
    this.hasBrokenOnce = false;
    this.mesh.material.userData.waxUniforms.hasBrokenOnce.value = 0;
    this._rebuildPositions();
    this.shellGeometry.attributes.crackDamage.needsUpdate = true;
    this.shellGeometry.attributes.holeMask.needsUpdate = true;
  }

  dispose() {
    this.coreGeometry.dispose();
    this.shellGeometry.dispose();
  }
}
