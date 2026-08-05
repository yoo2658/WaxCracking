import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { localThicknessAt } from './silhouette.js';

// PolyhedronGeometry emits non-indexed triangle soup with per-vertex (not
// per-shared-vertex) normals. That looks smooth as-authored, but
// computeVertexNormals() on a non-indexed geometry only ever produces flat
// per-triangle normals (no shared vertex to average into), so any
// post-deformation normal recompute would look faceted unless we weld
// matching vertices into a real indexed mesh first.
//
// mergeVertices() only merges vertices whose ENTIRE attribute set matches —
// position AND normal AND uv, if present. That's harmless for a smoothly
// curved, single-surface shape like the sphere (neighboring triangles
// already carry near-identical normals), but on THREE.ExtrudeGeometry's
// beveled sides — built as IMAGE_BEVEL_SEGMENTS discrete rings, each with
// its own per-facet normal — it means nothing actually welds across a
// ring-to-ring or cap-to-bevel boundary even though those vertices sit at
// the exact same position. Confirmed empirically (2026-08-05/06_Check.md):
// every single vertex in a test shape belonged to one of these "same spot,
// different normal" unwelded groups. Since poke() displaces each vertex
// along its OWN normal, these coincident-but-disconnected copies get pulled
// apart the moment anything nearby is pressed — the mesh visibly tears open
// right at that seam. Dropping normal/uv before merging forces a true
// position-only weld instead; uv isn't used anywhere in this project
// (photo/color mapping is a front projection by object position, not by UV
// — see wax-crack-chunks.js), so nothing else depends on it.
function weldAndSmooth(geometry) {
  geometry.deleteAttribute('normal');
  geometry.deleteAttribute('uv');
  const welded = mergeVertices(geometry);
  welded.computeVertexNormals();
  return welded;
}

// deformable-mesh.js needs to tell "how wide this shape is" (radius, used for
// dent footprint, texture projection scale, etc.) apart from "how thick it
// actually is front-to-back" (localDepth, used for anything that must never
// let one face's press reach the opposite face — see 2026-08-05/02_Plan.md).
// For a sphere those two happen to be the same thing (diameter), which is
// exactly why a sphere-only codebase never had to distinguish them.
export function buildSphereGeometry(radius = 1) {
  const geometry = weldAndSmooth(new THREE.IcosahedronGeometry(radius, 4));
  geometry.userData.localDepth = radius * 2;
  // See buildImageGeometry's minFeatureRadius below — a sphere's curvature is
  // uniform everywhere, so its own radius already IS that "tightest local
  // bend" scale, and using it here is a no-op (the sphere-derived cap this
  // produces in deformable-mesh.js always ends up looser than the existing
  // radius/thickness-based ones).
  geometry.userData.minFeatureRadius = radius;
  // Every point on a sphere is equally "safe" (uniform curvature) — see
  // computeCurvatureSafety below for what this means on a custom shape.
  geometry.userData.curvatureSafety = new Float32Array(geometry.attributes.position.count).fill(1);
  // See buildImageGeometry's imageFrameHalfExtent below — a sphere has no
  // photo frame of its own to match, so this is just the existing
  // radius-based projection, unchanged from before that fix.
  geometry.userData.imageFrameHalfExtent = { x: radius, y: radius };
  // See buildImageGeometry's computeShellClearance below — a sphere has no
  // narrow/concave silhouette spots (it's convex everywhere), so there's no
  // limit to apply; Infinity means "always use the nominal shellThickness".
  geometry.userData.shellClearance = new Float32Array(geometry.attributes.position.count).fill(Infinity);
  return geometry;
}

/** Farthest distance from the point cloud's own centroid — just a scale estimate for sizing the extrude depth/bevel below; the shape ends up re-centered on its REAL bounding box further down regardless of where these points happen to sit, so only the radius (not the centroid itself) is needed here. */
function boundingRadiusOf(points) {
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;

  let radius = 0;
  for (const p of points) {
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d > radius) radius = d;
  }
  return radius || 1;
}

// How much of the extrude's own depth each bevel eats into. 0.5 is the safe
// maximum for THREE.ExtrudeGeometry (the two bevels — front and back — meet
// exactly at the mid-plane without overlapping past each other), and also
// the roundest option: the cross-section becomes an almost-fully-curved
// "pillow"/lens shape with no flat vertical rim left, which is the "코롯토"/
// iClay silhouette look this shape is going for (see 02_Plan.md).
const IMAGE_BEVEL_THICKNESS_RATIO = 0.5;
const IMAGE_BEVEL_SIZE_RATIO = 0.4; // outward XY flare of the bevel, relative to the extrude's own depth
const IMAGE_BEVEL_SEGMENTS = 8;
// Total front-to-back thickness as a fraction of the traced silhouette's own
// bounding radius — a starting value, expected to be tuned visually once
// this is actually on screen (see 02_Plan.md's "시작값" note).
const IMAGE_CORE_DEPTH_RATIO = 0.34;

