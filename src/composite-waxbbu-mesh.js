/**
 * "왁뿌볼" + a custom (photo-silhouette) shape only. Wraps TWO independent
 * DeformableMesh instances — a plain sphere for the outer rubbery shell, and
 * the actual photo-shaped wax for the core/filling — instead of the usual
 * single shared-topology shell+core+filling used everywhere else.
 *
 * Why: DeformableMesh's shell is normally just the core's own vertices
 * offset outward along their shared normals — that only works because shell
 * and core are literally the same geometry. A sphere and an arbitrary photo
 * silhouette don't share any vertex correspondence at all, so there's no way
 * to derive one from the other that way. Two fully separate DeformableMesh
 * instances sidesteps this: each already knows how to dent/spring-back/crack
 * on its OWN geometry — poke() never assumed shell and core share topology,
 * it just always happened to be called on ones that did. Driving both from
 * the SAME click point (see poke() below) is what keeps the outer bubble
 * genuinely squishy (matches "겉껍질도 말랑하게 눌려야 해" — a static,
 * non-deforming bubble was tried first and rejected) while the inner wax
 * still cracks/reveals independently in its own real shape.
 *
 * Exposes the exact subset of DeformableMesh's public interface
 * pointer-interaction.js/main.js actually use, so callers never need to know
 * which one they have — see each method's own short comment for which
 * underlying instance it forwards to and why.
 */
// How much of the bubble's own CURRENT (live, possibly-dented — see
// getRadialRadiusGrid) surface distance, IN EACH DIRECTION, the wax inside
// is allowed to reach outward. Comfortably under 1 so the wax never visually
// touches/pokes the bubble's own inner surface even at its single tightest
// point in that direction.
const CONTAINMENT_MARGIN = 0.82;

export class CompositeWaxbbuMesh {
  constructor(shellDeform, coreDeform) {
    this.shellDeform = shellDeform;
    this.coreDeform = coreDeform;
    this.coreDeform.containmentRadiusPerVertex = coreDeform.buildContainmentFromGrid(
      shellDeform.getRadialRadiusGrid(),
      CONTAINMENT_MARGIN
    );

    // Scene-graph objects — only the shell's OWN shell mesh and the core
    // deform's core/filling meshes are ever added to the scene (see
    // main.js); shellDeform's own unused core/filling and coreDeform's own
    // unused shell are simply never added, so they cost some wasted
    // per-frame geometry updates but never render.
    this.mesh = shellDeform.mesh;
    // shellDeform is always a single-layer (layerCount 1) plain sphere for
    // 왁뿌볼 — see main.js's buildDeformable — so this is always a 1-element
    // array, but main.js's scene wiring always iterates shellMeshes (to also
    // support 크루아상's multi-layer stack elsewhere), so this facade needs
    // to expose it too, not just the single `.mesh` alias.
    this.shellMeshes = shellDeform.shellMeshes;
    this.coreMesh = coreDeform.coreMesh;
    this.fillingMesh = coreDeform.fillingMesh;

    // Click-targeting (pointer-interaction.js) always aims at the OUTER
    // (larger, closer-to-camera) bubble, not the smaller wax shape inside it.
    this.radius = shellDeform.radius;
    this.localDepth = shellDeform.localDepth;
    this.imageFrameHalfExtent = coreDeform.imageFrameHalfExtent;

    // Caches the LAST shell-side point/normal a poke() call was given, so
    // repeated frames of the SAME hold (pointer-interaction.js passes the
    // exact same {point, normal} object every frame of one continuous
    // press) don't re-run coreDeform's own O(vertexCount) surfacePointTowards
    // search every single frame — only once per NEW press.
    this._lastShellPoint = null;
    this._cachedCorePoint = null;
    this._cachedCoreNormal = null;

    this.setMaterialMode();
  }

  /** Real breaking only ever happens on the wax (core), never the plain rubber bubble — see class doc comment. */
  get hasBrokenOnce() {
    return this.coreDeform.hasBrokenOnce;
  }

