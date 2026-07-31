import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// PolyhedronGeometry emits non-indexed triangle soup with per-vertex (not
// per-shared-vertex) normals. That looks smooth as-authored, but
// computeVertexNormals() on a non-indexed geometry only ever produces flat
// per-triangle normals (no shared vertex to average into), so any
// post-deformation normal recompute would look faceted unless we weld
// matching vertices into a real indexed mesh first.
function weldAndSmooth(geometry) {
  const welded = mergeVertices(geometry);
  welded.computeVertexNormals();
  return welded;
}

export function buildSphereGeometry(radius = 1) {
  const geometry = new THREE.IcosahedronGeometry(radius, 4);
  return weldAndSmooth(geometry);
}
