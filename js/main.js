/* v9: module content (research / projects / talks / about, by type), hash sync, legend, the
 ticking uptime line, the corner-window xterm-backed shell (with the shell-open focus fix).
 sky lives in starfield.js. */
(function () {
 var shotM = /[?&]shot(?:=([a-z0-9]+))?/.exec(location.search);
 var reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
 var still = !!shotM || reducedMotion;
 if (still) document.documentElement.classList.add('still');

 var MODULES = ['research', 'projects', 'talks', 'about'];
 var ALIASES = { research: 'research', projects: 'projects', talks: 'talks', about: 'about', safeclaw: 'projects', publications: 'research', pubs: 'research' };
 /* v9 regrouped the sky by type; every id the site has ever used still lands somewhere sensible */
 var LEGACY_HASH = { ch1: 'about', ch2: 'about', ch3: 'projects', ch4: 'research', safeclaw: 'projects', scholar: 'research', researcher: 'research', builder: 'projects', hacker: 'about', archive: 'about' };
 var QLINE_CN = (document.getElementById('avatarPopoverCn') || {}).textContent || '';
 var QLINE_EN = (document.getElementById('avatarPopoverEn') || {}).textContent || '';

 var mods = {};
 MODULES.forEach(function (id) { mods[id] = document.getElementById('mod-' + id); });
 var visibleId = null;
 var shellOpen = false; /* while true, module content never takes focus (see showModule / sky:settle below) */

 /* in-memory FS mirroring the site, scraped from the DOM so content lives once */
 var FS = { type: 'dir', children: {} };
 function lineFromEl(el) {
  var out = '';
  el.childNodes.forEach(function (n) {
   if (n.nodeType === 3) out += n.textContent;
   else if (n.nodeType === 1) out += n.tagName === 'A' ? n.textContent + ' (' + n.getAttribute('href') + ')' : n.textContent;
  });
  return out.replace(/\s+/g, ' ').trim();
 }
 function scrapeLines(root) {
  var lines = [];
  root.querySelectorAll('p:not(.sub-slug), li').forEach(function (n) { var t = lineFromEl(n); if (t) lines.push(t); });
  return lines;
 }
 var SKILL_LINES = [
  'exploit-development (10y) · protocol-auditing (~1M LoC audited)',
  'zero-to-one shipping (3 products) · agentic-rl research (4 papers)',
 ];
 /* uptime: the footer status line ticks once a second in the shape of the unix command. the
  epoch is 1994-04-01T00:00Z, chosen by the owner (not a real birthday); only the days figure
  is meaningful and only to someone who does the arithmetic. */
 var UPTIME_EPOCH = Date.UTC(1994, 3, 1, 0, 0, 0);
 var LOAD_LINE = 'agent security, forensics, rl';
 function two(n) { return (n < 10 ? '0' : '') + n; }
 function uptimeText(full) {
  var s = Math.max(0, Math.floor((Date.now() - UPTIME_EPOCH) / 1000));
  var days = Math.floor(s / 86400); s -= days * 86400;
  var h = Math.floor(s / 3600); s -= h * 3600;
  var m = Math.floor(s / 60); s -= m * 60;
  if (full) {
   var now = new Date();
   return ' ' + two(now.getHours()) + ':' + two(now.getMinutes()) + ':' + two(now.getSeconds()) + ' up ' + days + ' days, ' + h + ':' + two(m) + ', 1 user, load average: ' + LOAD_LINE;
  }
  return 'up ' + days + ' days, ' + two(h) + ':' + two(m) + ':' + two(s) + ' \u00b7 load: ' + LOAD_LINE + ' \u00b7 1 user';
 }
 function startUptime() {
  var el = document.getElementById('uptimeLine');
  if (!el) return;
  function tick() { el.textContent = uptimeText(false); }
  tick();
  if (!still) setInterval(tick, 1000);
 }
 function buildFS() {
  MODULES.forEach(function (id) { FS.children[id] = { type: 'dir', children: {} }; });
  document.querySelectorAll('.subsec[data-slug]').forEach(function (sec) {
   var mod = sec.closest('.mod');
   if (!mod) return;
   FS.children[mod.dataset.module].children[sec.dataset.slug] = { type: 'file', content: scrapeLines(sec).join('\n') };
  });
  FS.children.README = { type: 'file', content: scrapeLines(document.querySelector('.id-block')).join('\n') };
  FS.children['cv.pdf'] = { type: 'file', content: 'binary. open it: /cv.pdf' };
  FS.children.notes = { type: 'file', content: 'M1r4c13: 51 study notes from 2017 and 2018, restored (/blog/)' };
  FS.children.skills = { type: 'file', content: SKILL_LINES.join('\n') };
 }
 function nodeAt(segs) {
  var n = FS;
  for (var i = 0; i < segs.length; i++) { if (!n.children || !n.children[segs[i]]) return null; n = n.children[segs[i]]; }
  return n;
 }
 function pathStr(segs) { return segs.length ? '~/' + segs.join('/') : '~'; }
 function resolvePath(raw, cwdArr) {
  raw = (raw || '').trim();
  if (raw === '~' || raw === '/') return { segs: [], node: FS };
  var abs = /^~\//.test(raw) || /^\//.test(raw);
  var segs = abs ? [] : cwdArr.slice();
  if (raw) {
   raw.replace(/^~\/?/, '').replace(/^\//, '').split('/').filter(Boolean).forEach(function (p) {
    if (p === '.') return;
    if (p === '..') segs.pop(); else segs.push(p);
   });
  }
  return { segs: segs, node: nodeAt(segs) };
 }

 /* module content show/hide */
 var FADE_OUT_MS = 160;
 function showModule(id) {
  var el = mods[id]; if (!el) return;
  el.hidden = false;
  void el.offsetHeight;
  el.classList.add('show');
  /* focus fix: while the shell window is open, module content NEVER takes focus (a shell-
   initiated `cd` must not have its fly-in settle steal focus mid-sentence, ~400ms later, out
   from under continuous typing). the shell input gets re-asserted instead, in the sky:settle
   handler below. mouse-initiated nav keeps today's behavior when the shell is closed. */
  if (!shellOpen) el.focus({ preventScroll: true });
  visibleId = id;
 }
 function hideModule(id) {
  var el = mods[id]; if (!el) return;
  el.classList.remove('show');
  if (still) el.hidden = true;
  else setTimeout(function () { if (!el.classList.contains('show')) el.hidden = true; }, FADE_OUT_MS);
  if (visibleId === id) visibleId = null;
 }
 function scrollSubsecIntoView(modId, slug) {
  if (!slug) return;
  var el = document.getElementById('sub-' + modId + '-' + slug);
  if (el && el.scrollIntoView) el.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
 }

 /* legend */
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

 /* hash sync (single source of truth for navigation) */
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
  if (!window.Sky) { setTimeout(sync, 60); return; } /* the no-WebGL fallback sky loads async; wait for it rather than throw */
  var id = moduleForHash(location.hash);
  if (id) Sky.flyTo(id); else Sky.flyOut();
 }

 /* chrome: back button, chevrons */
 function wireChrome() {
  document.getElementById('skyBack').addEventListener('click', dismiss);
  document.getElementById('chevL').addEventListener('click', function () { dispatchEvent(new CustomEvent('sky:swipe', { detail: -1 })); });
  document.getElementById('chevR').addEventListener('click', function () { dispatchEvent(new CustomEvent('sky:swipe', { detail: 1 })); });
 }

 /* avatar popover: click the ? to toggle a small card holding the two slogan lines (CN + EN).
  dismiss on: clicking ? again (handled by the toggle itself), clicking outside (document-level
  listener below), or ESC (see globalKeydown). */
 var avatarQ = document.getElementById('avatarQ');
 var avatarPopover = document.getElementById('avatarPopover');
 var popoverOpen = false;
 function openPopover() {
  popoverOpen = true;
  avatarPopover.hidden = false;
  void avatarPopover.offsetHeight;
  avatarPopover.classList.add('show');
  avatarQ.setAttribute('aria-expanded', 'true');
 }
 function closePopover() {
  popoverOpen = false;
  avatarPopover.classList.remove('show');
  if (still) avatarPopover.hidden = true;
  else setTimeout(function () { if (!avatarPopover.classList.contains('show')) avatarPopover.hidden = true; }, FADE_OUT_MS);
  avatarQ.setAttribute('aria-expanded', 'false');
 }
 function togglePopover() { if (popoverOpen) closePopover(); else openPopover(); }
 function wirePopover() {
  avatarQ.addEventListener('click', function () { togglePopover(); });
  document.addEventListener('click', function (e) {
   if (!popoverOpen) return;
   if (e.target === avatarQ || avatarPopover.contains(e.target)) return;
   closePopover();
  });
 }

 /* shell: a quiet bottom-right chip that opens a compact corner terminal window. xterm.js,
  self-hosted, lazy-loaded on first open; falls back to a hand-rolled plain-DOM pane if it
  fails to load. no first-visit promo of any kind: the chip just sits there quietly. */
 var shellChip = document.getElementById('shellChip');
 var shellWin = document.getElementById('shellWin');
 var shellClose = document.getElementById('shellClose');
 var shellRow = document.getElementById('shellRow');
 var shellPane = document.getElementById('shellPane');
 var shellInput = document.getElementById('shellInput');
 var shellTyped = document.getElementById('shellTyped');
 var skyCanvas = document.getElementById('sky');

 var cwd = [];
 var shellHistory = [], histIdx = 0;
 var xtermState = 'none'; /* -> loading -> ready|failed */
 var term = null, pending = [];

 /* open/close the whole window (not a pane-height animation anymore: the window is a fixed
  small box, so there's nothing to expand). shellOpen (declared above, near module state)
  gates the focus fix: while it's true, showModule() never calls .focus(). */
 function openShell() {
  shellOpen = true;
  shellChip.classList.add('is-hidden');
  shellWin.hidden = false;
  void shellWin.offsetHeight;
  shellWin.classList.add('show');
  shellChip.setAttribute('aria-expanded', 'true');
  loadXterm();
  shellInput.focus();
 }
 function closeShell() {
  shellOpen = false;
  shellWin.classList.remove('show');
  if (still) shellWin.hidden = true;
  else setTimeout(function () { if (!shellWin.classList.contains('show')) shellWin.hidden = true; }, FADE_OUT_MS);
  shellChip.classList.remove('is-hidden');
  shellChip.setAttribute('aria-expanded', 'false');
  shellInput.blur();
 }

 function ansiWrap(text, cls) {
  if (cls === 'cmdline') return '\x1b[38;2;233;228;214m' + text + '\x1b[0m';
  return text;
 }
 function appendPlain(text, cls) {
  var d = document.createElement('div');
  d.className = 'sl' + (cls ? ' sl-' + cls : '');
  d.textContent = text;
  shellPane.appendChild(d);
 }
 /* auto-scroll: every command's output should end with the last line (and the prompt) visible,
  in both the xterm path and the plain-DOM fallback, even when the output arrives asynchronously
  (queued in `pending` while xterm is still lazy-loading and flushed once it's ready). the one
  exception is a user who has manually scrolled up mid-output to re-read something: shellUserScrolled
  latches true when a scroll event leaves either pane off the bottom, and only a *new* command
  (the Enter handler, which is the one place that resets it) is allowed to clear it and force the
  view back down. */
 var shellUserScrolled = false;
 function scrollShellToBottom() {
  if (xtermState === 'ready' && term) term.scrollToBottom(); /* xterm's own internal scrollback viewport */
  shellPane.scrollTop = shellPane.scrollHeight; /* the outer pane can also scroll (xterm's rendered rows can exceed the pane's own box); harmless no-op when it fits */
 }
 function printLine(text, cls) {
  if (xtermState === 'ready') { term.writeln(ansiWrap(text, cls)); if (!shellUserScrolled) scrollShellToBottom(); return; }
  if (xtermState === 'loading') { pending.push([text, cls]); return; }
  appendPlain(text, cls);
  if (!shellUserScrolled) scrollShellToBottom();
 }
 function printLines(arr, cls) { arr.forEach(function (l) { printLine(l, cls); }); }

 function flushPending() {
  var q = pending; pending = [];
  q.forEach(function (p) { printLine(p[0], p[1]); });
 }
 function xtermFallback() { xtermState = 'failed'; flushPending(); }
 function loadXterm() {
  if (xtermState !== 'none') return;
  xtermState = 'loading';
  var link = document.createElement('link'); link.rel = 'stylesheet'; link.href = 'vendor/xterm.min.css';
  document.head.appendChild(link);
  var s = document.createElement('script');
  s.onload = function () {
   try {
    var mount = document.createElement('div'); mount.id = 'xtermMount';
    shellPane.appendChild(mount);
    var chW = Math.max(30, Math.floor((shellPane.clientWidth - 24) / 7.8));
    var rowsN = Math.max(10, Math.floor((innerHeight * 0.44) / 19));
    term = new window.Terminal({
     rows: rowsN, cols: chW, fontSize: 13, fontFamily: 'PlexMono, monospace',
     cursorBlink: false, disableStdin: true, convertEol: true, scrollback: 400, /* output-only pane; the real, focus-gated cursor is the prompt row's own glyph */
     theme: { background: 'rgba(0,0,0,0)', foreground: '#e9e4d6', cursor: '#d8c08a', selectionBackground: 'rgba(216,192,138,.25)' },
    });
    term.open(mount);
    term.onScroll(function () {
     var buf = term.buffer.active;
     shellUserScrolled = buf.viewportY < buf.baseY;
    });
    xtermState = 'ready';
    flushPending();
   } catch (err) { xtermFallback(); }
  };
  s.onerror = xtermFallback;
  s.src = 'vendor/xterm.min.js';
  document.head.appendChild(s);
 }

 var HELP_LINES = [
  'help, ?  this list',
  'ls [path]  list a directory, following cwd',
  'cd [path]  fly to a module (~ zooms out; a file flies + scrolls)',
  'pwd  print current location',
  'cat <path>  print a file (also: cat ?)',
  'grep <kw> [path]  search file contents, file:line',
  'echo <text>  fade text onto the sky',
  'skill, skills  print the skills manifest',
  'whoami  who is this',
  'uptime  how long this has been running',
  'history  command history',
  'date  today',
  'sudo <anything>  nice try',
  'reboot  reload the page',
  'sleep <n>  dim the sky for n seconds, max 10',
  'shutdown  ...',
  'clear  clear this output',
  'exit  close this window',
 ];
 var KNOWN = ['help', '?', 'ls', 'cd', 'pwd', 'cat', 'grep', 'echo', 'skill', 'skills', 'whoami', 'uptime', 'sudo', 'reboot', 'sleep', 'shutdown', 'clear', 'exit', 'history', 'date'];

 function lsCmd(arg) {
  var r = resolvePath(arg, cwd);
  if (!r.node) { printLine("ls: cannot access '" + (arg || '.') + "': No such file or directory"); return; }
  if (r.node.type === 'file') { printLine(r.segs[r.segs.length - 1]); return; }
  Object.keys(r.node.children).sort().forEach(function (n) { printLine(n + (r.node.children[n].type === 'dir' ? '/' : '')); });
 }
 function cdCmd(arg) {
  var a = (arg || '').trim();
  if (!a || a === '~') { cwd = []; request(null); printLine(pathStr(cwd)); return; }
  var r = resolvePath(a, cwd);
  if (!r.node) { printLine('cd: ' + a + ': No such file or directory'); return; }
  if (r.node.type === 'dir') {
   cwd = r.segs;
   request(cwd.length ? cwd[0] : null);
   printLine(pathStr(cwd));
  } else if (r.segs.length > 1 && MODULES.indexOf(r.segs[0]) >= 0) {
   /* cd into a subsection file (e.g. `cd hacker/protocol-auditing`): UX sugar — fly to its
    module and scroll to the subsection, per the help text ("a file flies + scrolls"). only
    applies to files nested inside a real module dir; top-level singleton files (README,
    skills) fall through to the Not-a-directory branch below like real cd on a plain file. */
   cwd = [r.segs[0]];
   request(cwd[0]);
   var slug = r.segs[1];
   setTimeout(function () { scrollSubsecIntoView(cwd[0], slug); }, still ? 0 : 720);
   printLine(pathStr(r.segs));
  } else {
   printLine('cd: ' + a + ': Not a directory');
  }
 }
 function catCmd(arg) {
  var a = (arg || '').trim();
  if (!a) { printLine('cat: missing operand'); return; }
  if (a === '?') { printLines([QLINE_CN, QLINE_EN]); return; }
  var r = resolvePath(a, cwd);
  if (!r.node) { printLine('cat: ' + a + ': No such file or directory'); return; }
  if (r.node.type === 'dir') { printLine('cat: ' + a + ': Is a directory'); return; }
  r.node.content.split('\n').forEach(function (line) { printLine(line); });
 }
 function grepCmd(argStr) {
  var parts = (argStr || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) { printLine('grep: missing pattern'); return; }
  var kw = parts[0], root = FS, prefix = [];
  if (parts[1]) {
   var r = resolvePath(parts[1], cwd);
   if (!r.node) { printLine('grep: ' + parts[1] + ': No such file or directory'); return; }
   root = r.node; prefix = r.segs;
  }
  var esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var re; try { re = new RegExp(esc, 'i'); } catch (e) { re = null; }
  var found = 0;
  (function walk(node, segs) {
   if (node.type === 'file') {
    node.content.split('\n').forEach(function (line, i) {
     if (re && re.test(line)) { printLine(pathStr(segs) + ':' + (i + 1) + ': ' + line); found++; }
    });
   } else {
    Object.keys(node.children).sort().forEach(function (k) { walk(node.children[k], segs.concat(k)); });
   }
  })(root, prefix);
  if (!found) printLine('grep: no matches for "' + kw + '"');
 }
 function sanitizeEcho(s) {
  var out = '';
  for (var i = 0; i < (s || '').length; i++) {
   var c = s[i], code = s.charCodeAt(i);
   if (code < 32 || code === 127) continue;
   if ('<>&"\'`\\'.indexOf(c) >= 0) continue;
   out += c;
  }
  return out.slice(0, 80);
 }
 function echoCmd(text) {
  var clean = sanitizeEcho(text);
  if (clean) { Sky.echo(clean); printLine('(echoing to the sky)'); }
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
 function clearCmd() { if (term) term.clear(); else shellPane.innerHTML = ''; }

 function runCommand(raw) {
  var line = raw.trim();
  if (!line) return;
  var sp = line.indexOf(' ');
  var cmd = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
  var arg = sp < 0 ? '' : line.slice(sp + 1);
  if (KNOWN.indexOf(cmd) < 0) { printLine('sh: ' + cmd + ': command not found'); return; }
  switch (cmd) {
   case 'help': case '?': printLines(HELP_LINES); break;
   case 'ls': lsCmd(arg); break;
   case 'cd': cdCmd(arg); break;
   case 'pwd': printLine(pathStr(cwd)); break;
   case 'cat': catCmd(arg); break;
   case 'grep': grepCmd(arg); break;
   case 'echo': echoCmd(arg); break;
   case 'skill': case 'skills': printLines(SKILL_LINES); break;
   case 'whoami': printLine('xhyumiracle. imperfect, therefore fascinating.'); break;
   case 'uptime': printLine(uptimeText(true)); break;
   case 'history': shellHistory.forEach(function (h, i) { printLine('  ' + (i + 1) + '  ' + h); }); break;
   case 'date': printLine(new Date().toString()); break;
   case 'sudo': printLine('approval required: passkey not found.'); break;
   case 'reboot': printLine('rebooting…'); setTimeout(function () { location.reload(); }, 250); break;
   case 'sleep': sleepCmd(arg); break;
   case 'shutdown': shutdownCmd(); break;
   case 'clear': clearCmd(); break;
   case 'exit': closeShell(); break;
  }
 }

 function pathCandidates(partial) {
  var idx = partial.lastIndexOf('/');
  var base = idx >= 0 ? partial.slice(0, idx) : '';
  var frag = idx >= 0 ? partial.slice(idx + 1) : partial;
  var r = resolvePath(base, cwd);
  if (!r.node || r.node.type !== 'dir') return [];
  return Object.keys(r.node.children).filter(function (k) { return k.indexOf(frag) === 0; })
   .map(function (k) { return (base ? base + '/' : '') + k + (r.node.children[k].type === 'dir' ? '/' : ''); });
 }
 function autocomplete() {
  var v = shellInput.value;
  var sp = v.indexOf(' ');
  if (sp < 0) {
   var pfx = v.toLowerCase();
   if (!pfx) return;
   var m = KNOWN.filter(function (c) { return c.indexOf(pfx) === 0; });
   if (m.length === 1) shellInput.value = m[0] + ' ';
   else if (m.length > 1) printLine(m.join('  '));
   return;
  }
  var cmd = v.slice(0, sp).toLowerCase();
  if (['cd', 'cat', 'grep', 'ls'].indexOf(cmd) < 0) return;
  var rest = v.slice(sp + 1);
  var lastSp = rest.lastIndexOf(' ');
  var pathPart = lastSp >= 0 ? rest.slice(lastSp + 1) : rest;
  var head = lastSp >= 0 ? rest.slice(0, lastSp + 1) : '';
  var cands = pathCandidates(pathPart);
  if (cands.length === 1) shellInput.value = cmd + ' ' + head + cands[0] + (cands[0].slice(-1) === '/' ? '' : ' ');
  else if (cands.length > 1) printLine(cands.join('  '));
 }

 function mirrorInput() { shellTyped.textContent = shellInput.value; }

 function wireShell() {
  shellChip.addEventListener('click', function () { openShell(); });
  shellClose.addEventListener('click', function () { closeShell(); });
  /* cursor blinks ONLY while the input is focused; the chip's own `>_` glyph is always static */
  shellInput.addEventListener('focus', function () { shellRow.classList.add('focused'); });
  shellInput.addEventListener('blur', function () { shellRow.classList.remove('focused'); });
  shellInput.addEventListener('input', mirrorInput);
  shellPane.addEventListener('click', function () { shellInput.focus(); });
  /* plain-DOM fallback path's own scroll container (the xterm path is wired separately, inside
   loadXterm(), via term.onScroll): latch shellUserScrolled whenever the pane isn't at the
   bottom. our own programmatic scrollShellToBottom() calls always land exactly at the bottom,
   so they never falsely set this. */
  shellPane.addEventListener('scroll', function () {
   shellUserScrolled = shellPane.scrollTop + shellPane.clientHeight < shellPane.scrollHeight - 4;
  });
  shellInput.addEventListener('keydown', function (e) {
   if (e.key === 'Escape') { closeShell(); return; }
   if (e.key === 'Enter') {
    e.preventDefault();
    var v = shellInput.value;
    if (v.trim()) shellHistory.push(v);
    histIdx = shellHistory.length;
    shellUserScrolled = false; /* a new command always follows its own output down */
    printLine('xhyu@sky:~$ ' + v, 'cmdline');
    runCommand(v);
    shellInput.value = ''; mirrorInput();
    shellInput.focus(); /* v3 bug: focus was lost after Enter. always refocus. (the fly-in focus
     steal, ~400ms later, is handled separately; see showModule() and sky:settle below.) */
    return;
   }
   if (e.key === 'ArrowUp') { e.preventDefault(); if (histIdx > 0) { histIdx--; shellInput.value = shellHistory[histIdx] || ''; mirrorInput(); } return; }
   if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (histIdx < shellHistory.length - 1) { histIdx++; shellInput.value = shellHistory[histIdx] || ''; }
    else { histIdx = shellHistory.length; shellInput.value = ''; }
    mirrorInput(); return;
   }
   if (e.key === 'Tab') { e.preventDefault(); autocomplete(); mirrorInput(); return; }
  });
 }

 /* global keydown: '/' opens the shell, escape closes the popover, then the shell, then zooms
  out (in that priority order) if none of those is open, arrows cycle modules while zoomed */
 function globalKeydown(e) {
  var typing = e.target && e.target.closest && e.target.closest('input, textarea');
  if (typing) return; /* the shell input owns its own keydown handler */
  if (e.key === '/') { e.preventDefault(); openShell(); return; }
  if (e.key === 'Escape') {
   if (popoverOpen) { closePopover(); return; }
   if (shellOpen) { closeShell(); return; }
   if (Sky.isZoomed()) dismiss();
   return;
  }
  if (Sky.isZoomed()) {
   if (e.key === 'ArrowLeft') { e.preventDefault(); dispatchEvent(new CustomEvent('sky:swipe', { detail: -1 })); }
   else if (e.key === 'ArrowRight') { e.preventDefault(); dispatchEvent(new CustomEvent('sky:swipe', { detail: 1 })); }
   else if (e.key === 'ArrowUp') { e.preventDefault(); dismiss(); }
  }
 }

 /* boot */
 function boot() {
  buildFS();
  startUptime();
  wireLegend();
  wireChrome();
  wirePopover();
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
  /* focus fix: showModule() itself already skips focusing while the shell is open (see its
   definition above); here we additionally re-assert focus onto the shell input once the fly
   settles, so a shell-initiated `cd` can never lose the user's place mid-sentence. */
  addEventListener('sky:settle', function (e) {
   if (e.detail.id) showModule(e.detail.id);
   if (shellOpen) shellInput.focus();
  });
  addEventListener('hashchange', sync);
  addEventListener('popstate', sync);
  document.addEventListener('keydown', globalKeydown);

  if (shotM && shotM[1] === 'shell') {
   openShell();
   var tries = 0;
   var iv = setInterval(function () {
    tries++;
    if (xtermState === 'ready' || xtermState === 'failed' || tries > 40) {
     clearInterval(iv);
     printLine('xhyu@sky:~$ ls', 'cmdline');
     lsCmd('');
    }
   }, 50);
  } else if (shotM && shotM[1] && shotM[1] !== 'top') {
   var target = ALIASES[shotM[1].toLowerCase()];
   if (target) setTimeout(function () { request(target); }, 40);
  } else if (location.hash) {
   setTimeout(sync, 40);
  }
 }
 if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot); else boot();
})();