  /** See setCellReveal's own doc comment on why this must be THE single shared source of truth for the shader uniform of the same name — reads from coreDeform, same reasoning. */
  get globalRevealProgress() {
    return this.coreDeform.globalRevealProgress;
  }

  /**
   * A composite only ever exists for "왁뿌볼" (see buildDeformable in
   * main.js) — the bubble always springs back elastic like any other 왁뿌볼
   * shell, but the wax inside is deliberately CLAY-like (plastic, permanent
   * — "속에 있는 왁스와 속재질은 클레이처럼 누르면 모양이 뭉개지면 좋겠어")
   * instead of 왁뿌볼's usual elastic wax, REGARDLESS of whatever mode
   * string this happens to be called with — main.js's general "재질 전환"
   * plumbing calls setMaterialMode(mode) with the UI's raw selection, but a
   * composite's own two halves never both want that same raw value.
   */
  setMaterialMode() {
    this.shellDeform.setMaterialMode('waxbbu');
    this.coreDeform.setMaterialMode('clay');
  }

  /** Only ever called once per press (see pointer-interaction.js's _onDown) — against the OUTER bubble, matching this.radius/localDepth above. */
  surfacePointTowards(direction) {
    return this.shellDeform.surfacePointTowards(direction);
  }

  /**
   * point/normal are the BUBBLE's own surface point (from surfacePointTowards
   * above) — poke the bubble with them directly, then separately look up
   * (and cache — see the constructor) the wax's OWN corresponding point in
   * roughly the same direction, and poke that too. Both dent/crack
   * completely independently from here on; only the driving click point is
   * shared. Returns the WAX's own fragmentSpawn descriptor (sound/first-break
   * signal) — the bubble's own is intentionally discarded, since it never
   * shows a dramatic break at all (see class doc comment).
   */
  poke(point, normal, delta, holdSeconds) {
    this.shellDeform.poke(point, normal, delta, holdSeconds);

    if (point !== this._lastShellPoint) {
      const { point: corePoint, normal: coreNormal } = this.coreDeform.surfacePointTowards(point);
      this._lastShellPoint = point;
      this._cachedCorePoint = corePoint;
      this._cachedCoreNormal = coreNormal;
    }
    return this.coreDeform.poke(this._cachedCorePoint, this._cachedCoreNormal, delta, holdSeconds);
  }

  /**
   * Both independently advance their own spring-back/GPU upload — a visual
   * change in EITHER one still means the frame needs rendering. Recomputes
   * the core's per-vertex containment grid from the shell's freshly-updated
   * LIVE surface first (see getRadialRadiusGrid's own doc comment) — must
   * happen between the two update() calls, not before both or after both, so
   * this frame's core position rebuild (inside coreDeform.update, right
   * below) already clamps against however dented the bubble actually is
   * RIGHT NOW, in every direction independently.
   */
  update(dt) {
    const shellChanged = this.shellDeform.update(dt);
    // Only worth recomputing (getRadialRadiusGrid is a full pass over the
    // shell's vertices, plus a neighbor-blur pass on top) when the shell's
    // own live surface actually moved this frame — while idle (nothing
    // being pressed, no elastic spring-back still settling), it's the exact
    // same grid as last frame, so skip it and keep using that. Confirmed
    // this was running on EVERY frame regardless, all the time this shape
    // has been on screen at all, not just while actively deforming.
    if (shellChanged) {
      this.coreDeform.containmentRadiusPerVertex = this.coreDeform.buildContainmentFromGrid(
        this.shellDeform.getRadialRadiusGrid(),
        CONTAINMENT_MARGIN
      );
    }
    const coreChanged = this.coreDeform.update(dt);
    return shellChanged || coreChanged;
  }

  /** The wax's own — the bubble never tracks/shows any breaking (see class doc comment). */
  getRemainingWaxRatio() {
    return this.coreDeform.getRemainingWaxRatio();
  }

  reset() {
    this._lastShellPoint = null;
    this.shellDeform.reset();
    this.coreDeform.reset();
  }

  dispose() {
    this.shellDeform.dispose();
    this.coreDeform.dispose();
  }
}
