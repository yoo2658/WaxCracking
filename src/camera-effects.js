import * as THREE from 'three';

const ZOOM_FOV_RATIO = 0.85; // fully anticipating = 85% of the base FOV, a subtle dolly-in
const SHAKE_AMOUNT = 0.028; // world units at full anticipation. Lowered from 0.045 per feedback that it was a bit too strong.
const SHAKE_BASE_FRACTION = 0.4; // shake starts at this fraction of SHAKE_AMOUNT right from the first instant of a press, not from zero
const SMOOTHING_LAMBDA = 8; // how fast the displayed effect chases the raw target — matters most on the way back down, so a break/release eases the camera back to normal instead of snapping it there in one frame

let smoothedAnticipation = 0;

/**
 * Camera feedback for a fresh wax's silent hold-to-break wait: a subtle
 * zoom-in plus a shake that's already noticeable the instant you press down
 * and builds further from there, in place of the on-screen progress ring
 * (mobile users found the ring gets hidden right under their own thumb).
 * Call every frame AFTER controls.update() — OrbitControls recomputes
 * camera.position from its own damped spherical state each frame regardless,
 * so anything applied before that call would just get overwritten, and
 * anything applied after it never accumulates (next frame starts fresh from
 * OrbitControls' own clean position again).
 *
 * targetAnticipation is 0..1 (0 once released/broken/dragged away, see
 * pointer-interaction.js's onPressProgress). The zoom follows a damped,
 * lagging copy of it (smoothedAnticipation) rather than the raw value
 * directly, so the moment the target snaps from ~1 to 0 (the break itself,
 * or a release) the camera relaxes back to normal smoothly over a fraction
 * of a second instead of an instant, jarring cut. The shake, though, follows
 * the RAW target directly and stops immediately at that same instant —
 * still shaking through the whole build-up is right, but shaking through
 * the break itself (or its eased-out zoom afterward) would just be visual
 * noise on top of the crack payoff, not another beat of anticipation.
 * Returns whether it actually changed anything this frame, so the
 * render-on-demand loop knows to draw.
 */
export function applyPressAnticipation(camera, baseFov, targetAnticipation, dt) {
  smoothedAnticipation = THREE.MathUtils.damp(smoothedAnticipation, targetAnticipation, SMOOTHING_LAMBDA, dt);
  if (smoothedAnticipation < 0.001) smoothedAnticipation = 0;

  let changed = false;

  const targetFov = THREE.MathUtils.lerp(baseFov, baseFov * ZOOM_FOV_RATIO, smoothedAnticipation);
  if (camera.fov !== targetFov) {
    camera.fov = targetFov;
    camera.updateProjectionMatrix();
    changed = true;
  }

  if (targetAnticipation > 0) {
    const shakeStrength = SHAKE_BASE_FRACTION + (1 - SHAKE_BASE_FRACTION) * targetAnticipation;
    const shake = SHAKE_AMOUNT * shakeStrength;
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    camera.position.z += (Math.random() - 0.5) * shake;
    changed = true;
  }

  return changed;
}
