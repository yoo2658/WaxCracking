import * as THREE from 'three';

// Traces a rounded, clay-like silhouette out of a PNG's alpha channel. Used
// only when a photo turns out to have a transparent background (see
// hasTransparentBackground) — texture-loader.js calls extractSilhouette and
// returns null when there's nothing usable to trace, which main.js treats as
// "keep/revert to the plain sphere".
//
// Pipeline (see 2026-08-05/02_Plan.md for the reasoning): rasterize alpha at
// a small working resolution -> binarize -> blur + re-threshold (this is the
// actual "make it round like clay, not a pixel-sharp cutout" step — a
// symmetric morphological rounding of both convex and concave corners) ->
// fill any fully-enclosed transparent holes solid -> keep only the largest
// opaque blob -> trace its boundary -> simplify -> spline-smooth into a
// final closed polygon. geometries.js turns that polygon into the actual 3D
// "코롯토" shape.

const MASK_SIZE = 128;
const ALPHA_THRESHOLD = 128;
const TRANSPARENT_ALPHA_CUTOFF = 200;
const TRANSPARENT_RATIO_THRESHOLD = 0.01; // >1% of the drawn image reading as transparent-ish => treat as "has a transparent background"
const ROUND_BLUR_RADIUS_RATIO = 0.05; // as a fraction of MASK_SIZE — the roundness knob; a starting value, tune visually
const SIMPLIFY_EPSILON = 1.2; // in mask-grid units
const SIMPLIFY_MAX_POINTS = 90;
const SPLINE_SAMPLE_COUNT = 128;
const LOCAL_THICKNESS_SEARCH_RADIUS_RATIO = 0.45; // as a fraction of MASK_SIZE — bounds the search in sampleLocalThickness below. Needs to be at least as large as the widest plausible open area's own radius, or a query point deep inside that open area won't find its own disk within range and reads as narrower than it really is (confirmed empirically at 0.25 — most of an ordinary round head came back "reduced"); the disk-covering check itself still correctly filters out anything that isn't actually local, so a generous radius here is safe, just a bit more one-time search cost.

/** Draws `image` into a MASK_SIZE×MASK_SIZE canvas, letterboxed to preserve aspect ratio, and returns its alpha channel plus the drawn rect (needed to tell real transparency apart from the letterbox bars). */
function rasterizeAlpha(image) {
  const canvas = document.createElement('canvas');
  canvas.width = MASK_SIZE;
  canvas.height = MASK_SIZE;
  const ctx = canvas.getContext('2d');

  const scale = Math.min(MASK_SIZE / image.width, MASK_SIZE / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const offsetX = (MASK_SIZE - drawWidth) / 2;
  const offsetY = (MASK_SIZE - drawHeight) / 2;
  ctx.clearRect(0, 0, MASK_SIZE, MASK_SIZE);
  ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);

  const { data } = ctx.getImageData(0, 0, MASK_SIZE, MASK_SIZE);
  const alpha = new Uint8ClampedArray(MASK_SIZE * MASK_SIZE);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
  return { alpha, offsetX, offsetY, drawWidth, drawHeight };
}

/**
 * Only samples inside the actually-drawn rect — a wide/tall image's
 * letterbox bars are legitimately transparent but shouldn't make an
 * ordinary opaque JPEG register as "has a transparent background". Rounds
 * INWARD (not outward like a first version of this did) plus a 1px margin:
 * drawWidth/drawHeight are almost never exact integers (any photo whose
 * aspect ratio doesn't divide MASK_SIZE evenly — i.e. most photos), and
 * ctx.drawImage() then leaves a thin, partially-antialiased edge row/column
 * that can read as partly transparent even for a fully opaque JPEG.
 * Confirmed directly: a 519×255 test JPEG (an ordinary opaque screenshot)
 * had alpha drop to 0 in a ~3%-of-drawn-area edge strip purely from this
 * rounding, tripping the 1% threshold below and wrongly building a custom
 * shape out of a plain opaque photo. Rounding inward keeps the checked rect
 * entirely within the confidently fully-painted interior.
 */
