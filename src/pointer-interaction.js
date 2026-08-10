import * as THREE from 'three';
import { FIRST_BREAK_HOLD_SECONDS } from './deformable-mesh.js';

const TAP_MAX_MOVEMENT_PX = 6;
const MIN_HOLD_STRENGTH = 0.5; // halved from 1 per feedback that presses felt too forceful
const MAX_HOLD_STRENGTH = 1.2; // halved from 2.4, same reason
const HOLD_SECONDS_FOR_MAX_STRENGTH = 1.1;

/**
 * Ray-vs-ellipsoid intersection (semi-axes semiXY, semiXY, semiZ; centered at
 * the origin), returning the nearest point in front of the ray or null.
 * Used instead of a plain bounding-sphere test (see _onDown) because a flat
 * custom shape's bounding sphere — sized to its wide silhouette — sits far
 * outside where its actual thin surface is; a ray hitting that sphere lands
 * nowhere near the real geometry, so surfacePointTowards' "closest direction
 * from origin" match ends up comparing against the wrong scale and can pick
 * an inconsistent vertex from one click to the next (see
 * 2026-08-05/08_Check.md). semiXY = semiZ reduces this to an exact sphere —
 * i.e. a sphere is the special case, not a separate code path.
 */
function intersectRayEllipsoid(ray, semiXY, semiZ) {
  const ox = ray.origin.x / semiXY;
  const oy = ray.origin.y / semiXY;
  const oz = ray.origin.z / semiZ;
  const dx = ray.direction.x / semiXY;
  const dy = ray.direction.y / semiXY;
  const dz = ray.direction.z / semiZ;

  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (ox * dx + oy * dy + oz * dz);
  const c = ox * ox + oy * oy + oz * oz - 1;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;

  const sqrtDiscriminant = Math.sqrt(discriminant);
  const t1 = (-b - sqrtDiscriminant) / (2 * a);
  const t2 = (-b + sqrtDiscriminant) / (2 * a);
  const t = t1 >= 0 ? t1 : t2; // nearest intersection actually in front of the ray, matching THREE's intersectSphere semantics
  if (t < 0) return null;

  return ray.origin.clone().addScaledVector(ray.direction, t);
}

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
  constructor({ renderer, camera, getActiveMesh, onPoke, onFragmentPop, onPressProgress, onShortTap, onCrackAttempt, onPressStart, onPressCancel }) {
    this.renderer = renderer;
    this.camera = camera;
    this.getActiveMesh = getActiveMesh;
    this.onPoke = onPoke;
    this.onFragmentPop = onFragmentPop;
    this.onPressProgress = onPressProgress;
    this.onShortTap = onShortTap;
    this.onCrackAttempt = onCrackAttempt;
    this.onPressStart = onPressStart;
    this.onPressCancel = onPressCancel;

    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.active = null; // { downX, downY, point, normal, startTime, appliedStrength, soundPlayed }

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

    // Find the click direction via a simple analytic shape (an ellipsoid
    // sized to this mesh's own radius/localDepth) rather than an exact
    // per-triangle Mesh raycast: on this project's generated (welded/merged)
    // geometries, the exact triangle test proved unreliable in practice —
    // intermittently missing valid hits for reasons that didn't trace back
    // to winding, material, or geometry corruption. The ellipsoid test is
    // simple, deterministic math with no such flakiness, and — unlike a
    // plain bounding sphere — actually sits close to a flat custom shape's
    // real thin surface instead of ballooning out to its widest silhouette
    // extent (see intersectRayEllipsoid above). That gives a direction, not
    // an accurate surface point, so snap it to the nearest real vertex via
    // surfacePointTowards.
    const approx = intersectRayEllipsoid(this.raycaster.ray, mesh.radius, mesh.localDepth / 2);
    if (!approx) return;
    // normal is the shape's actual rest-normal at the snapped point, not
    // point.clone().normalize() (direction from the origin) — those only
    // coincide for a sphere; on a flat custom shape they can point in very
    // different directions (see deformable-mesh.js's surfacePointTowards).
    const { point, normal } = mesh.surfacePointTowards(approx);

    this.active = {
      downX: event.clientX,
      downY: event.clientY,
      point,
      normal,
      startTime: performance.now(),
      appliedStrength: 0,
      soundPlayed: false,
    };

    // A still-pristine wax gets an audible "hairline crack" cue on every
    // attempt (not just its eventual first real break, which already has
    // its own sound) — repeated short taps before the player realizes they
    // need to hold it down still each get this feedback.
    if (!mesh.hasBrokenOnce) {
      this.onCrackAttempt?.();
    }

    // Counted as a click ("클릭 수") right away, provisionally — a real press
    // needs to register the instant it starts (e.g. if the wax crosses the
    // completion line while STILL being held, the summary should already
    // include this press, not wait for release). _onMove below reverses this
    // via onPressCancel the moment the gesture turns out to be a camera-
    // rotate drag instead, so a rotation nets to zero rather than a +1/-0.
    this.onPressStart?.();
  };

  _onMove = (event) => {
    if (!this.active) return;
    const moved = Math.hypot(event.clientX - this.active.downX, event.clientY - this.active.downY);
    if (moved >= TAP_MAX_MOVEMENT_PX) {
      this.active = null; // hand it off to OrbitControls as a drag
      this.onPressProgress?.(null);
      this.onPressCancel?.(); // undo the provisional click count from _onDown — this was a rotate, not a press
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

      // Releasing before a still-pristine wax has ever had its first
      // dramatic break (see hasBrokenOnce in deformable-mesh.js) means this
      // was a tap that let go too soon — repeated instances of that suggest
      // the player doesn't realize they need to hold it, not just click.
      const mesh = this.getActiveMesh();
      if (mesh && !mesh.hasBrokenOnce) {
        this.onShortTap?.();
      }
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

    // A wax that has never broken at all now dents and cracks a little from
    // the very first instant of a press, same as any later one — poke() runs
    // every frame regardless. deformable-mesh.js's own _checkBreak still
    // withholds the actual dramatic payoff (a wide crack burst, the hole,
    // and the falling fragment) until this hold has lasted FIRST_BREAK_HOLD_SECONDS,
    // so a light tap still won't shatter it — it just means a fresh wax isn't
    // completely rigid/silent while you're building up to that first break.
    const targetStrength = this._currentStrength(active);
    const delta = Math.max(targetStrength - active.appliedStrength, 0);

    const fragmentSpawn = mesh.poke(active.point, active.normal, delta, holdSeconds);
    active.appliedStrength = targetStrength;

    // The camera zoom/shake anticipation cue (see camera-effects.js) only
    // matters while building up to a wax's first-ever dramatic break — once
    // that's happened (just now, or on some earlier press), hide it.
    if (mesh.hasBrokenOnce) {
      this.onPressProgress?.(null);
    } else {
      this.onPressProgress?.(active.downX, active.downY, Math.min(holdSeconds / FIRST_BREAK_HOLD_SECONDS, 1));
    }

    if (fragmentSpawn) {
      active.soundPlayed = true;
      this.onPoke?.(targetStrength, fragmentSpawn.isFirstBreak);
      this.onFragmentPop?.(fragmentSpawn.point, active.normal, fragmentSpawn.radius, fragmentSpawn.colors);
    }
  }
}
