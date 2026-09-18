/* reveals + command palette */
(function () {
  const shotM = location.search.match(/[?&]shot(?:=([a-z0-9]+))?/);
  if (shotM) {
    document.documentElement.classList.add('shot');
    if (shotM[1]) addEventListener('load', () => setTimeout(() => {
      const el = document.getElementById(shotM[1]);
      if (el) el.style.cssText += ';position:fixed;inset:0;z-index:5;background:#070a12;min-height:0;height:100vh;overflow:hidden;';
    }, 60));
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* scroll-in */
  const io = new IntersectionObserver(es => {
    for (const e of es) if (e.isIntersecting) { e.target.classList.add('seen'); io.unobserve(e.target); }
  }, { threshold: 0.25 });
  document.querySelectorAll('.question, .chapter, .safeclaw, .fainter').forEach(el => io.observe(el));

  /* command palette */
  const pal = document.getElementById('palette');
  const input = document.getElementById('paletteInput');
  const list = document.getElementById('paletteList');
  const fab = document.getElementById('paletteFab');
  const CMDS = [
    { l: 'the sky', k: 'top', id: 'top', kw: 'home start sky stars' },
    { l: '其一 · the puzzle years', k: '2012', id: 'ch1', kw: 'icpc jhu ctf study bnu student' },
    { l: '其二 · a hundred zero-days', k: '2018', id: 'ch2', kw: 'blockchain security 0day cve defcon chaitin evm jop' },
    { l: '其三 · the builder detour', k: '2023', id: 'ch3', kw: 'cto startup opml erc standards' },
    { l: '其四 · agents', k: '2025', id: 'ch4', kw: 'papers research sudp locard acl tmlr phd imperial' },
    { l: 'safeclaw', k: 'now', id: 'safeclaw', kw: 'product credentials secrets passkey' },
    { l: 'fainter stars', k: 'archive', id: 'archive', kw: 'blog essays yucius m1r4c13 writing contact email' },
  ];
  let idx = 0, items = [];

  function render(q) {
    const s = q.trim().toLowerCase();
    if (s === 'sudo') {
      list.innerHTML = '<li class="egg">approval required: passkey not found.</li>';
      items = []; return;
    }
    items = CMDS.filter(c => !s || (c.l + ' ' + c.kw).toLowerCase().includes(s));
    idx = 0;
    list.innerHTML = items.map((c, i) =>
      `<li data-id="${c.id}" class="${i === 0 ? 'active' : ''}"><span>${c.l}</span><span class="k">${c.k}</span></li>`).join('');
  }
  function go(id) {
    close();
    document.getElementById(id)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
  }
  function open() { pal.hidden = false; input.value = ''; render(''); input.focus(); }
  function close() { pal.hidden = true; input.blur(); }

  fab.addEventListener('click', open);
  pal.addEventListener('click', e => { if (e.target === pal) close(); });
  list.addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) go(li.dataset.id); });
  input.addEventListener('input', () => render(input.value));
  document.addEventListener('keydown', e => {
    if (pal.hidden) {
      if (e.key === '/' && !e.target.closest('input, textarea')) { e.preventDefault(); open(); }
      return;
    }
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && items[idx]) go(items[idx].id);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      idx = (idx + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % Math.max(items.length, 1);
      [...list.children].forEach((li, i) => li.classList.toggle('active', i === idx));
    }
  });
})();