// How far the flat front/back caps get pushed outward at their most domed
// point, as a fraction of coreDepth — a subtle "puffy cushion" lift rather
// than a real hemisphere. Requested after the original perfectly-flat caps
// both looked too flat and seemed to poke-respond worse than the curved rim
// (every vertex in a truly flat cap shares the exact same normal, so a poke
// there reads as a uniform, low-contrast dent instead of an obviously
// deformed silhouette).
const CAP_DOME_RATIO = 0.18;
// Only vertices whose normal is within ~25° of pointing straight along the
// cap's own axis (|normal.z| above this) get any dome push — this is what
// keeps the dome fading out to exactly 0 right where the surface starts
// curving into the bevel, so it blends in rather than adding a new crease.
const CAP_FLATNESS_MIN_NORMAL_Z = 0.9;

/**
 * Pushes each flat cap's vertices outward along their own (already-computed)
 * normal, tapering by two independent falloffs so the bump reads as a dome
 * rather than a uniformly raised plateau: how close the vertex's normal is
 * to dead-on flat (near the bevel, normals start tilting away from that,
 * fading the bump to 0 — see CAP_FLATNESS_MIN_NORMAL_Z), and how far the
 * vertex sits from the shape's own central axis in XY (peaking at the axis,
 * fading toward the silhouette's own edge). Both signals come from the
 * vertex's own data (no need to know the exact cap/bevel z-boundaries),
 * so this works the same regardless of a silhouette's shape.
 */
function domeFlatCaps(geometry, rawRadius, maxBumpHeight) {
  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;

  for (let v = 0; v < pos.count; v++) {
    const nx = nrm.getX(v);
    const ny = nrm.getY(v);
    const nz = nrm.getZ(v);
    const flatness = THREE.MathUtils.smoothstep(Math.abs(nz), CAP_FLATNESS_MIN_NORMAL_Z, 1.0);
    if (flatness <= 0) continue;

    const x = pos.getX(v);
    const y = pos.getY(v);
    const distFromAxis = Math.hypot(x, y);
    const radialFactor = 1 - THREE.MathUtils.smoothstep(distFromAxis, 0, rawRadius);

    const bump = maxBumpHeight * flatness * radialFactor;
    if (bump === 0) continue;
    pos.setXYZ(v, x + nx * bump, y + ny * bump, pos.getZ(v) + nz * bump);
  }

  pos.needsUpdate = true;
  geometry.computeVertexNormals(); // topology (indices/sharing) is unchanged — only positions moved — so this alone is enough, no re-merge needed
}

/**
 * Per-vertex "how safe is it to displace this point by a lot" — 1 on the
 * flat caps (including their now-slightly-domed interior — still far from
 * any tight bend), fading toward 0 right where the surface starts curving
 * into the beveled rim. deformable-mesh.js blends its generous (flat-safe)
 * and tight (rim-safe) poke limits by this value *per vertex actually
 * affected*, instead of clamping the whole shape down to the rim's tight
 * limit — a global clamp was simple but made every press on the flat face
 * feel weak, not just presses actually near the rim (reported directly:
 * "테두리는 조금씩만 부서지는데 평평한 부분은 잘 안 부서진다" — see
 * 2026-08-05/08_Check.md). Reuses the exact same normal-flatness signal as
 * domeFlatCaps, just kept around per-vertex instead of only used inline.
 */
function computeCurvatureSafety(geometry) {
  const nrm = geometry.attributes.normal;
  const safety = new Float32Array(nrm.count);
  for (let v = 0; v < nrm.count; v++) {
    safety[v] = THREE.MathUtils.smoothstep(Math.abs(nrm.getZ(v)), CAP_FLATNESS_MIN_NORMAL_Z, 1.0);
  }
  return safety;
}

/**
 * Samples the silhouette's own local-thickness field (see silhouette.js's
 * localThicknessAt) directly at each final 3D vertex's own (x, y) — mapped
 * back to mask-grid coordinates by inverting the translate+scale this
 * function already applied to the rest of the geometry. Deliberately NOT
 * "find the nearest traced boundary point and borrow ITS value": that
 * indirection was tried first and got the wrong answer in both directions —
 * a thin spike (hair, say) sitting right next to a wide-open area could
 * have its own nearest boundary point be on that wide area, borrowing a
 * clearance value that has nothing to do with the spike's own tightness;
 * conversely a wide-open interior cap vertex could end up nearest to some
 * distant narrow-neck boundary point and incorrectly borrow ITS small value
 * (reported directly as stripes of wrongly-thin shell cutting across an
 * otherwise open face). Querying each vertex's own position directly
 * sidesteps both failure modes at once — see 2026-08-05/17_Plan.md.
 */
