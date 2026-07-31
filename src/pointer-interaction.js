import * as THREE from 'three';

const TAP_MAX_MOVEMENT_PX = 6;
const MIN_HOLD_STRENGTH = 1;
const MAX_HOLD_STRENGTH = 2.4;
const HOLD_SECONDS_FOR_MAX_STRENGTH = 1.1;

/**
 * Distinguishes a tap from a drag on the canvas. Drags are left entirely to
 * OrbitControls (view rotation) — this class only watches for the
 * complementary case: pointerdown+pointerup with little movement in
 * between, which pokes+cracks the wax at that point. Because it only acts on
 * pointerup, it never fights OrbitControls for the same gesture.
 */
export class PointerInteraction {
  constructor({ renderer, camera, getActiveMesh, onPoke, onFragmentPop }) {
    this.renderer = renderer;
    this.camera = camera;
    this.getActiveMesh = getActiveMesh;
    this.onPoke = onPoke;
    this.onFragmentPop = onFragmentPop;

    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.down = null;

    const dom = renderer.domElement;
    dom.addEventListener('pointerdown', this._onDown);
    dom.addEventListener('pointerup', this._onUp);
    dom.addEventListener('pointercancel', this._onCancel);
  }

  _onDown = (event) => {
    this.down = { x: event.clientX, y: event.clientY, time: performance.now() };
  };

  _onCancel = () => {
    this.down = null;
  };

  _onUp = (event) => {
    const down = this.down;
    this.down = null;
    if (!down) return;

    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (moved >= TAP_MAX_MOVEMENT_PX) return; // was a view-rotation drag, not a tap

    const mesh = this.getActiveMesh();
    if (!mesh) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);

    // Find the click direction via the geometry's bounding sphere rather
    // than an exact per-triangle Mesh raycast: on this project's generated
    // (welded/merged) geometries, the exact triangle test proved unreliable
    // in practice — intermittently missing valid hits for reasons that
    // didn't trace back to winding, material, or geometry corruption. The
    // sphere test is simple, deterministic math with no such flakiness.
    // That gives a direction, not an accurate surface point for non-round
    // shapes, so snap it to the nearest real vertex via surfacePointTowards.
    const sphere = mesh.mesh.geometry.boundingSphere;
    const approx = new THREE.Vector3();
    if (!sphere || !this.raycaster.ray.intersectSphere(sphere, approx)) return;
    const point = mesh.surfacePointTowards(approx);
    const normal = point.clone().normalize();

    // Holding the click longer before releasing hits harder — a quick tap
    // is a light flick, a held-down press is a real push.
    const holdSeconds = (performance.now() - down.time) / 1000;
    const holdFraction = Math.min(holdSeconds / HOLD_SECONDS_FOR_MAX_STRENGTH, 1);
    const strength = MIN_HOLD_STRENGTH + holdFraction * (MAX_HOLD_STRENGTH - MIN_HOLD_STRENGTH);

    const fragmentSpawn = mesh.poke(point, normal, strength);

    this.onPoke?.(strength);
    if (fragmentSpawn) this.onFragmentPop?.(fragmentSpawn.point, normal, fragmentSpawn.radius);
  };
}
