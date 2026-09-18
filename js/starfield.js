/* the sky: stars, constellations, and one bright one */
(function () {
  const canvas = document.getElementById('sky');
  const ctx = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const touch = matchMedia('(hover: none)').matches;

  let W = 0, H = 0, dpr = 1, stars = [], t0 = performance.now();
  let mouse = { x: -1, y: -1 }, par = { x: 0, y: 0 };
  let interacted = false;

  const CONS = [
    { id: 'ch1', label: '01 · first exploits', ax: .14, ay: .22,
      pts: [[0,0],[.55,-.12],[.5,.45],[1.05,.4],[1,.95]], close: false },
    { id: 'ch2', label: '02 · a hundred zero-days', ax: .84, ay: .18,
      pts: [[0,.1],[.3,-.15],[.62,.05],[.9,-.2],[1.25,0],[1.5,-.3]], close: false },
    { id: 'ch3', label: '03 · builder years', ax: .12, ay: .72,
      pts: [[0,.6],[.2,.15],[.55,0],[.9,.18],[1.1,.62]], close: false },
    { id: 'ch4', label: '04 · agent security', ax: .87, ay: .68,
      pts: [[.5,0],[1,.35],[.8,.9],[.2,.9],[0,.35]], close: true },
    { id: 'safeclaw', label: 'now · safeclaw', ax: .66, ay: .1,
      pts: [[0,0]], close: false, bright: true },
  ];
  CONS.forEach(c => { c.hover = 0; c.pulse = 0; c.stars = []; });

  function layout() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const s = Math.min(W, H) * (W < 720 ? 0.085 : 0.11);
    CONS.forEach(c => {
      c.stars = c.pts.map(([px, py]) => ({ x: c.ax * W + px * s, y: c.ay * H + py * s }));
      const xs = c.stars.map(p => p.x), ys = c.stars.map(p => p.y);
      c.cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      c.cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      c.rad = Math.max(s * (c.bright ? 0.9 : 1.35), 52);
    });

    const n = Math.round(W * H / (W < 720 ? 2600 : 1300));
    stars = [];
    while (stars.length < n) {
      const u = Math.random(), v = Math.random();
      const d = Math.abs(u + v - 1) / Math.SQRT2;           /* milky way diagonal */
      if (Math.random() > 0.3 + 0.7 * Math.exp(-((d / 0.14) ** 2))) continue;
      const big = Math.random() < 0.035;
      const roll = Math.random();
      stars.push({
        x: u * W, y: v * H,
        r: big ? 1.5 + Math.random() * 0.9 : 0.35 + Math.random() * 0.85,
        a: 0.35 + Math.random() * 0.55,
        ph: Math.random() * Math.PI * 2,
        sp: 0.4 + Math.random() * 1.1,
        depth: 0.4 + Math.random() * 0.6,
        tint: roll < 0.9 ? '232,230,221' : roll < 0.97 ? '216,192,138' : '160,190,230',
      });
    }
  }

  function drawCon(c, now) {
    const vis = Math.max(c.hover, c.pulse, reduced ? 0.25 : 0);
    /* member stars */
    for (const p of c.stars) {
      const glow = c.bright ? 1 : 0.55 + 0.45 * vis;
      ctx.beginPath();
      ctx.arc(p.x, p.y, c.bright ? 2.6 : 1.9, 0, 7);
      ctx.fillStyle = c.bright
        ? `rgba(138,212,207,${0.8 + 0.2 * Math.sin(now / 700)})`
        : `rgba(233,228,214,${0.55 * glow + 0.35})`;
      ctx.fill();
      if (c.bright) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 9 + 2 * Math.sin(now / 700), 0, 7);
        ctx.fillStyle = 'rgba(138,212,207,0.12)'; ctx.fill();
      }
    }
    /* lines, partially drawn */
    if (vis > 0.01 && c.stars.length > 1) {
      const pts = c.close ? c.stars.concat([c.stars[0]]) : c.stars;
      const total = pts.length - 1, drawn = total * Math.min(vis * 1.15, 1);
      ctx.strokeStyle = `rgba(216,192,138,${0.34 * vis})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i <= Math.floor(drawn); i++) ctx.lineTo(pts[i].x, pts[i].y);
      const f = drawn - Math.floor(drawn), i = Math.floor(drawn);
      if (f > 0 && i < total) {
        ctx.lineTo(pts[i].x + (pts[i + 1].x - pts[i].x) * f,
                   pts[i].y + (pts[i + 1].y - pts[i].y) * f);
      }
      ctx.stroke();
    }
    /* label */
    const la = c.bright ? Math.max(vis, touch ? 0.5 : 0.35) : vis;
    if (la > 0.05) {
      ctx.font = '11px PlexMono, NotoSerifSCsub, monospace';
      ctx.textAlign = c.ax > 0.5 ? 'right' : 'left';
      ctx.fillStyle = `rgba(139,144,160,${0.9 * la})`;
      ctx.fillText(c.label, c.cx + (c.ax > 0.5 ? -c.rad * 0.2 : c.rad * 0.2), c.cy + c.rad + 6);
    }
  }

  let fade = 1;
  function frame(now) {
    if (scrollY > H * 1.8) { requestAnimationFrame(frame); return; }
    ctx.clearRect(0, 0, W, H);
    const t = (now - t0) / 1000;
    par.x += ((mouse.x >= 0 ? (mouse.x - W / 2) / W : 0) * 7 - par.x) * 0.04;
    par.y += ((mouse.y >= 0 ? (mouse.y - H / 2) / H : 0) * 7 - par.y) * 0.04;

    for (const s of stars) {
      const tw = reduced ? 1 : 0.72 + 0.28 * Math.sin(t * s.sp + s.ph);
      ctx.beginPath();
      ctx.arc(s.x - par.x * s.depth, s.y - par.y * s.depth, s.r, 0, 7);
      ctx.fillStyle = `rgba(${s.tint},${s.a * tw})`;
      ctx.fill();
    }

    let anyHover = false;
    for (const c of CONS) {
      if (!touch && mouse.x >= 0 && scrollY < H * 0.6) {
        const d = Math.hypot(mouse.x - c.cx, mouse.y - c.cy);
        const want = d < c.rad ? 1 : 0;
        if (want) { anyHover = true; interacted = true; }
        c.hover += (want - c.hover) * (reduced ? 1 : 0.08);
      } else c.hover *= 0.92;
      c.pulse *= 0.975;
      drawCon(c, now);
    }
    document.body.style.cursor = anyHover ? 'pointer' : '';
    requestAnimationFrame(frame);
  }

  /* idle hint: breathe each constellation in turn until first interaction */
  function hintCycle(i) {
    if (interacted && !touch) return;
    const c = CONS[i % CONS.length];
    c.pulse = 0.85;
    setTimeout(() => hintCycle(i + 1), i % CONS.length === CONS.length - 1 ? 6500 : 1400);
  }

  addEventListener('resize', layout, { passive: true });
  addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
  addEventListener('scroll', () => {
    fade = Math.max(0.14, 1 - scrollY / (H * 1.15));
    canvas.style.opacity = fade;
  }, { passive: true });
  document.addEventListener('click', e => {
    if (e.target.closest('a, button, input, .palette')) return;
    if (scrollY > H * 0.6) return;
    for (const c of CONS) {
      if (Math.hypot(e.clientX - c.cx, e.clientY - c.cy) < c.rad * (touch ? 1.4 : 1)) {
        interacted = true;
        document.getElementById(c.id === 'safeclaw' ? 'safeclaw' : c.id)
          ?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
        return;
      }
    }
  });

  layout();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => {});
  requestAnimationFrame(frame);
  setTimeout(() => hintCycle(0), 3000);
})();
