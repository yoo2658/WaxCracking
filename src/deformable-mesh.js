import * as THREE from 'three';

const MAX_PLASTIC_DISPLACEMENT_RATIO = 0.32;
const POKE_DEPTH_RATIO_OF_MAX = 0.72; // poke depth relative to maxDisplacement, kept < 1 so thin shapes don't punch through
const CRACK_RATE_PER_HIT = 0.55;
const ELASTIC_DECAY_LAMBDA = 2.6; // lower = slower, gooier slime spring-back
const HOTSPOT_RADIUS_RATIO = 0.4; // clicks within this distance count as "the same spot" — generous enough that ordinary hand/mouse imprecision on a real click still registers as a repeat hit
const HOTSPOT_HIT_THRESHOLD = 2; // hits on the same spot before a chunk actually breaks off and falls. The first hit already shows the core through the thinning, increasingly see-through wax (crackDamage-driven alpha in the shell shader) — this threshold is only for the discrete "a piece physically comes loose" event, kept a little rarer so debris doesn't spawn on every single tap
const HOLE_RADIUS_RATIO = 0.7; // how much of the shell opens up per popped chunk. The smoothstep falloff below means the actual visible opening (where the interpolated mask crosses the 0.5 discard threshold) is roughly half of this ratio's radius
const FRAGMENT_RADIUS_RATIO = 0.18; // size of the falling debris shard — deliberately much smaller than HOLE_RADIUS_RATIO, since a huge chunk flying off every hit read as excessive

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
 *  - the CORE (slime/squishy): sits inset beneath the surface by
 *    shellThickness, carries the actual plastic (permanent, squishy) and
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
 * crackDamage (cosmetic crack growth) and holeMask (a spot where a chunk has
 * actually broken off and fallen) live on the shell only.
 *
 * Both meshes are kept at an identity transform (no rotation/translation/
 * scale) for their whole lifetime, so raycast hit points in world space can
 * be used directly as local/object space — no matrix conversion needed. View
 * rotation is handled separately by OrbitControls in scene.js.
 */
export class DeformableMesh {
  constructor(geometry, coreMaterial, shellMaterial) {
    this.materialMode = 'squishy'; // 'squishy' | 'slime'

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
    this._hotspots = []; // { point: Vector3, count: number } — tracks repeated hits near the same spot
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
   * One-shot poke + crack at a clicked point. normal is the outward surface
   * normal at that point; strength (>=1) scales dent depth, bulge, and crack
   * damage — pointer-interaction.js derives it from how long the click was
   * held. Returns a fragment-pop descriptor ({ point, radius }) once the same
   * spot has been hit enough times, or null otherwise — the caller uses this
   * to spawn a falling debris piece.
   */
  poke(pointWorld, normal, strength = 1) {
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
      const decay = this.elasticDecay;
      if (decay > 0 && decay < 1) {
        for (let i = 0; i < target.length; i++) target[i] *= decay;
      }
      this.elasticDecay = 1;
    }

    for (let v = 0; v < this.vertexCount; v++) {
      const i3 = v * 3;
      const dx = rest[i3] - pointWorld.x;
      const dy = rest[i3 + 1] - pointWorld.y;
      const dz = rest[i3 + 2] - pointWorld.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
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

    return this._registerHotspotHit(pointWorld);
  }

  _registerHotspotHit(pointWorld) {
    const hotspotRadius = this.radius * HOTSPOT_RADIUS_RATIO;
    let spot = null;
    for (const candidate of this._hotspots) {
      if (candidate.point.distanceTo(pointWorld) < hotspotRadius) {
        spot = candidate;
        break;
      }
    }
    if (!spot) {
      spot = { point: pointWorld.clone(), count: 0 };
      this._hotspots.push(spot);
    }
    spot.count += 1;

    if (spot.count < HOTSPOT_HIT_THRESHOLD) return null;

    spot.count = 0; // let repeated clicking pop additional chunks from the same worn spot
    this._boostHoleAt(pointWorld);
    return { point: pointWorld.clone(), radius: this.radius * FRAGMENT_RADIUS_RATIO };
  }

  /** Marks the spot a chunk just fell off of as a clean hole in the shell — no crack cosmetics there, and the shell fragment shader discards it so the core shows through. */
  _boostHoleAt(pointWorld) {
    const rest = this.restPosition;
    const radius = this.radius * HOLE_RADIUS_RATIO;
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

    if (this.elasticDecay > 0) {
      this.elasticDecay = THREE.MathUtils.damp(this.elasticDecay, 0, ELASTIC_DECAY_LAMBDA, dt);
      if (this.elasticDecay < 0.002) this.elasticDecay = 0;
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
    this.crackDamage.fill(0);
    this.holeMask.fill(0);
    this._hotspots = [];
    this._rebuildPositions();
    this.shellGeometry.attributes.crackDamage.needsUpdate = true;
    this.shellGeometry.attributes.holeMask.needsUpdate = true;
  }

  dispose() {
    this.coreGeometry.dispose();
    this.shellGeometry.dispose();
  }
}
