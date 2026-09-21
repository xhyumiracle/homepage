/* v9 sky: the anime frame (deep navy, a luminous blue galaxy, white-hot stars with cyan rims,
 serif labels that glow) on top of the v6 gaze model. v6 notes follow.

 v6 sky: the gaze model. no rotation axis, no fisheye. the world is a plane ~1.7x the
 viewport in each dimension, centered on polaris; every star and constellation gets a
 STATIC world position (the old theta-orbit rest poses, spread further into the extra
 world margin so panning toward an edge reveals content). the camera pans opposite the
 pointer through a damped spring with rubber-band edges at the world margin, "standing
 under the sky, looking around" — but only barely: pan is ambient parallax, not navigation
 (~4-5% of viewport width at full pointer travel; see the K comment down with the gaze
 constants), since the home pose already shows every constellation.

 dust is 4 depth layers (ultra-far/far/mid/near), density-biased into a band so it reads as
 a milky-way star-river, PLUS the milky way's own nebulosity+dark-rift layer — all of it
 generated exactly ONCE, at module init, from a single seeded PRNG (mulberry32, fixed literal
 seed) over a fixed viewport-independent coordinate space. layout() (boot + every resize)
 never re-randomizes any of that: it only re-bakes crops of the fixed field into differently
 sized offscreen world canvases and just drawImage's them each frame — cheap, static
 parallax, no per-star cost. only near's brightest ~2% (the ones with halo sprites) stay
 live-drawn for real per-star twinkle; see the dust-section comment for why (a real, profiled
 frame-budget regression an earlier rewrite hit and fixed). a pan-factor stack (GAZE_PF/
 MID_PF/FAR_PF/ULTRA_FAR_PF/MW_PF) further dampens how much of the camera's already-small raw
 excursion each depth layer actually shows — including the milky way itself, which used to be
 blitted screen-locked with no parallax term at all (see the root-cause note by mwField()).

 the milky way is one physical field (mwField(): seeded fBm clouds + a carved Great-Rift dark
 lane along the band spine), not two independently-random overlays: star density AND alpha in
 every layer read from the same field the nebulosity canvas paints, so faint stars visibly
 cluster where the cloud is bright and thin out inside the rift.

 attention (the constellation nearest the pointer) is light, never size. idle drifts on a
 slow Lissajous wander; touch drags the camera directly (same gentle range) with momentum. a
 click on polaris toggles a frozen mode (camera eases home and holds, wander suspended,
 subtle ring on polaris) unless a module is open, in which case it zooms out first as before.
 the sky background carries a pre-rendered atmosphere: a faint horizon lift and a gentle
 vignette, both screen-space (a lens effect, not sky content) and both plain fixed-stop
 gradients — no randomness ever touched them. module/shell logic (including the corner
 shell's own auto-scroll) lives in main.js. */