function hasTransparentBackground({ alpha, offsetX, offsetY, drawWidth, drawHeight }) {
  const margin = 1;
  const x0 = Math.max(0, Math.ceil(offsetX) + margin);
  const x1 = Math.min(MASK_SIZE, Math.floor(offsetX + drawWidth) - margin);
  const y0 = Math.max(0, Math.ceil(offsetY) + margin);
  const y1 = Math.min(MASK_SIZE, Math.floor(offsetY + drawHeight) - margin);

  let transparentish = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      total++;
      if (alpha[y * MASK_SIZE + x] < TRANSPARENT_ALPHA_CUTOFF) transparentish++;
    }
  }
  return total > 0 && transparentish / total > TRANSPARENT_RATIO_THRESHOLD;
}

function binarize(alpha) {
  const mask = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) mask[i] = alpha[i] >= ALPHA_THRESHOLD ? 1 : 0;
  return mask;
}

/** Box-blurs the 0/1 mask then re-thresholds at 0.5. A blur+re-threshold rounds convex corners (like a dilate) and concave corners (like an erode) symmetrically — the simplest robust way to turn a pixel-sharp cutout into a soft, clay-like outline without a real morphological/polygon-offset library. */
function roundMask(mask, size) {
  const radius = Math.max(1, Math.round(size * ROUND_BLUR_RADIUS_RATIO));
  const blurred = new Float32Array(mask.length);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= size) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = x + dx;
          if (sx < 0 || sx >= size) continue;
          sum += mask[sy * size + sx];
          count++;
        }
      }
      blurred[y * size + x] = sum / count;
    }
  }

  const rounded = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) rounded[i] = blurred[i] >= 0.5 ? 1 : 0;
  return rounded;
}

/** 4-connected flood fill from every seed cell where `predicate` holds, marking visited cells in-place. */
function floodFillFrom(seeds, predicate, size, visited) {
  const stack = [];
  for (const idx of seeds) {
    if (visited[idx]) continue;
    visited[idx] = 1;
    stack.push(idx);
  }
  while (stack.length) {
    const idx = stack.pop();
    const x = idx % size;
    const y = (idx - x) / size;
    const neighbors = [x > 0 ? idx - 1 : -1, x < size - 1 ? idx + 1 : -1, y > 0 ? idx - size : -1, y < size - 1 ? idx + size : -1];
    for (const n of neighbors) {
      if (n < 0 || visited[n] || !predicate(n)) continue;
      visited[n] = 1;
      stack.push(n);
    }
  }
}

/** Background pixels reachable from the mask's border are the real background; anything transparent but NOT reachable (donut holes, the inside of a letter "O", ...) is an enclosed hole — filled solid per the user's confirmed "채워서 통짜" choice. */
function fillEnclosedHoles(mask, size) {
  const isBackground = (i) => mask[i] === 0;
  const seeds = [];
  for (let x = 0; x < size; x++) {
    seeds.push(x, (size - 1) * size + x);
  }
  for (let y = 0; y < size; y++) {
    seeds.push(y * size, y * size + size - 1);
  }

  const reachable = new Uint8Array(mask.length);
  floodFillFrom(seeds.filter(isBackground), isBackground, size, reachable);

  const filled = mask.slice();
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0 && !reachable[i]) filled[i] = 1;
  }
  return filled;
}

