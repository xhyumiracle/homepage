/* v10 sky: the real one. 41,148 catalogued stars (HYG v4.4, to magnitude 8.0) drawn as
 WebGL point sprites at full device resolution, over NASA's Deep Star Maps 2020 (1.7 billion
 Gaia stars rasterised into one all-sky image) sampled per pixel as the milky way and the
 faint-star grain behind them. everything is at infinity, so there is no layer parallax:
 the pointer turns the observer's head by a couple of degrees, that is all. the view is the
 winter evening sky from ~40N, facing south-west, chosen so the four module asterisms (Orion,
 Taurus with the Pleiades, Canis Major with Sirius, Gemini) clear the page chrome on both
 desktop and phone; it does not rotate (the real sky does not visibly move within a minute,
 and content that drifts off-screen was rejected in v3).

 why this replaces the v6-v9 canvas sky: that one had to bake its star layers at 0.3-0.4x CSS
 resolution (0.15-0.19x device pixels on a retina screen) to stay under a canvas-2D pixel
 budget, then upscale them every frame, which read as a blurred photograph; its milky way was
 value noise; and its depth parallax was physically wrong for a sky. see design/research-sky.md.

 layout of this file: math -> data -> GL (background + stars) -> the 2D overlay (asterisms,
 labels, home mark, meteors, echo) -> camera (gaze spring, wander, touch, freeze, fly-to) ->
 events and the window.Sky API, which is byte-for-byte the one main.js already speaks. if
 WebGL is unavailable the v9 canvas sky is loaded instead and this file steps aside. */
