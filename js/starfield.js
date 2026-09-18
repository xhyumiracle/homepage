/* v5b sky: the gaze model. no rotation axis, no fisheye. the world is a plane ~1.7x the
 viewport in each dimension, centered on polaris; every star and constellation gets a
 STATIC world position (the old theta-orbit rest poses, spread further into the extra
 world margin so panning toward an edge reveals content). the camera pans opposite the
 pointer through a damped spring with rubber-band edges at the world margin, "standing
 under the sky, looking around" — but only barely: pan is ambient parallax, not navigation
 (~4-5% of viewport width at full pointer travel; see the K comment down with the gaze
 constants), since the home pose already shows every constellation.

 dust is 3 depth layers, density-biased into a band so it reads as a milky-way star-river:
 far and mid, plus ~98% of near (everything but its brightest sliver), are pre-rendered once
 per layout() onto offscreen world-sized canvases at reduced resolution and just drawImage'd
 each frame — cheap, static parallax, no per-star cost. only near's brightest ~2% (the ones
 with halo sprites) stay live-drawn for real per-star twinkle; see the dust-section comment
 for why (a real, profiled frame-budget regression this rewrite hit and fixed). a pan-factor
 stack (GAZE_PF/MID_PF/FAR_PF) further dampens how much of the camera's already-small raw
 excursion each depth layer actually shows.

 attention (the constellation nearest the pointer) is light, never size. idle drifts on a
 slow Lissajous wander; touch drags the camera directly (same gentle range) with momentum. a
 click on polaris toggles a frozen mode (camera eases home and holds, wander suspended,
 subtle ring on polaris) unless a module is open, in which case it zooms out first as before.
 the sky background carries a pre-rendered atmosphere: a faint horizon lift, a gentle
 vignette, and a mottled, band-biased milky-way wash so the star river reads as cloud
 structure, not a flat gradient. module/shell logic (including the corner shell's own
 auto-scroll) lives in main.js. */