/** Keeps only the largest connected opaque blob — stray noise/specks elsewhere in the mask are dropped. */
function keepLargestComponent(mask, size) {
  const isForeground = (i) => mask[i] === 1;
  const globallyVisited = new Uint8Array(mask.length);
  let best = null;
  let bestCount = 0;

  for (let i = 0; i < mask.length; i++) {
    if (!isForeground(i) || globallyVisited[i]) continue;
    const component = new Uint8Array(mask.length);
    floodFillFrom([i], isForeground, size, component);
    let count = 0;
    for (let j = 0; j < component.length; j++) {
      if (component[j]) {
        globallyVisited[j] = 1;
        count++;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      best = component;
    }
  }

  return best ?? new Uint8Array(mask.length);
}

/**
 * Two-pass chamfer distance transform: for every foreground (mask=1) pixel,
 * an approximate straight-line distance (in mask-grid units) to the nearest
 * background (mask=0) pixel — 0 at the boundary, growing toward the middle
 * of any wide-open area, staying small all the way through a narrow neck
 * (since both sides of a neck are close to background). Background pixels
 * are fixed at 0. Classic two-pass propagation (forward pass sweeps
 * top-left→bottom-right pulling from already-visited N/W/NW/NE neighbors,
 * backward pass sweeps the opposite direction pulling from S/E/SE/SW) —
 * an approximation, not exact Euclidean distance, but accurate enough to
 * tell "wide open" apart from "narrow neck" (see 2026-08-05/14_Plan.md).
 */
function distanceTransform(mask, size) {
  const INF = 1e6;
  const dist = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) dist[i] = mask[i] === 1 ? INF : 0;

  const ORTHOGONAL = 1;
  const DIAGONAL = Math.SQRT2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (mask[i] === 0) continue;
      let best = dist[i];
      if (x > 0) best = Math.min(best, dist[i - 1] + ORTHOGONAL);
      if (y > 0) {
        best = Math.min(best, dist[i - size] + ORTHOGONAL);
        if (x > 0) best = Math.min(best, dist[i - size - 1] + DIAGONAL);
        if (x < size - 1) best = Math.min(best, dist[i - size + 1] + DIAGONAL);
      }
      dist[i] = best;
    }
  }

  for (let y = size - 1; y >= 0; y--) {
    for (let x = size - 1; x >= 0; x--) {
      const i = y * size + x;
      if (mask[i] === 0) continue;
      let best = dist[i];
      if (x < size - 1) best = Math.min(best, dist[i + 1] + ORTHOGONAL);
      if (y < size - 1) {
        best = Math.min(best, dist[i + size] + ORTHOGONAL);
        if (x < size - 1) best = Math.min(best, dist[i + size + 1] + DIAGONAL);
        if (x > 0) best = Math.min(best, dist[i + size - 1] + DIAGONAL);
      }
      dist[i] = best;
    }
  }

  return dist;
}

/**
 * The correct notion of "local thickness at (px, py)" from a distance
 * transform: the largest DT(q), over every point q whose OWN disk (radius
 * DT(q), guaranteed by definition to lie entirely inside the shape) actually
 * reaches (px, py) — i.e. dist((px,py), q) <= DT(q), not merely "q is
 * somewhere within a fixed search window". That distinction matters a lot
 * in practice: a first version of this used "max DT value within a fixed
 * radius" instead, which on a thin spike (a strand of hair, say) sitting
 * right next to a wide-open area (the head it's attached to) picked up the
 * head's own large DT value even though the head's own "disk" never
 * actually reaches out into the thin spike — reported directly (a photo's
 * fine spiky details read as fully open/wide, so the wax shell there was
 * never actually narrowed and self-overlapped exactly like before this
 * whole fix existed). The disk-covering check fixes that: a wide-open q
 * only "counts" for a point p if q's own disk is provably large enough to
 * have already swept over p, which a spike sitting outside that disk's
 * true reach can never satisfy — see 2026-08-05/17_Plan.md.
 */
function sampleLocalThickness(distField, size, px, py, searchRadius) {
  let best = 0;
  const x0 = Math.max(0, Math.floor(px - searchRadius));
  const x1 = Math.min(size - 1, Math.ceil(px + searchRadius));
  const y0 = Math.max(0, Math.floor(py - searchRadius));
  const y1 = Math.min(size - 1, Math.ceil(py + searchRadius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dq = distField[y * size + x];
      if (dq <= best) continue; // can't possibly improve `best` even if its disk does reach (px, py)
      const dist = Math.hypot(px - x, py - y);
      if (dist <= dq) best = dq; // q's own disk genuinely covers (px, py)
    }
  }
  return best;
}

