import * as THREE from 'three';
import { FIRST_BREAK_HOLD_SECONDS } from './deformable-mesh.js';

const TAP_MAX_MOVEMENT_PX = 6;
const MIN_HOLD_STRENGTH = 1;
const MAX_HOLD_STRENGTH = 2.4;
const HOLD_SECONDS_FOR_MAX_STRENGTH = 1.1;

/**
 * Presses the wax in real time: as soon as the pointer goes down, it starts
 * denting immediately, and gets deeper the longer it's held — like actually
 * pressing a thumb into something, not a discrete tap resolved only on
 * release. Distinguishes a press from a drag: if the pointer moves past
 * TAP_MAX_MOVEMENT_PX before release, the press is abandoned and OrbitControls
 * (view rotation) takes over from there — this class never fights it for the
 * same gesture, it just stops feeding the mesh once a drag is detected.
 */
export class PointerInteraction {
  constructor({ renderer, camera, getActiveMesh, onPoke, onFragmentPop, onPressProgress }) {
    this.renderer = renderer;
    this.camera = camera;
    this.getActiveMesh = getActiveMesh;
    this.onPoke = onPoke;
    this.onFragmentPop = onFragmentPop;
    this.onPressProgress = onPressProgress;

    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.active = null; // { downX, downY, point, normal, startTime, appliedStrength, brokeOrReleasedSound }

    const dom = renderer.domElement;
    dom.addEventListener('pointerdown', this._onDown);
    dom.addEventListener('pointermove', this._onMove);
    dom.addEventListener('pointerup', this._onUp);
    dom.addEventListener('pointercancel', this._onCancel);
    // A long press is exactly our "hold to break" gesture — without this,
    // mobile browsers read it as a text-selection/callout gesture and pop up
    // their own context menu (e.g. "Copy") on top of it.
    dom.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  _onDown = (event) => {
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

    this.active = {
      downX: event.clientX,
      downY: event.clientY,
      point,
      normal,
      startTime: performance.now(),
      appliedStrength: 0,
      soundPlayed: false,
    };
  };

  _onMove = (event) => {
    if (!this.active) return;
    const moved = Math.hypot(event.clientX - this.active.downX, event.clientY - this.active.downY);
    if (moved >= TAP_MAX_MOVEMENT_PX) {
      this.active = null; // hand it off to OrbitControls as a drag
      this.onPressProgress?.(null);
    }
  };

  _onCancel = () => {
    this.active = null;
    this.onPressProgress?.(null);
  };

  _onUp = () => {
    // A light tap that never held long enough to break anything still gets
    // a soft tactile sound on release — a break (see update()) already
    // played its own sound in sync the moment it happened, mid-hold or not.
    if (this.active && !this.active.soundPlayed) {
      this.onPoke?.(this._currentStrength(this.active));
    }
    this.active = null;
    this.onPressProgress?.(null);
  };

  _currentStrength(active) {
    const holdSeconds = (performance.now() - active.startTime) / 1000;
    const holdFraction = Math.min(holdSeconds / HOLD_SECONDS_FOR_MAX_STRENGTH, 1);
    return MIN_HOLD_STRENGTH + holdFraction * (MAX_HOLD_STRENGTH - MIN_HOLD_STRENGTH);
  }

  /** Called once per frame from the main render loop while a press is active. */
  update() {
    const active = this.active;
    if (!active) return;

    const mesh = this.getActiveMesh();
    if (!mesh) {
      this.active = null;
      return;
    }

    const holdSeconds = (performance.now() - active.startTime) / 1000;

    // A wax that has never broken at all stays completely rigid — no dent,
    // no bulge, no crack — for the whole first-break hold: poke() isn't
    // called at all yet, so nothing in the mesh moves. appliedStrength stays
    // at 0 through this entire window, so the moment the gate opens, the
    // very next call's delta is the FULL plateaued strength, not just that
    // frame's sliver — the press "gives way" all at once instead of finishing
    // off a dent that was already most of the way there.
    if (!mesh.hasBrokenOnce) {
      // The wax itself stays silent and unmoving through this whole wait, so
      // without some other cue it's easy to think the press didn't register
      // at all — a small on-screen ring fills up instead, independent of the
      // wax's own (deliberately blank) visual state.
      this.onPressProgress?.(active.downX, active.downY, Math.min(holdSeconds / FIRST_BREAK_HOLD_SECONDS, 1));
      if (holdSeconds < FIRST_BREAK_HOLD_SECONDS) return;
      this.onPressProgress?.(null);
    }

    const targetStrength = this._currentStrength(active);
    const delta = Math.max(targetStrength - active.appliedStrength, 0);

    const fragmentSpawn = mesh.poke(active.point, active.normal, delta, holdSeconds);
    active.appliedStrength = targetStrength;

    if (fragmentSpawn) {
      active.soundPlayed = true;
      this.onPoke?.(targetStrength, fragmentSpawn.isFirstBreak);
      this.onFragmentPop?.(fragmentSpawn.point, active.normal, fragmentSpawn.radius);
    }
  }
}
