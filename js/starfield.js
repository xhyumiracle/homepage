/* v5 sky: the gaze model. no rotation axis, no fisheye. the world is a plane ~1.7x the
 viewport in each dimension, centered on polaris; every star and constellation gets a
 STATIC world position (the old theta-orbit rest poses, spread further into the extra
 world margin so panning toward an edge reveals content). the camera pans opposite the
 pointer through a damped spring with rubber-band edges at the world margin, "standing
 under the sky, looking around." 3-layer dust gives cheap depth parallax. attention (the
 constellation nearest the pointer) is light, never size. idle drifts on a slow Lissajous
 wander; touch drags the camera directly with momentum. realism pass: power-law star
 brightness with pre-rendered halo sprites for the brightest, a faint milky-way wash, and
 twinkle that's stronger in the near layer. module/shell logic lives in main.js. */
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
 var dustFar = [], dustMid = [], dustNear = [];
 var meteors = [], meteorNext = 0;
 var echo = null;
 var mouse = { x: -1, y: -1 };
 var litId = null;

 var zoomed = false, activeId = null;
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

 function screenToBase(x, y) { return { x: (x - W / 2) / CAM.scale + CAM.cx, y: (y - H / 2) / CAM.scale + CAM.cy }; }
 function baseToScreen(x, y) { return { x: (x - CAM.cx) * CAM.scale + W / 2, y: (y - CAM.cy) * CAM.scale + H / 2 }; }

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

 /* --- dust: 3 depth layers, generated once per layout() over the full 1.7x world rect. far
  pans at 55% of camera travel, mid at 75%, near (this layer) at 100%, same rate as the
  constellations, since it sits in the same picture plane as them. realism: power-law
  brightness (many faint, few bright) drives both size and alpha; the near layer's brightest
  ~2% get a halo-sprite flag; the near layer also twinkles most, far layer least. */
 var MW_ANGLE = -0.58; /* fixed diagonal used both for the density bias below and the milky-way wash, so they align */
 function powerBrightness(pw) { return Math.pow(Math.random(), pw); }
 function genLayer(count, opt) {
  var out = [];
  var guard = 0, need = count;
  while (out.length < need && guard < need * 6) {
   guard++;
   var x = pole.x + (Math.random() * 2 - 1) * WORLD.halfW;
   var y = pole.y + (Math.random() * 2 - 1) * WORLD.halfH;
   var a0 = Math.atan2(y - pole.y, x - pole.x);
   var d = Math.abs(norm(a0 - MW_ANGLE));
   if (Math.random() > 0.35 + 0.65 * Math.exp(-Math.pow(d / 0.6, 2))) continue;
   var b = powerBrightness(opt.pow);
   var star = {
    x: x, y: y,
    size: (opt.sizeMin + b * (opt.sizeMax - opt.sizeMin)) * (0.88 + Math.random() * 0.24),
    alpha: opt.alphaMin + b * (opt.alphaMax - opt.alphaMin),
    ph: Math.random() * Math.PI * 2,
    sp: 0.4 + Math.random() * 1.1,
    tw: opt.tw,
    tint: Math.random() < 0.9 ? '232,230,221' : Math.random() < 0.7 ? '216,192,138' : '160,190,230',
    halo: opt.halo && b > 0.93,
   };
   out.push(star);
  }
  return out;
 }

 var mwCanvas = document.createElement('canvas'), mwCtx = mwCanvas.getContext('2d');
 function buildMilkyWash() {
  mwCanvas.width = Math.max(1, W); mwCanvas.height = Math.max(1, H);
  mwCtx.clearRect(0, 0, W, H);
  var cx = W / 2, cy = H / 2, len = Math.hypot(W, H);
  var px = -Math.sin(MW_ANGLE), py = Math.cos(MW_ANGLE); /* perpendicular to the band direction: gradient crosses the band's width */
  var x0 = cx - px * len / 2, y0 = cy - py * len / 2, x1 = cx + px * len / 2, y1 = cy + py * len / 2;
  var grad = mwCtx.createLinearGradient(x0, y0, x1, y1);
  grad.addColorStop(0, 'rgba(220,216,204,0)');
  grad.addColorStop(0.5, 'rgba(224,220,206,0.05)');
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
  the 3 dust layers. called on boot and on every resize. structured so that ALL of it is
  computed into local scratch vars first and only written onto shared state at the very end
  of a successful run, so a transient bad viewport (0-size mid-resize) or a thrown error can
  never leave the sky half old / half new. */
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
   camAnim = null; /* any in-flight fly tween targeted the pre-resize layout; drop it, we just snapped to the correct one */
   gazeHomeUntil = 0; gazeIdling = false; /* pre-resize gaze state is stale */

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

   var far = genLayer(mobile ? 260 : 520, { sizeMin: .25, sizeMax: .55, alphaMin: .12, alphaMax: .28, pow: 2.2, tw: .12, halo: false });
   var mid = genLayer(mobile ? 340 : 680, { sizeMin: .3, sizeMax: .85, alphaMin: .18, alphaMax: .4, pow: 2.6, tw: .18, halo: false });
   var near = genLayer(mobile ? 480 : 980, { sizeMin: .35, sizeMax: 1.9, alphaMin: .28, alphaMax: .82, pow: 3.2, tw: .26, halo: true });
   buildMilkyWash();

   /* --- commit: everything above succeeded, so write it all at once. --- */
   pole.x = newPole.x; pole.y = newPole.y;
   WORLD.halfW = newWorld.halfW; WORLD.halfH = newWorld.halfH; WORLD.marginX = newWorld.marginX; WORLD.marginY = newWorld.marginY;
   for (var j = 0; j < CONS.length; j++) {
    var cc = CONS[j], res = results[j];
    cc.localPts = res.localPts; cc.maxR = res.maxR; cc.wx = res.wx; cc.wy = res.wy;
    cc.rad = res.rad; cc.align = res.align; cc.labelDY = res.labelDY;
   }
   dustFar = far; dustMid = mid; dustNear = near;
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
  meteors = [];
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
 function goHome() { gazeHomeUntil = performance.now() + 1500; if (zoomed) flyOut(); }

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
 }

 /* dust layer draw: `pf` (pan factor) is how much of the camera's displacement from home this
  layer feels: 1.0 = moves exactly with the constellations (the near layer IS that plane),
  smaller pf lags behind, reading as depth. implemented as a per-layer virtual camera center
  that only travels pf of the way from home to CAM's actual center. */
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
  vector used for the head can double as the screen-space tail direction. */
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
  if (!zoomed && meteors.length === 0 && now >= meteorNext) spawnMeteor(now);
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

 /* --- the gaze camera: pointer pans opposite-wise through a damped spring, rubber-banded at
  the world margin; idle (6s no movement, or always on touch when not dragging) wanders on a
  slow Lissajous drift; touch drag pans directly with release momentum. zoomed state suspends
  all of this (the fly-in system owns CAM then). --- */
 var K = 0.7; /* target = home + (pointer - viewportCenter) * K: exactly sweeps the world margin at full mouse travel */
 var SPRING_TAU = 0.2; /* ~8%/frame at 60fps: CAM eases toward target, never snaps */
 var IDLE_MS = 6000;
 var WANDER_PERIOD = 90; /* seconds */
 var WANDER_AMP = 0.15; /* fraction of the margin */
 var RUBBER_C = 1.4; /* softness of the edge compression */

 var lastMoveTime = -1e9;
 var gazeIdling = false, gazeIdleStart = 0, gazeIdleAnchorX = 0, gazeIdleAnchorY = 0;
 var gazeHomeUntil = 0;
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
  if (zoomed) return; /* the fly-in system owns CAM while a module is open */

  if (touch && ptrDragging) {
   CAM.cx = pole.x + rubber(touchRawX, WORLD.marginX);
   CAM.cy = pole.y + rubber(touchRawY, WORLD.marginY);
   return; /* direct 1:1 drag, no spring lag, per spec */
  }

  var desiredX, desiredY;
  if (now < gazeHomeUntil) {
   desiredX = 0; desiredY = 0; /* polaris click: ease home, ignore other inputs briefly */
  } else if (touch) {
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
 function frame(now) {
  if (document.hidden) { if (!still) requestAnimationFrame(frame); return; }
  ctx.clearRect(0, 0, W, H);
  var dt = Math.min((now - lastT) / 1000, 0.1); lastT = now;

  updateCam(now);
  updateGaze(now, dt);

  ctx.drawImage(mwCanvas, 0, 0, W, H); /* faint milky-way wash, pre-rendered, composited under the dust */
  drawDust(dustFar, now, 0.55);
  drawDust(dustMid, now, 0.75);
  drawDust(dustNear, now, 1);

  drawPolaris(now);
  if (!still) drawMeteors(now); else if (zoomed) meteors = [];

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
  clicking polaris resets home. while zoomed, a drag of either kind swipes between modules. */
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
   var mdx = e.clientX - dragLastX, mdy = e.clientY - dragLastY;
   var mdt = Math.max((now - dragLastT) / 1000, 0.001);
   touchRawX -= mdx; touchRawY -= mdy; /* content follows the finger */
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
    goHome();
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
  home: goHome,
  echo: setEcho,
  current: function () { return activeId; },
  isZoomed: function () { return zoomed; },
 };

 buildHaloSprites();
 layout();
 requestAnimationFrame(frame);
 if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (still) repaint(); });
})();