/** Public wrapper for geometries.js — samples this SAME distance field/search radius directly at an arbitrary (gridX, gridY), not just at one of the traced boundary points. Used per 3D VERTEX rather than per boundary point, so a vertex's own local thickness never gets borrowed from some other, merely-nearby boundary point's value — the other half of the fix described above (2026-08-05/17_Plan.md). */
export function localThicknessAt(distanceField, gridX, gridY) {
  const { values, size } = distanceField;
  const searchRadius = size * LOCAL_THICKNESS_SEARCH_RADIUS_RATIO;
  return sampleLocalThickness(values, size, gridX, gridY, searchRadius);
}

/**
 * Traces the boundary of the mask's opaque region as an ordered loop of grid
 * corner points, by registering every exposed pixel edge (between an opaque
 * cell and a non-opaque neighbor) as a short directed segment — each
 * consistently oriented so the opaque region stays on the same side of
 * travel — then stitching them end-to-end. Assumes a single simple
 * boundary loop (true once fillEnclosedHoles + keepLargestComponent have
 * run); very unusual patterns connected only diagonally (checkerboards) can
 * still confuse this, same known limitation noted in the earlier version of
 * this pipeline.
 */
function traceBoundary(mask, size) {
  const isForeground = (x, y) => x >= 0 && y >= 0 && x < size && y < size && mask[y * size + x] === 1;
  const edges = [];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isForeground(x, y)) continue;
      if (!isForeground(x, y - 1)) edges.push([[x, y], [x + 1, y]]); // top
      if (!isForeground(x + 1, y)) edges.push([[x + 1, y], [x + 1, y + 1]]); // right
      if (!isForeground(x, y + 1)) edges.push([[x + 1, y + 1], [x, y + 1]]); // bottom
      if (!isForeground(x - 1, y)) edges.push([[x, y + 1], [x, y]]); // left
    }
  }
  if (edges.length === 0) return null;

  const key = (p) => `${p[0]},${p[1]}`;
  const fromMap = new Map();
  for (const edge of edges) {
    const k = key(edge[0]);
    if (!fromMap.has(k)) fromMap.set(k, []);
    fromMap.get(k).push(edge);
  }

  const used = new Set();
  const loop = [];
  let current = edges[0];
  const startKey = key(current[0]);
  let guard = edges.length + 1;

  while (guard-- > 0) {
    used.add(current);
    loop.push(current[0]);
    const nextKey = key(current[1]);
    if (nextKey === startKey) break;
    const candidates = (fromMap.get(nextKey) || []).filter((e) => !used.has(e));
    if (candidates.length === 0) break; // shouldn't happen for a clean single loop — bail out with whatever was traced so far
    current = candidates[0];
  }

  return loop.length >= 3 ? loop : null;
}

function pointLineDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function simplifyDP(points, epsilon) {
  if (points.length < 3) return points.slice();
  const first = points[0];
  const last = points[points.length - 1];
  let maxDist = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointLineDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist <= epsilon) return [first, last];
  const left = simplifyDP(points.slice(0, index + 1), epsilon);
  const right = simplifyDP(points.slice(index), epsilon);
  return left.slice(0, -1).concat(right);
}

/** Douglas-Peucker only works on an open polyline, so a closed loop is split at its two farthest-apart points into two open chains, simplified separately, then rejoined. If the point budget is still exceeded, epsilon is relaxed and retried rather than truncating (which would just chop off part of the outline). */
function simplifyClosed(points, epsilon, maxPoints) {
  if (points.length <= 3) return points;

  let a = 0;
  let b = 1;
  let best = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]);
      if (d > best) {
        best = d;
        a = i;
        b = j;
      }
    }
  }
  const chain1 = points.slice(a, b + 1);
  const chain2 = points.slice(b).concat(points.slice(0, a + 1));

  let eps = epsilon;
  let simplified;
  for (let attempt = 0; attempt < 6; attempt++) {
    const s1 = simplifyDP(chain1, eps);
    const s2 = simplifyDP(chain2, eps);
    simplified = s1.slice(0, -1).concat(s2.slice(0, -1));
    if (simplified.length <= maxPoints) break;
    eps *= 1.6;
  }
  return simplified;
}

