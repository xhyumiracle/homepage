/* v2 sky: a rotating field of background stars, pinned constellations, one bright one */
(function () {
  const canvas = document.getElementById('sky');
  const ctx = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const touch = matchMedia('(hover: none)').matches;
  const shot = /[?&]shot/.test(location.search);
  const still = reduced || shot;

  let W = 0, H = 0, dpr = 1, diag = 0;
  let stars = [], meteors = [];
  let mouse = { x: -1, y: -1 }, par = { x: 0, y: 0 };
  let hoverId = null, litId = null;   /* litId: forced highlight from legend hover */
  const OMEGA = (Math.PI * 2) / 2400; /* one revolution per 40 min */
  const t0 = performance.now();

  const CONS = [
    { id: 'ch1', name: '01 · first exploits', sub: '2012–2018',
      ax: .36, ay: .63, max: .22, may: .45,
      pts: [[0,0],[.55,-.12],[.5,.45],[1.05,.4],[1,.95]], close: false },
    { id: 'ch2', name: '02 · a hundred zero-days', sub: '2018–2023',
      ax: .44, ay: .30, max: .60, may: .37,
      pts: [[0,.1],[.3,-.15],[.62,.05],[.9,-.2],[1.25,0],[1.5,-.3]], close: false },
    { id: 'ch3', name: '03 · builder years', sub: '2023–2025',
      ax: .40, ay: .44, max: .24, may: .63,
      pts: [[0,.6],[.2,.15],[.55,0],[.9,.18],[1.1,.62]], close: false },
    { id: 'ch4', name: '04 · agent security', sub: '2025–now',
      ax: .62, ay: .55, max: .68, may: .53,
      pts: [[.5,0],[1,.35],[.8,.9],[.2,.9],[0,.35]], close: true },
    { id: 'safeclaw', name: 'SafeClaw', sub: 'now · live', bright: true,
      ax: .68, ay: .14, max: .50, may: .30,
      pts: [[0,0]], close: false },
    { id: 'archive', name: 'fainter stars', sub: 'archive', dim: true,
      ax: .55, ay: .77, max: .48, may: .73,
      pts: [[0,0],[.7,.25],[.25,.55]], close: true },
  ];
  CONS.forEach(c => { c.hover = 0; c.pulse = 0; c.stars = []; });

  const QMARK = { x: 0, y: 0, hover: 0,
    line: 'most of what moves the world never survives it. what does is half a sentence.' };

  function layout() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight; diag = Math.hypot(W, H);
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mobile = W < 720;

    const s = Math.min(W, H) * (mobile ? 0.085 : 0.10);
    for (const c of CONS) {
      const ax = mobile ? c.max : c.ax, ay = mobile ? c.may : c.ay;
      c.stars = c.pts.map(p => ({ x: ax * W + p[0] * s, y: ay * H + p[1] * s }));
      const xs = c.stars.map(p => p.x), ys = c.stars.map(p => p.y);
      c.cx = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
      c.cy = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
      c.botY = Math.max.apply(null, ys);
      c.rad = Math.max(s * (c.bright ? 0.9 : 1.3), 48);
    }
    QMARK.x = W * (mobile ? 0.16 : 0.24); QMARK.y = H * (mobile ? 0.62 : 0.56);

    /* background stars in polar coords around an off-screen pole */
    const px = W * 1.15, py = -H * 0.25;
    const n = Math.round(W * H / (mobile ? 2400 : 1250));
    stars = [];
    while (stars.length < n) {
      const u = Math.random(), v = Math.random();
      const d = Math.abs(u + v - 1) / Math.SQRT2;   /* milky way diagonal density band */
      if (Math.random() > 0.3 + 0.7 * Math.exp(-Math.pow(d / 0.14, 2))) continue;
      const x = u * W, y = v * H;
      const roll = Math.random();
      stars.push({
        r: Math.hypot(x - px, y - py),
        a: Math.atan2(y - py, x - px),
        size: Math.random() < 0.035 ? 1.5 + Math.random() * 0.9 : 0.35 + Math.random() * 0.85,
        alpha: 0.3 + Math.random() * 0.55,
        ph: Math.random() * Math.PI * 2,
        sp: 0.4 + Math.random() * 1.1,
        depth: 0.5 + Math.random() * 0.5,
        tint: roll < 0.9 ? '232,230,221' : roll < 0.97 ? '216,192,138' : '160,190,230',
      });
    }
    stars.pole = { x: px, y: py };
  }

  function drawCon(c, now) {
    const forced = (litId === c.id) ? 1 : 0;
    const base = c.dim ? 0.14 : 0.22;
    const vis = still ? 0.55 : Math.min(1, base + Math.max(c.hover, c.pulse * 0.6, forced) * (1 - base));
    /* member stars */
    for (const p of c.stars) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, (c.bright ? 2.7 : c.dim ? 1.4 : 1.9) + vis * 0.8, 0, 7);
      ctx.fillStyle = c.bright
        ? 'rgba(138,212,207,' + (0.75 + 0.25 * Math.sin(now / 700)) + ')'
        : 'rgba(233,228,214,' + (0.5 + 0.45 * vis) + ')';
      ctx.fill();
      if (c.bright) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 9 + 2 * Math.sin(now / 700), 0, 7);
        ctx.fillStyle = 'rgba(138,212,207,0.13)'; ctx.fill();
      }
    }
    /* lines: visible by default, brighter on attention */
    if (c.stars.length > 1) {
      const pts = c.close ? c.stars.concat([c.stars[0]]) : c.stars;
      ctx.strokeStyle = 'rgba(216,192,138,' + (0.38 * vis) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    /* labels: name + sub, always readable */
    const la = still ? 0.9 : 0.55 + 0.45 * vis;
    const align = c.cx > W * 0.5 ? 'right' : 'left';
    const lx = c.cx + (align === 'right' ? -c.rad * 0.15 : c.rad * 0.15);
    ctx.textAlign = align;
    ctx.font = '11px PlexMono, monospace';
    ctx.fillStyle = c.bright ? 'rgba(138,212,207,' + la + ')' : 'rgba(180,184,196,' + la + ')';
    ctx.fillText(c.name, lx, c.botY + 20);
    ctx.font = '9px PlexMono, monospace';
    ctx.fillStyle = 'rgba(86,91,107,' + la + ')';
    ctx.fillText(c.sub, lx, c.botY + 34);
  }

  function drawQmark(now) {
    const a = 0.35 + 0.5 * QMARK.hover + (still ? 0.15 : 0.08 * Math.sin(now / 900));
    ctx.textAlign = 'center';
    ctx.font = 'italic 15px Spectral, serif';
    ctx.fillStyle = 'rgba(216,192,138,' + a + ')';
    ctx.fillText('?', QMARK.x, QMARK.y);
    if (QMARK.hover > 0.5) {
      ctx.font = 'italic 11px Spectral, serif';
      ctx.fillStyle = 'rgba(139,144,160,' + QMARK.hover * 0.9 + ')';
      ctx.textAlign = QMARK.x < W / 2 ? 'left' : 'right';
      ctx.fillText(QMARK.line, QMARK.x + (QMARK.x < W / 2 ? 14 : -14), QMARK.y + 1);
    }
  }

  let pulseIdx = 0, lastPulse = 0;
  function frame(now) {
    if (document.hidden) { requestAnimationFrame(frame); return; }
    ctx.clearRect(0, 0, W, H);
    const t = (now - t0) / 1000;
    par.x += (((mouse.x >= 0 ? mouse.x : W / 2) - W / 2) / W * 8 - par.x) * 0.04;
    par.y += (((mouse.y >= 0 ? mouse.y : H / 2) - H / 2) / H * 8 - par.y) * 0.04;

    /* rotating background field */
    const pole = stars.pole, rot = still ? 0 : OMEGA * t;
    for (const s of stars) {
      const a = s.a + rot;
      const x = pole.x + s.r * Math.cos(a) - par.x * s.depth;
      const y = pole.y + s.r * Math.sin(a) - par.y * s.depth;
      if (x < -8 || x > W + 8 || y < -8 || y > H + 8) continue;
      const tw = still ? 1 : 0.72 + 0.28 * Math.sin(t * s.sp + s.ph);
      ctx.beginPath();
      ctx.arc(x, y, s.size, 0, 7);
      ctx.fillStyle = 'rgba(' + s.tint + ',' + (s.alpha * tw) + ')';
      ctx.fill();
    }

    /* meteors */
    if (!still) {
      if (now - (meteors.last || 0) > 18000 + Math.random() * 18000) {
        meteors.last = now;
        const mx = Math.random() * W * 0.8 + W * 0.1, my = Math.random() * H * 0.3;
        meteors.push({ x: mx, y: my, vx: -(3 + Math.random() * 3), vy: 2 + Math.random() * 2, life: 1 });
      }
      for (const m of meteors) {
        m.x += m.vx; m.y += m.vy; m.life -= 0.02;
        if (m.life <= 0) continue;
        ctx.strokeStyle = 'rgba(233,228,214,' + (0.5 * m.life) + ')';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.vx * 8, m.y - m.vy * 8); ctx.stroke();
      }
      meteors = meteors.filter(m => m.life > 0), meteors.last = meteors.last || now;
    }

    /* gentle attention pulse cycling through constellations */
    if (!still && now - lastPulse > 5200) { lastPulse = now; CONS[pulseIdx % CONS.length].pulse = 1; pulseIdx++; }

    let anyHover = false;
    for (const c of CONS) {
      if (!touch && mouse.x >= 0) {
        const want = Math.hypot(mouse.x - c.cx, mouse.y - c.cy) < c.rad ? 1 : 0;
        if (want) { anyHover = true; hoverId = c.id; }
        c.hover += (want - c.hover) * (still ? 1 : 0.1);
      }
      c.pulse *= 0.985;
      drawCon(c, now);
    }
    if (!anyHover && hoverId) hoverId = null;

    const qw = Math.hypot(mouse.x - QMARK.x, mouse.y - QMARK.y) < 26 ? 1 : 0;
    QMARK.hover += (qw - QMARK.hover) * (still ? 1 : 0.12);
    drawQmark(now);

    document.body.style.cursor = anyHover ? 'pointer' : '';
    if (!still) requestAnimationFrame(frame);
  }

  /* public API for main.js */
  window.Sky = {
    highlight: function (id, on) { litId = on ? id : (litId === id ? null : litId); if (still) frame(performance.now()); },
    repaint: function () { frame(performance.now()); },
  };

  addEventListener('resize', function () { layout(); if (still) frame(performance.now()); }, { passive: true });
  addEventListener('mousemove', function (e) {
    if (e.target !== canvas) { mouse.x = -1; mouse.y = -1; return; }
    mouse.x = e.clientX; mouse.y = e.clientY;
  }, { passive: true });
  canvas.addEventListener('click', function (e) {
    for (const c of CONS) {
      if (Math.hypot(e.clientX - c.cx, e.clientY - c.cy) < c.rad * (touch ? 1.5 : 1)) {
        dispatchEvent(new CustomEvent('sky:select', { detail: c.id }));
        return;
      }
    }
  });

  layout();
  requestAnimationFrame(frame);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (still) frame(performance.now()); });
})();