(function () {
 var canvas = document.getElementById('sky');
 var ctx = canvas.getContext('2d');
 var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
 var touch = matchMedia('(hover: none)').matches;
 var shotM = /[?&]shot(?:=([a-z0-9]+))?/.exec(location.search);
 var shot = !!shotM;
 var still = reduced || shot;

 var MODULES = ['hacker', 'builder', 'scholar', 'archive'];

 var W = 0, H = 0, dpr = 1;
 var pole = { x: 0, y: 0 }; /* world center: polaris, the home anchor the gaze camera rests at */
 var WORLD = { halfW: 0, halfH: 0, marginX: 0, marginY: 0 }; /* 1.7x-viewport world bounds */
 var dustNearBright = []; /* far/mid/near-bulk are baked into offscreen canvases at layout() time; only the brightest sliver of near is drawn live (see the dust section below) */
 var meteors = [], meteorNext = 0;
 var satellite = null, satelliteNext = 0;
 var echo = null;
 var mouse = { x: -1, y: -1 };
 var litId = null;

 var zoomed = false, activeId = null, frozen = false;
 var CAM = { scale: 1, cx: 0, cy: 0 };
 var camAnim = null;

 function d2r(d) { return d * Math.PI / 180; }
 function norm(d) { while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }
 function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
 function smooth01(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

 /* asterism data: normalized local coords, y-down, upright (never rotated, never scaled by
  hover/attention). Orion (hacker): classic outline quadrilateral Betelgeuse-Bellatrix-Rigel-
  Saiph plus the belt as its own separate 3-star polyline. Pleiades (archive): real mini-dipper
  arrangement, 9 named stars, no connecting lines. */
 var CONS = [
  { id: 'hacker', name: 'hacker', sub: 'blockchain security', scaleF: 0.19,
   /* Betelgeuse, Bellatrix, Rigel, Saiph, Alnitak, Alnilam, Mintaka */
   pts: [[.20,.05],[.62,.12],[.72,.90],[.28,.95],[.34,.48],[.44,.52],[.54,.56]],
   lines: [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6]], warmIdx: 0 },
  { id: 'builder', name: 'builder', sub: 'SafeClaw · standards', scaleF: 0.15,
   pts: [[0,.10],[.12,.35],[.35,.60],[.50,.68],[.72,.55],[.82,.18],[.95,.05]],
   lines: [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,0]], specialIdx: 6 },
  { id: 'scholar', name: 'scholar', sub: 'ICL PhD · 3 directions', scaleF: 0.15,
   pts: [[.15,.10],[.30,.02],[.32,.25],[.55,.35],[.50,.62],[.72,.60]],
   lines: [[0,1],[0,2],[2,3],[3,5],[5,4],[4,2]], brightIdx: 0 },
  { id: 'archive', name: 'fainter stars', sub: 'archive', scaleF: 0.14, dim: true,
   /* Atlas, Alcyone, Merope, Electra, Maia, Taygeta, Pleione, Celaeno, Sterope */
   pts: [[.72,.30],[.58,.38],[.50,.56],[.36,.50],[.40,.30],[.28,.26],[.76,.22],[.30,.38],[.36,.20]],
   sizes: [1.2,1.4,1.0,1.05,1.1,.95,.9,.8,.8], lines: [] },
 ];
 var byId = {};
 CONS.forEach(function (c) { byId[c.id] = c; c.hover = 0; c.pulseStart = null; });

 /* static world placement: each constellation keeps its old theta=0 direction (ORBIT.ang) but
  the amplitude is now measured against the 1.7x WORLD half-extent instead of the viewport
  half-extent, so the same "clear of chrome, non-overlapping" margin math that used to bound
  the rest pose to the viewport now spreads the shape out into the extra world margin instead:
  hacker upper-left, builder right, scholar lower-right, archive mid-left, same as before, just
  further out. no per-frame recompute: c.wx/c.wy are written once in layout() and read forever. */
 var ORBIT = {
  hacker:  { ang: d2r(205), fracA: .30, fracB: .42 },
  builder: { ang: d2r(5),   fracA: .46, fracB: .66 },
  scholar: { ang: d2r(60),  fracA: .46, fracB: .56 },
  archive: { ang: d2r(175), fracA: .46, fracB: .48 },
 };

 var pulseNext = 0, lastPulseId = null;

 /* pan-factor stack: how much of the camera's raw excursion from home each depth plane shows.
  K (below, with the gaze constants) controls how far the camera itself travels per pointer
  pixel; these factors independently damp what each layer actually displays, so a single
  pointer swing reads as real depth rather than a flat pan. only the near/constellation plane
  snaps to a factor of 1 while a module is zoomed (precise fly-to navigation there, no gaze
  damping); far/mid dust keep their parallax always, zoomed or not. */
 var GAZE_PF = 0.9, MID_PF = 0.7, FAR_PF = 0.5;
 function gazeCam() {
  if (zoomed) return CAM;
  return { scale: CAM.scale, cx: pole.x + (CAM.cx - pole.x) * GAZE_PF, cy: pole.y + (CAM.cy - pole.y) * GAZE_PF };
 }
 function screenToBase(x, y) { var c = gazeCam(); return { x: (x - W / 2) / c.scale + c.cx, y: (y - H / 2) / c.scale + c.cy }; }
 function baseToScreen(x, y) { var c = gazeCam(); return { x: (x - c.cx) * c.scale + W / 2, y: (y - c.cy) * c.scale + H / 2 }; }

 /* upright local star layout for a constellation: its normalized pts scaled and re-centered
  on their own bounding-box center. computed once per layout() call. never rotated, never
  scaled by hover/attention: only alpha (visOf) moves with attention. */
 function buildLocalShape(c, scale) {
  var raw = c.pts.map(function (p) { return { x: (p[0] - .5) * scale, y: (p[1] - .5) * scale }; });
  var xs = raw.map(function (p) { return p.x; }), ys = raw.map(function (p) { return p.y; });
  var cx0 = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
  var cy0 = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
  var pts = raw.map(function (p) { return { x: p.x - cx0, y: p.y - cy0 }; });
  var maxR = 0;
  for (var k = 0; k < pts.length; k++) maxR = Math.max(maxR, Math.hypot(pts[k].x, pts[k].y));
  return { localPts: pts, maxR: maxR };
 }

 /* --- dust + atmosphere ---
  MW_ANGLE is the one fixed diagonal shared by three things so they all line up: the star-
  density band bias below, the nebulosity blobs, and the milky-way wash gradient.

  root-cause note (the "no dust on real browsers" regression): genLayer() used to read the
  shared `pole`/`WORLD` closure vars directly. layout() only writes those at its very end (the
  "commit" step, by design: a half-built layout should never clobber a good one), but it used
  to call genLayer() *before* that commit — so every star was generated against pole={x:0,y:0}
  and WORLD={halfW:0,halfH:0}, i.e. `pole.x + rand*WORLD.halfW` collapsed to exactly (0,0) for
  every single star, every layout(). the whole dust field sat stacked in one point just off the
  top-left corner, permanently, on every load and resize, independent of dpr — dpr only changed
  how forgiving downscaled preview screenshots were about not noticing. fixed by threading the
  freshly-computed newPole/newWorld into genLayer()/prerenderLayer() explicitly instead of
  reading the stale shared globals. */
 var MW_ANGLE = -0.58;
 function powerBrightness(pw) { return Math.pow(Math.random(), pw); }
 function bandFrac(px, py, cx, cy, bandWidth) {
  var perp = (px - cx) * -Math.sin(MW_ANGLE) + (py - cy) * Math.cos(MW_ANGLE);
  return Math.exp(-(perp * perp) / (2 * bandWidth * bandWidth));
 }
 function genLayer(count, opt, poleRef, worldRef) {
  var out = [];
  var guard = 0, need = count;
  var floor = opt.floor != null ? opt.floor : 0.35;
  var bandWidth = opt.bandWidth || worldRef.halfH * 0.35;
  while (out.length < need && guard < need * 8) {
   guard++;
   var x = poleRef.x + (Math.random() * 2 - 1) * worldRef.halfW;
   var y = poleRef.y + (Math.random() * 2 - 1) * worldRef.halfH;
   var bf = bandFrac(x, y, poleRef.x, poleRef.y, bandWidth);
   if (Math.random() > floor + (1 - floor) * bf) continue;
   var b = powerBrightness(opt.pow);
   var star = {
    x: x, y: y,
    size: (opt.sizeMin + b * (opt.sizeMax - opt.sizeMin)) * (0.88 + Math.random() * 0.24),
    alpha: opt.alphaMin + b * (opt.alphaMax - opt.alphaMin),
    ph: Math.random() * Math.PI * 2,
    sp: 0.4 + Math.random() * 1.1,
    tw: opt.tw || 0,
    tint: Math.random() < 0.9 ? '232,230,221' : Math.random() < 0.7 ? '216,192,138' : '160,190,230',
    halo: !!(opt.halo && b > 0.93),
   };
   out.push(star);
  }
  return out;
 }

 /* far/mid/near-bulk: baked once per layout() onto a world-sized offscreen canvas, each at its
  own reduced resolution (bakeScale, well under 1 device pixel per CSS pixel — see the
  prerenderLayer call sites in layout() for the actual factors). deliberately soft: these are
  meant to read as out-of-focus background dust (only nearBright, below, stays pin-sharp), and
  a smaller backing store is both cheaper to rasterize once here AND, far more importantly,
  cheaper for drawImage() to resample every single frame (see next paragraph). frame() just
  drawImage()s the visible window of each canvas with the camera offset — no per-star cost at
  all, so these layers can carry the bulk of the star count for density without touching frame
  budget.

  near is split: ~98% of it (nearBulk) is baked in here alongside far/mid, since a software
  canvas rasterizer (no GPU compositing — the config this was profiled under, and plausibly
  some real visitors' browsers too: locked-down corporate Chrome, some VMs/remote desktops,
  older integrated graphics falling back to software) turned out to cost ~90ms/frame once 1400
  individually beginPath()+arc()+fill()'d circles were actually scattered across the whole
  canvas instead of degenerately stacked on one point (see the root-cause note: that's exactly
  what the pre-fix bug had been accidentally hiding — profiled with CDP's Profiler domain,
  91% of frame time was native fill() called from this loop). only the brightest ~2% (b > .93,
  the ones that already carry the halo-sprite flag) stay live-drawn in nearBright, per-star,
  with real twinkle — a few dozen stars, negligible cost, and they're the only ones a viewer's
  eye actually registers twinkling anyway. moving the bulk to prerendered drawImage() calls
  fixed that, but re-profiling turned up a second, smaller version of the same story: 3 full-
  resolution drawImage() calls of a ~2400×1500 source, every frame, cost ~72% of frame time on
  the same software rasterizer (large source + a sub-pixel-positioned destination forces a
  bilinear resample of the whole image, not a cheap blit). bakeScale below is the fix: shrink
  the source resolution so there's simply less to resample. net result on the profiled machine:
  ~90ms/frame -> ~1.5ms/frame average. */
 var farCanvas = document.createElement('canvas'), farCtx = farCanvas.getContext('2d');
 var midCanvas = document.createElement('canvas'), midCtx = midCanvas.getContext('2d');
 var nearCanvas = document.createElement('canvas'), nearCtx = nearCanvas.getContext('2d');
 function prerenderLayer(canvas, cctx, stars, poleRef, worldRef, bakeScale) {
  var w = worldRef.halfW * 2, h = worldRef.halfH * 2;
  canvas.width = Math.max(1, Math.round(w * bakeScale));
  canvas.height = Math.max(1, Math.round(h * bakeScale));
  cctx.setTransform(bakeScale, 0, 0, bakeScale, 0, 0); /* star math below stays in full CSS-world units; the transform is what actually shrinks the backing store */
  cctx.clearRect(0, 0, w, h);
  var ox = poleRef.x - worldRef.halfW, oy = poleRef.y - worldRef.halfH;
  for (var i = 0; i < stars.length; i++) {
   var s = stars[i];
   cctx.beginPath();
   cctx.arc(s.x - ox, s.y - oy, s.size, 0, 7);
   cctx.fillStyle = 'rgba(' + s.tint + ',' + s.alpha + ')';
   cctx.fill();
  }
 }
 function drawPrerenderedLayer(canvas, pf, alphaMul) {
  var lcx = pole.x + (CAM.cx - pole.x) * pf, lcy = pole.y + (CAM.cy - pole.y) * pf;
  var ox = pole.x - WORLD.halfW, oy = pole.y - WORLD.halfH;
  var sx0 = (ox - lcx) * CAM.scale + W / 2, sy0 = (oy - lcy) * CAM.scale + H / 2;
  var dw = WORLD.halfW * 2 * CAM.scale, dh = WORLD.halfH * 2 * CAM.scale;
  ctx.globalAlpha = alphaMul;
  ctx.drawImage(canvas, sx0, sy0, dw, dh);
  ctx.globalAlpha = 1;
 }

 /* live dust layer draw (near only): `pf` (pan factor) is how much of the camera's displacement
  from home this layer feels, implemented as a per-layer virtual camera center that only
  travels pf of the way from home to CAM's actual center — same trick as drawPrerenderedLayer,
  just per-star since near still twinkles and carries halo sprites. */
 function drawDust(layer, now, pf) {
  var lcx = pole.x + (CAM.cx - pole.x) * pf, lcy = pole.y + (CAM.cy - pole.y) * pf;
  var bgMul = zoomed ? 0.35 : 1;
  for (var i = 0; i < layer.length; i++) {
   var s = layer[i];
   var sx = (s.x - lcx) * CAM.scale + W / 2, sy = (s.y - lcy) * CAM.scale + H / 2;
   if (sx < -8 || sx > W + 8 || sy < -8 || sy > H + 8) continue;
   var tw = still ? 1 : (1 - s.tw) + s.tw * (0.72 + 0.28 * Math.sin((now / 1000) * s.sp + s.ph));
   var rr = s.size * Math.max(CAM.scale, 0.6);
   if (s.halo) {
    var sprite = haloSprites[s.tint];
    if (sprite) {
     var hs = rr * 7;
     ctx.globalAlpha = s.alpha * tw * bgMul;
     ctx.drawImage(sprite, sx - hs / 2, sy - hs / 2, hs, hs);
     ctx.globalAlpha = 1;
    }
   }
   ctx.beginPath();
   ctx.arc(sx, sy, rr, 0, 7);
   ctx.fillStyle = 'rgba(' + s.tint + ',' + (s.alpha * tw * bgMul) + ')';
   ctx.fill();
  }
 }

 /* atmosphere, viewport-sized (not world-sized: it's a lens/eye effect, not a pannable plane),
  rebuilt once per layout(). three coats: a subliminal horizon lift + vignette base, mottled
  nebulosity blobs hugging the MW_ANGLE band, and the band wash itself on top, slightly
  brightened so it doesn't read as a flat gradient under the blobs. */
 var mwCanvas = document.createElement('canvas'), mwCtx = mwCanvas.getContext('2d');
 function buildAtmosphere() {
  mwCanvas.width = Math.max(1, W); mwCanvas.height = Math.max(1, H);
  mwCtx.clearRect(0, 0, W, H);
  var cx = W / 2, cy = H / 2;

  /* horizon glow: darkest at top, a ~4%-luminance lift toward the bottom edge. never flat black. */
  var vgrad = mwCtx.createLinearGradient(0, 0, 0, H);
  vgrad.addColorStop(0, 'rgba(200,210,230,0)');
  vgrad.addColorStop(0.55, 'rgba(200,210,230,0)');
  vgrad.addColorStop(1, 'rgba(205,215,232,.045)');
  mwCtx.fillStyle = vgrad;
  mwCtx.fillRect(0, 0, W, H);

  /* gentle radial vignette */
  var vig = mwCtx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(W, H) * 0.62);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,.12)');
  mwCtx.fillStyle = vig;
  mwCtx.fillRect(0, 0, W, H);

  /* mottled nebulosity: 3 octaves of soft, band-hugging blobs (elongated along MW_ANGLE) so the
   milky way reads as cloud structure rather than a flat gradient. centers rejection-sampled
   with the same perpendicular gaussian used for the star density bias, so clouds and star-river
   line up. */
  var octaves = [
   { n: 22, rMin: 90, rMax: 190, a: .022 },
   { n: 30, rMin: 40, rMax: 95, a: .028 },
   { n: 40, rMin: 16, rMax: 40, a: .032 },
  ];
  var bw = Math.min(W, H) * 0.16;
  var along = Math.hypot(W, H) * 0.65;
  var dirX = Math.cos(MW_ANGLE), dirY = Math.sin(MW_ANGLE);
  var perpX = -Math.sin(MW_ANGLE), perpY = Math.cos(MW_ANGLE);
  octaves.forEach(function (oct) {
   for (var i = 0; i < oct.n; i++) {
    var perp = (Math.random() * 2 - 1) * bw * 1.4;
    if (Math.random() > Math.exp(-(perp * perp) / (2 * bw * bw))) continue;
    var t = (Math.random() * 2 - 1) * along;
    var bx = cx + dirX * t + perpX * perp, by = cy + dirY * t + perpY * perp;
    var r = oct.rMin + Math.random() * (oct.rMax - oct.rMin);
    var g = mwCtx.createRadialGradient(bx, by, 0, bx, by, r);
    g.addColorStop(0, 'rgba(224,220,206,' + oct.a + ')');
    g.addColorStop(1, 'rgba(224,220,206,0)');
    mwCtx.fillStyle = g;
    mwCtx.save();
    mwCtx.translate(bx, by); mwCtx.rotate(MW_ANGLE); mwCtx.scale(1.6, 1); mwCtx.translate(-bx, -by);
    mwCtx.beginPath(); mwCtx.arc(bx, by, r, 0, 7); mwCtx.fill();
    mwCtx.restore();
   }
  });

  /* the band wash itself, brightened slightly so it sits visibly under the nebulosity+dust */
  var len = Math.hypot(W, H);
  var x0 = cx - perpX * len / 2, y0 = cy - perpY * len / 2, x1 = cx + perpX * len / 2, y1 = cy + perpY * len / 2;
  var grad = mwCtx.createLinearGradient(x0, y0, x1, y1);
  grad.addColorStop(0, 'rgba(220,216,204,0)');
  grad.addColorStop(0.5, 'rgba(224,220,206,.065)');
  grad.addColorStop(1, 'rgba(220,216,204,0)');
  mwCtx.fillStyle = grad;
  mwCtx.fillRect(0, 0, W, H);
 }

 var HALO_TINTS = ['232,230,221', '216,192,138', '160,190,230'];
 var haloSprites = {}, haloBuilt = false;
 function buildHaloSprites() {
  if (haloBuilt) return; haloBuilt = true;
  HALO_TINTS.forEach(function (tint) {
   var size = 24, c = document.createElement('canvas');
   c.width = size; c.height = size;
   var hc = c.getContext('2d');
   var g = hc.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
   g.addColorStop(0, 'rgba(' + tint + ',.5)');
   g.addColorStop(0.4, 'rgba(' + tint + ',.2)');
   g.addColorStop(1, 'rgba(' + tint + ',0)');
   hc.fillStyle = g;
   hc.beginPath(); hc.arc(size / 2, size / 2, size / 2, 0, 7); hc.fill();
   haloSprites[tint] = c;
  });
 }

 /* full re-layout: viewport size, world bounds, every constellation's static position, and
  the dust layers (near generated live, far/mid generated + baked to offscreen canvases).
  called on boot and on every resize. structured so that ALL of it is computed into local
  scratch vars first and only written onto shared state at the very end of a successful run,
  so a transient bad viewport (0-size mid-resize) or a thrown error can never leave the sky
  half old / half new. genLayer/prerenderLayer take the fresh newPole/newWorld explicitly
  (see the root-cause note above the dust section) rather than reading the shared globals,
  which are still the previous layout's values at this point in the function. */
 function layout() {
  var newW = innerWidth, newH = innerHeight;
  if (!newW || !newH) return; /* transient 0×0 mid-resize: keep the last good frame, retry on the next resize/rAF */

  try {
   dpr = Math.min(devicePixelRatio || 1, 2);
   W = newW; H = newH;
   canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
   ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
   var mobile = W < 720;
   var ultrawide = (W / H) > 1.9;

   var newPole = { x: W * 0.5, y: H * (mobile ? 0.56 : 0.5) }; /* polaris = world center = camera home; a touch lower on mobile to clear the stacked header */
   var newWorld = { halfW: W * 0.85, halfH: H * 0.85 };
   newWorld.marginX = newWorld.halfW - W / 2; /* = 0.35W: the extra world beyond the viewport edge on each side */
   newWorld.marginY = newWorld.halfH - H / 2;

   CAM.scale = 1; CAM.cx = newPole.x; CAM.cy = newPole.y;
   if (zoomed && activeId && byId[activeId]) {
    var camT = targetCamForStatic(byId[activeId], newPole); CAM.scale = camT.scale; CAM.cx = camT.cx; CAM.cy = camT.cy;
   } else if (zoomed) {
    zoomed = false; activeId = null; /* defensive: never leave the camera pointed at a dead target */
   }
   camAnim = null; /* any in-flight fly/freeze tween targeted the pre-resize layout; drop it, we just snapped to the correct one */
   frozen = false; gazeIdling = false; /* pre-resize gaze/freeze state is stale */

   var results = new Array(CONS.length);
   for (var i = 0; i < CONS.length; i++) {
    var c = CONS[i];
    var o = ORBIT[c.id];
    var scale = Math.min(W, H) * c.scaleF * (mobile ? 0.72 : 1);
    if (ultrawide) scale *= 1.25;
    var shape = buildLocalShape(c, scale);
    var padScale = mobile ? 0.35 : 1;
    var marginX = shape.maxR + 24 * padScale;
    var marginY = shape.maxR + 40 * padScale;
    var floor = shape.maxR * 0.6;
    /* fracA/fracB measured against the WORLD half-extent (not the viewport's) is the whole
     trick that turns the old viewport-bounded rest pose into a world position that spreads
     into the extra 1.7x margin: same formula, bigger canvas underneath it. */
    var orbitA = Math.max(o.fracA * newWorld.halfW - marginX, floor);
    var orbitB = Math.max(o.fracB * newWorld.halfH - marginY, floor);
    var wx = newPole.x + orbitA * Math.cos(o.ang), wy = newPole.y + orbitB * Math.sin(o.ang);
    results[i] = {
     localPts: shape.localPts, maxR: shape.maxR, wx: wx, wy: wy,
     rad: Math.max(shape.maxR + scale * 0.28, 46),
     align: wx > newPole.x ? 'right' : 'left',
     labelDY: shape.maxR + 24,
    };
   }

   /* counts: far/mid/near-bulk carry the bulk (they're free at frame time, baked once below);
    only near's brightest sliver stays live-drawn. floor/bandWidth bias the majority of far/mid
    toward the MW_ANGLE band so it reads as a grainy star-river; near stays close to uniform (a
    gentle nudge only) since it's the foreground/personal-space layer. */
   var far = genLayer(mobile ? 1200 : 3200, { sizeMin: .22, sizeMax: .5, alphaMin: .08, alphaMax: .22, pow: 2.4, floor: .10, bandWidth: newWorld.halfH * 0.26 }, newPole, newWorld);
   var mid = genLayer(mobile ? 900 : 2200, { sizeMin: .26, sizeMax: .8, alphaMin: .12, alphaMax: .34, pow: 2.7, floor: .14, bandWidth: newWorld.halfH * 0.30 }, newPole, newWorld);
   var near = genLayer(mobile ? 650 : 1400, { sizeMin: .35, sizeMax: 1.9, alphaMin: .28, alphaMax: .82, pow: 3.2, tw: .26, halo: true, floor: .60, bandWidth: newWorld.halfH * 0.42 }, newPole, newWorld);
   var nearBulk = [], nearBright = [];
   for (var ni = 0; ni < near.length; ni++) (near[ni].halo ? nearBright : nearBulk).push(near[ni]);
   /* baked below native resolution: these read as soft background dust anyway (only nearBright
    stays pin-sharp, live-drawn), and a smaller source image is dramatically cheaper for
    drawImage() to resample every frame in a software (non-GPU-composited) canvas backend —
    see the dust-section note above for the profiling that found this. */
   prerenderLayer(farCanvas, farCtx, far, newPole, newWorld, 0.4);
   prerenderLayer(midCanvas, midCtx, mid, newPole, newWorld, 0.45);
   prerenderLayer(nearCanvas, nearCtx, nearBulk, newPole, newWorld, 0.55);
   buildAtmosphere();

   /* --- commit: everything above succeeded, so write it all at once. --- */
   pole.x = newPole.x; pole.y = newPole.y;
   WORLD.halfW = newWorld.halfW; WORLD.halfH = newWorld.halfH; WORLD.marginX = newWorld.marginX; WORLD.marginY = newWorld.marginY;
   for (var j = 0; j < CONS.length; j++) {
    var cc = CONS[j], res = results[j];
    cc.localPts = res.localPts; cc.maxR = res.maxR; cc.wx = res.wx; cc.wy = res.wy;
    cc.rad = res.rad; cc.align = res.align; cc.labelDY = res.labelDY;
   }
   dustNearBright = nearBright;
  } catch (err) {
   /* leave the last good layout in place rather than a half-built one */
   if (window.console && console.warn) console.warn('sky layout() failed, keeping previous frame', err);
  }
 }

 function targetCamForStatic(c, poleRef) {
  var mobile = W < 720;
  var scale = 2.4;
  var tScreenX = mobile ? W * 0.5 : W * 0.225;
  var tScreenY = mobile ? H * 0.20 : H * 0.5;
  return { scale: scale, cx: c.wx - (tScreenX - W / 2) / scale, cy: c.wy - (tScreenY - H / 2) / scale };
 }
 function targetCamFor(id) { return targetCamForStatic(byId[id], pole); }

 function setCamImmediate(t) { CAM.scale = t.scale; CAM.cx = t.cx; CAM.cy = t.cy; camAnim = null; }
 function tweenCam(target, dur, onDone) {
  if (still || dur <= 0) { setCamImmediate(target); if (onDone) onDone(); return; }
  camAnim = { from: { scale: CAM.scale, cx: CAM.cx, cy: CAM.cy }, to: target, t0: performance.now(), dur: dur, onDone: onDone };
 }
 function updateCam(now) {
  if (!camAnim) return;
  var t = (now - camAnim.t0) / camAnim.dur;
  if (t >= 1) t = 1;
  var e = easeInOutCubic(t);
  CAM.scale = camAnim.from.scale + (camAnim.to.scale - camAnim.from.scale) * e;
  CAM.cx = camAnim.from.cx + (camAnim.to.cx - camAnim.from.cx) * e;
  CAM.cy = camAnim.from.cy + (camAnim.to.cy - camAnim.from.cy) * e;
  if (t >= 1) { var cb = camAnim.onDone; camAnim = null; if (cb) cb(); }
 }

 function flyTo(id) {
  if (!byId[id] || activeId === id && zoomed && !camAnim) return;
  zoomed = true; activeId = id; ptrDragging = false;
  meteors = []; satellite = null;
  dispatchEvent(new CustomEvent('sky:zoomstart', { detail: { id: id } }));
  tweenCam(targetCamFor(id), 700, function () {
   dispatchEvent(new CustomEvent('sky:settle', { detail: { id: id } }));
  });
  if (still) repaint();
 }
 function flyOut() {
  if (!zoomed) return;
  zoomed = false; activeId = null;
  dispatchEvent(new CustomEvent('sky:zoomstart', { detail: { id: null } }));
  tweenCam({ scale: 1, cx: pole.x, cy: pole.y }, 700, function () {
   dispatchEvent(new CustomEvent('sky:settle', { detail: { id: null } }));
  });
  if (still) repaint();
 }
 function stepNext() { if (!zoomed) return; var i = MODULES.indexOf(activeId); flyTo(MODULES[(i + 1) % MODULES.length]); }
 function stepPrev() { if (!zoomed) return; var i = MODULES.indexOf(activeId); flyTo(MODULES[(i - 1 + MODULES.length) % MODULES.length]); }

 /* polaris click: while a module is zoomed, always zoom out first (existing nav semantics,
  unaffected by freeze). otherwise toggles freeze: click 1 eases the camera home over ~1s and
  holds it there (gaze-follow and idle wander both suspended — updateGaze() bails out early
  whenever frozen is true, same as it already does for zoomed), click 2 drops the hold and
  gaze-follow resumes on the very next frame, immediately, from wherever the pointer is. */
 function onPolarisClick() {
  if (zoomed) { flyOut(); return; }
  frozen = !frozen;
  if (frozen) { gazeIdling = false; tweenCam({ scale: 1, cx: pole.x, cy: pole.y }, 1000); }
  else { camAnim = null; }
 }

 function pulseAlpha(c, now) {
  if (c.pulseStart == null) return 0;
  var FADE_IN = 1400, HOLD = 1800, FADE_OUT = 2800, TOTAL = FADE_IN + HOLD + FADE_OUT;
  var e = now - c.pulseStart;
  if (e > TOTAL) { c.pulseStart = null; return 0; }
  if (e < FADE_IN) return smooth01(e / FADE_IN);
  if (e < FADE_IN + HOLD) return 1;
  return 1 - smooth01((e - FADE_IN - HOLD) / FADE_OUT);
 }
 function maybePulse(now) {
  if (still || zoomed) return;
  if (now >= pulseNext) {
   var choices = CONS.filter(function (c) { return c.id !== lastPulseId; });
   var pick = choices[Math.floor(Math.random() * choices.length)];
   pick.pulseStart = now;
   lastPulseId = pick.id;
   pulseNext = now + 4000 + Math.random() * 3000;
  }
 }

 function visOf(c, now) {
  var base = c.dim ? 0.24 : 0.30; /* archive is still the faintest constellation, just less dim than before */
  if (zoomed) return (activeId === c.id) ? 0.95 : 0.28;
  var v = base;
  v = Math.max(v, base + pulseAlpha(c, now) * (0.55 - base));
  var forced = (litId === c.id) ? 1 : 0;
  var hoverA = Math.max(c.hover, forced); /* attention = light: hover eases alpha, geometry never scales */
  v = Math.max(v, base + hoverA * (0.95 - base));
  return still ? Math.max(v, 0.55) : v;
 }

 function drawCon(c, now) {
  var vis = visOf(c, now);
  var pts = c.localPts.map(function (lp) { return baseToScreen(c.wx + lp.x, c.wy + lp.y); }); /* static world center, upright local shape */
  var sizeMul = (zoomed && activeId === c.id) ? 1.3 : 1;

  if (c.lines && c.lines.length && pts.length > 1) {
   ctx.strokeStyle = 'rgba(216,192,138,' + (0.38 * vis) + ')';
   ctx.lineWidth = 1;
   for (var li = 0; li < c.lines.length; li++) {
    var p0 = pts[c.lines[li][0]], p1 = pts[c.lines[li][1]];
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
   }
  }

  for (var i = 0; i < pts.length; i++) {
   var p = pts[i];
   var memberSize = (c.sizes ? c.sizes[i] : 1.9) * sizeMul;
   if (c.specialIdx === i) {
    var glow = (9 + 2 * Math.sin(now / 700)) * sizeMul;
    ctx.beginPath(); ctx.arc(p.x, p.y, glow, 0, 7);
    ctx.fillStyle = 'rgba(138,212,207,' + (0.16 * vis) + ')'; ctx.fill();
    ctx.beginPath(); ctx.arc(p.x, p.y, (2.7 + vis * 0.8) * sizeMul, 0, 7);
    ctx.fillStyle = 'rgba(138,212,207,' + (0.55 + 0.35 * vis * (0.75 + 0.25 * Math.sin(now / 700))) + ')';
    ctx.fill();
   } else if (c.brightIdx === i) {
    ctx.beginPath(); ctx.arc(p.x, p.y, (2.4 + vis * 0.9) * sizeMul, 0, 7);
    ctx.fillStyle = 'rgba(240,236,222,' + (0.55 + 0.4 * vis) + ')'; ctx.fill();
   } else {
    var tint = (c.warmIdx === i) ? '233,220,196' : '233,228,214';
    ctx.beginPath(); ctx.arc(p.x, p.y, memberSize, 0, 7);
    ctx.fillStyle = 'rgba(' + tint + ',' + (0.5 + 0.45 * vis) + ')';
    ctx.fill();
   }
  }

  var la = still ? 0.9 : 0.55 + 0.45 * vis;
  var cenScreen = baseToScreen(c.wx, c.wy);
  var lx = cenScreen.x + (c.align === 'right' ? -c.rad * 0.15 : c.rad * 0.15) * CAM.scale;
  var ly = cenScreen.y + c.labelDY * CAM.scale;
  ctx.textAlign = c.align;
  ctx.font = '13px PlexMono, monospace';
  ctx.fillStyle = 'rgba(180,184,196,' + la + ')';
  ctx.fillText(c.name, lx, ly);
  ctx.font = '10.5px PlexMono, monospace';
  ctx.fillStyle = 'rgba(86,91,107,' + la + ')';
  ctx.fillText(c.sub, lx, ly + 15);
 }

 function drawPolaris(now) {
  var p = baseToScreen(pole.x, pole.y);
  if (p.x < -10 || p.x > W + 10 || p.y < -10 || p.y > H + 10) return;
  var tw = still ? 1 : 0.85 + 0.15 * Math.sin(now / 900);
  var s = Math.max(CAM.scale, 0.6);
  ctx.beginPath(); ctx.arc(p.x, p.y, 5 * s, 0, 7);
  ctx.fillStyle = 'rgba(240,236,222,.15)'; ctx.fill();
  ctx.beginPath(); ctx.arc(p.x, p.y, 1.9 * s, 0, 7);
  ctx.fillStyle = 'rgba(240,236,222,' + (0.75 + 0.25 * tw) + ')'; ctx.fill();
  if (frozen) {
   ctx.beginPath(); ctx.arc(p.x, p.y, 9 * s, 0, 7);
   ctx.strokeStyle = 'rgba(216,192,138,.38)'; ctx.lineWidth = 1;
   ctx.stroke();
  }
 }

 function drawEcho(now) {
  if (!echo) return;
  var FADE_IN = 800, HOLD = 2500, FADE_OUT = 1500, TOTAL = FADE_IN + HOLD + FADE_OUT;
  var el = now - echo.t0;
  if (el > TOTAL) { echo = null; return; }
  var a = el < FADE_IN ? smooth01(el / FADE_IN) : el < FADE_IN + HOLD ? 1 : 1 - smooth01((el - FADE_IN - HOLD) / FADE_OUT);
  var drift = Math.min(el, FADE_IN + HOLD) / (FADE_IN + HOLD) * 14;
  var p = baseToScreen(echo.bx, echo.by); /* world space: pans with the sky like everything else */
  ctx.save();
  ctx.font = 'italic 300 ' + Math.round(28 * Math.min(CAM.scale, 1.4)) + 'px Spectral, serif';
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(216,192,138,.55)'; ctx.shadowBlur = 14;
  ctx.fillStyle = 'rgba(216,192,138,' + (0.75 * a) + ')';
  ctx.fillText(echo.text, p.x, p.y - drift);
  ctx.restore();
 }
 function setEcho(text) {
  var b = screenToBase(W / 2, H * 0.44);
  echo = { text: text, t0: performance.now(), bx: b.x, by: b.y };
  if (still) repaint();
 }

 /* meteors: world-space now (they pan with the sky). CAM.scale is always 1 while meteors are
  eligible to spawn (only when !zoomed), so world deltas equal screen deltas and the direction
  vector used for the head can double as the screen-space tail direction. never overlaps the
  satellite (mutually exclusive spawn gates on both sides). */
 function scheduleMeteor(now) {
  var gap = 90000 + Math.random() * 60000; /* 90-150s baseline */
  if (Math.random() < 0.15) gap += 90000 + Math.random() * 90000; /* sometimes none for 4+ min */
  meteorNext = now + gap;
 }
 function spawnMeteor(now) {
  var dir = Math.random() < 0.5 ? 1 : -1;
  var ang = (15 + Math.random() * 20) * Math.PI / 180;
  var speed = 900 + Math.random() * 600;
  var life = 0.5 + Math.random() * 0.4;
  var spanX = WORLD.halfW * 2, spanY = WORLD.halfH * 2;
  var wx0 = dir > 0 ? pole.x - WORLD.halfW - 0.06 * spanX + Math.random() * 0.25 * spanX
                    : pole.x + WORLD.halfW * 0.85 + Math.random() * 0.2 * spanX;
  var wy0 = pole.y - WORLD.halfH + Math.random() * spanY * 0.55;
  meteors.push({ x0: wx0, y0: wy0, vx: Math.cos(ang) * speed * dir, vy: Math.sin(ang) * speed, t0: now, life: life });
 }
 function drawMeteors(now) {
  if (!zoomed && meteors.length === 0 && !satellite && now >= meteorNext) spawnMeteor(now);
  for (var m = meteors.length - 1; m >= 0; m--) {
   var mt = meteors[m];
   var el = (now - mt.t0) / 1000;
   if (el > mt.life) { meteors.splice(m, 1); scheduleMeteor(now); continue; }
   var prog = el / mt.life;
   var env = prog < 0.15 ? smooth01(prog / 0.15) : prog > 0.65 ? 1 - smooth01((prog - 0.65) / 0.35) : 1;
   var whx = mt.x0 + mt.vx * el, why = mt.y0 + mt.vy * el;
   var head = baseToScreen(whx, why);
   var spd = Math.hypot(mt.vx, mt.vy) || 1, ux = mt.vx / spd, uy = mt.vy / spd, tail = 160 * CAM.scale;
   var hx = head.x, hy = head.y;
   var grad = ctx.createLinearGradient(hx - ux * tail, hy - uy * tail, hx, hy);
   grad.addColorStop(0, 'rgba(216,192,138,0)');
   grad.addColorStop(1, 'rgba(233,228,214,' + (0.75 * env) + ')');
   ctx.strokeStyle = grad; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
   ctx.beginPath(); ctx.moveTo(hx - ux * tail, hy - uy * tail); ctx.lineTo(hx, hy); ctx.stroke();
   ctx.beginPath(); ctx.arc(hx, hy, 1.8, 0, 7);
   ctx.fillStyle = 'rgba(240,236,222,' + (0.9 * env) + ')'; ctx.fill();
  }
 }

 /* satellite: a single dim point crossing the world in a slow straight line (35-50s), at most
  every few minutes, never alongside a meteor. no tail, no glow — just a quiet moving dot. */
 function scheduleSatellite(now) {
  satelliteNext = now + 150000 + Math.random() * 120000; /* every 2.5-4.5 min */
 }
 function spawnSatellite(now) {
  var dir = Math.random() < 0.5 ? 1 : -1;
  var ang = (Math.random() * 30 - 15) * Math.PI / 180; /* shallow, near-horizontal path */
  var life = 35 + Math.random() * 15;
  var spanX = WORLD.halfW * 2;
  var speed = (spanX * 1.15) / life;
  var wx0 = dir > 0 ? pole.x - WORLD.halfW - 0.08 * spanX : pole.x + WORLD.halfW + 0.08 * spanX;
  var wy0 = pole.y + (Math.random() * 2 - 1) * WORLD.halfH * 0.5;
  satellite = { x0: wx0, y0: wy0, vx: Math.cos(ang) * speed * dir, vy: Math.sin(ang) * speed * 0.3, t0: now, life: life };
 }
 function drawSatellite(now) {
  if (!zoomed && !satellite && meteors.length === 0 && now >= satelliteNext) spawnSatellite(now);
  if (!satellite) return;
  var el = (now - satellite.t0) / 1000;
  if (el > satellite.life) { satellite = null; scheduleSatellite(now); return; }
  var env = el < 2 ? el / 2 : el > satellite.life - 2 ? (satellite.life - el) / 2 : 1;
  var wx = satellite.x0 + satellite.vx * el, wy = satellite.y0 + satellite.vy * el;
  var p = baseToScreen(wx, wy);
  ctx.beginPath(); ctx.arc(p.x, p.y, 1.1, 0, 7);
  ctx.fillStyle = 'rgba(210,214,222,' + (0.4 * env) + ')';
  ctx.fill();
 }

 /* --- the gaze camera: pointer pans opposite-wise through a damped spring, rubber-banded at
  the world margin; idle (6s no movement, or always on touch when not dragging) wanders on a
  slow Lissajous drift; touch drag pans directly (scaled the same as pointer) with release
  momentum. zoomed or frozen state suspends all of this (the fly-in system / the freeze-tween
  owns CAM then).

  ambient, not navigational: full pointer sweep (or a full-width touch drag) moves the raw
  camera by only ~4-5% of the viewport width (~60-65px at 1440w) — small-amplitude, symbolic
  parallax that's felt more than seen, since the home pose already shows every constellation
  and nothing depends on panning to reach content. GAZE_PF/MID_PF/FAR_PF (declared up with
  gazeCam()) then further split that already-small travel into depth ratios ~.9/.7/.5. K and
  WANDER_AMP below are calibrated against rubber()'s edge response (see the K/WANDER_AMP
  comments) rather than being the raw pixel targets themselves, since rubber() isn't linear
  even well inside the margin. --- */
 var K = 0.057; /* target = home + (pointer - viewportCenter) * K: solved so full pointer travel, after rubber(), lands the raw camera ~4.5% of viewport width from home (was 0.7, ~100% of the margin) */
 var SPRING_TAU = 0.13; /* snappy: CAM starts converging on the very next frame after any pointer move or idle-wander handoff, no gating — kept alive and immediate even though travel is now small */
 var IDLE_MS = 6000;
 var WANDER_PERIOD = 90; /* seconds */
 var WANDER_AMP = 0.028; /* fraction of the margin, solved so idle wander's post-rubber excursion is ~20-25px at 1440w (was 0.15, ~75px) */
 var RUBBER_C = 1.4; /* softness of the edge compression; at these small amplitudes it rarely engages */

 var lastMoveTime = -1e9;
 var gazeIdling = false, gazeIdleStart = 0, gazeIdleAnchorX = 0, gazeIdleAnchorY = 0;
 var touchRawX = 0, touchRawY = 0, touchVelX = 0, touchVelY = 0, touchMomentumActive = false;

 function rubber(raw, margin) {
  if (margin <= 0) return 0;
  var x = raw / margin;
  var k = Math.tanh(RUBBER_C);
  return margin * Math.tanh(x * RUBBER_C) / (k || 1);
 }
 function wanderOffset(now, t0, ax, ay) {
  var t = (now - t0) / 1000;
  return {
   x: ax + WANDER_AMP * WORLD.marginX * Math.sin((2 * Math.PI * t) / WANDER_PERIOD),
   y: ay + WANDER_AMP * WORLD.marginY * Math.sin((2 * Math.PI * t) / (WANDER_PERIOD * 1.5) + 1.3),
  };
 }

 function updateGaze(now, dt) {
  if (still) { CAM.cx = pole.x; CAM.cy = pole.y; return; } /* prefers-reduced-motion / shot mode: static camera, no wander */
  if (zoomed || frozen) return; /* the fly-in system, or the freeze hold/tween, owns CAM while either is active */

  if (touch && ptrDragging) {
   CAM.cx = pole.x + rubber(touchRawX, WORLD.marginX);
   CAM.cy = pole.y + rubber(touchRawY, WORLD.marginY);
   return; /* direct 1:1 drag, no spring lag, per spec */
  }

  var desiredX, desiredY;
  if (touch) {
   if (touchMomentumActive) {
    touchRawX += touchVelX * dt; touchRawY += touchVelY * dt;
    var decay = Math.exp(-dt / 0.4);
    touchVelX *= decay; touchVelY *= decay;
    if (Math.hypot(touchVelX, touchVelY) < 2) {
     touchMomentumActive = false;
     gazeIdling = true; gazeIdleStart = now; gazeIdleAnchorX = touchRawX; gazeIdleAnchorY = touchRawY;
    }
    desiredX = touchRawX; desiredY = touchRawY;
   } else {
    if (!gazeIdling) { gazeIdling = true; gazeIdleStart = now; gazeIdleAnchorX = CAM.cx - pole.x; gazeIdleAnchorY = CAM.cy - pole.y; }
    var w0 = wanderOffset(now, gazeIdleStart, gazeIdleAnchorX, gazeIdleAnchorY);
    desiredX = w0.x; desiredY = w0.y;
   }
  } else if (mouse.x < 0 || now - lastMoveTime > IDLE_MS) {
   if (!gazeIdling) { gazeIdling = true; gazeIdleStart = now; gazeIdleAnchorX = CAM.cx - pole.x; gazeIdleAnchorY = CAM.cy - pole.y; }
   var w1 = wanderOffset(now, gazeIdleStart, gazeIdleAnchorX, gazeIdleAnchorY);
   desiredX = w1.x; desiredY = w1.y;
  } else {
   gazeIdling = false;
   desiredX = (mouse.x - W / 2) * K;
   desiredY = (mouse.y - H / 2) * K;
  }

  var tx = pole.x + rubber(desiredX, WORLD.marginX);
  var ty = pole.y + rubber(desiredY, WORLD.marginY);
  var f = 1 - Math.exp(-dt / SPRING_TAU);
  CAM.cx += (tx - CAM.cx) * f;
  CAM.cy += (ty - CAM.cy) * f;
 }

 var t0 = performance.now(), lastT = t0;
 scheduleMeteor(t0);
 scheduleSatellite(t0);
 function frame(now) {
  if (document.hidden) { if (!still) requestAnimationFrame(frame); return; }
  ctx.clearRect(0, 0, W, H);
  var dt = Math.min((now - lastT) / 1000, 0.1); lastT = now;

  updateCam(now);
  updateGaze(now, dt);

  ctx.drawImage(mwCanvas, 0, 0, W, H); /* atmosphere + nebulous milky-way wash, pre-rendered, composited under the dust */
  var bgMul = zoomed ? 0.35 : 1;
  var nearPf = zoomed ? 1 : GAZE_PF;
  drawPrerenderedLayer(farCanvas, FAR_PF, bgMul);
  drawPrerenderedLayer(midCanvas, MID_PF, bgMul * (0.94 + 0.06 * Math.sin(now / 4000))); /* whole-layer "breathing" stands in for per-star twinkle at near-zero cost */
  drawPrerenderedLayer(nearCanvas, nearPf, bgMul * (0.92 + 0.08 * Math.sin(now / 2600))); /* the ~98% bulk of near, baked (see the dust section note on why) */
  drawDust(dustNearBright, now, nearPf); /* the brightest ~2% of near, still live: real per-star twinkle + halo sprites, at negligible cost since it's only a few dozen stars */

  drawPolaris(now);
  if (!still) { drawMeteors(now); drawSatellite(now); } else if (zoomed) { meteors = []; satellite = null; }

  maybePulse(now);

  /* attention = light: the single constellation nearest the pointer, within ~30% of the
   viewport's short side, eases toward the hover level; everyone else eases back to base.
   geometry (sizeMul) is untouched by this, only alpha. */
  var anyHover = false;
  if (!touch && mouse.x >= 0) {
   var attnR = 0.3 * Math.min(W, H);
   var pp = baseToScreen(pole.x, pole.y);
   if (Math.hypot(mouse.x - pp.x, mouse.y - pp.y) < 14) anyHover = true;
   var nearestC = null, nearestD = Infinity;
   for (var ci = 0; ci < CONS.length; ci++) {
    var cs = baseToScreen(CONS[ci].wx, CONS[ci].wy);
    var dd = Math.hypot(mouse.x - cs.x, mouse.y - cs.y);
    if (dd < nearestD) { nearestD = dd; nearestC = CONS[ci]; }
   }
   for (var cj = 0; cj < CONS.length; cj++) {
    var c = CONS[cj];
    var want = (c === nearestC && nearestD < attnR) ? 1 : 0;
    if (want) anyHover = true;
    c.hover += (want - c.hover) * (still ? 1 : 0.15);
   }
  } else {
   for (var ck = 0; ck < CONS.length; ck++) CONS[ck].hover *= 0.9;
  }

  for (var k = 0; k < CONS.length; k++) drawCon(CONS[k], now);
  drawEcho(now);

  canvas.style.cursor = anyHover ? 'pointer' : '';

  if (!still) requestAnimationFrame(frame);
 }
 function repaint() { frame(performance.now()); }

 /* pointer: on desktop, hover alone drives the gaze camera (see updateGaze); a mouse drag
  never pans, it only distinguishes a click from an accidental jiggle. on touch, one-finger
  drag pans the camera directly with momentum on release; tap still selects. clicking a
  constellation (even while zoomed, hit-tested through the camera transform) flies there;
  clicking polaris toggles freeze (or zooms out first, if a module is open). */
 var ptrActive = false, ptrDragging = false;
 var ptr0 = { x: 0, y: 0 };
 var dragLastX = 0, dragLastY = 0, dragLastT = 0;
 var THRESH = 6;

 canvas.addEventListener('pointerdown', function (e) {
  ptrActive = true; ptrDragging = false;
  ptr0.x = e.clientX; ptr0.y = e.clientY;
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
 });
 canvas.addEventListener('pointermove', function (e) {
  if (!touch) { mouse.x = e.clientX; mouse.y = e.clientY; lastMoveTime = performance.now(); }
  if (!ptrActive) return;
  var dx = e.clientX - ptr0.x, dy = e.clientY - ptr0.y;
  if (!ptrDragging && Math.hypot(dx, dy) > THRESH) {
   ptrDragging = true;
   if (touch && !zoomed) {
    /* resync the drag's raw accumulator to wherever the camera actually is right now (it may
     have drifted via idle wander since the last drag), so the drag can never snap on grab */
    touchRawX = CAM.cx - pole.x; touchRawY = CAM.cy - pole.y;
    touchMomentumActive = false; touchVelX = 0; touchVelY = 0;
    dragLastX = e.clientX; dragLastY = e.clientY; dragLastT = performance.now();
   }
  }
  if (!ptrDragging || zoomed) { if (still) repaint(); return; }
  if (touch) {
   var now = performance.now();
   var mdx = (e.clientX - dragLastX) * K, mdy = (e.clientY - dragLastY) * K; /* same gentle ambient range as pointer gaze, not a 1:1 drag */
   var mdt = Math.max((now - dragLastT) / 1000, 0.001);
   touchRawX -= mdx; touchRawY -= mdy; /* content follows the finger, softly */
   var ivx = -mdx / mdt, ivy = -mdy / mdt;
   touchVelX = touchVelX * 0.7 + ivx * 0.3; touchVelY = touchVelY * 0.7 + ivy * 0.3;
   dragLastX = e.clientX; dragLastY = e.clientY; dragLastT = now;
   if (still) repaint();
  }
 });
 function endPointer(e) {
  if (!ptrActive) return;
  ptrActive = false;
  if (zoomed && ptrDragging) {
   var dxz = e.clientX - ptr0.x;
   if (Math.abs(dxz) > 40) dispatchEvent(new CustomEvent('sky:swipe', { detail: dxz < 0 ? 1 : -1 }));
   ptrDragging = false;
   return;
  }
  if (touch && ptrDragging) {
   touchMomentumActive = true;
   ptrDragging = false;
   return;
  }
  if (!ptrDragging) {
   var pp = baseToScreen(pole.x, pole.y);
   if (Math.hypot(e.clientX - pp.x, e.clientY - pp.y) < 14) {
    onPolarisClick();
   } else {
    for (var i = 0; i < CONS.length; i++) {
     var c = CONS[i];
     var cs = baseToScreen(c.wx, c.wy);
     if (Math.hypot(e.clientX - cs.x, e.clientY - cs.y) < c.rad * (touch ? 1.5 : 1)) {
      dispatchEvent(new CustomEvent('sky:select', { detail: c.id }));
      break;
     }
    }
   }
  }
  ptrDragging = false;
 }
 canvas.addEventListener('pointerup', endPointer);
 canvas.addEventListener('pointercancel', endPointer);
 canvas.addEventListener('pointerleave', function () { mouse.x = -1; mouse.y = -1; });

 addEventListener('resize', function () { layout(); if (still) repaint(); }, { passive: true });

 window.Sky = {
  MODULES: MODULES,
  highlight: function (id, on) { litId = on ? id : (litId === id ? null : litId); if (still) repaint(); },
  repaint: repaint,
  flyTo: flyTo,
  flyOut: flyOut,
  next: stepNext,
  prev: stepPrev,
  home: onPolarisClick,
  echo: setEcho,
  current: function () { return activeId; },
  isZoomed: function () { return zoomed; },
 };

 buildHaloSprites();
 layout();
 requestAnimationFrame(frame);
 if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (still) repaint(); });
})();
