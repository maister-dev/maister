/* ═══════════════════════════════════════════════════════════════
   MAIster · Project · Task board · interactions
   Owns: theme/lang toggle · tab→panel switching · layout modes ·
   filter chips · clickable cards/HITL/settings · "as of" clock ·
   toast feedback · ⌘L / ⌘N shortcuts
   ═══════════════════════════════════════════════════════════════ */
(function () {
  const root = document.documentElement;
  const $  = (s, c) => (c || document).querySelector(s);
  const $$ = (s, c) => Array.from((c || document).querySelectorAll(s));

  /* ── toast ──────────────────────────────────────────────── */
  const toast = $('#toast'), toastMsg = $('#toast-msg');
  let toastT;
  function ping(msg) {
    if (!toast) return;
    toastMsg.innerHTML = msg;
    toast.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  /* ── theme ──────────────────────────────────────────────── */
  const tbtn = $('#theme-toggle'), tlbl = $('#theme-label'), ticon = $('#theme-icon');
  function paintTheme(t) {
    root.setAttribute('data-theme', t);
    tbtn.setAttribute('aria-pressed', t === 'dark');
    if (tlbl) tlbl.textContent = t === 'dark' ? 'Dark' : 'Light';
    if (ticon) ticon.innerHTML = t === 'dark'
      ? '<path d="M13 8.5A5.5 5.5 0 1 1 7.5 3a4.5 4.5 0 0 0 5.5 5.5z"/>'
      : '<path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 2v1.5M8 12.5V14M14 8h-1.5M3.5 8H2M12.24 3.76l-1.06 1.06M4.82 11.18l-1.06 1.06M12.24 12.24l-1.06-1.06M4.82 4.82L3.76 3.76"/>';
    try { localStorage.setItem('maister-theme', t); } catch (e) {}
  }
  let initialTheme = 'light';
  try {
    const saved = localStorage.getItem('maister-theme');
    if (saved) initialTheme = saved;
    else if (window.matchMedia('(prefers-color-scheme: dark)').matches) initialTheme = 'dark';
  } catch (e) {}
  paintTheme(initialTheme);
  tbtn.addEventListener('click', () =>
    paintTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

  /* ── lang ───────────────────────────────────────────────── */
  const langBtn = $('#lang-toggle'), langLbl = $('#lang-label'), langOth = $('#lang-other');
  function setLang(l) {
    if (langLbl) langLbl.textContent = l.toUpperCase();
    if (langOth) langOth.textContent = '· ' + (l === 'en' ? 'RU' : 'EN');
    root.setAttribute('lang', l);
    try { localStorage.setItem('maister-lang', l); } catch (e) {}
  }
  try { const sl = localStorage.getItem('maister-lang'); if (sl) setLang(sl); } catch (e) {}
  if (langBtn) langBtn.addEventListener('click', () =>
    setLang((root.getAttribute('lang') || 'en') === 'en' ? 'ru' : 'en'));

  /* ── tabs → panels ──────────────────────────────────────── */
  const tabs   = $$('.proj-tabs a[data-tab]');
  const panels = $$('.tab-panel');
  function showTab(name) {
    const has = panels.some(p => p.getAttribute('data-tab') === name);
    if (!has) return;
    tabs.forEach(t => {
      const on = t.getAttribute('data-tab') === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    panels.forEach(p => p.classList.toggle('is-active', p.getAttribute('data-tab') === name));
    try { localStorage.setItem('maister-board-tab', name); } catch (e) {}
  }
  tabs.forEach(t => t.addEventListener('click', () => showTab(t.getAttribute('data-tab'))));
  // restore last tab
  try {
    const lt = localStorage.getItem('maister-board-tab');
    if (lt) showTab(lt);
  } catch (e) {}

  /* anything with data-jump jumps to a tab (inbox→board, mcps→mcps, etc.) */
  const JUMP = { inbox: 'board', board: 'board', activity: 'activity',
                 prs: 'prs', flows: 'flows', mcps: 'mcps', settings: 'settings' };
  $$('[data-jump]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const dest = JUMP[el.getAttribute('data-jump')] || 'board';
      showTab(dest);
      if (el.getAttribute('data-jump') === 'inbox') {
        const hitl = $('.hitl');
        if (hitl) hitl.animate(
          [{ boxShadow: '0 0 0 0 var(--amber)' }, { boxShadow: '0 0 0 4px var(--amber-soft)' }, { boxShadow: '0 0 0 0 var(--amber)' }],
          { duration: 900, easing: 'ease-out' });
      }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
    });
  });

  /* rail-nav jumps too */
  $$('.rail-nav a[data-jump]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      $$('.rail-nav a').forEach(x => x.classList.remove('is-active'));
      a.classList.add('is-active');
    });
  });

  /* ── layout modes (board / swimlanes / list) ────────────── */
  const board = $('.board');
  const layoutGroup = $('#layout-group');
  function setLayout(mode) {
    if (!board) return;
    board.setAttribute('data-layout', mode);
    $$('button', layoutGroup).forEach(b =>
      b.setAttribute('aria-pressed', b.getAttribute('data-layout') === mode ? 'true' : 'false'));
    try { localStorage.setItem('maister-board-layout', mode); } catch (e) {}
  }
  if (layoutGroup) {
    layoutGroup.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-layout]');
      if (btn) { setLayout(btn.getAttribute('data-layout')); ping('Layout · <code>' + btn.getAttribute('data-layout') + '</code>'); }
    });
    try { const sl = localStorage.getItem('maister-board-layout'); if (sl) setLayout(sl); } catch (e) {}
  }

  /* ── filter chips (cycle values) ────────────────────────── */
  const FILTER_VALUES = {
    flow:    ['any', 'bugfix', 'spec-clarify', 'autonomous', 'refactor'],
    agent:   ['any', 'claude', 'codex', 'dev'],
    prio:    ['any', 'high', 'med', 'low'],
    touched: ['7d', '24h', '1h', '30d']
  };
  function applyFilters() {
    const flow  = curFilter('flow'),  agent = curFilter('agent'), prio = curFilter('prio');
    $$('.board .task, .board .flight-card').forEach(card => {
      let show = true;
      if (flow  !== 'any' && card.getAttribute('data-flow')  !== flow)  show = false;
      if (agent !== 'any' && card.getAttribute('data-agent') !== agent) show = false;
      if (prio  !== 'any' && card.getAttribute('data-prio')  !== prio)  show = false;
      card.style.display = show ? '' : 'none';
    });
  }
  function curFilter(name) {
    const chip = $('.chip[data-filter="' + name + '"]');
    return chip ? $('b', chip).textContent.trim() : 'any';
  }
  $$('.chip[data-filter]').forEach(chip => {
    const name = chip.getAttribute('data-filter');
    chip.addEventListener('click', () => {
      const vals = FILTER_VALUES[name] || ['any'];
      const cur = $('b', chip).textContent.trim();
      const next = vals[(vals.indexOf(cur) + 1) % vals.length];
      $('b', chip).textContent = next;
      const active = !(next === 'any' || (name === 'touched' && next === '7d'));
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
      applyFilters();
    });
  });

  /* ── clickable cards ────────────────────────────────────── */
  // backlog/prepare task cards → "open task"
  $$('.task').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.t-launch')) return;
      const title = $('.t-title', card);
      ping('Open task · ' + (title ? title.textContent.trim().slice(0, 42) : ''));
    });
    const launch = $('.t-launch', card);
    if (launch) launch.addEventListener('click', (e) => {
      e.stopPropagation();
      const title = $('.t-title', card);
      ping('▸ Launching run · ' + (title ? '<code>' + title.textContent.trim().slice(0, 30) + '</code>' : ''));
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); card.click(); }
    });
  });

  // flight / workspace cards → "attach to ws/…"
  $$('.flight-card').forEach(card => {
    card.addEventListener('click', () => {
      const ws = card.getAttribute('data-ws') || $('.nm', card)?.textContent || '';
      ping('Attach → <code>' + ws + '</code>');
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); card.click(); }
    });
  });

  // add-task tiles
  $$('.task-add, .flight-add').forEach(el =>
    el.addEventListener('click', () => ping('New task — paste a GitHub issue or type a title')));

  /* ── HITL actions ───────────────────────────────────────── */
  $$('.hitl-item').forEach(item => {
    const ws = item.getAttribute('data-ws') || '';
    // whole-row → review
    item.addEventListener('click', (e) => {
      if (e.target.closest('.hi-act') || e.target.closest('[data-choice]')) return;
      ping('Reviewing → <code>' + ws + '</code>');
    });
    $$('.hi-act .review', item).forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation(); ping('Reviewing → <code>' + ws + '</code>');
    }));
    $$('.hi-act .snooze', item).forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      item.animate([{ opacity: 1 }, { opacity: 0.35 }], { duration: 260, fill: 'forwards' });
      ping('Snoozed · <code>' + ws + '</code> · back in 1h');
      setTimeout(refreshInbox, 280);
    }));
    // inline choice chips (permission opts / schema pick)
    $$('[data-choice]', item).forEach(opt => opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const choice = opt.getAttribute('data-choice');
      item.animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(12px)', opacity: 0 }],
        { duration: 300, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
      ping('✓ <code>' + choice + '</code> → resuming <code>' + ws + '</code>');
      setTimeout(() => { item.style.display = 'none'; refreshInbox(); }, 320);
    }));
  });
  function refreshInbox() {
    const live = $$('.hitl-item').filter(i => i.style.display !== 'none' && i.style.opacity !== '0.35');
    const visible = $$('.hitl-item').filter(i => i.style.display !== 'none');
    const tag = $('.hitl-head .hh-tag');
    if (tag) tag.textContent = visible.length + ' paused';
    const inboxNum = $('.rail-nav [data-jump="inbox"] .num');
    if (inboxNum) inboxNum.textContent = String(visible.length);
  }

  /* ── settings toggles ───────────────────────────────────── */
  $$('.toggle').forEach(tg => {
    function flip() {
      const on = tg.getAttribute('aria-pressed') === 'true';
      tg.setAttribute('aria-pressed', on ? 'false' : 'true');
    }
    tg.addEventListener('click', flip);
    tg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
    });
  });
  $$('.settings-stack .edit, .def-card .edit').forEach(el =>
    el.addEventListener('click', (e) => { e.stopPropagation(); ping('Edit setting…'); }));

  /* feed / def-card / pm-cell generic open */
  $$('.feed .row').forEach(r => r.addEventListener('click', () => ping('Open · activity item')));
  $$('.def-card').forEach(c => c.addEventListener('click', (e) => {
    if (e.target.closest('.edit')) return;
    const nm = $('.dc-name', c);
    ping('Open · ' + (nm ? nm.textContent.trim() : 'definition'));
  }));

  /* ── rail ws click → mark current ───────────────────────── */
  $$('.rail .ws-li').forEach(li => li.addEventListener('click', () => {
    $$('.rail .ws-li').forEach(x => x.classList.remove('is-current'));
    li.classList.add('is-current');
    ping('Attach → <code>' + ($('.name', li)?.textContent || '') + '</code>');
  }));

  /* ── launch + shortcuts ─────────────────────────────────── */
  const launchBtn = $('#launch-btn');
  if (launchBtn) launchBtn.addEventListener('click', () => {
    launchBtn.animate(
      [{ transform: 'translateY(0)' }, { transform: 'translateY(-3px) scale(1.02)' }, { transform: 'translateY(0)' }],
      { duration: 380, easing: 'cubic-bezier(.4,0,.2,1)' });
    ping('▸ Launch run · pick a task or start ad-hoc');
  });
  const newTask = $('#new-task-btn');
  if (newTask) newTask.addEventListener('click', () => { showTab('board'); ping('New task — paste a GitHub issue or type a title'); });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); launchBtn && launchBtn.click(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newTask && newTask.click(); }
  });

  /* repo link */
  const repo = $('.repo[data-action="repo"]');
  if (repo) repo.addEventListener('click', () => window.open('https://github.com/kanischev/mAIster', '_blank', 'noopener'));

  /* ── "as of" clock ──────────────────────────────────────── */
  const asofTime = $('#asof-time'), asof = $('#asof');
  const started = Date.now();
  function fmtAgo() {
    const s = Math.floor((Date.now() - started) / 1000);
    if (s < 8) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60); return m + 'm ago';
  }
  function tickAsof() { if (asofTime) asofTime.textContent = fmtAgo(); }
  setInterval(tickAsof, 5000);
  if (asof) asof.addEventListener('click', () => {
    asof.animate([{ opacity: 1 }, { opacity: 0.4 }, { opacity: 1 }], { duration: 500 });
    ping('Refreshed · just now');
  });

})();
