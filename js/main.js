/* v3: module content wiring + hash sync + legend + the shell.
   world/camera/render/input lives in starfield.js; this file reacts to it. */
(function () {
  var shotM = /[?&]shot(?:=([a-z0-9]+))?/.exec(location.search);
  if (shotM) document.documentElement.classList.add('shot');
  var reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  var MODULES = ['hacker', 'builder', 'scholar', 'archive'];
  var ALIASES = { hacker: 'hacker', builder: 'builder', scholar: 'scholar', archive: 'archive', safeclaw: 'builder' };
  var LEGACY_HASH = { ch1: 'hacker', ch2: 'hacker', ch3: 'builder', ch4: 'scholar', safeclaw: 'builder' };
  var QLINE = 'most of what moves the world never survives it. what does is half a sentence.';

  var mods = {};
  MODULES.forEach(function (id) { mods[id] = document.getElementById('mod-' + id); });
  var visibleId = null;

  /* ---- hand-rolled search index + publications, scraped from the DOM at load ---- */
  var INDEX = [];
  var PAPERS = [];
  function buildIndex() {
    MODULES.forEach(function (id) {
      var root = mods[id];
      if (!root) return;
      var lines = root.querySelectorAll('.idx-line');
      for (var i = 0; i < lines.length; i++) {
        var t = lines[i].textContent.replace(/\s+/g, ' ').trim();
        if (t) INDEX.push({ module: id, text: t });
      }
    });
    var pubEls = document.querySelectorAll('#mod-scholar .pubs li.pub');
    for (var j = 0; j < pubEls.length; j++) {
      var li = pubEls[j];
      var titleEl = li.querySelector('.pub-title');
      var url = (titleEl && titleEl.tagName === 'A') ? titleEl.getAttribute('href') : null;
      var codeEl = li.querySelector('.pub-code');
      var codeUrl = codeEl ? codeEl.getAttribute('href') : null;
      var metaEl = li.querySelector('.pub-meta');
      PAPERS.push({
        title: titleEl ? titleEl.textContent.trim() : '',
        meta: metaEl ? metaEl.textContent.replace(/\s+/g, ' ').trim() : '',
        url: url, codeUrl: codeUrl,
      });
    }
  }

  /* ---- module content show/hide ---- */
  var FADE_OUT_MS = 160;
  function showModule(id) {
    var el = mods[id]; if (!el) return;
    el.hidden = false;
    void el.offsetHeight;
    el.classList.add('show');
    el.focus({ preventScroll: true });
    visibleId = id;
  }
  function hideModule(id) {
    var el = mods[id]; if (!el) return;
    el.classList.remove('show');
    if (document.documentElement.classList.contains('shot') || reducedMotion) el.hidden = true;
    else setTimeout(function () { if (!el.classList.contains('show')) el.hidden = true; }, FADE_OUT_MS);
    if (visibleId === id) visibleId = null;
  }

  /* ---- legend ---- */
  function updateLegendCurrent(id) {
    var rows = document.querySelectorAll('.legend-row');
    for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('current', rows[i].dataset.module === id);
  }
  function wireLegend() {
    var rows = document.querySelectorAll('.legend-row');
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var id = row.dataset.module;
        row.addEventListener('click', function () { request(id); });
        row.addEventListener('mouseenter', function () { row.classList.add('lit'); if (window.Sky) Sky.highlight(id, true); });
        row.addEventListener('mouseleave', function () { row.classList.remove('lit'); if (window.Sky) Sky.highlight(id, false); });
      })(rows[i]);
    }
  }

  /* ---- hash sync (single source of truth for navigation) ---- */
  function moduleForHash(h) {
    h = (h || '').replace('#', '');
    if (!h) return null;
    if (MODULES.indexOf(h) >= 0) return h;
    return LEGACY_HASH[h] || null;
  }
  function request(id) {
    if (id) { if (location.hash.slice(1) !== id) location.hash = id; else sync(); }
    else dismiss();
  }
  function dismiss() {
    if (location.hash) history.pushState('', document.title, location.pathname + location.search);
    sync();
  }
  function sync() {
    var id = moduleForHash(location.hash);
    if (id) Sky.flyTo(id); else Sky.flyOut();
  }

  /* ---- chrome: back button, chevrons, zoomed body class ---- */
  function wireChrome() {
    document.getElementById('skyBack').addEventListener('click', dismiss);
    document.getElementById('chevL').addEventListener('click', function () { dispatchEvent(new CustomEvent('sky:swipe', { detail: -1 })); });
    document.getElementById('chevR').addEventListener('click', function () { dispatchEvent(new CustomEvent('sky:swipe', { detail: 1 })); });
  }

  /* ---- the shell ---- */
  var shellFab = document.getElementById('shellFab');
  var shellEl = document.getElementById('shell');
  var shellOutput = document.getElementById('shellOutput');
  var shellInput = document.getElementById('shellInput');
  var shellOpenedOnce = false;
  var shellHistory = [], histIdx = 0;
  var skyEcho = document.getElementById('skyEcho');
  var echoTimer1 = null, echoTimer2 = null;
  var skyCanvas = document.getElementById('sky');

  var KNOWN = ['help', '?', 'ls', 'cd', 'pwd', 'cat', 'grep', 'echo', 'skill', 'skills', 'whoami', 'uptime', 'sudo', 'reboot', 'sleep', 'shutdown', 'clear'];
  var HELP_LINES = [
    'help, ?                this list',
    'ls [skills|papers]     list modules, or skills, or papers',
    'cd <module>            fly to a module (~ or .. zooms out)',
    'pwd                    print current location',
    'cat <module|papers|?>  print module text, the papers, or the half-sentence',
    'grep <kw>               search all module text',
    'echo <text>            fade text onto the sky, closes this shell',
    'skill, skills          print the skills manifest',
    'whoami                 who is this',
    'uptime                 how long this has been running',
    'sudo <anything>        nice try',
    'reboot                 reload the page',
    'sleep <n>              dim the sky for n seconds, max 10',
    'shutdown               ...',
    'clear                  clear this output',
  ];
  var SKILL_LINES = [
    'skills/  exploit-development (10y) · protocol-auditing (~1M LoC audited)',
    '         zero-to-one shipping (3 products) · agentic-rl research (4 papers)',
  ];

  function printLine(text, cls) {
    var d = document.createElement('div');
    d.className = 'sl' + (cls ? ' sl-' + cls : '');
    d.textContent = text;
    shellOutput.appendChild(d);
    shellOutput.scrollTop = shellOutput.scrollHeight;
  }
  function printLines(arr, cls) { for (var i = 0; i < arr.length; i++) printLine(arr[i], cls); }
  function pathForId(id) { return id ? '~/sky/' + id : '~/sky'; }

  function openShell() {
    shellEl.hidden = false;
    if (!shellOpenedOnce) { printLine('xhyu shell · try: ls, cd builder, cat papers, echo hello, skill', 'banner'); shellOpenedOnce = true; }
    shellInput.value = '';
    shellInput.focus();
  }
  function closeShell() { shellEl.hidden = true; shellInput.blur(); }

  function lsCmd(arg) {
    arg = (arg || '').trim().toLowerCase();
    if (arg === 'skills') { printLines(SKILL_LINES); return; }
    if (arg === 'papers') { PAPERS.forEach(function (p) { printLine('- ' + p.title); }); return; }
    MODULES.forEach(function (id) { printLine(id + '/'); });
  }
  function cdCmd(arg) {
    var a = (arg || '').trim().toLowerCase();
    if (!a || a === '~' || a === '..' || a === 'sky') { request(null); printLine(pathForId(null)); return; }
    var id = ALIASES[a];
    if (!id) { printLine('cd: no such module: ' + a); return; }
    request(id);
    printLine(pathForId(id));
  }
  function catPapers() {
    PAPERS.forEach(function (p) {
      printLine(p.title + '  ·  ' + p.meta);
      if (p.url) printLine('  ' + p.url);
      if (p.codeUrl) printLine('  code: ' + p.codeUrl);
    });
  }
  function catCmd(arg) {
    var a = (arg || '').trim().toLowerCase();
    if (!a) { printLine('cat: missing operand'); return; }
    if (a === 'papers') { catPapers(); return; }
    if (a === '?') { printLine(QLINE); return; }
    var id = ALIASES[a];
    if (!id) { printLine('cat: no such module: ' + a); return; }
    var lines = INDEX.filter(function (e) { return e.module === id; });
    lines.forEach(function (e) { printLine(e.text); });
  }
  function grepCmd(kw) {
    kw = (kw || '').trim();
    if (!kw) { printLine('grep: missing pattern'); return; }
    var esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re;
    try { re = new RegExp(esc, 'i'); } catch (e) { re = null; }
    var found = 0;
    INDEX.forEach(function (e) {
      if (re && re.test(e.text)) { printLine('[' + e.module + '] ' + e.text + '  (cd ' + e.module + ')'); found++; }
    });
    if (!found) printLine('grep: no matches for "' + kw + '"');
  }
  function echoCmd(text) {
    closeShell();
    if (!text) return;
    skyEcho.textContent = text;
    skyEcho.style.transitionDuration = '.6s';
    void skyEcho.offsetHeight;
    skyEcho.classList.add('show');
    clearTimeout(echoTimer1); clearTimeout(echoTimer2);
    echoTimer1 = setTimeout(function () {
      skyEcho.style.transitionDuration = '1.5s';
      skyEcho.classList.remove('show');
      echoTimer2 = setTimeout(function () { skyEcho.textContent = ''; }, 1500);
    }, 2500);
  }
  function sleepCmd(arg) {
    var n = parseFloat(arg);
    if (!isFinite(n) || n <= 0) { printLine('sleep: usage: sleep <seconds>'); return; }
    n = Math.min(n, 10);
    printLine('sleeping for ' + n + 's…');
    skyCanvas.classList.add('dim');
    setTimeout(function () { skyCanvas.classList.remove('dim'); }, n * 1000);
  }
  function shutdownCmd() {
    closeShell();
    var veil = document.getElementById('shutdownVeil');
    var line = document.getElementById('shutdownLine');
    line.textContent = 'not for this sky.';
    veil.style.transitionDuration = '2s';
    line.style.transitionDuration = '1s';
    void veil.offsetHeight;
    veil.classList.add('show');
    setTimeout(function () { line.classList.add('show'); }, 1000);
    setTimeout(function () {
      veil.style.transitionDuration = '3s';
      veil.classList.remove('show');
      line.classList.remove('show');
    }, 4000);
  }

  function runCommand(raw) {
    var line = raw.trim();
    if (!line) return;
    var parts = line.split(/\s+/);
    var cmd = parts[0].toLowerCase();
    var arg = parts.slice(1).join(' ');
    if (KNOWN.indexOf(cmd) < 0) { grepCmd(line); return; }
    switch (cmd) {
      case 'help': case '?': printLines(HELP_LINES); break;
      case 'ls': lsCmd(arg); break;
      case 'cd': cdCmd(arg); break;
      case 'pwd': printLine(pathForId(Sky.current())); break;
      case 'cat': catCmd(arg); break;
      case 'grep': grepCmd(arg); break;
      case 'echo': echoCmd(arg); break;
      case 'skill': case 'skills': printLines(SKILL_LINES); break;
      case 'whoami': printLine('xhyumiracle. imperfect, therefore fascinating.'); break;
      case 'uptime': printLine('since 1993, mostly.'); break;
      case 'sudo': printLine('approval required: passkey not found.'); break;
      case 'reboot': printLine('rebooting…'); setTimeout(function () { location.reload(); }, 250); break;
      case 'sleep': sleepCmd(arg); break;
      case 'shutdown': shutdownCmd(); break;
      case 'clear': shellOutput.innerHTML = ''; break;
    }
  }

  function autocomplete() {
    var v = shellInput.value;
    var parts = v.split(/\s+/);
    if (parts.length <= 1) {
      var pfx = (parts[0] || '').toLowerCase();
      if (!pfx) return;
      var m = KNOWN.filter(function (c) { return c.indexOf(pfx) === 0; });
      if (m.length === 1) shellInput.value = m[0] + ' ';
      else if (m.length > 1) printLine(m.join('  '));
      return;
    }
    var cmd = parts[0].toLowerCase();
    if (cmd === 'cd' || cmd === 'cat') {
      var last = parts[parts.length - 1].toLowerCase();
      var names = Object.keys(ALIASES).concat(['~', '..']);
      var m2 = names.filter(function (n) { return n.indexOf(last) === 0; });
      if (m2.length === 1) { parts[parts.length - 1] = m2[0]; shellInput.value = parts.join(' ') + ' '; }
      else if (m2.length > 1) printLine(m2.join('  '));
    }
  }

  function handleShellKeydown(e) {
    if (e.key === 'Escape') { closeShell(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      var v = shellInput.value;
      if (v.trim()) shellHistory.push(v);
      histIdx = shellHistory.length;
      printLine('xhyu@sky:~$ ' + v, 'cmdline');
      runCommand(v);
      shellInput.value = '';
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (histIdx > 0) { histIdx--; shellInput.value = shellHistory[histIdx] || ''; }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx < shellHistory.length - 1) { histIdx++; shellInput.value = shellHistory[histIdx] || ''; }
      else { histIdx = shellHistory.length; shellInput.value = ''; }
      return;
    }
    if (e.key === 'Tab') { e.preventDefault(); autocomplete(); return; }
  }
  function wireShell() {
    shellFab.addEventListener('click', function () { if (shellEl.hidden) openShell(); else closeShell(); });
  }

  /* ---- global keydown: shell toggle, escape, zoomed arrow-key navigation ---- */
  function globalKeydown(e) {
    if (!shellEl.hidden) { handleShellKeydown(e); return; }
    var typing = e.target && e.target.closest && e.target.closest('input, textarea');
    if (e.key === '/' && !typing) { e.preventDefault(); openShell(); return; }
    if (e.key === 'Escape') { if (Sky.isZoomed()) dismiss(); return; }
    if (Sky.isZoomed()) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); dispatchEvent(new CustomEvent('sky:swipe', { detail: -1 })); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); dispatchEvent(new CustomEvent('sky:swipe', { detail: 1 })); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); dismiss(); }
    }
  }

  /* ---- boot ---- */
  function boot() {
    buildIndex();
    wireLegend();
    wireChrome();
    wireShell();

    addEventListener('sky:select', function (e) { request(e.detail); });
    addEventListener('sky:swipe', function (e) {
      var id = Sky.current(); if (!id) return;
      var idx = Sky.MODULES.indexOf(id), n = Sky.MODULES.length;
      request(Sky.MODULES[(idx + e.detail + n) % n]);
    });
    addEventListener('sky:zoomstart', function (e) {
      var id = e.detail.id;
      document.body.classList.toggle('zoomed', !!id);
      updateLegendCurrent(id);
      if (visibleId) hideModule(visibleId);
    });
    addEventListener('sky:settle', function (e) { if (e.detail.id) showModule(e.detail.id); });
    addEventListener('hashchange', sync);
    addEventListener('popstate', sync);
    document.addEventListener('keydown', globalKeydown);

    if (shotM && shotM[1] && shotM[1] !== 'top') {
      var target = ALIASES[shotM[1].toLowerCase()];
      if (target) setTimeout(function () { request(target); }, 40);
    } else if (location.hash) {
      setTimeout(sync, 40);
    }
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot); else boot();
})();