/** Catmull-Rom-resamples the simplified closed polygon so no straight segments remain — the final smoothing pass that turns "fewer jagged points" into an actually curved outline. */
function splineRound(points, sampleCount) {
  const vectors = points.map(([x, y]) => new THREE.Vector3(x, y, 0));
  const curve = new THREE.CatmullRomCurve3(vectors, true, 'catmullrom', 0.5);
  const sampled = curve.getPoints(sampleCount);
  return sampled.slice(0, -1).map((v) => ({ x: v.x, y: v.y })); // getPoints repeats the start point at the end of a closed curve
}

function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  return area / 2;
}

/** THREE.ExtrudeGeometry's front-cap normal points toward +Z only for a counter-clockwise shape — geometries.js relies on that to know which way is "outward". */
function ensureCCW(points) {
  return signedArea(points) < 0 ? points.slice().reverse() : points;
}

/**
 * Returns { points, imageHalfExtent, distanceField } or null if `image`
 * doesn't have a usable transparent background (an ordinary opaque photo,
 * or one where nothing traceable was found) — the caller should keep/revert
 * to the plain sphere in that case.
 *
 * points: an array of {x, y} (roughly origin-centered, in mask-grid units —
 * geometries.js normalizes the final scale) tracing a rounded silhouette of
 * the opaque region.
 *
 * imageHalfExtent: { x, y } — half the photo's OWN drawn width/height, in
 * the SAME mask-grid units as `points`. The traced silhouette is almost
 * always smaller than this (real artwork usually leaves some margin around
 * the character, and isn't circularly symmetric), so it's a different
 * number from the silhouette's own bounding radius — geometries.js needs
 * both: the silhouette to build the shape, and this to size the front-
 * projected texture so the photo lands at its own true scale instead of
 * being zoomed to whatever the silhouette's farthest point happens to be
 * (see 2026-08-05/11_Plan.md — this used to make the photo read as
 * "cropped/zoomed in", cutting off ears/hands near the silhouette's edge).
 *
 * distanceField: { values, size } — the mask's own distance transform (see
 * distanceTransform above), in the SAME mask-grid units/orientation as the
 * raw mask (NOT yet centered/flipped like `points`). geometries.js samples
 * this directly, once per final 3D vertex (via localThicknessAt, exported
 * above) — small at narrow/concave silhouette spots (between two ears, an
 * armpit, a thin hair spike, ...), large in open areas — to keep the wax
 * shell's thickness from exceeding what a narrow spot can actually fit,
 * which otherwise let the shell self-overlap there and expose the core
 * underneath (see 2026-08-05/14_Plan.md and 17_Plan.md).
 */
export function extractSilhouette(image) {
  const raster = rasterizeAlpha(image);
  if (!hasTransparentBackground(raster)) return null;

  let mask = binarize(raster.alpha);
  mask = roundMask(mask, MASK_SIZE);
  mask = fillEnclosedHoles(mask, MASK_SIZE);
  mask = keepLargestComponent(mask, MASK_SIZE);

  const loop = traceBoundary(mask, MASK_SIZE);
  if (!loop) return null;

  const simplified = simplifyClosed(loop, SIMPLIFY_EPSILON, SIMPLIFY_MAX_POINTS);
  const rounded = splineRound(simplified, SPLINE_SAMPLE_COUNT);

  // Grid corners are in image space (origin top-left, y grows downward).
  // Flip y and re-center on the mask so +y ends up as "top of the source
  // photo" — matching how the front-projected texture (wax-crack-chunks.js's
  // CORE_FRAGMENT_COLOR) already expects object-space +y to be "up", with no
  // shape-specific adjustment of its own.
  const half = MASK_SIZE / 2;
  const oriented = rounded.map((p) => ({ x: p.x - half, y: half - p.y }));

  return {
    points: ensureCCW(oriented),
    imageHalfExtent: { x: raster.drawWidth / 2, y: raster.drawHeight / 2 },
    distanceField: { values: distanceTransform(mask, MASK_SIZE), size: MASK_SIZE },
  };
}
