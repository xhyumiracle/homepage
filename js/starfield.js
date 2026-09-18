/* v4 sky: circumpolar rotating field, pole on-screen so nothing rotates away. real
 asterisms, camera fly-in, rare meteors, canvas echo. module/shell logic lives in main.js. */
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
 var pole = { x: 0, y: 0 };
 var stars = [];
 var meteors = [], meteorNext = 0;
 var echo = null;
 var mouse = { x: -1, y: -1 };
 var litId = null;
 var OMEGA = (Math.PI * 2) / 2400; /* one revolution per 40 min */

 var rot = 0, rotVel = 0, rotAnim = null; /* angle, drag momentum, ease-home tween */
 var zoomed = false, activeId = null;
 var CAM = { scale: 1, cx: 0, cy: 0 };
 var camAnim = null;

 function d2r(d) { return d * Math.PI / 180; }

 /* asterism data: normalized local coords, y-down, centered on their own anchor */
 var CONS = [
  { id: 'hacker', name: 'hacker', sub: 'blockchain security', scaleF: 0.16,
   pts: [[.20,.05],[.62,.12],[.34,.48],[.44,.52],[.54,.56],[.28,.95],[.72,.90]],
   lines: [[0,1],[0,2],[1,4],[2,3],[3,4],[2,5],[4,6]], warmIdx: 0 },
  { id: 'builder', name: 'builder', sub: 'SafeClaw · standards', scaleF: 0.13,
   pts: [[0,.10],[.12,.35],[.35,.60],[.50,.68],[.72,.55],[.82,.18],[.95,.05]],
   lines: [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,0]], specialIdx: 6 },
  { id: 'scholar', name: 'scholar', sub: 'ICL PhD · 3 directions', scaleF: 0.13,
   pts: [[.15,.10],[.30,.02],[.32,.25],[.55,.35],[.50,.62],[.72,.60]],
   lines: [[0,1],[0,2],[2,3],[3,5],[5,4],[4,2]], brightIdx: 0 },
  { id: 'archive', name: 'fainter stars', sub: 'archive', scaleF: 0.09, dim: true,
   pts: [[.05,.08],[.14,.03],[.20,.12],[.10,.18],[.22,.20],[.16,.09],[.02,.16]],
   sizes: [1.0,.8,1.3,.9,1.1,1.4,.85], lines: [] },
 ];
 var byId = {};
 CONS.forEach(function (c) { byId[c.id] = c; c.hover = 0; c.pulseStart = null; });

 /* pole: fraction of viewport, on-screen. each constellation is a polar anchor around it. */
 var POLE_DESK = { x: .54, y: .46 }, POLE_MOB = { x: .50, y: .58 };
 var ANCHOR = {
  hacker:  { ang: d2r(205), rF: .34 },
  builder: { ang: d2r(10),  rF: .40 },
  scholar: { ang: d2r(60),  rF: .30 },
  archive: { ang: d2r(160), rF: .18 }, /* nudged from 135: builder's new mobile spot (shared ANCHOR) crowded it */
 };

 var pulseNext = 0, lastPulseId = null;

 function norm(d) { while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }
 function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
 function smooth01(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

 function screenToBase(x, y) { return { x: (x - W / 2) / CAM.scale + CAM.cx, y: (y - H / 2) / CAM.scale + CAM.cy }; }
 function baseToScreen(x, y) { return { x: (x - CAM.cx) * CAM.scale + W / 2, y: (y - CAM.cy) * CAM.scale + H / 2 }; }

 /* place a constellation at (ang, rWant) around the pole; pull inward if it would
  cross the nearest edge. runs at CAM scale 1, so it holds at every rotation angle. */
 function placeConstellation(c, scale, ang, rWant, marginMin) {
  var r = rWant;
  for (var pass = 0; pass < 2; pass++) {
   var ox = pole.x + r * Math.cos(ang), oy = pole.y + r * Math.sin(ang);
   var basePts = c.pts.map(function (p) { return { x: ox + (p[0] - .5) * scale, y: oy + (p[1] - .5) * scale }; });
   var xs = basePts.map(function (p) { return p.x; }), ys = basePts.map(function (p) { return p.y; });
   var cx0 = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
   var cy0 = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
   var mR = 0;
   for (var k = 0; k < basePts.length; k++) mR = Math.max(mR, Math.hypot(basePts[k].x - cx0, basePts[k].y - cy0));
   var rc = Math.hypot(cx0 - pole.x, cy0 - pole.y);
   var need = rc + mR + 40;
   if (pass === 0 && need > marginMin) { r = Math.max(r - (need - marginMin), scale * 0.5); continue; }
   return { basePts: basePts, cx0: cx0, cy0: cy0, maxR: mR };
  }
 }

 function layout() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  var mobile = W < 720;

  CAM.scale = 1; CAM.cx = W / 2; CAM.cy = H / 2;
  if (zoomed && activeId) { var t = targetCamFor(activeId); CAM.scale = t.scale; CAM.cx = t.cx; CAM.cy = t.cy; }

  var pp = mobile ? POLE_MOB : POLE_DESK;
  pole.x = W * pp.x; pole.y = H * pp.y;
  var minWH = Math.min(W, H);
  var marginMin = Math.min(pole.x, W - pole.x, pole.y, H - pole.y);

  for (var i = 0; i < CONS.length; i++) {
   var c = CONS[i];
   var a = ANCHOR[c.id];
   var scale = minWH * c.scaleF * (mobile ? 0.72 : 1);
   var rWant = Math.min(minWH * a.rF * (mobile ? 0.82 : 1), minWH * 0.46);
   var placed = placeConstellation(c, scale, a.ang, rWant, marginMin);
   c.rad = Math.max(placed.maxR + scale * 0.28, 46);
   c.align = placed.cx0 > W * 0.5 ? 'right' : 'left';
   c.starsPolar = placed.basePts.map(function (p) {
    return { r: Math.hypot(p.x - pole.x, p.y - pole.y), a: Math.atan2(p.y - pole.y, p.x - pole.x) };
   });
   c.rc = Math.hypot(placed.cx0 - pole.x, placed.cy0 - pole.y);
   c.ac = Math.atan2(placed.cy0 - pole.y, placed.cx0 - pole.x);
   c.labelDY = placed.maxR + 24;
  }

  /* background stars: a full ring around the pole, not just the viewport's wedge, so
   rotation never spins past populated sky. radii span nearest point to farthest corner. */
  var corners = [[0, 0], [W, 0], [0, H], [W, H]];
  var minR = Infinity, maxR = 0;
  for (var ci = 0; ci < corners.length; ci++) {
   var dR = Math.hypot(corners[ci][0] - pole.x, corners[ci][1] - pole.y);
   if (dR < minR) minR = dR; if (dR > maxR) maxR = dR;
  }
  minR = Math.max(minR - 40, 0); maxR += 40;
  var bandAngle = Math.atan2(H / 2 - pole.y, W / 2 - pole.x);
  var ringArea = Math.PI * (maxR * maxR - minR * minR);
  var density = 1 / (mobile ? 2400 : 1250);
  var n = Math.round(ringArea * density);
  stars = [];
  var guard = 0;
  while (stars.length < n && guard < n * 8) {
   guard++;
   var a0 = Math.random() * Math.PI * 2;
   var d = Math.abs(norm(a0 - bandAngle));
   if (Math.random() > 0.3 + 0.7 * Math.exp(-Math.pow(d / 0.55, 2))) continue;
   var r0 = Math.sqrt(minR * minR + Math.random() * (maxR * maxR - minR * minR));
   stars.push({
    r: r0, a: a0,
    size: Math.random() < 0.035 ? 1.5 + Math.random() * 0.9 : 0.35 + Math.random() * 0.85,
    alpha: 0.3 + Math.random() * 0.55,
    ph: Math.random() * Math.PI * 2,
    sp: 0.4 + Math.random() * 1.1,
    tint: Math.random() < 0.9 ? '232,230,221' : Math.random() < 0.7 ? '216,192,138' : '160,190,230',
   });
  }
 }

 function targetCamFor(id) {
  var c = byId[id];
  var ang = c.ac + rot;
  var cenX = pole.x + c.rc * Math.cos(ang), cenY = pole.y + c.rc * Math.sin(ang);
  var mobile = W < 720;
  var scale = 2.4;
  var tScreenX = mobile ? W * 0.5 : W * 0.225;
  var tScreenY = mobile ? H * 0.20 : H * 0.5;
  return { scale: scale, cx: cenX - (tScreenX - W / 2) / scale, cy: cenY - (tScreenY - H / 2) / scale };
 }

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

 function tweenRot(target, dur) {
  rotVel = 0;
  if (still) { rot = target; return; }
  rotAnim = { from: rot, delta: norm(target - rot), t0: performance.now(), dur: dur };
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
  tweenCam({ scale: 1, cx: W / 2, cy: H / 2 }, 700, function () {
   dispatchEvent(new CustomEvent('sky:settle', { detail: { id: null } }));
  });
  if (still) repaint();
 }
 function stepNext() { if (!zoomed) return; var i = MODULES.indexOf(activeId); flyTo(MODULES[(i + 1) % MODULES.length]); }
 function stepPrev() { if (!zoomed) return; var i = MODULES.indexOf(activeId); flyTo(MODULES[(i - 1 + MODULES.length) % MODULES.length]); }
 function goHome() { tweenRot(0, 1600); if (zoomed) flyOut(); }

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
  var base = c.dim ? 0.18 : 0.30;
  if (zoomed) return (activeId === c.id) ? 0.95 : 0.28;
  var v = base;
  v = Math.max(v, base + pulseAlpha(c, now) * (0.55 - base));
  var forced = (litId === c.id) ? 1 : 0;
  var hoverA = Math.max(c.hover, forced);
  v = Math.max(v, base + hoverA * (0.95 - base));
  return still ? Math.max(v, 0.55) : v;
 }

 function drawCon(c, now) {
  var vis = visOf(c, now);
  var pts = c.starsPolar.map(function (sp) {
   var ang = sp.a + rot;
   return baseToScreen(pole.x + sp.r * Math.cos(ang), pole.y + sp.r * Math.sin(ang));
  });
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
  var cen = baseToScreen(pole.x + c.rc * Math.cos(c.ac + rot), pole.y + c.rc * Math.sin(c.ac + rot));
  var lx = cen.x + (c.align === 'right' ? -c.rad * 0.15 : c.rad * 0.15) * CAM.scale;
  var ly = cen.y + c.labelDY * CAM.scale;
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

 function drawEcho(now) {
  if (!echo) return;
  var FADE_IN = 800, HOLD = 2500, FADE_OUT = 1500, TOTAL = FADE_IN + HOLD + FADE_OUT;
  var el = now - echo.t0;
  if (el > TOTAL) { echo = null; return; }
  var a = el < FADE_IN ? smooth01(el / FADE_IN) : el < FADE_IN + HOLD ? 1 : 1 - smooth01((el - FADE_IN - HOLD) / FADE_OUT);
  var drift = Math.min(el, FADE_IN + HOLD) / (FADE_IN + HOLD) * 14;
  var p = baseToScreen(echo.bx, echo.by);
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
  var sx = dir > 0 ? -0.06 * W + Math.random() * 0.25 * W : W * 0.85 + Math.random() * 0.2 * W;
  meteors.push({ x0: sx, y0: Math.random() * H * 0.55, vx: Math.cos(ang) * speed * dir, vy: Math.sin(ang) * speed, t0: now, life: life });
 }
 function drawMeteors(now) {
  if (!zoomed && meteors.length === 0 && now >= meteorNext) spawnMeteor(now);
  for (var m = meteors.length - 1; m >= 0; m--) {
   var mt = meteors[m];
   var el = (now - mt.t0) / 1000;
   if (el > mt.life) { meteors.splice(m, 1); scheduleMeteor(now); continue; }
   var prog = el / mt.life;
   var env = prog < 0.15 ? smooth01(prog / 0.15) : prog > 0.65 ? 1 - smooth01((prog - 0.65) / 0.35) : 1;
   var hx = mt.x0 + mt.vx * el, hy = mt.y0 + mt.vy * el;
   var spd = Math.hypot(mt.vx, mt.vy) || 1, ux = mt.vx / spd, uy = mt.vy / spd, tail = 160;
   var grad = ctx.createLinearGradient(hx - ux * tail, hy - uy * tail, hx, hy);
   grad.addColorStop(0, 'rgba(216,192,138,0)');
   grad.addColorStop(1, 'rgba(233,228,214,' + (0.75 * env) + ')');
   ctx.strokeStyle = grad; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
   ctx.beginPath(); ctx.moveTo(hx - ux * tail, hy - uy * tail); ctx.lineTo(hx, hy); ctx.stroke();
   ctx.beginPath(); ctx.arc(hx, hy, 1.8, 0, 7);
   ctx.fillStyle = 'rgba(240,236,222,' + (0.9 * env) + ')'; ctx.fill();
  }
 }

 var t0 = performance.now(), lastT = t0;
 scheduleMeteor(t0);
 function frame(now) {
  if (document.hidden) { if (!still) requestAnimationFrame(frame); return; }
  ctx.clearRect(0, 0, W, H);
  var dt = Math.min((now - lastT) / 1000, 0.1); lastT = now;

  updateCam(now);
  if (rotAnim) {
   var rt = (now - rotAnim.t0) / rotAnim.dur;
   if (rt >= 1) { rot = rotAnim.from + rotAnim.delta; rotAnim = null; }
   else rot = rotAnim.from + rotAnim.delta * easeInOutCubic(rt);
  } else if (!zoomed && !ptrDragging) {
   rotVel = Math.max(-6, Math.min(6, rotVel));
   rot += (OMEGA + rotVel) * dt;
   if (!still) rotVel *= Math.exp(-dt / 0.55); else rotVel = 0;
  }

  var bgMul = zoomed ? 0.35 : 1;
  for (var i = 0; i < stars.length; i++) {
   var s = stars[i];
   var ang = s.a + rot;
   var p = baseToScreen(pole.x + s.r * Math.cos(ang), pole.y + s.r * Math.sin(ang));
   if (p.x < -8 || p.x > W + 8 || p.y < -8 || p.y > H + 8) continue;
   var tw = still ? 1 : 0.72 + 0.28 * Math.sin((now / 1000) * s.sp + s.ph);
   ctx.beginPath();
   ctx.arc(p.x, p.y, s.size * Math.max(CAM.scale, 0.6), 0, 7);
   ctx.fillStyle = 'rgba(' + s.tint + ',' + (s.alpha * tw * bgMul) + ')';
   ctx.fill();
  }

  drawPolaris(now);
  if (!still) drawMeteors(now); else if (zoomed) meteors = [];

  maybePulse(now);

  var anyHover = false;
  if (!touch && mouse.x >= 0) {
   var b = screenToBase(mouse.x, mouse.y);
   var pp = baseToScreen(pole.x, pole.y);
   if (Math.hypot(mouse.x - pp.x, mouse.y - pp.y) < 14) anyHover = true;
   for (var ci = 0; ci < CONS.length; ci++) {
    var c = CONS[ci];
    var ang2 = c.ac + rot;
    var cenX = pole.x + c.rc * Math.cos(ang2), cenY = pole.y + c.rc * Math.sin(ang2);
    var want = Math.hypot(b.x - cenX, b.y - cenY) < c.rad ? 1 : 0;
    if (want) anyHover = true;
    c.hover += (want - c.hover) * (still ? 1 : 0.15);
   }
  } else {
   for (var cj = 0; cj < CONS.length; cj++) CONS[cj].hover *= 0.9;
  }

  for (var k = 0; k < CONS.length; k++) drawCon(CONS[k], now);
  drawEcho(now);

  if (ptrDragging) canvas.style.cursor = zoomed ? '' : 'grabbing';
  else if (anyHover) canvas.style.cursor = 'pointer';
  else canvas.style.cursor = (touch || zoomed) ? '' : 'grab';

  if (!still) requestAnimationFrame(frame);
 }
 function repaint() { frame(performance.now()); }

 /* pointer: drag rotates the sky; click a constellation (even while zoomed, hit-tested
  through the camera transform) flies there; click polaris resets home; zoomed drag swipes */
 var ptrActive = false, ptrDragging = false;
 var ptr0 = { x: 0, y: 0 }, ang0 = 0, rot0 = 0, lastAng = 0, lastAngT = 0;
 var THRESH = 6;

 canvas.addEventListener('pointerdown', function (e) {
  ptrActive = true; ptrDragging = false;
  ptr0.x = e.clientX; ptr0.y = e.clientY;
  if (!zoomed) {
   var b = screenToBase(e.clientX, e.clientY);
   ang0 = Math.atan2(b.y - pole.y, b.x - pole.x);
   rot0 = rot; lastAng = ang0; lastAngT = performance.now();
  }
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
 });
 canvas.addEventListener('pointermove', function (e) {
  if (!touch) { mouse.x = e.clientX; mouse.y = e.clientY; }
  if (!ptrActive) return;
  var dx = e.clientX - ptr0.x, dy = e.clientY - ptr0.y;
  if (!ptrDragging && Math.hypot(dx, dy) > THRESH) { ptrDragging = true; rotVel = 0; rotAnim = null; }
  if (!ptrDragging || zoomed) return;
  var b = screenToBase(e.clientX, e.clientY);
  var ang = Math.atan2(b.y - pole.y, b.x - pole.x);
  rot = rot0 + norm(ang - ang0);
  var now = performance.now(), dt = (now - lastAngT) / 1000;
  if (dt > 0.012) rotVel = Math.max(-6, Math.min(6, norm(ang - lastAng) / dt));
  lastAng = ang; lastAngT = now;
  if (still) repaint();
 });
 function endPointer(e) {
  if (!ptrActive) return;
  ptrActive = false;
  if (zoomed && ptrDragging) {
   var dx = e.clientX - ptr0.x;
   if (Math.abs(dx) > 40) dispatchEvent(new CustomEvent('sky:swipe', { detail: dx < 0 ? 1 : -1 }));
   ptrDragging = false;
   return;
  }
  if (!ptrDragging) {
   var pp = baseToScreen(pole.x, pole.y);
   if (Math.hypot(e.clientX - pp.x, e.clientY - pp.y) < 14) {
    goHome();
   } else {
    var b = screenToBase(e.clientX, e.clientY);
    for (var i = 0; i < CONS.length; i++) {
     var c = CONS[i];
     var ang2 = c.ac + rot;
     var cenX = pole.x + c.rc * Math.cos(ang2), cenY = pole.y + c.rc * Math.sin(ang2);
     if (Math.hypot(b.x - cenX, b.y - cenY) < c.rad * (touch ? 1.5 : 1)) {
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

 layout();
 requestAnimationFrame(frame);
 if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (still) repaint(); });
})();