(function () {
 var glCanvas = document.getElementById('skygl');
 var canvas = document.getElementById('sky');
 var ctx = canvas.getContext('2d');
 var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
 var touch = matchMedia('(hover: none)').matches;
 var shotM = /[?&]shot(?:=([a-z0-9]+))?/.exec(location.search);
 var shot = !!shotM;
 var still = reduced || shot;

 var MODULES = ['research', 'projects', 'talks', 'about'];
 var DATA = window.SKY_DATA;

 var gl = null;
 try {
  gl = glCanvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: shot, powerPreference: 'low-power' });
 } catch (e) { gl = null; }
 if (!gl || !DATA) {
  /* no WebGL: fall back to the v9 canvas sky (same window.Sky API), loaded on demand */
  glCanvas.remove();
  var s = document.createElement('script'); s.src = 'js/starfield.js?v=14'; document.body.appendChild(s);
  return;
 }

 /* --- math. frames: equatorial J2000 (x toward RA 0 on the equator, z toward the north
  celestial pole), horizontal (x east, y north, z up), camera (x right, y up, z forward).
  projection is stereographic: a direction at angle t from the view centre lands F*tan(t/2)
  pixels away, which keeps a 120-degree field pleasant where a pinhole projection would smear
  the corners; Stellarium's default for the same reason. --- */
 var D2R = Math.PI / 180;
 var LAT = 40 * D2R;         /* the observer: ~40N (Beijing, and near enough London's sky) */
 var LST = 8.4 * 15 * D2R;   /* local sidereal time of the frozen moment: a winter evening */
 var VIEW = { yaw: 240 * D2R, pitch: 44 * D2R, fov: 120 * D2R }; /* desktop rest pose (see the mobile override in layout()) */
 var VIEW_MOBILE = { yaw: 225 * D2R, pitch: 74 * D2R, fov: 80 * D2R };
 var ZOOM = 2.4;

 function eqToHorMatrix() { /* rows: east, north, up (see the derivation in design/research-sky.md notes) */
  var st = Math.sin(LST), ct = Math.cos(LST), sp = Math.sin(LAT), cp = Math.cos(LAT);
  return [-st, ct, 0, -sp * ct, -sp * st, cp, cp * ct, cp * st, sp];
 }
 var M_EQ2HOR = eqToHorMatrix();
 function camBasis(yaw, pitch) {
  var cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  var f = [cp * sy, cp * cy, sp], r = [cy, -sy, 0];
  var u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return { f: f, r: r, u: u };
 }
 function mul3(a, b) { /* a*b, both row-major 3x3 */
  var o = new Array(9);
  for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
 }
 function eqToCamMatrix(yaw, pitch) {
  var b = camBasis(yaw, pitch);
  return mul3([b.r[0], b.r[1], b.r[2], b.u[0], b.u[1], b.u[2], b.f[0], b.f[1], b.f[2]], M_EQ2HOR);
 }
 /* the look-around: small rotations about the camera's OWN axes (turn the head right: about
  the screen's vertical; look up: about the screen's horizontal), composed onto the rest pose.
  rotating the pose's azimuth instead (v10.0) spun the sky about the zenith, which at a 44
  degree pitch reads as the field wheeling rather than the head turning. gx > 0 turns right,
  gy > 0 pitches up; both in radians. */
 function eqToCamWithGaze(yaw, pitch, gx, gy) {
  var base = eqToCamMatrix(yaw, pitch);
  var cy = Math.cos(gx), sy = Math.sin(gx), cp = Math.cos(gy), sp = Math.sin(gy);
  var Ry = [cy, 0, -sy, 0, 1, 0, sy, 0, cy];
  var Rx = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  return mul3(mul3(Rx, Ry), base);
 }
 function transpose3(m) { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; }
 function apply3(m, v) { return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]; }
 function radecToDir(raDeg, decDeg) {
  var a = raDeg * D2R, d = decDeg * D2R, cd = Math.cos(d);
  return [cd * Math.cos(a), cd * Math.sin(a), Math.sin(d)];
 }
 function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
 function smooth01(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

 /* B-V colour index -> linear-ish RGB, a compact fit of the usual blackbody table */
 function bvToRgb(bv) {
  var t = Math.max(-0.4, Math.min(2.0, bv));
  var r, g, b;
  if (t < 0.0) { r = 0.61 + 0.11 * (t + 0.4) / 0.4; g = 0.70 + 0.07 * (t + 0.4) / 0.4; b = 1.0; }
  else if (t < 0.4) { r = 0.83 + 0.17 * t / 0.4; g = 0.87 + 0.11 * t / 0.4; b = 1.0; }
  else if (t < 1.0) { r = 1.0; g = 0.98 - 0.16 * (t - 0.4) / 0.6; b = 1.0 - 0.34 * (t - 0.4) / 0.6; }
  else { r = 1.0; g = 0.82 - 0.22 * (t - 1.0); b = 0.66 - 0.36 * (t - 1.0); }
  return [r, g, b];
 }

 /* --- state --- */
 var W = 0, H = 0, dpr = 1, mobile = false;
 var CAM = { yaw: VIEW.yaw, pitch: VIEW.pitch, F: 1 }; /* the actual camera each frame */
 var REST = { yaw: VIEW.yaw, pitch: VIEW.pitch, F: 1 };
 var GAZE = { cx: 0, cy: 0 }; /* ambient look-around, in rest-view pixels; converted to angles below */
 var zoomed = false, activeId = null, frozen = false, camAnim = null;
 var mouse = { x: -1, y: -1 };
 var litId = null;
 var starCount = 0, texReady = 0, texFadeT0 = 0;
 var mEqCam = eqToCamMatrix(CAM.yaw, CAM.pitch);
 function rebuildCam() { mEqCam = eqToCamWithGaze(CAM.yaw, CAM.pitch, GAZE.cx / REST.F, -GAZE.cy / REST.F); }

 /* --- data: stars.bin -> interleaved float buffer --- */
 var starBuf = null, starVerts = null;
 function unpackStars(buf) {
  var n = Math.floor(buf.byteLength / 6), dv = new DataView(buf);
  var out = new Float32Array(n * 8), seed = 1234567;
  function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
  for (var i = 0; i < n; i++) {
   var o = i * 6;
   var ra = dv.getUint16(o, true) / 65535 * 360;
   var dec = dv.getInt16(o + 2, true) / 32767 * 90;
   var mag = dv.getInt8(o + 4) / 20;
   var ci = dv.getInt8(o + 5) / 50;
   var d = radecToDir(ra, dec), c = bvToRgb(ci), k = i * 8;
   out[k] = d[0]; out[k + 1] = d[1]; out[k + 2] = d[2];
   out[k + 3] = mag;
   out[k + 4] = c[0]; out[k + 5] = c[1]; out[k + 6] = c[2];
   out[k + 7] = rnd() * 6.2832;
  }
  return out;
 }

 /* --- GL --- */
 function compile(type, src) {
  var sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
 }
 function program(vs, fs) {
  var p = gl.createProgram(); gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
 }
 var BG_VS = 'attribute vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }';
 /* the background: per pixel, undo the projection to get a sky direction, rotate it into the
  equatorial frame, and look the milky way up in the all-sky map. plus the atmosphere: a navy
  base, a faint blue lift toward the horizon, a soft vignette. the map is sRGB-encoded with
  headroom (see tools notes); it is linearised, exposed and graded cool here. */
 var BG_FS = [
  '#ifdef GL_FRAGMENT_PRECISION_HIGH', 'precision highp float;', '#else', 'precision mediump float;', '#endif', /* the RA/Dec -> uv lookup needs ~1e-5 or the map swims on 16-bit mediump GPUs */
  'uniform mat3 uCamToEq; uniform vec2 uCenter; uniform float uF; uniform sampler2D uTex; uniform float uTexOn; uniform float uBg; uniform float uExposure;',
  'uniform mat3 uHorRows; /* camera -> horizontal frame (columns right, up, forward) */',
  'const float PI = 3.14159265;',
  'void main(){',
  ' vec2 p = (gl_FragCoord.xy - uCenter) / uF;',
  ' float r2 = dot(p, p);',
  ' vec3 v = vec3(2.0 * p, 1.0 - r2) / (1.0 + r2);', /* inverse stereographic: camera-space unit direction */
  ' vec3 hor = uHorRows * v;', /* horizontal frame, for altitude */
  ' vec3 eq = uCamToEq * v;',
  ' float ra = atan(eq.y, eq.x); float dec = asin(clamp(eq.z, -1.0, 1.0));',
  ' vec2 uv = vec2(fract(0.5 - ra / (2.0 * PI)), 0.5 - dec / PI);',
  ' vec3 base = vec3(0.004, 0.022, 0.06);', /* deep navy, a shade under v9's so the map's own glow carries the blue */
  ' float alt = hor.z;',
  ' vec3 col = base;',
  ' col += vec3(0.018, 0.045, 0.10) * pow(clamp(1.0 - alt * 5.0, 0.0, 1.0), 3.0);', /* a whisper of horizon in the lowest ~11 degrees */
  ' if (uTexOn > 0.0) {',
  '  vec3 t = texture2D(uTex, uv).rgb;',
  '  t = pow(clamp((t - 0.09) / 0.91, 0.0, 1.0), vec3(1.45));', /* lift the black point, then a gentle curve so the band comes through. the map is shipped pre-softened (tools notes): its individual faint stars would only read as upscaled mottling, and the catalogue draws every star to 7.5 sharply anyway, so the map contributes haze, clumps and dust lanes only */
  '  vec3 mw = t * vec3(0.5, 0.76, 1.22) * uExposure;', /* cool grade; the map is neutral-warm */
  '  col += mw * uTexOn;',
  ' }',
  ' float vig = 1.0 - 0.34 * smoothstep(0.25, 1.2, sqrt(r2));',
  ' col *= vig * uBg;',
  ' gl_FragColor = vec4(pow(col, vec3(1.0 / 1.9)), 1.0);', /* mild display gamma; the stars are added on top in this same space */
  '}'].join('\n');
 var STAR_VS = [
  'attribute vec3 aDir; attribute float aMag; attribute vec3 aCol; attribute float aPhase;',
  'uniform mat3 uEqToCam; uniform vec2 uCenter; uniform float uF; uniform vec2 uRes; uniform float uTime; uniform float uTwinkle; uniform float uScale; uniform float uDpr; uniform float uMaxPt; uniform float uGain;',
  'varying vec3 vCol; varying float vI; varying float vCore; varying float vHalo;',
  'void main(){',
  ' vec3 v = uEqToCam * aDir;',
  ' if (v.z < -0.6) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }',
  ' vec2 s = uCenter + uF * v.xy / (1.0 + v.z);',
  ' float m = aMag;',
  ' float core = (0.75 + 2.2 * max(0.0, 6.5 - m) / 8.0) * uDpr * sqrt(uScale);', /* core radius, device px: Sirius ~2.9, mag 2 ~2.0, mag 6.5+ ~0.75 */
  ' float halo = core * 2.4 + 2.0 * uDpr;',
  ' float R = min(halo, uMaxPt * 0.5);',
  ' gl_PointSize = 2.0 * R;',
  ' vCore = core / R;',
  ' float I = pow(10.0, -0.4 * (m - 1.0) * 0.36);', /* Pogson, compressed: mag 1 -> 1, mag 8 -> .10 */
  ' I = min(I, 1.7) * uGain;',
  ' float tw = m < 2.5 ? 0.22 : (m < 5.0 ? 0.13 : 0.07);',
  ' float k = 1.0 + uTwinkle * tw * (0.6 * sin(uTime * 1.7 + aPhase) + 0.4 * sin(uTime * 4.3 + aPhase * 2.1));',
  ' vI = I * k; vCol = aCol;',
  ' vHalo = 0.12 + 0.3 * clamp((3.5 - m) / 4.0, 0.0, 1.0);', /* the glare skirt only really shows on the bright ones */
  ' gl_Position = vec4(s / uRes * 2.0 - 1.0, 0.0, 1.0);',
  '}'].join('\n');
 var STAR_FS = [
  'precision mediump float;',
  'varying vec3 vCol; varying float vI; varying float vCore; varying float vHalo;',
  'void main(){',
  ' vec2 p = gl_PointCoord * 2.0 - 1.0; float d = dot(p, p);',
  ' if (d > 1.0) discard;',
  ' float c2 = vCore * vCore;',
  ' float core = exp(-d / (0.55 * c2));', /* gaussian point-spread core */
  ' float halo = exp(-d * 2.4) * vHalo;',      /* short, soft glare skirt */
  ' float a = vI * (core + halo);',
  ' vec3 col = mix(vec3(1.0), vCol, smoothstep(0.0, 1.6 * c2, d));', /* white-hot centre, the star\'s colour in the rim */
  ' gl_FragColor = vec4(col * a, 1.0);',
  '}'].join('\n');

 var bgProg, starProg, bgBuf, tex = null, maxPt = 64;
 var U = {};
 function initGL() {
  bgProg = program(BG_VS, BG_FS);
  starProg = program(STAR_VS, STAR_FS);
  bgBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE); maxPt = Math.min(range ? range[1] : 64, 96);
  ['uCamToEq', 'uCenter', 'uF', 'uTex', 'uTexOn', 'uBg', 'uHorRows', 'uExposure'].forEach(function (n) { U['bg_' + n] = gl.getUniformLocation(bgProg, n); });
  ['uEqToCam', 'uCenter', 'uF', 'uRes', 'uTime', 'uTwinkle', 'uScale', 'uDpr', 'uMaxPt', 'uGain'].forEach(function (n) { U['st_' + n] = gl.getUniformLocation(starProg, n); });
  U.aPos = gl.getAttribLocation(bgProg, 'aPos');
  U.aDir = gl.getAttribLocation(starProg, 'aDir'); U.aMag = gl.getAttribLocation(starProg, 'aMag');
  U.aCol = gl.getAttribLocation(starProg, 'aCol'); U.aPhase = gl.getAttribLocation(starProg, 'aPhase');
  gl.disable(gl.DEPTH_TEST);
 }
 function uploadStars(verts) {
  starVerts = verts; starCount = verts.length / 8;
  if (!starBuf) starBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, starBuf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
 }
 function loadTexture() {
  /* the 2k map (320KB webp, 430KB jpg fallback) is enough: the catalogue supplies every crisp
   star, the map only has to be haze and grain. it is fetched after first paint and fades in. */
  var img = new Image();
  var webp = document.createElement('canvas').toDataURL('image/webp').indexOf('data:image/webp') === 0;
  img.onload = function () {
   tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
   gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
   gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
   gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
   gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
   gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
   gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
   texFadeT0 = performance.now(); texReady = 1;
   if (still) repaint();
  };
  img.onerror = function () { if (webp && img.src.indexOf('.webp') > 0) img.src = 'img/starmap-2k.jpg?v=14'; };
  img.src = webp ? 'img/starmap-2k.webp?v=14' : 'img/starmap-2k.jpg?v=14';
 }

 function drawGL(now) {
  var Wd = glCanvas.width, Hd = glCanvas.height;
  gl.viewport(0, 0, Wd, Hd);
  var b = camBasis(CAM.yaw, CAM.pitch);
  var camToEq = transpose3(mEqCam);
  var camToHor = [b.r[0], b.u[0], b.f[0], b.r[1], b.u[1], b.f[1], b.r[2], b.u[2], b.f[2]]; /* columns = r,u,f in the horizontal frame */
  var texOn = texReady ? (still ? 1 : smooth01((now - texFadeT0) / 1400)) : 0;
  var bgMul = zoomed ? 0.42 : 1;

  gl.disable(gl.BLEND);
  gl.useProgram(bgProg);
  gl.uniformMatrix3fv(U.bg_uCamToEq, false, new Float32Array(transpose3(camToEq))); /* GL wants column-major */
  gl.uniformMatrix3fv(U.bg_uHorRows, false, new Float32Array(transpose3(camToHor)));
  gl.uniform2f(U.bg_uCenter, Wd / 2, Hd / 2);
  gl.uniform1f(U.bg_uF, CAM.F * dpr);
  gl.uniform1f(U.bg_uTexOn, texOn);
  gl.uniform1f(U.bg_uBg, bgMul);
  gl.uniform1f(U.bg_uExposure, TUNE.exposure);
  if (tex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(U.bg_uTex, 0); }
  gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
  gl.enableVertexAttribArray(U.aPos); gl.vertexAttribPointer(U.aPos, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.disableVertexAttribArray(U.aPos);

  if (!starBuf) return;
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
  gl.useProgram(starProg);
  gl.uniformMatrix3fv(U.st_uEqToCam, false, new Float32Array(transpose3(mEqCam)));
  gl.uniform2f(U.st_uCenter, Wd / 2, Hd / 2);
  gl.uniform1f(U.st_uF, CAM.F * dpr);
  gl.uniform2f(U.st_uRes, Wd, Hd);
  gl.uniform1f(U.st_uTime, now / 1000);
  gl.uniform1f(U.st_uTwinkle, still ? 0 : 1);
  gl.uniform1f(U.st_uScale, CAM.F / REST.F);
  gl.uniform1f(U.st_uDpr, dpr);
  gl.uniform1f(U.st_uMaxPt, maxPt);
  gl.uniform1f(U.st_uGain, TUNE.gain * bgMul);
  gl.bindBuffer(gl.ARRAY_BUFFER, starBuf);
  gl.enableVertexAttribArray(U.aDir); gl.vertexAttribPointer(U.aDir, 3, gl.FLOAT, false, 32, 0);
  gl.enableVertexAttribArray(U.aMag); gl.vertexAttribPointer(U.aMag, 1, gl.FLOAT, false, 32, 12);
  gl.enableVertexAttribArray(U.aCol); gl.vertexAttribPointer(U.aCol, 3, gl.FLOAT, false, 32, 16);
  gl.enableVertexAttribArray(U.aPhase); gl.vertexAttribPointer(U.aPhase, 1, gl.FLOAT, false, 32, 28);
  gl.drawArrays(gl.POINTS, 0, starCount);
 }
 var TUNE = { gain: 1.3, exposure: 1.15 };

 /* --- projection for the overlay (CSS px, y down) --- */
 function project(dirEq) {
  var v = apply3(mEqCam, dirEq);
  if (v[2] < -0.6) return null;
  var inv = 1 / (1 + v[2]);
  return { x: W / 2 + CAM.F * v[0] * inv, y: H / 2 - CAM.F * v[1] * inv, z: v[2] };
 }

 /* --- asterisms (the four modules) --- */
 var CONS = [];
 var LABEL = { research: ['research', 'ICL PhD · 4 papers'], projects: ['projects', 'SafeClaw · open source'], talks: ['talks', '9 talks · 2018 to 2026'], about: ['about', 'career · education · honors'] };
 MODULES.forEach(function (id) {
  var a = DATA.asterisms[id];
  var members = a.pts.map(function (p) { return { dir: radecToDir(p[0], p[1]), mag: p[2], col: bvToRgb(p[3]), name: p[4] }; });
  var cen = [0, 0, 0];
  members.forEach(function (m) { cen[0] += m.dir[0]; cen[1] += m.dir[1]; cen[2] += m.dir[2]; });
  var n = Math.hypot(cen[0], cen[1], cen[2]); cen = [cen[0] / n, cen[1] / n, cen[2] / n];
  CONS.push({ id: id, name: LABEL[id][0], sub: LABEL[id][1], members: members, lines: a.lines, dir: cen,
   brightIdx: a.brightIdx, specialIdx: a.specialIdx, warmIdx: a.warmIdx, hover: 0, pulseStart: null, rad: 60, sx: 0, sy: 0, bbox: null });
 });
 var byId = {}; CONS.forEach(function (c) { byId[c.id] = c; });

 var pulseNext = 0, lastPulseId = null;
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
   pick.pulseStart = now; lastPulseId = pick.id;
   pulseNext = now + 4000 + Math.random() * 3000;
  }
 }
 function visOf(c, now) {
  var base = 0.30;
  if (zoomed) return (activeId === c.id) ? 0.95 : 0.28;
  var v = Math.max(base, base + pulseAlpha(c, now) * (0.55 - base));
  var hoverA = Math.max(c.hover, litId === c.id ? 1 : 0);
  v = Math.max(v, base + hoverA * (0.95 - base));
  return still ? Math.max(v, 0.55) : v;
 }

 function drawCon(c, now) {
  var vis = visOf(c, now);
  var pts = c.members.map(function (m) { return project(m.dir); });
  if (pts.some(function (p) { return !p; })) return;
  var sizeMul = (zoomed && activeId === c.id) ? 1.3 : 1;
  var scaleK = Math.sqrt(CAM.F / REST.F);

  ctx.strokeStyle = 'rgba(190,220,255,' + (0.34 * vis) + ')';
  ctx.lineWidth = 1;
  for (var li = 0; li < c.lines.length; li++) {
   var p0 = pts[c.lines[li][0]], p1 = pts[c.lines[li][1]];
   ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
  }
  /* members: the GL star underneath already carries the real brightness and colour; the
   overlay adds the attention light (a soft ring whose alpha follows vis) so the figure reads
   as a figure, and marks the special star in SafeClaw cyan. */
  var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (var i = 0; i < pts.length; i++) {
   var p = pts[i], m = c.members[i];
   minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
   var r = (1.6 + Math.max(0, 4.5 - m.mag) * 0.5) * scaleK * sizeMul;
   var attn = Math.max(0, (vis - 0.3) / 0.65); /* 0 at rest, 1 under full attention: the GL star already carries the real brightness and colour, the overlay only adds light when looked at */
   if (c.specialIdx === i) {
    var glow = (10 + 2 * Math.sin(now / 700)) * sizeMul * scaleK;
    ctx.beginPath(); ctx.arc(p.x, p.y, glow, 0, 7);
    ctx.fillStyle = 'rgba(150,235,255,' + (0.12 + 0.14 * vis) + ')'; ctx.fill();
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.9, 0, 7);
    ctx.fillStyle = 'rgba(190,245,255,' + (0.35 + 0.45 * vis * (0.75 + 0.25 * Math.sin(now / 700))) + ')'; ctx.fill();
   } else if (attn > 0.02) {
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.2, 0, 7);
    ctx.fillStyle = 'rgba(170,230,255,' + (0.16 * attn) + ')'; ctx.fill();
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.8, 0, 7);
    ctx.fillStyle = 'rgba(250,253,255,' + (0.55 * attn) + ')'; ctx.fill();
   }
  }
  c.sx = (minX + maxX) / 2; c.sy = (minY + maxY) / 2; c.bbox = [minX, minY, maxX, maxY];
  c.rad = Math.max(46, Math.hypot(maxX - minX, maxY - minY) * 0.5 + 12);

  if (zoomed && activeId !== c.id) return; /* while a module is open the other figures stay as faint lines only: their labels would float over the panel text */
  var la = still ? 0.9 : 0.55 + 0.45 * vis;
  var half = 60;
  var lx = Math.max(half, Math.min(W - half, c.sx)), ly = maxY + 22 * scaleK; /* keep the label inside the viewport even when the figure touches an edge (phone) */
  ctx.textAlign = 'center';
  ctx.save();
  ctx.font = '300 16px Spectral, serif';
  ctx.shadowColor = 'rgba(140,210,255,' + (0.7 * la) + ')'; ctx.shadowBlur = 9;
  ctx.fillStyle = 'rgba(236,244,255,' + la + ')';
  ctx.fillText(c.name, lx, ly);
  ctx.restore();
 }

 /* home mark: where the camera rests; click toggles freeze (or zooms out). there is no
  Polaris in a south-west view, so the mark is the rest centre itself, kept very quiet. */
 function homeScreen() { return { x: W / 2 - GAZE.cx, y: H / 2 - GAZE.cy }; }
 function drawHome(now) {
  if (zoomed) return;
  var p = homeScreen();
  var tw = still ? 1 : 0.85 + 0.15 * Math.sin(now / 900);
  ctx.beginPath(); ctx.arc(p.x, p.y, 1.6, 0, 7);
  ctx.fillStyle = 'rgba(250,253,255,' + (0.35 + 0.25 * tw) + ')'; ctx.fill();
  if (frozen) {
   ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, 7);
   ctx.strokeStyle = 'rgba(190,220,255,.4)'; ctx.lineWidth = 1; ctx.stroke();
  }
 }

 /* echo (shell `echo` drawn on the sky) and meteors: screen space, brief */
 var echo = null;
 function drawEcho(now) {
  if (!echo) return;
  var FADE_IN = 800, HOLD = 2500, FADE_OUT = 1500, TOTAL = FADE_IN + HOLD + FADE_OUT;
  var el = now - echo.t0;
  if (el > TOTAL) { echo = null; return; }
  var a = el < FADE_IN ? smooth01(el / FADE_IN) : el < FADE_IN + HOLD ? 1 : 1 - smooth01((el - FADE_IN - HOLD) / FADE_OUT);
  var drift = Math.min(el, FADE_IN + HOLD) / (FADE_IN + HOLD) * 14;
  ctx.save();
  ctx.font = 'italic 300 28px Spectral, serif'; ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(216,192,138,.55)'; ctx.shadowBlur = 14;
  ctx.fillStyle = 'rgba(216,192,138,' + (0.75 * a) + ')';
  ctx.fillText(echo.text, W / 2, H * 0.44 - drift);
  ctx.restore();
 }
 function setEcho(text) { echo = { text: text, t0: performance.now() }; if (still) repaint(); }

 var meteors = [], meteorNext = 0;
 function scheduleMeteor(now) {
  var gap = 90000 + Math.random() * 60000;
  if (Math.random() < 0.15) gap += 90000 + Math.random() * 90000;
  meteorNext = now + gap;
 }
 function drawMeteors(now) {
  if (zoomed) { meteors = []; return; }
  if (now >= meteorNext) {
   var ang = (200 + Math.random() * 50) * D2R;
   meteors.push({ x: W * (0.2 + Math.random() * 0.6), y: H * (0.05 + Math.random() * 0.4), vx: Math.cos(ang) * 900, vy: -Math.sin(ang) * 900, t0: now, life: 500 + Math.random() * 300 });
   scheduleMeteor(now);
  }
  for (var i = meteors.length - 1; i >= 0; i--) {
   var m = meteors[i], t = (now - m.t0) / 1000, env = 1 - (now - m.t0) / m.life;
   if (env <= 0) { meteors.splice(i, 1); continue; }
   var x = m.x + m.vx * t, y = m.y + m.vy * t, len = 90 * env;
   var grad = ctx.createLinearGradient(x - m.vx / 900 * len, y - m.vy / 900 * len, x, y);
   grad.addColorStop(0, 'rgba(170,230,255,0)'); grad.addColorStop(1, 'rgba(240,248,255,' + (0.8 * env) + ')');
   ctx.beginPath(); ctx.moveTo(x - m.vx / 900 * len, y - m.vy / 900 * len); ctx.lineTo(x, y);
   ctx.strokeStyle = grad; ctx.lineWidth = 1.4; ctx.lineCap = 'round'; ctx.stroke();
   ctx.beginPath(); ctx.arc(x, y, 1.6, 0, 7); ctx.fillStyle = 'rgba(250,253,255,' + (0.95 * env) + ')'; ctx.fill();
  }
 }

 /* --- camera --- */
 function restFor() { return mobile ? VIEW_MOBILE : VIEW; }
 function focalFor(fov) { return (W / 2) / Math.tan(fov / 4); }
 function layout() {
  var newW = innerWidth, newH = innerHeight;
  if (!newW || !newH) return;
  W = newW; H = newH; dpr = Math.min(devicePixelRatio || 1, 2);
  mobile = W < 720;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  glCanvas.width = Math.round(W * dpr); glCanvas.height = Math.round(H * dpr);
  var v = restFor();
  REST.yaw = v.yaw; REST.pitch = v.pitch; REST.F = focalFor(v.fov);
  if (zoomed && activeId && byId[activeId]) { var t = targetCamFor(activeId); CAM.yaw = t.yaw; CAM.pitch = t.pitch; CAM.F = t.F; }
  else { zoomed = false; activeId = null; CAM.yaw = REST.yaw; CAM.pitch = REST.pitch; CAM.F = REST.F; }
  camAnim = null; frozen = false; gazeIdling = false;
  rebuildCam();
 }
 function applyGaze() { /* the pose rests; the look-around itself is composed in rebuildCam() from GAZE (pixels at the rest focal length -> radians) */
  CAM.yaw = REST.yaw; CAM.pitch = REST.pitch; CAM.F = REST.F;
 }
 /* fly-to target: the asterism centre lands at (0.225W, 0.5H) (phone: 0.5W, 0.2H) with the
  focal length x ZOOM. solved by a few fixed-point steps on yaw/pitch against the actual
  projection, which converges fast at these offsets. */
 function targetCamFor(id) {
  var c = byId[id];
  var F = REST.F * ZOOM;
  var sx = mobile ? W * 0.5 : W * 0.225, sy = mobile ? H * 0.20 : H * 0.5;
  var hor = apply3(M_EQ2HOR, c.dir);
  var yaw = Math.atan2(hor[0], hor[1]), pitch = Math.asin(Math.max(-1, Math.min(1, hor[2])));
  for (var k = 0; k < 12; k++) {
   var m = eqToCamMatrix(yaw, pitch), v = apply3(m, c.dir), inv = 1 / (1 + v[2]);
   var px = W / 2 + F * v[0] * inv, py = H / 2 - F * v[1] * inv;
   var ex = px - sx, ey = py - sy;
   if (Math.abs(ex) < 0.2 && Math.abs(ey) < 0.2) break;
   yaw += ex / F / Math.max(0.2, Math.cos(pitch)) * 0.9;
   pitch -= ey / F * 0.9;
   pitch = Math.max(-0.3, Math.min(1.5, pitch));
  }
  return { yaw: yaw, pitch: pitch, F: F };
 }
 function setCamImmediate(t) { CAM.yaw = t.yaw; CAM.pitch = t.pitch; CAM.F = t.F; camAnim = null; }
 function tweenCam(target, dur, onDone) {
  /* yaw is an angle: take the short way round. the rest pose sits at 240 degrees while
   targetCamFor() solves in (-180, 180], so without this the fly-in swung the camera a full
   turn through the whole sky ("跳跃好远") instead of the few degrees actually needed. */
  var dy = target.yaw - CAM.yaw;
  while (dy > Math.PI) dy -= 2 * Math.PI;
  while (dy < -Math.PI) dy += 2 * Math.PI;
  target = { yaw: CAM.yaw + dy, pitch: target.pitch, F: target.F };
  if (still || dur <= 0) { setCamImmediate(target); if (onDone) onDone(); return; }
  camAnim = { from: { yaw: CAM.yaw, pitch: CAM.pitch, F: CAM.F }, to: target, gaze0: { cx: GAZE.cx, cy: GAZE.cy }, t0: performance.now(), dur: dur, onDone: onDone };
 }
 function updateCam(now) {
  if (!camAnim) return;
  var t = Math.min(1, (now - camAnim.t0) / camAnim.dur), e = easeInOutCubic(t);
  CAM.yaw = camAnim.from.yaw + (camAnim.to.yaw - camAnim.from.yaw) * e;
  CAM.pitch = camAnim.from.pitch + (camAnim.to.pitch - camAnim.from.pitch) * e;
  CAM.F = camAnim.from.F + (camAnim.to.F - camAnim.from.F) * e;
  GAZE.cx = camAnim.gaze0.cx * (1 - e); GAZE.cy = camAnim.gaze0.cy * (1 - e); /* whatever look-around was in effect folds into the flight instead of snapping off at its start */
  if (t >= 1) { var cb = camAnim.onDone; camAnim = null; if (cb) cb(); }
 }
 function flyTo(id) {
  if (!byId[id] || activeId === id && zoomed && !camAnim) return;
  zoomed = true; activeId = id; ptrDragging = false; meteors = [];
  dispatchEvent(new CustomEvent('sky:zoomstart', { detail: { id: id } }));
  tweenCam(targetCamFor(id), 700, function () { dispatchEvent(new CustomEvent('sky:settle', { detail: { id: id } })); });
  if (still) repaint();
 }
 function flyOut() {
  if (!zoomed) return;
  zoomed = false; activeId = null;
  dispatchEvent(new CustomEvent('sky:zoomstart', { detail: { id: null } }));
  tweenCam({ yaw: REST.yaw, pitch: REST.pitch, F: REST.F }, 700, function () { dispatchEvent(new CustomEvent('sky:settle', { detail: { id: null } })); });
  if (still) repaint();
 }
 function stepNext() { if (!zoomed) return; var i = MODULES.indexOf(activeId); flyTo(MODULES[(i + 1) % MODULES.length]); }
 function stepPrev() { if (!zoomed) return; var i = MODULES.indexOf(activeId); flyTo(MODULES[(i - 1 + MODULES.length) % MODULES.length]); }
 function onHomeClick() {
  if (zoomed) { flyOut(); return; }
  frozen = !frozen;
  if (frozen) { gazeIdling = false; tweenCam({ yaw: REST.yaw, pitch: REST.pitch, F: REST.F }, 1000); }
  else { camAnim = null; }
 }

 /* the gaze: same ambient model as v5-v9 (pointer -> damped spring, idle Lissajous wander,
  touch drag with momentum), only the unit changed: GAZE.cx/cy are pixels at the rest focal
  length and become yaw/pitch in applyGaze(). full pointer travel turns the head ~3 degrees. */
 var K = 0.05, SPRING_TAU = 0.13, IDLE_MS = 6000, WANDER_PERIOD = 90, WANDER_AMP = 22;
 var lastMoveTime = -1e9, gazeIdling = false, gazeIdleStart = 0, gazeIdleAnchorX = 0, gazeIdleAnchorY = 0;
 var touchRawX = 0, touchRawY = 0, touchVelX = 0, touchVelY = 0, touchMomentumActive = false;
 var GAZE_MAX = 0.09; /* radians of head turn a drag may reach (~5 degrees); pointer gaze stays well inside */
 function clampGaze(v) { var lim = GAZE_MAX * REST.F; return Math.max(-lim, Math.min(lim, v)); }
 function wanderOffset(now, t0, ax, ay) {
  var t = (now - t0) / 1000;
  return { x: ax + WANDER_AMP * Math.sin((2 * Math.PI * t) / WANDER_PERIOD), y: ay + WANDER_AMP * 0.7 * Math.sin((2 * Math.PI * t) / (WANDER_PERIOD * 1.5) + 1.3) };
 }
 function updateGaze(now, dt) {
  if (zoomed || frozen || camAnim) return; /* the flight (in or out) and the freeze hold own the camera; the spring resumes from GAZE = 0 the frame after a flight lands, which is exactly where the flight leaves it, so nothing jumps (v10.0 let applyGaze() overwrite the fly-out tween on its first frame: the exit snapped) */
  if (still) { GAZE.cx = 0; GAZE.cy = 0; applyGaze(); return; }
  if (touch && ptrDragging) { GAZE.cx = clampGaze(touchRawX); GAZE.cy = clampGaze(touchRawY); applyGaze(); return; }
  var desiredX, desiredY;
  if (touch) {
   if (touchMomentumActive) {
    touchRawX += touchVelX * dt; touchRawY += touchVelY * dt;
    var decay = Math.exp(-dt / 0.4); touchVelX *= decay; touchVelY *= decay;
    if (Math.hypot(touchVelX, touchVelY) < 2) { touchMomentumActive = false; gazeIdling = true; gazeIdleStart = now; gazeIdleAnchorX = touchRawX; gazeIdleAnchorY = touchRawY; }
    desiredX = touchRawX; desiredY = touchRawY;
   } else {
    if (!gazeIdling) { gazeIdling = true; gazeIdleStart = now; gazeIdleAnchorX = GAZE.cx; gazeIdleAnchorY = GAZE.cy; }
    var w0 = wanderOffset(now, gazeIdleStart, gazeIdleAnchorX, gazeIdleAnchorY); desiredX = w0.x; desiredY = w0.y;
   }
  } else if (mouse.x < 0 || now - lastMoveTime > IDLE_MS) {
   if (!gazeIdling) { gazeIdling = true; gazeIdleStart = now; gazeIdleAnchorX = GAZE.cx; gazeIdleAnchorY = GAZE.cy; }
   var w1 = wanderOffset(now, gazeIdleStart, gazeIdleAnchorX, gazeIdleAnchorY); desiredX = w1.x; desiredY = w1.y;
  } else {
   gazeIdling = false;
   desiredX = (mouse.x - W / 2) * K; desiredY = (mouse.y - H / 2) * K;
  }
  var f = 1 - Math.exp(-dt / SPRING_TAU);
  GAZE.cx = clampGaze(GAZE.cx + (clampGaze(desiredX) - GAZE.cx) * f);
  GAZE.cy = clampGaze(GAZE.cy + (clampGaze(desiredY) - GAZE.cy) * f);
  applyGaze();
 }

 /* --- frame --- */
 var PERF = { emaMs: 0, samples: 0 };
 var lastT = performance.now();
 scheduleMeteor(lastT);
 function frame(now) {
  if (document.hidden) { if (!still) requestAnimationFrame(frame); return; }
  var t0 = performance.now();
  /* dt from performance.now(), not the rAF timestamp: the two clocks are not guaranteed to
   agree at the first frame (headless and some vsync paths hand rAF a stamp behind, or on
   another origin than, performance.now()), and a negative dt flips the spring's sign so the
   gaze spirals off to thousands of pixels before it recovers. clamped to [0, 100ms]. */
  var dt = Math.max(0, Math.min((t0 - lastT) / 1000, 0.1)); lastT = t0;
  updateCam(now);
  updateGaze(now, dt);
  rebuildCam();

  drawGL(now);

  ctx.clearRect(0, 0, W, H);
  maybePulse(now);
  var anyHover = false;
  if (!touch && mouse.x >= 0) {
   var attnR = 0.3 * Math.min(W, H);
   var hp = homeScreen();
   if (Math.hypot(mouse.x - hp.x, mouse.y - hp.y) < 14) anyHover = true;
   var nearestC = null, nearestD = Infinity;
   for (var ci = 0; ci < CONS.length; ci++) {
    var dd = Math.hypot(mouse.x - CONS[ci].sx, mouse.y - CONS[ci].sy);
    if (dd < nearestD) { nearestD = dd; nearestC = CONS[ci]; }
   }
   for (var cj = 0; cj < CONS.length; cj++) {
    var c = CONS[cj], want = (c === nearestC && nearestD < attnR) ? 1 : 0;
    if (want) anyHover = true;
    c.hover += (want - c.hover) * (still ? 1 : 0.15);
   }
  } else { for (var ck = 0; ck < CONS.length; ck++) CONS[ck].hover *= 0.9; }
  for (var k = 0; k < CONS.length; k++) drawCon(CONS[k], now);
  drawHome(now);
  if (!still) drawMeteors(now);
  drawEcho(now);
  canvas.style.cursor = anyHover ? 'pointer' : '';

  var dtm = performance.now() - t0;
  PERF.samples++; PERF.emaMs = PERF.samples === 1 ? dtm : PERF.emaMs * 0.9 + dtm * 0.1;
  if (!still) requestAnimationFrame(frame);
 }
 function repaint() { frame(performance.now()); }

 /* --- pointer --- */
 var ptrActive = false, ptrDragging = false, ptr0 = { x: 0, y: 0 }, dragLastX = 0, dragLastY = 0, dragLastT = 0, THRESH = 6;
 canvas.addEventListener('pointerdown', function (e) {
  ptrActive = true; ptrDragging = false; ptr0.x = e.clientX; ptr0.y = e.clientY;
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
 });
 canvas.addEventListener('pointermove', function (e) {
  if (!touch) { mouse.x = e.clientX; mouse.y = e.clientY; lastMoveTime = performance.now(); }
  if (!ptrActive) return;
  var dx = e.clientX - ptr0.x, dy = e.clientY - ptr0.y;
  if (!ptrDragging && Math.hypot(dx, dy) > THRESH) {
   ptrDragging = true;
   if (touch && !zoomed) { touchRawX = GAZE.cx; touchRawY = GAZE.cy; touchMomentumActive = false; touchVelX = 0; touchVelY = 0; dragLastX = e.clientX; dragLastY = e.clientY; dragLastT = performance.now(); }
  }
  if (!ptrDragging || zoomed) { if (still) repaint(); return; }
  if (touch) {
   var now = performance.now();
   var mdx = (e.clientX - dragLastX) * 0.35, mdy = (e.clientY - dragLastY) * 0.35; /* the sky follows the finger at a third of its travel: enough to feel, not enough to lose the page */
   var mdt = Math.max((now - dragLastT) / 1000, 0.001);
   touchRawX -= mdx; touchRawY -= mdy;
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
   ptrDragging = false; return;
  }
  if (touch && ptrDragging) { touchMomentumActive = true; ptrDragging = false; return; }
  if (!ptrDragging) {
   var hp = homeScreen();
   if (Math.hypot(e.clientX - hp.x, e.clientY - hp.y) < 14) onHomeClick();
   else {
    for (var i = 0; i < CONS.length; i++) {
     var c = CONS[i];
     if (Math.hypot(e.clientX - c.sx, e.clientY - c.sy) < c.rad * (touch ? 1.5 : 1)) { dispatchEvent(new CustomEvent('sky:select', { detail: c.id })); break; }
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
  flyTo: flyTo, flyOut: flyOut, next: stepNext, prev: stepPrev, home: onHomeClick, echo: setEcho,
  current: function () { return activeId; },
  isZoomed: function () { return zoomed; },
  perf: function () { return { avgMs: PERF.emaMs, samples: PERF.samples, stars: starCount, tex: texReady }; },
  tune: function (o) { for (var k in o) TUNE[k] = o[k]; if (still) repaint(); }, /* dev: Sky.tune({gain: 1.3}) */
  cam: function () { return { yaw: CAM.yaw, pitch: CAM.pitch, F: CAM.F, rest: REST, gaze: GAZE, idle: gazeIdling, still: still, anim: !!camAnim }; }, /* dev: read the live camera */
  engine: 'webgl',
 };

 /* --- boot: GL first (navy + atmosphere paints on the very first frame), stars as soon as
  the 155KB catalogue lands, the milky way map last, fading in. nothing here blocks paint. --- */
 initGL();
 layout();
 requestAnimationFrame(frame);
 /* the catalogue comes in two files, brightest first: the naked-eye sky (mag <= 6, ~5k stars,
  30KB) is on screen within the first few hundred milliseconds, the faint 36k follow and are
  appended in place; the map starts loading once the bright set is up. */
 function fetchBin(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }); }
 fetchBin('data/stars-bright.bin?v=14').then(function (buf) {
  uploadStars(unpackStars(buf));
  if (still) repaint();
  loadTexture();
  return fetchBin('data/stars-faint.bin?v=14').then(function (buf2) {
   var faint = unpackStars(buf2), all = new Float32Array(starVerts.length + faint.length);
   all.set(starVerts); all.set(faint, starVerts.length);
   uploadStars(all);
   if (still) repaint();
  });
 }).catch(function (err) { if (window.console) console.warn('sky: star catalogue failed to load', err); if (!tex) loadTexture(); });
 if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (still) repaint(); });
})();