function computeShellClearance(geometry, distanceField, center, scale) {
  const pos = geometry.attributes.position;
  const half = distanceField.size / 2;
  const result = new Float32Array(pos.count);
  for (let v = 0; v < pos.count; v++) {
    // Inverse of geometry.translate(-center) then geometry.scale(scale) —
    // then inverse of silhouette.js's own "center on mask, flip y" step.
    const orientedX = pos.getX(v) / scale + center.x;
    const orientedY = pos.getY(v) / scale + center.y;
    const gridX = orientedX + half;
    const gridY = half - orientedY;
    result[v] = localThicknessAt(distanceField, gridX, gridY) * scale;
  }
  return result;
}

/**
 * Builds the "코롯토형" custom shape from a silhouette.js-traced, already
 * rounded outline (`silhouette.points` — {x, y} in arbitrary, roughly
 * origin-centered units, plus `silhouette.imageHalfExtent`, the source
 * photo's own half-width/half-height in those same units — see
 * silhouette.js). Flat front/back caps, pillow-style bevel on the rim (see
 * IMAGE_BEVEL_* above), rescaled at the end so this shape's own bounding-
 * sphere radius matches `radius` — the same value a sphere would use — so
 * every radius-relative constant in deformable-mesh.js keeps behaving
 * consistently no matter which shape is active.
 */
export function buildImageGeometry(silhouette, radius = 1) {
  const { points, imageHalfExtent, distanceField } = silhouette;
  const rawRadius = boundingRadiusOf(points);
  const shape = new THREE.Shape(points.map((p) => new THREE.Vector2(p.x, p.y)));

  const coreDepth = rawRadius * IMAGE_CORE_DEPTH_RATIO;
  const bevelThickness = coreDepth * IMAGE_BEVEL_THICKNESS_RATIO;
  const bevelSize = coreDepth * IMAGE_BEVEL_SIZE_RATIO;

  let geometry = new THREE.ExtrudeGeometry(shape, {
    depth: coreDepth,
    bevelEnabled: true,
    bevelThickness,
    bevelSize,
    bevelSegments: IMAGE_BEVEL_SEGMENTS,
    curveSegments: 1, // the shape is already an all-straight-segment polygon (silhouette.js did the curve smoothing) — no extra tessellation needed
  });

  geometry = weldAndSmooth(geometry);

  // Re-center on the geometry's REAL bounding box rather than trusting the
  // shape's nominal (cx, cy) — the bevel's outward flare can shift the true
  // center slightly, and this project's whole deformation model (poke
  // distances, restNormal-as-origin-direction fallback, raycast direction
  // matching) assumes the shape is centered at the origin.
  geometry.computeBoundingBox();
  const center = new THREE.Vector3();
  geometry.boundingBox.getCenter(center);
  geometry.translate(-center.x, -center.y, -center.z);

  domeFlatCaps(geometry, rawRadius, coreDepth * CAP_DOME_RATIO);

  // Rescale (measuring the ACTUAL built geometry rather than predicting
  // THREE.ExtrudeGeometry's bevel math by hand) so this shape's own
  // bounding-sphere radius equals `radius`, same as buildSphereGeometry.
  geometry.computeBoundingSphere();
  const scale = radius / (geometry.boundingSphere.radius || 1);
  geometry.scale(scale, scale, scale);

  geometry.computeBoundingBox();
  geometry.userData.localDepth = geometry.boundingBox.max.z - geometry.boundingBox.min.z;

  // The tightest local bend anywhere on this shape — the rounded bevel rim,
  // whose radius of curvature is on the order of its own thickness/outward
  // flare (min of the two, being conservative). deformable-mesh.js also
  // clamps a poke's footprint and depth by this value: a poke that's fine on
  // the flat front/back cap can still fold the mesh right at this tightly
  // curved rim if it's allowed to displace vertices by more than the rim's
  // own bend radius can absorb — see 2026-08-05's follow-up fix.
  geometry.userData.minFeatureRadius = Math.min(bevelThickness, bevelSize) * scale;
  geometry.userData.curvatureSafety = computeCurvatureSafety(geometry);

  // The photo's own half-width/half-height, converted through the SAME
  // uniform `scale` used to normalize the shape's geometry, so the two stay
  // in the same units. Used to size the front-projected texture to the
  // photo's true scale instead of the silhouette's own (usually smaller,
  // and differently-proportioned) bounding radius — see silhouette.js's
  // imageHalfExtent doc comment and 2026-08-05/11_Plan.md.
  geometry.userData.imageFrameHalfExtent = {
    x: imageHalfExtent.x * scale,
    y: imageHalfExtent.y * scale,
  };

  // Per-vertex ceiling on how far the wax shell can offset outward here
  // before it would overlap itself across a narrow/concave silhouette spot
  // (see computeShellClearance above and 2026-08-05/14_Plan.md, 17_Plan.md).
  geometry.userData.shellClearance = computeShellClearance(geometry, distanceField, center, scale);

  return geometry;
}
