/* ═══════════════════════════════════════════════════════════════
   MAIster · Portfolio home · interactions
   Theme/lang/palette setters reused; this file owns:
   - density toggle
   - state toggle (populated / empty)
   - extra-project count
   - ticker rotation
   - tiny launch-button keyboard shortcut (⌘L / Ctrl+L)
   ═══════════════════════════════════════════════════════════════ */

(function(){
  const root = document.documentElement;

  // ── theme ────────────────────────────────────────────────
  const tbtn = document.getElementById('theme-toggle');
  const tlbl = document.getElementById('theme-label');
  const ticon = document.getElementById('theme-icon');
  function paintTheme(t){
    root.setAttribute('data-theme', t);
    tbtn.setAttribute('aria-pressed', t === 'dark');
    tlbl.textContent = t === 'dark' ? 'Dark' : 'Light';
    ticon.innerHTML = t === 'dark'
      ? '<path d="M13 8.5A5.5 5.5 0 1 1 7.5 3a4.5 4.5 0 0 0 5.5 5.5z"/>'
      : '<path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 2v1.5M8 12.5V14M14 8h-1.5M3.5 8H2M12.24 3.76l-1.06 1.06M4.82 11.18l-1.06 1.06M12.24 12.24l-1.06-1.06M4.82 4.82L3.76 3.76"/>';
    try{ localStorage.setItem('maister-theme', t); }catch(e){}
  }
  let initialTheme = 'light';
  try{
    const saved = localStorage.getItem('maister-theme');
    if(saved) initialTheme = saved;
    else if(window.matchMedia('(prefers-color-scheme: dark)').matches) initialTheme = 'dark';
  }catch(e){}
  paintTheme(initialTheme);
  tbtn.addEventListener('click', () => paintTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  window.MaisterSetTheme = paintTheme;

  // ── palette ─────────────────────────────────────────────
  function setPalette(p){
    root.setAttribute('data-palette', p);
    try{ localStorage.setItem('maister-palette', p); }catch(e){}
  }
  try{ const sp = localStorage.getItem('maister-palette'); if(sp) setPalette(sp); }catch(e){}
  window.MaisterSetPalette = setPalette;

  // ── lang (placeholder; no string swaps on this page) ────
  const langBtn = document.getElementById('lang-toggle');
  const langLbl = document.getElementById('lang-label');
  const langOth = document.getElementById('lang-other');
  function setLang(l){
    if(langLbl) langLbl.textContent = l.toUpperCase();
    if(langOth) langOth.textContent = '· ' + (l === 'en' ? 'RU' : 'EN');
    root.setAttribute('lang', l);
    try{ localStorage.setItem('maister-lang', l); }catch(e){}
  }
  try{ const sl = localStorage.getItem('maister-lang'); if(sl) setLang(sl); }catch(e){}
  if(langBtn) langBtn.addEventListener('click', () => setLang((root.getAttribute('lang') || 'en') === 'en' ? 'ru' : 'en'));
  window.MaisterSetLang = setLang;

  // ── density toggle ──────────────────────────────────────
  const shell = document.querySelector('.shell');
  const densitySeg = document.querySelector('.seg[data-tool="density"]');
  function setDensity(d){
    shell.setAttribute('data-density', d);
    densitySeg.querySelectorAll('button').forEach(b => {
      b.setAttribute('aria-pressed', b.getAttribute('data-density') === d);
    });
    try{ localStorage.setItem('maister-density', d); }catch(e){}
  }
  densitySeg.addEventListener('click', e => {
    const btn = e.target.closest('button[data-density]');
    if(btn) setDensity(btn.getAttribute('data-density'));
  });
  try{ const sd = localStorage.getItem('maister-density'); if(sd) setDensity(sd); }catch(e){}
  window.MaisterSetDensity = setDensity;

  // ── state toggle (populated / empty) ────────────────────
  const canvas = document.querySelector('.canvas');
  function setState(s){
    canvas.setAttribute('data-state', s);
    const rail = document.querySelector('.rail');
    if(s === 'empty'){
      rail.classList.add('is-empty');
      // hide ws list in rail
      document.querySelectorAll('.rail .ws-li').forEach(li => li.style.display = 'none');
      document.getElementById('rail-ws-count').textContent = '0';
    } else {
      rail.classList.remove('is-empty');
      document.querySelectorAll('.rail .ws-li').forEach(li => li.style.display = '');
      const visible = document.querySelectorAll('.rail .ws-li').length;
      document.getElementById('rail-ws-count').textContent = String(visible);
    }
  }
  window.MaisterSetState = setState;

  // ── project count slider ────────────────────────────────
  function setProjectCount(n){
    // n = 3 → just maister/confup/umnitsa
    // n = 4..6 → reveal extras one at a time
    const extras = document.querySelectorAll('.pr-extra');
    extras.forEach((el, i) => {
      if(i < (n - 3)){ el.hidden = false; el.removeAttribute('hidden'); }
      else { el.hidden = true; el.setAttribute('hidden', ''); }
    });
  }
  window.MaisterSetProjectCount = setProjectCount;

  // ── tile content toggles ────────────────────────────────
  function setTileFeature(feature, on){
    document.body.classList.toggle('hide-' + feature, !on);
  }
  window.MaisterSetTileFeature = setTileFeature;
  // CSS hooks (inject)
  const tileStyle = document.createElement('style');
  tileStyle.textContent = `
    body.hide-team .pr-team { display: none; }
    body.hide-needs .pr-needs { display: none; }
    body.hide-foot .pr-foot { display: none; }
    body.hide-desc .pr-head .desc { display: none; }
    body.hide-ticker .live-ticker { display: none; }
  `;
  document.head.appendChild(tileStyle);

  // ── launch button → ⌘L / Ctrl+L ─────────────────────────
  const launchBtn = document.getElementById('launch-btn');
  function pingLaunch(){
    if(!launchBtn) return;
    launchBtn.animate(
      [{ transform: 'translateY(0)' }, { transform: 'translateY(-3px) scale(1.02)' }, { transform: 'translateY(0)' }],
      { duration: 400, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
    );
  }
  if(launchBtn) launchBtn.addEventListener('click', () => {
    pingLaunch();
    console.log('[maister] Launch run …');
  });
  document.addEventListener('keydown', e => {
    if((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l'){
      e.preventDefault();
      launchBtn && launchBtn.click();
    }
  });

  // ── rail ws click → console (placeholder) ───────────────
  document.querySelectorAll('.rail .ws-li').forEach(li => {
    li.addEventListener('click', () => {
      document.querySelectorAll('.rail .ws-li').forEach(x => x.classList.remove('is-current'));
      li.classList.add('is-current');
    });
  });

  // ── live ticker rotation ────────────────────────────────
  const TICKER_LINES = [
    '<b>claude</b> committed <code>e3b1a · feat(auth): split-spine layout</code> in <b>maister · ws/auth-flow</b>',
    '<b>codex</b> opened diff in <b>umnitsa · ws/bot-orchestrator</b> · awaiting schema decision',
    '<b>claude</b> finished <code>transcribe_chunk</code> in <b>umnitsa · ws/voice-pipeline</b> · 32 tests pass',
    '<b>dev</b> merged <code>r-7c2a</code> to <code>main</code> in <b>maister · landing-v3</b> · --no-ff',
    '<b>claude</b> pushed <code>2 commits</code> to <b>confup · ws/speaker-portal</b> · 18 LOC, 4 files',
    '<b>codex</b> resumed checkpoint in <b>umnitsa · ws/billing</b> · 1.2k tok continuation'
  ];
  let tickI = 0;
  const tickerEl = document.getElementById('ticker-text');
  function rotateTicker(){
    if(!tickerEl) return;
    tickI = (tickI + 1) % TICKER_LINES.length;
    tickerEl.style.opacity = '0';
    tickerEl.style.transition = 'opacity 0.3s ease';
    setTimeout(() => {
      tickerEl.innerHTML = TICKER_LINES[tickI];
      tickerEl.style.opacity = '1';
    }, 280);
  }
  setInterval(rotateTicker, 5200);

  // ── needs-strip count auto ──────────────────────────────
  function updateNeedsCount(){
    const items = document.querySelectorAll('.canvas[data-state="populated"] .needs-strip .ns-item');
    const head = document.querySelector('.needs-strip .ns-head .lhs');
    if(head && items.length){
      head.firstChild ? null : null;
      head.childNodes[head.childNodes.length-1].nodeValue = items.length + ' things need your review';
    }
  }
  updateNeedsCount();

})();
