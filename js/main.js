/* v2: panel controller + legend linking + command palette */
(function () {
  const shotM = location.search.match(/[?&]shot(?:=([a-z0-9]+))?/);
  if (shotM) document.documentElement.classList.add('shot');

  const veil = document.getElementById('veil');
  const PANEL_IDS = ['ch1', 'ch2', 'ch3', 'ch4', 'safeclaw', 'archive'];
  let openId = null, lastFocus = null;

  function panelOf(id) { return PANEL_IDS.indexOf(id) >= 0 ? document.getElementById(id) : null; }

  function openRaw(id) {
    const p = panelOf(id);
    if (!p || openId === id) return;
    if (openId) closeRaw(true);
    lastFocus = document.activeElement;
    veil.hidden = false; p.hidden = false;
    void p.offsetHeight;                       /* reflow so the transition runs */
    veil.classList.add('open'); p.classList.add('open');
    p.focus({ preventScroll: true });
    openId = id;
  }
  function closeRaw(fast) {
    if (!openId) return;
    const p = panelOf(openId);
    veil.classList.remove('open'); p.classList.remove('open');
    if (fast || document.documentElement.classList.contains('shot')) {
      veil.hidden = true; p.hidden = true;
    } else {
      setTimeout(function () { veil.hidden = true; p.hidden = true; }, 300);
    }
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
    openId = null;
  }

  function sync() {
    const id = location.hash.replace('#', '');
    if (panelOf(id)) openRaw(id); else closeRaw();
  }
  function request(id) { if (location.hash !== '#' + id) location.hash = id; else sync(); }
  function dismiss() {
    if (location.hash) history.pushState('', document.title, location.pathname + location.search);
    sync();
  }

  addEventListener('hashchange', sync);
  addEventListener('popstate', sync);
  addEventListener('sky:select', function (e) { request(e.detail); });
  veil.addEventListener('click', dismiss);
  document.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', dismiss); });
  document.querySelectorAll('.legend-row').forEach(function (row) {
    const id = row.dataset.panel;
    row.addEventListener('click', function () { request(id); });
    row.addEventListener('mouseenter', function () { row.classList.add('lit'); if (window.Sky) Sky.highlight(id, true); });
    row.addEventListener('mouseleave', function () { row.classList.remove('lit'); if (window.Sky) Sky.highlight(id, false); });
  });

  /* command palette */
  const pal = document.getElementById('palette');
  const input = document.getElementById('paletteInput');
  const list = document.getElementById('paletteList');
  const fab = document.getElementById('paletteFab');
  const CMDS = [
    { l: '01 · first exploits', k: '2012', id: 'ch1', kw: 'icpc jhu ctf study bnu student oscp' },
    { l: '02 · a hundred zero-days', k: '2018', id: 'ch2', kw: 'blockchain security 0day cve defcon chaitin evm jop ctf' },
    { l: '03 · builder years', k: '2023', id: 'ch3', kw: 'cto startup opml erc standards' },
    { l: '04 · agent security', k: '2025', id: 'ch4', kw: 'papers research sudp locard acl tmlr phd imperial' },
    { l: 'safeclaw', k: 'now', id: 'safeclaw', kw: 'product credentials secrets passkey' },
    { l: 'fainter stars', k: 'archive', id: 'archive', kw: 'blog essays m1r4c13 writing notes' },
    { l: 'close panels', k: 'esc', id: '', kw: 'top home sky close back' },
  ];
  let idx = 0, items = [];
  function render(q) {
    const s = q.trim().toLowerCase();
    if (s === 'sudo') { list.innerHTML = '<li class="egg">approval required: passkey not found.</li>'; items = []; return; }
    items = CMDS.filter(function (c) { return !s || (c.l + ' ' + c.kw).toLowerCase().indexOf(s) >= 0; });
    idx = 0;
    list.innerHTML = items.map(function (c, i) {
      return '<li data-id="' + c.id + '" class="' + (i === 0 ? 'active' : '') + '"><span>' + c.l + '</span><span class="k">' + c.k + '</span></li>';
    }).join('');
  }
  function go(id) { closePal(); if (id) request(id); else dismiss(); }
  function openPal() { pal.hidden = false; input.value = ''; render(''); input.focus(); }
  function closePal() { pal.hidden = true; input.blur(); }

  fab.addEventListener('click', openPal);
  pal.addEventListener('click', function (e) { if (e.target === pal) closePal(); });
  list.addEventListener('click', function (e) { const li = e.target.closest('li[data-id]'); if (li) go(li.dataset.id); });
  input.addEventListener('input', function () { render(input.value); });
  document.addEventListener('keydown', function (e) {
    if (!pal.hidden) {
      if (e.key === 'Escape') closePal();
      else if (e.key === 'Enter' && items[idx]) go(items[idx].id);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        idx = (idx + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % Math.max(items.length, 1);
        Array.prototype.forEach.call(list.children, function (li, i) { li.classList.toggle('active', i === idx); });
      }
      return;
    }
    if (e.key === '/' && !e.target.closest('input, textarea')) { e.preventDefault(); openPal(); }
    else if (e.key === 'Escape' && openId) dismiss();
  });

  /* boot: deep link or shot target */
  if (shotM && shotM[1] && shotM[1] !== 'top') {
    addEventListener('load', function () { setTimeout(function () { openRaw(shotM[1]); }, 60); });
  } else if (location.hash) {
    sync();
  }
})();