(function () {
 var canvas = document.getElementById('sky');
 var ctx = canvas.getContext('2d');
 var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
 var touch = matchMedia('(hover: none)').matches;
 var shotM = /[?&]shot(?:=([a-z0-9]+))?/.exec(location.search);
 var shot = !!shotM;
 var still = reduced || shot;

 var MODULES = ['research', 'projects', 'talks', 'about'];

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
  hover/attention). Orion (about): classic outline quadrilateral Betelgeuse-Bellatrix-Rigel-
  Saiph plus the belt as its own separate 3-star polyline. Pleiades (talks): real mini-dipper
  arrangement, 9 named stars, no connecting lines. */
 var CONS = [
  { id: 'about', name: 'about', sub: 'career · education · honors', scaleF: 0.19,
   /* Betelgeuse, Bellatrix, Rigel, Saiph, Alnitak, Alnilam, Mintaka */
   pts: [[.20,.05],[.62,.12],[.72,.90],[.28,.95],[.34,.48],[.44,.52],[.54,.56]],
   lines: [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6]], warmIdx: 0 },
  { id: 'projects', name: 'projects', sub: 'SafeClaw · open source', scaleF: 0.15,
   pts: [[0,.10],[.12,.35],[.35,.60],[.50,.68],[.72,.55],[.82,.18],[.95,.05]],
   lines: [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,0]], specialIdx: 6 },
  { id: 'research', name: 'research', sub: 'ICL PhD · 4 papers', scaleF: 0.15,
   pts: [[.15,.10],[.30,.02],[.32,.25],[.55,.35],[.50,.62],[.72,.60]],
   lines: [[0,1],[0,2],[2,3],[3,5],[5,4],[4,2]], brightIdx: 0 },
  { id: 'talks', name: 'talks', sub: '9 talks · 2018 to 2026', scaleF: 0.17,
   /* Atlas, Alcyone, Merope, Electra, Maia, Taygeta, Pleione, Celaeno, Sterope */
   pts: [[.72,.30],[.58,.38],[.50,.56],[.36,.50],[.40,.30],[.28,.26],[.76,.22],[.30,.38],[.36,.20]],
   /* v9: it carries a module now, so it gets the mini-dipper drawn in — bowl Alcyone-Merope-Electra-Maia, handle out to Atlas, tip to Taygeta */
   sizes: [1.5,1.8,1.3,1.35,1.4,1.2,1.1,1.0,1.0], lines: [[1,2],[2,3],[3,4],[4,1],[1,0],[4,5]], brightIdx: 1 },
 ];
 var byId = {};
 CONS.forEach(function (c) { byId[c.id] = c; c.hover = 0; c.pulseStart = null; });

 /* static world placement: each constellation keeps its old theta=0 direction (ORBIT.ang) but
  the amplitude is now measured against the 1.7x WORLD half-extent instead of the viewport
  half-extent, so the same "clear of chrome, non-overlapping" margin math that used to bound
  the rest pose to the viewport now spreads the shape out into the extra world margin instead:
  about upper-left, projects right, research lower-right, talks mid-left, same as before, just
  further out. no per-frame recompute: c.wx/c.wy are written once in layout() and read forever. */
 var ORBIT = {
  about:    { ang: d2r(205), fracA: .30, fracB: .42 },
  projects: { ang: d2r(5),   fracA: .46, fracB: .66 },
  research: { ang: d2r(60),  fracA: .46, fracB: .56 },
  talks:    { ang: d2r(175), fracA: .46, fracB: .48 },
 };

 var pulseNext = 0, lastPulseId = null;

 /* pan-factor stack: how much of the camera's raw excursion from home each depth plane shows.
  K (below, with the gaze constants) controls how far the camera itself travels per pointer
  pixel; these factors independently damp what each layer actually displays, so a single
  pointer swing reads as real depth rather than a flat pan. only the near/constellation plane
  snaps to a factor of 1 while a module is zoomed (precise fly-to navigation there, no gaze
  damping); far/mid dust keep their parallax always, zoomed or not. */
 var GAZE_PF = 1.0, MID_PF = 0.7, FAR_PF = 0.45, ULTRA_FAR_PF = 0.3, MW_PF = 0.34; /* widened slightly from the old .9/.7/.5 near/mid/far so depth separation reads more clearly; ULTRA_FAR/MW sit further back than far still */
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

 /* --- deterministic sky generation ---
  every star position/size/alpha/color, the milky-way nebulosity field (fbm clouds + the dark
  rift), and the band structure are all drawn from ONE seeded PRNG (mulberry32, fixed literal
  seed) and generated in a FIXED, viewport-independent local coordinate space (GEN_HALF_W/H
  below) centered on the world origin. layout() never re-randomizes any of it on resize/zoom:
  resize only changes WORLD (the viewport-sized "view window" cropped out of this fixed field)
  and re-bakes the crop into differently-sized offscreen canvases. that's what makes the sky
  pixel-stable in world space across resizes/dpr/reloads — only the projection (what part of
  the fixed field is visible, and at what canvas resolution) ever changes.

  root-cause note (the earlier "no dust on real browsers" regression, now moot but the lesson
  still applies): genLayer() used to read the shared `pole`/`WORLD` closure vars directly, which
  layout() only writes at its very end (the "commit" step, by design: a half-built layout should
  never clobber a good one) — calling genLayer() before that commit collapsed every star to
  pole={x:0,y:0}. the fix then was threading fresh values through explicitly; the fix now goes
  further and removes pole/WORLD from star generation entirely (see below), so that whole class
  of bug can't recur and, as a side effect, resize no longer re-samples anything. */
 var RNG_SEED = 0x9E3779B9;
 function mulberry32(seed) {
  return function () {
   seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
   var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
   t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
   return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
 }
 var rng = mulberry32(RNG_SEED);
 var GEN_HALF_W = 1900, GEN_HALF_H = 1300; /* fixed generation extent: comfortably covers WORLD.halfW/halfH (= viewport*0.85) for any realistic browser window; a viewport wide enough to exceed it just loses a little content at the fringe rather than breaking */

 /* value-noise fBm over an unbounded integer lattice, hashed (not stored) so there's no tiling
  seam: hash2() is a fixed deterministic function of (seed, ix, iy), independent of rng()'s
  sequential draw order, so it can be called any number of times in any order without disturbing
  the star-generation sequence below. */
 function hash2(ix, iy) {
  var h = (ix * 374761393 + iy * 668265263 + RNG_SEED * 2654435761) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967295;
 }
 function smootherstep(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
 function valueNoise2D(x, y) {
  var x0 = Math.floor(x), y0 = Math.floor(y);
  var fx = smootherstep(x - x0), fy = smootherstep(y - y0);
  var v00 = hash2(x0, y0), v10 = hash2(x0 + 1, y0), v01 = hash2(x0, y0 + 1), v11 = hash2(x0 + 1, y0 + 1);
  var a = v00 + (v10 - v00) * fx, b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fy;
 }
 var MW_OCTAVES = 5;
 function fbm(x, y, octaves) {
  var amp = 0.55, freq = 1, sum = 0, norm = 0;
  var n = octaves || MW_OCTAVES;
  for (var o = 0; o < n; o++) {
   sum += amp * valueNoise2D(x * freq, y * freq);
   norm += amp;
   amp *= 0.54; freq *= 2.13; /* slightly irregular lacunarity/persistence so the octaves don't stack into an obviously self-similar pattern */
  }
  return sum / norm;
 }

 /* the milky way band: one shared field function, mwField(), that every consumer reads from —
  star generation (density AND alpha) below, and the nebulosity canvas further down. that's the
  "one physical object, not two overlays" fix: there is exactly one procedural galaxy here, and
  everything else just samples it.

  root-cause note (the "screen-space fog" complaint): the old buildAtmosphere() painted its
  nebulosity blobs straight onto a viewport-sized canvas that frame() drew at a fixed (0,0)
  offset every frame, with NO camera/parallax term at all — every other depth layer (far/mid/
  near dust, constellations) pans with gazeCam(), so the milky way sat visually glued to the
  glass while everything behind/around it drifted, which is exactly what reads as "fog on the
  lens" instead of "part of the sky" (and, separately, its per-layout Math.random() blob
  scatter meant resize/zoom regenerated a different cloud shape — the two complaints share one
  root cause: it was never treated as sky content). the fix below bakes the field into a WORLD-
  sized canvas (mwWorldCanvas) exactly like the star layers and draws it through
  drawPrerenderedLayer() with its own pan factor (MW_PF), so it participates in the same
  parallax stack, and its shape comes from the same fixed seed as everything else. */
 var MW_ANGLE = -0.58;
 var MW_DIR_X = Math.cos(MW_ANGLE), MW_DIR_Y = Math.sin(MW_ANGLE);
 var MW_PERP_X = -Math.sin(MW_ANGLE), MW_PERP_Y = Math.cos(MW_ANGLE);
 var BAND_SIGMA = 150; /* perpendicular half-width of the overall band envelope — ~45% of the original 230; the architect's visual review called the wider band "storm haze" dominating the frame, this narrows it to a proper river */
 var MW_SCALE_ALONG = 340, MW_SCALE_PERP = 130; /* fbm feature scale, anisotropic so cloud structure elongates along the band rather than reading as isotropic static */

 /* the Great Rift: a single meandering dark dust lane along the band's spine, carved out of the
  same field it dims — not a separate mask. shape (two sine harmonics) and placement (center/
  length/width) are all drawn from the shared seeded rng() at module init, once, so the rift's
  path never changes across reloads/resizes. covers roughly a third of the band's length, per
  the real Great Rift (it doesn't run the band's whole length), tapered by a gaussian envelope
  rather than a hard cutoff. */
 var RIFT = (function () {
  return {
   f1: 0.85 + rng() * 0.5, f2: 2.0 + rng() * 0.9,
   p1: rng() * Math.PI * 2, p2: rng() * Math.PI * 2,
   a1: 85 + rng() * 35, a2: 26 + rng() * 18,
   center: (rng() * 2 - 1) * 260,
   halfLen: 560 + rng() * 160,
   widthBase: 50 + rng() * 18,
  };
 })();
 /* the rift's width jitter is a 1-D function of `along` only, so it's tabulated once (4px steps
  over the whole generation extent) instead of costing a full fbm() per pixel in the mw bake. */
 var RIFT_WJ_STEP = 4, RIFT_WJ = (function () {
  var n = Math.ceil(GEN_HALF_W * 2 / RIFT_WJ_STEP) + 2, t = new Float32Array(n);
  for (var i = 0; i < n; i++) t[i] = 0.72 + 0.5 * fbm((i * RIFT_WJ_STEP - GEN_HALF_W) / 900 + 40, 11);
  return t;
 })();
 function riftWidthJit(along) {
  var i = Math.round((along + GEN_HALF_W) / RIFT_WJ_STEP);
  return RIFT_WJ[i < 0 ? 0 : i >= RIFT_WJ.length ? RIFT_WJ.length - 1 : i];
 }
 function riftCenterline(along) {
  var t = along / 480;
  return RIFT.a1 * Math.sin(t * RIFT.f1 + RIFT.p1) + RIFT.a2 * Math.sin(t * RIFT.f2 + RIFT.p2);
 }
 function mwField(lx, ly) {
  var along = lx * MW_DIR_X + ly * MW_DIR_Y;
  var perp = lx * MW_PERP_X + ly * MW_PERP_Y;
  var bandEnv = Math.exp(-(perp * perp) / (2 * BAND_SIGMA * BAND_SIGMA));
  var neb = fbm(along / MW_SCALE_ALONG, perp / MW_SCALE_PERP);
  var edgeFade = 1 - smooth01((Math.abs(along) - GEN_HALF_W * 0.72) / (GEN_HALF_W * 0.26)); /* fades the field out before the fixed generation extent's own edge, so a viewport wide enough to approach GEN_HALF_W never shows a hard boundary */
  var widthJit = riftWidthJit(along);
  var rc = riftCenterline(along);
  var renv = Math.exp(-Math.pow(along - RIFT.center, 2) / (2 * RIFT.halfLen * RIFT.halfLen));
  var rw = RIFT.widthBase * widthJit;
  var rift = renv * Math.exp(-Math.pow(perp - rc, 2) / (2 * rw * rw));
  /* v9: the cloud gets a contrast curve (so it reads as clumps and wisps, not an even haze) plus
   a finer wispy octave, and the band envelope gains a wide, faint second gaussian so the blue
   diffuses well beyond the river itself — that spill is most of what makes the reference frame
   feel blue rather than black-with-a-stripe. */
  var nebC = smooth01((neb - 0.26) / 0.62);
  var wisp = fbm(along / (MW_SCALE_ALONG * 0.22) + 7.3, perp / (MW_SCALE_PERP * 0.22) - 3.1, 3); /* 3 octaves: this term only supplies the fine structure, the low frequencies are already in `neb`; keeps the per-layout bake cost close to v6 */
  var wispC = smooth01((wisp - 0.3) / 0.6);
  var spill = Math.exp(-(perp * perp) / (2 * (BAND_SIGMA * 2.4) * (BAND_SIGMA * 2.4)));
  var bright = (bandEnv * (0.18 + 0.82 * nebC) * (0.55 + 0.65 * wispC) + spill * 0.3 * (0.4 + 0.6 * neb)) * edgeFade;
  bright *= (1 - 0.62 * rift); /* carve the dark lane — dust never quite fully occludes, same as the real thing */
  return { bright: Math.max(0, bright), perp: perp, along: along, rift: rift, bandEnv: bandEnv };
 }

 /* star generation: rejection-sampled over the FIXED GEN_HALF_W/H extent (never the viewport-
  scaled WORLD — see the determinism note above), reading density AND alpha from the same
  mwField() the nebulosity canvas paints, so faint stars visibly thin out inside the rift and
  cluster where the cloud is bright — coupling, not two independently-random overlays.
  `coupling` blends between full mwField-driven density (1, far/mid) and the old flatter
  band-only gaussian (0, closer to near's original near-uniform foreground feel). */
 function genLayer(count, opt) {
  var out = [];
  var guard = 0, need = count;
  var floor = opt.floor != null ? opt.floor : 0.35;
  var coupling = opt.coupling != null ? opt.coupling : 1;
  while (out.length < need && guard < need * 40) {
   guard++;
   var x = (rng() * 2 - 1) * GEN_HALF_W;
   var y = (rng() * 2 - 1) * GEN_HALF_H;
   var f = mwField(x, y);
   var bf = coupling * f.bright + (1 - coupling) * f.bandEnv;
   if (rng() > floor + (1 - floor) * bf) continue;
   var b = Math.pow(rng(), opt.pow);
   var haloAt = opt.haloAt != null ? opt.haloAt : 0.93;
   var halo = !!(opt.halo && b > haloAt);
   var live = !!(halo && b > (opt.liveAt != null ? opt.liveAt : 0.985)); /* the tiny live-drawn sliver (real twinkle); every other halo is baked */
   var tr = rng();
   out.push({
    x: x, y: y,
    size: (opt.sizeMin + b * (opt.sizeMax - opt.sizeMin)) * (0.88 + rng() * 0.24),
    alpha: (opt.alphaMin + b * (opt.alphaMax - opt.alphaMin)) * (0.62 + 0.38 * (1 - f.rift)), /* dim behind the rift — same field, no separate pass */
    ph: rng() * Math.PI * 2,
    sp: 0.4 + rng() * 1.1,
    tw: opt.tw || 0,
    tint: tr < 0.3 ? '234,245,255' : tr < 0.75 ? '140,225,255' : tr < 0.95 ? '110,178,255' : '255,236,208', /* v9 anime palette: white, cyan-white, blue, a rare warm one */
    halo: halo,
    live: live,
   });
  }
  return out;
 }

 /* the whole sky's content — every layer's stars — generated exactly once, at module init, from
  the seeded rng() in the fixed GEN_HALF_W/H space above. layout() (boot + every resize) never
  touches this again: it only re-bakes crops of it (prerenderLayer/buildMilkyWay below) into
  viewport-sized offscreen canvases. counts are calibrated against the fixed generation area
  (not the viewport), so — unlike the old per-resize regeneration — a phone simply sees a
  smaller crop of the same field at the same density, rather than a separately-randomized,
  lower-count sky; the old mobile/desktop count split is gone for the same reason. */
 var SKY = { ultraFar: [], far: [], mid: [], near: [], nearBulk: [], nearBright: [] };
 function buildSkyContent() {
  SKY.ultraFar = genLayer(2600, { sizeMin: .14, sizeMax: .3, alphaMin: .08, alphaMax: .2, pow: 3.4, floor: .10, coupling: .7 });
  /* far/mid alphaMin/alphaMax nudged up (~+15-20%, floor untouched so the off-band sky stays
   near-black) per the architect's "grain first" note: with the cloud opacity cut way down
   (see buildMilkyWay), the band needs to read as dense faint stars with cloud structure behind
   them, not the other way around. */
  /* v9 (the anime sky): every layer lifted in size and alpha so the field reads as a dense,
   bright, blue-white sky rather than grain on black; mid and near both carry halos now (a
   white-hot core inside a cyan rim, see prerenderLayer/drawDust), baked except for near's
   brightest ~1.5% (`live`) which still twinkles per-star. */
  SKY.far = genLayer(8400, { sizeMin: .34, sizeMax: .8, alphaMin: .24, alphaMax: .6, pow: 2.3, floor: .16, coupling: 1 });
  SKY.mid = genLayer(5800, { sizeMin: .55, sizeMax: 1.7, alphaMin: .35, alphaMax: .9, pow: 2.6, floor: .22, coupling: 1, halo: true, haloAt: .86, liveAt: 2 });
  var nearAll = genLayer(3700, { sizeMin: .7, sizeMax: 3.1, alphaMin: .5, alphaMax: 1, pow: 2.8, tw: .26, halo: true, haloAt: .74, liveAt: .985, floor: .55, coupling: .45 });
  SKY.near = nearAll;
  SKY.nearBulk = []; SKY.nearBright = [];
  for (var i = 0; i < nearAll.length; i++) (nearAll[i].live ? SKY.nearBright : SKY.nearBulk).push(nearAll[i]);
 }

 /* ultra-far/far/mid/near-bulk: baked once per layout() onto world-sized offscreen canvases (one
  per layer, sized to the CURRENT WORLD view window) at a reduced resolution (bakeScale) — cheap
  to rasterize and, far more importantly, cheap for drawImage() to resample every frame in a
  software (non-GPU-composited) canvas backend.

  root-cause note (a real, profiled ~45ms/frame regression this pass hit and fixed, and the
  reason bakeScale is now a FUNCTION of world size rather than a fixed constant): raising
  bakeScale toward 0.75+ (attempting the "0.75, or full res if the budget allows" brief) looked
  fine in isolation at one viewport size, then fell off a cliff — 40-60ms/frame — as soon as (a)
  more than one layer sat near that scale at once, or (b) the viewport got larger (1920x1080,
  2560x1200: same code, same bakeScale constants, catastrophically slow). CDP CPU profiling kept
  attributing the cost to whichever fill()/drawImage() happened to run right after the bake
  canvases were touched — not a consistent single call site — which is the signature of a shared
  resource being thrashed: the browser's own GPU/raster cache for canvas backing stores has a
  roughly fixed memory budget, and once the COMBINED byte size of every baked canvas (not any one
  canvas alone) crosses it, they stop fitting together and get evicted/re-uploaded constantly.
  confirmed empirically (isolated headless profiling, A/B against this same file's git history):
  ~0.9ms/frame comfortably under the budget, ~45ms/frame just over it, at the same viewport; and
  world area — which is what actually drives each canvas's pixel count — scales with
  viewport²-ish, so a bakeScale that's safe at 1440×900 is not safe at 1920×1080.

  the fix: pick bakeScale adaptively so the total pixel budget across all 5 baked canvases stays
  roughly CONSTANT regardless of viewport size, rather than a fixed fraction of a variable-sized
  world. small viewports (including mobile) get sharper baking, up to BAKE_MAX; very large
  viewports back off automatically rather than ever crossing the cliff. PX_BUDGET below is
  calibrated with headroom under the empirically-found threshold (re-profile via PERF/perf() if
  porting to a different rendering backend — the cliff is backend-specific, not a fixed number).

  only near's brightest ~2% (SKY.nearBright, the ones with halo sprites) stay live-drawn per-star
  for real twinkle; see drawDust below. */
 var BAKE_MIN = 0.3, BAKE_MAX = 0.85;
 var PX_BUDGET = { ultraFar: 550000, far: 900000, mid: 1100000, near: 1350000, mw: 330000 }; /* mw budget cut 550k -> 330k in v9: the nebula field costs two fbm() calls per pixel now and is a smooth object anyway, so it can afford the softer bake — measured ~2x cheaper per layout() with no visible loss */ /* ~4.45M px total (~18MB @ 4B/px) offscreen, at MAIN_PX_REF main-canvas size — see budgetScaleFor() for why this also backs off further on very large/high-dpr viewports */
 var MAIN_PX_REF = 1300000; /* ~1440x900: the viewport size this budget was profiled against */
 function budgetScaleFor() {
  /* the cliff empirically also gets worse as the MAIN visible canvas's own backing store
   (W*dpr x H*dpr, set in layout()) grows — a 3440x1440 ultrawide or a high-dpr desktop eats
   into whatever shared resource is being thrashed even with the offscreen budget above held
   constant. back the whole offscreen budget off further, beyond MAIN_PX_REF, so those cases
   don't recreate the cliff; only matters well past ordinary desktop sizes (BAKE_MIN still
   applies as a floor so this never makes anything vanish). */
  var mainPx = canvas.width * canvas.height;
  if (mainPx <= MAIN_PX_REF) return 1;
  return MAIN_PX_REF / mainPx;
 }
 function bakeScaleFor(worldRef, budgetPx) {
  var area = worldRef.halfW * 2 * worldRef.halfH * 2;
  if (area <= 0) return BAKE_MAX;
  return Math.max(BAKE_MIN, Math.min(BAKE_MAX, Math.sqrt(budgetPx * budgetScaleFor() / area)));
 }
 var ultraFarCanvas = document.createElement('canvas'), ultraFarCtx = ultraFarCanvas.getContext('2d');
 var farCanvas = document.createElement('canvas'), farCtx = farCanvas.getContext('2d');
 var midCanvas = document.createElement('canvas'), midCtx = midCanvas.getContext('2d');
 var nearCanvas = document.createElement('canvas'), nearCtx = nearCanvas.getContext('2d');
 function prerenderLayer(canvas, cctx, stars, worldRef, bakeScale) {
  var w = worldRef.halfW * 2, h = worldRef.halfH * 2;
  canvas.width = Math.max(1, Math.round(w * bakeScale));
  canvas.height = Math.max(1, Math.round(h * bakeScale));
  cctx.setTransform(bakeScale, 0, 0, bakeScale, 0, 0); /* star math below stays in full CSS-world units; the transform is what actually shrinks the backing store */
  cctx.clearRect(0, 0, w, h);
  var grads = buildHaloGradients(cctx); /* per-bake-context unit gradients (a handful of objects per layout(), not per star) */
  for (var i = 0; i < stars.length; i++) {
   var s = stars[i];
   var cx = s.x + worldRef.halfW, cy = s.y + worldRef.halfH; /* local (pole-relative) -> canvas pixel; pole itself never enters this math, which is exactly what keeps content pixel-stable across resizes */
   if (cx < -4 || cx > w + 4 || cy < -4 || cy > h + 4) continue; /* the fixed generation extent can exceed a narrow WORLD (e.g. mobile); skip what won't be visible rather than paying for it */
   if (s.halo) {
    /* baked halo: the same white-core/colored-rim sprite drawDust paints live, minus twinkle.
     rasterized once here so the per-frame cost of hundreds of glowing stars is one drawImage */
    var hr = s.size * HALO_R;
    cctx.save();
    cctx.translate(cx, cy); cctx.scale(hr, hr);
    cctx.globalAlpha = s.alpha;
    cctx.beginPath(); cctx.arc(0, 0, 1, 0, 7);
    cctx.fillStyle = grads[s.tint]; cctx.fill();
    cctx.restore();
    cctx.globalAlpha = 1;
    cctx.beginPath();
    cctx.arc(cx, cy, s.size * 0.85, 0, 7);
    cctx.fillStyle = 'rgba(' + CORE_TINT + ',' + Math.min(1, s.alpha * 1.1) + ')';
    cctx.fill();
    continue;
   }
   cctx.beginPath();
   cctx.arc(cx, cy, s.size, 0, 7);
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

 /* one unit-radius (center 0,0, radius 1) radial gradient per tint, built ONCE and reused every
  frame via ctx.translate()+ctx.scale() (a CanvasGradient's stops live in user space and are
  evaluated against whatever transform is active when it's actually painted, so translating/
  scaling the canvas before fill() re-centers and re-sizes it for free — no new gradient object
  needed per star). HALO_TINTS mirrors the tint choices in genLayer().

  root-cause note (a real, profiled ~40ms/frame regression this pass hit, twice): first pass
  used a small pre-baked 24x24 canvas, drawImage()'d per star — profiling (a monkey-patched
  CanvasRenderingContext2D.prototype.drawImage, timed via CDP) found that specific call costing
  ~2.7ms EACH here, so replaced with a live arc()+fill() using a *freshly created*
  createRadialGradient() per star per frame. that traded the drawImage cost for a new one: a CPU
  profile (Profiler.start/stop over the actual running page, not a synthetic benchmark — an
  isolated microbenchmark of the same fill() call in isolation showed it as cheap, which is what
  pointed at allocation churn rather than raster cost) showed ~93% of frame time still inside
  drawDust's fill(), concentrated in occasional single ~35-44ms spikes rather than many small
  costs — the signature of GC pressure from reallocating ~15-80 gradient objects (each with 3
  addColorStop calls) every frame, not of the fill() itself being slow. building the gradient(s)
  once and reusing them via the transform, below, removes that allocation entirely. */
 var HALO_TINTS = ['234,245,255', '140,225,255', '110,178,255', '255,236,208'];
 var CORE_TINT = '250,253,255'; /* every halo star has the same white-hot center; only the rim carries the tint */
 var HALO_R = 2.7; /* halo radius as a multiple of the core radius: compact — a tight glow around a bright point, not a bloom */
 var haloGrad = {};
 function buildHaloGradients(c) {
  var out = {};
  HALO_TINTS.forEach(function (tint) {
   var g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
   g.addColorStop(0, 'rgba(' + CORE_TINT + ',.95)');
   g.addColorStop(0.36, 'rgba(' + tint + ',.6)');
   g.addColorStop(0.68, 'rgba(' + tint + ',.16)');
   g.addColorStop(1, 'rgba(' + tint + ',0)');
   out[tint] = g;
  });
  return out;
 }

 /* live dust layer draw (near's brightest sliver only): `pf` (pan factor) is how much of the
  camera's displacement from home this layer feels — same trick as drawPrerenderedLayer, just
  per-star since this sliver still twinkles and carries a halo glow. s.x/s.y are local (pole-
  relative); lcx/lcy below are the camera's displacement in that same local frame, so pole never
  has to appear in the per-star math either. */
 function drawDust(layer, now, pf) {
  var lcx = (CAM.cx - pole.x) * pf, lcy = (CAM.cy - pole.y) * pf;
  var bgMul = zoomed ? 0.35 : 1;
  for (var i = 0; i < layer.length; i++) {
   var s = layer[i];
   var sx = (s.x - lcx) * CAM.scale + W / 2, sy = (s.y - lcy) * CAM.scale + H / 2;
   if (sx < -8 || sx > W + 8 || sy < -8 || sy > H + 8) continue;
   var tw = still ? 1 : (1 - s.tw) + s.tw * (0.72 + 0.28 * Math.sin((now / 1000) * s.sp + s.ph));
   var rr = s.size * Math.max(CAM.scale, 0.6);
   if (s.halo) {
    var hgrad = haloGrad[s.tint];
    if (hgrad) {
     var hr = rr * HALO_R;
     ctx.save();
     ctx.translate(sx, sy); ctx.scale(hr, hr);
     ctx.globalAlpha = s.alpha * tw * bgMul;
     ctx.beginPath(); ctx.arc(0, 0, 1, 0, 7);
     ctx.fillStyle = hgrad; ctx.fill();
     ctx.restore();
     ctx.globalAlpha = 1;
    }
   }
   ctx.beginPath();
   ctx.arc(sx, sy, s.halo ? rr * 0.85 : rr, 0, 7);
   ctx.fillStyle = 'rgba(' + (s.halo ? CORE_TINT : s.tint) + ',' + Math.min(1, s.alpha * tw * bgMul * (s.halo ? 1.1 : 1)) + ')';
   ctx.fill();
  }
 }

 /* the milky way itself: mwField() rasterized directly into a world-sized ImageData buffer (one
  putImageData() rather than thousands of gradient-fill draw calls — much cheaper for a noise
  field sampled per-pixel) at an adaptive bakeScale (see bakeScaleFor()), then drawn every frame exactly like the star
  layers via drawPrerenderedLayer(mwWorldCanvas, MW_PF, ...) — a real parallaxing world object,
  not a screen-locked wash (see the root-cause note by mwField()). color: a low-saturation blend
  from a slightly warm core (near the band spine, small |perp|) to a cooler edge (further out
  but still inside the band envelope), per the warm-core/cool-edge brief. */
 var mwWorldCanvas = document.createElement('canvas'), mwWorldCtx = mwWorldCanvas.getContext('2d');
 function buildMilkyWay(worldRef, bakeScale) {
  var w = Math.max(1, Math.round(worldRef.halfW * 2 * bakeScale));
  var h = Math.max(1, Math.round(worldRef.halfH * 2 * bakeScale));
  mwWorldCanvas.width = w; mwWorldCanvas.height = h;
  var img = mwWorldCtx.createImageData(w, h);
  var data = img.data;
  /* architect's visual review tuning pass: WARM pulled way down in saturation (was a distinct
   brown, now barely off-grey) and COOL shifted toward neutral with a faint blue undertone, so
   the color reads as "slight warm tint right at the spine" rather than warm-grey-brown
   everywhere; the core-tint falloff (coreW below) is also tightened (0.85->0.5 of BAND_SIGMA)
   so that tint stays tight to the spine instead of spreading across the whole band width. */
  /* v9 (the anime sky): the galaxy is blue now. three-stop ramp by local brightness — deep
   blue in the faint spill, saturated sky-blue through the body of the band, and a pale
   cyan-white only in the brightest clumps — at a real opacity, so the band is a luminous
   object the stars sit in, not a grey smudge behind them. */
  var DEEP = [16, 58, 128], BODY = [40, 118, 208], HOT = [90, 164, 240];
  for (var py = 0; py < h; py++) {
   var ly = (py / bakeScale) - worldRef.halfH;
   for (var px = 0; px < w; px++) {
    var lx = (px / bakeScale) - worldRef.halfW;
    var f = mwField(lx, ly);
    if (f.bright <= 0.004) continue; /* leave fully transparent — ImageData is zero-inited */
    var idx = (py * w + px) * 4;
    var b = Math.min(1, f.bright);
    var t1 = smooth01(b / 0.6), t2 = smooth01((b - 0.82) / 0.3);
    data[idx] = (DEEP[0] + (BODY[0] - DEEP[0]) * t1) * (1 - t2) + HOT[0] * t2;
    data[idx + 1] = (DEEP[1] + (BODY[1] - DEEP[1]) * t1) * (1 - t2) + HOT[1] * t2;
    data[idx + 2] = (DEEP[2] + (BODY[2] - DEEP[2]) * t1) * (1 - t2) + HOT[2] * t2;
    data[idx + 3] = Math.round(Math.pow(b, 0.8) * 0.52 * 255); /* was .30 (~+30% peak lift, "storm haze"); cut to .12 (~0.4x, ~+10% peak lift) per architect review — the sky outside the band should stay near-black */
   }
  }
  mwWorldCtx.putImageData(img, 0, 0);
 }

 /* screen-space atmosphere: horizon lift + vignette only now (the nebulosity/band wash moved to
  mwWorldCanvas above, so it can parallax). both gradients here are plain fixed color stops — no
  randomness ever touched them, so "seeded/deterministic" was already true; kept as a viewport-
  sized, camera-independent lens effect on purpose (it's fog on the glass, literally — just not
  what used to be misrepresenting the milky way). */
 var mwCanvas = document.createElement('canvas'), mwCtx = mwCanvas.getContext('2d');
 function buildAtmosphere() {
  mwCanvas.width = Math.max(1, W); mwCanvas.height = Math.max(1, H);
  mwCtx.clearRect(0, 0, W, H);
  var cx = W / 2, cy = H / 2;

  /* horizon glow: darkest at top, a ~4%-luminance lift toward the bottom edge. never flat black. */
  var vgrad = mwCtx.createLinearGradient(0, 0, 0, H);
  vgrad.addColorStop(0, 'rgba(60,120,200,0)');
  vgrad.addColorStop(0.5, 'rgba(60,120,200,0)');
  vgrad.addColorStop(1, 'rgba(70,135,215,.09)');
  mwCtx.fillStyle = vgrad;
  mwCtx.fillRect(0, 0, W, H);

  /* gentle radial vignette */
  var vig = mwCtx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(W, H) * 0.62);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,4,14,.18)');
  mwCtx.fillStyle = vig;
  mwCtx.fillRect(0, 0, W, H);
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

   var newPole = { x: W * 0.5, y: H * 0.5 }; /* polaris = world center = camera home. note: the camera rests ON the pole, so the pole always renders at screen center whatever this is; mobile clearance for the stacked header is done with MOBILE_DY below, not here */
   var MOBILE_DY = mobile ? H * 0.12 : 0; /* v9: the header is taller (affiliation + positioning lines), so on mobile every constellation sits this much further down the world than its desktop rest pose */
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
    var orbitB = Math.max(o.fracB * newWorld.halfH * (mobile ? 0.75 : 1) - marginY, floor); /* mobile: squeeze the vertical spread so the MOBILE_DY shift doesn't push the bottom constellation off-screen */
    var wx = newPole.x + orbitA * Math.cos(o.ang), wy = newPole.y + orbitB * Math.sin(o.ang) + MOBILE_DY;
    results[i] = {
     localPts: shape.localPts, maxR: shape.maxR, wx: wx, wy: wy,
     rad: Math.max(shape.maxR + scale * 0.28, 46),
     align: wx > newPole.x ? 'right' : 'left',
     labelDY: shape.maxR + 24,
    };
   }

   /* star content itself (SKY.*) was generated exactly once at module init — see
    buildSkyContent(). all layout() does here is re-bake crops of it, sized to the current
    WORLD view window, into the offscreen canvases; nothing here is randomized. bakeScale is
    recomputed every layout() from the current world size — see bakeScaleFor()'s comment above
    for why it's adaptive rather than a fixed constant. */
   prerenderLayer(ultraFarCanvas, ultraFarCtx, SKY.ultraFar, newWorld, bakeScaleFor(newWorld, PX_BUDGET.ultraFar));
   prerenderLayer(farCanvas, farCtx, SKY.far, newWorld, bakeScaleFor(newWorld, PX_BUDGET.far));
   prerenderLayer(midCanvas, midCtx, SKY.mid, newWorld, bakeScaleFor(newWorld, PX_BUDGET.mid));
   prerenderLayer(nearCanvas, nearCtx, SKY.nearBulk, newWorld, bakeScaleFor(newWorld, PX_BUDGET.near));
   buildMilkyWay(newWorld, bakeScaleFor(newWorld, PX_BUDGET.mw));
   buildAtmosphere();

   /* --- commit: everything above succeeded, so write it all at once. --- */
   pole.x = newPole.x; pole.y = newPole.y;
   WORLD.halfW = newWorld.halfW; WORLD.halfH = newWorld.halfH; WORLD.marginX = newWorld.marginX; WORLD.marginY = newWorld.marginY;
   for (var j = 0; j < CONS.length; j++) {
    var cc = CONS[j], res = results[j];
    cc.localPts = res.localPts; cc.maxR = res.maxR; cc.wx = res.wx; cc.wy = res.wy;
    cc.rad = res.rad; cc.align = res.align; cc.labelDY = res.labelDY;
   }
   dustNearBright = SKY.nearBright;
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
   ctx.strokeStyle = 'rgba(190,220,255,' + (0.36 * vis) + ')';
   ctx.lineWidth = 1;
   for (var li = 0; li < c.lines.length; li++) {
    var p0 = pts[c.lines[li][0]], p1 = pts[c.lines[li][1]];
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
   }
  }

  for (var i = 0; i < pts.length; i++) {
   var p = pts[i];
   var memberSize = (c.sizes ? c.sizes[i] : 1.9) * 1.25 * sizeMul; /* v9: the field stars got bigger, the asterism members keep a step ahead of them */
   if (c.specialIdx === i) {
    var glow = (10 + 2 * Math.sin(now / 700)) * sizeMul;
    ctx.beginPath(); ctx.arc(p.x, p.y, glow, 0, 7);
    ctx.fillStyle = 'rgba(150,235,255,' + (0.2 * vis) + ')'; ctx.fill();
    ctx.beginPath(); ctx.arc(p.x, p.y, (2.7 + vis * 0.8) * sizeMul, 0, 7);
    ctx.fillStyle = 'rgba(190,245,255,' + (0.6 + 0.35 * vis * (0.75 + 0.25 * Math.sin(now / 700))) + ')';
    ctx.fill();
   } else if (c.brightIdx === i) {
    ctx.beginPath(); ctx.arc(p.x, p.y, (3.4 + vis) * 2.2 * sizeMul, 0, 7);
    ctx.fillStyle = 'rgba(170,230,255,' + (0.14 + 0.1 * vis) + ')'; ctx.fill();
    ctx.beginPath(); ctx.arc(p.x, p.y, (2.4 + vis * 0.9) * sizeMul, 0, 7);
    ctx.fillStyle = 'rgba(250,253,255,' + (0.6 + 0.4 * vis) + ')'; ctx.fill();
   } else {
    var tint = (c.warmIdx === i) ? '255,236,208' : '240,248,255';
    ctx.beginPath(); ctx.arc(p.x, p.y, memberSize * 2.2, 0, 7);
    ctx.fillStyle = 'rgba(150,225,255,' + (0.1 + 0.14 * vis) + ')'; ctx.fill();
    ctx.beginPath(); ctx.arc(p.x, p.y, memberSize, 0, 7);
    ctx.fillStyle = 'rgba(' + tint + ',' + (0.55 + 0.45 * vis) + ')';
    ctx.fill();
   }
  }

  var la = still ? 0.9 : 0.55 + 0.45 * vis;
  var cenScreen = baseToScreen(c.wx, c.wy);
  var lx = cenScreen.x + (c.align === 'right' ? -c.rad * 0.15 : c.rad * 0.15) * CAM.scale;
  var ly = cenScreen.y + c.labelDY * CAM.scale;
  ctx.textAlign = c.align;
  /* v9: the name is set in the serif with a soft cyan glow (the reference frame's credit-roll
   look); the tag beneath stays mono, no glow, so the hierarchy is type, not size. */
  ctx.save();
  ctx.font = '300 16px Spectral, serif';
  ctx.shadowColor = 'rgba(140,210,255,' + (0.7 * la) + ')'; ctx.shadowBlur = 9;
  ctx.fillStyle = 'rgba(236,244,255,' + la + ')';
  ctx.fillText(c.name, lx, ly);
  ctx.restore();
  ctx.save();
  ctx.font = '10.5px PlexMono, monospace';
  ctx.shadowColor = 'rgba(2,11,26,' + (0.9 * la) + ')'; ctx.shadowBlur = 3; /* a whisper of dark under the tag so it survives sitting on the bright part of the band */
  ctx.fillStyle = 'rgba(132,158,194,' + la + ')';
  ctx.fillText(c.sub, lx, ly + 16);
  ctx.restore();
 }

 function drawPolaris(now) {
  var p = baseToScreen(pole.x, pole.y);
  if (p.x < -10 || p.x > W + 10 || p.y < -10 || p.y > H + 10) return;
  var tw = still ? 1 : 0.85 + 0.15 * Math.sin(now / 900);
  var s = Math.max(CAM.scale, 0.6);
  ctx.beginPath(); ctx.arc(p.x, p.y, 7 * s, 0, 7);
  ctx.fillStyle = 'rgba(170,230,255,.16)'; ctx.fill();
  ctx.beginPath(); ctx.arc(p.x, p.y, 2.1 * s, 0, 7);
  ctx.fillStyle = 'rgba(250,253,255,' + (0.75 + 0.25 * tw) + ')'; ctx.fill();
  if (frozen) {
   ctx.beginPath(); ctx.arc(p.x, p.y, 10 * s, 0, 7);
   ctx.strokeStyle = 'rgba(190,220,255,.4)'; ctx.lineWidth = 1;
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
   grad.addColorStop(0, 'rgba(170,230,255,0)');
   grad.addColorStop(1, 'rgba(240,248,255,' + (0.8 * env) + ')');
   ctx.strokeStyle = grad; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
   ctx.beginPath(); ctx.moveTo(hx - ux * tail, hy - uy * tail); ctx.lineTo(hx, hy); ctx.stroke();
   ctx.beginPath(); ctx.arc(hx, hy, 1.8, 0, 7);
   ctx.fillStyle = 'rgba(250,253,255,' + (0.95 * env) + ')'; ctx.fill();
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
  ctx.fillStyle = 'rgba(200,220,245,' + (0.45 * env) + ')';
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
  if (zoomed || frozen) return; /* the fly-in system, or the freeze hold/tween, owns CAM while either is active — including under `still`, where the zoom target was set immediately by tweenCam() and must not be snapped back to the pole below (that snap-back is what used to zoom reduced-motion users, and every ?shot=<module> capture, into the wrong patch of sky) */
  if (still) { CAM.cx = pole.x; CAM.cy = pole.y; return; } /* prefers-reduced-motion / shot mode: static camera, no wander */ /* the fly-in system, or the freeze hold/tween, owns CAM while either is active */

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

 /* frame-time tracker: a tiny rAF exec-time wrapper (two performance.now() calls/frame, ~free)
  so the ~4ms/frame budget claim is re-measurable rather than asserted — see window.Sky.perf().
  exponential moving average so a single slow frame (e.g. the tab regaining visibility) doesn't
  dominate the read-out. */
 var PERF = { emaMs: 0, samples: 0 };

 var t0 = performance.now(), lastT = t0;
 scheduleMeteor(t0);
 scheduleSatellite(t0);
 function frame(now) {
  if (document.hidden) { if (!still) requestAnimationFrame(frame); return; }
  var __ft0 = performance.now();
  ctx.clearRect(0, 0, W, H);
  var dt = Math.min((now - lastT) / 1000, 0.1); lastT = now;

  updateCam(now);
  updateGaze(now, dt);

  ctx.drawImage(mwCanvas, 0, 0, W, H); /* horizon lift + vignette: screen-space lens effect, composited first */
  var bgMul = zoomed ? 0.35 : 1;
  var nearPf = zoomed ? 1 : GAZE_PF;
  drawPrerenderedLayer(mwWorldCanvas, MW_PF, bgMul); /* the milky way itself — now a real world-space parallax layer, not screen-locked fog */
  drawPrerenderedLayer(ultraFarCanvas, ULTRA_FAR_PF, bgMul);
  drawPrerenderedLayer(farCanvas, FAR_PF, bgMul);
  drawPrerenderedLayer(midCanvas, MID_PF, bgMul * (0.94 + 0.06 * Math.sin(now / 4000))); /* whole-layer "breathing" stands in for per-star twinkle at near-zero cost */
  drawPrerenderedLayer(nearCanvas, nearPf, bgMul * (0.92 + 0.08 * Math.sin(now / 2600))); /* the ~98% bulk of near, baked (see the dust section note on why) */
  drawDust(dustNearBright, now, nearPf); /* the brightest ~2% of near, still live: real per-star twinkle + halo, at negligible cost since it's only a few dozen stars */

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

  var __ft1 = performance.now(), __dt = __ft1 - __ft0;
  PERF.samples++; PERF.emaMs = PERF.samples === 1 ? __dt : PERF.emaMs * 0.9 + __dt * 0.1;

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
  perf: function () { return { avgMs: PERF.emaMs, samples: PERF.samples }; }, /* frame-time re-measurement hook, see the PERF comment above frame() */
  /* dev/verification hook: a checksum of the generated star content itself (SKY.*, built once
   at module init in the fixed GEN_HALF_W/H space — see buildSkyContent()) plus the milky-way
   field's rift/noise parameters, all of which are computed before layout() ever reads the
   viewport. two page loads at different viewport widths should report the SAME checksum here
   — that's the determinism requirement, verified directly against the seeded source content
   rather than a rendered/composited pixel (which the viewport-relative vignette will always
   perturb slightly between different widths, by design — see buildAtmosphere()). */
  debugChecksum: function () {
   var sum = 0, n = 0;
   function mix(v) { sum = (sum + (v * 2654435761 | 0) * (n + 1)) >>> 0; n++; }
   ['ultraFar', 'far', 'mid', 'near'].forEach(function (k) {
    SKY[k].forEach(function (s) { mix(s.x); mix(s.y); mix(s.size * 1000 | 0); mix(s.alpha * 1000 | 0); mix(s.ph * 1000 | 0); });
   });
   mix(RIFT.center); mix(RIFT.halfLen); mix(RIFT.a1); mix(RIFT.a2); mix(RIFT.f1); mix(RIFT.f2); mix(RIFT.p1); mix(RIFT.p2);
   return { checksum: sum, counts: { ultraFar: SKY.ultraFar.length, far: SKY.far.length, mid: SKY.mid.length, near: SKY.near.length } };
  },
 };

 haloGrad = buildHaloGradients(ctx);
 buildSkyContent(); /* the whole seeded sky, generated exactly once — see the comment above buildSkyContent() */
 layout();
 requestAnimationFrame(frame);
 if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (still) repaint(); });
})();
