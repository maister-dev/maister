/* ═══════════════════════════════════════════════════════════════
   MAIster · Login page · interactions + i18n strings
   ═══════════════════════════════════════════════════════════════ */

// ── mode switching ──────────────────────────────────────────────
function setAuthMode(mode){
  const modes = ['login','register','magic'];
  modes.forEach(m => {
    const el = document.getElementById('mode-' + m);
    if(el) el.classList.toggle('active', m === mode);
  });

  // tabs (only login/register; magic hides the tabs)
  const tL = document.getElementById('tab-login');
  const tR = document.getElementById('tab-register');
  const tabs = document.querySelector('.auth-tabs');
  if(tL && tR){
    if(mode === 'magic'){
      tabs.style.display = 'none';
    } else {
      tabs.style.display = '';
      tL.setAttribute('aria-selected', mode === 'login');
      tR.setAttribute('aria-selected', mode === 'register');
    }
  }

  // title + sub + eyebrow text via i18n keys
  const eyebrow = document.getElementById('auth-eyebrow');
  const title   = document.getElementById('auth-title');
  const sub     = document.getElementById('auth-sub');
  const swap    = document.getElementById('auth-swap');
  const swapText= document.getElementById('swap-text');
  const swapLink= document.getElementById('swap-link');

  const map = {
    login: {
      eyebrow:'auth.eyebrow.login', title:'auth.title.login', sub:'auth.sub.login',
      swap:true, swapText:'auth.swap.toRegister', swapLink:'auth.swap.signup', swapMode:'register'
    },
    register: {
      eyebrow:'auth.eyebrow.register', title:'auth.title.register', sub:'auth.sub.register',
      swap:true, swapText:'auth.swap.toLogin', swapLink:'auth.swap.signin', swapMode:'login'
    },
    magic: {
      eyebrow:'auth.eyebrow.magic', title:'auth.title.magic', sub:'auth.sub.magic',
      swap:false
    }
  };
  const cfg = map[mode];
  if(eyebrow){ eyebrow.setAttribute('data-i18n', cfg.eyebrow); }
  if(title)  { title.setAttribute('data-i18n',   cfg.title);   }
  if(sub)    { sub.setAttribute('data-i18n',     cfg.sub);     }
  if(swap){
    swap.style.display = cfg.swap ? '' : 'none';
    if(cfg.swap && swapText && swapLink){
      swapText.setAttribute('data-i18n', cfg.swapText);
      // swap-link has an inner span with data-i18n + an arr suffix
      const inner = swapLink.querySelector('span:not(.arr)');
      if(inner) inner.setAttribute('data-i18n', cfg.swapLink);
      swapLink.setAttribute('onclick', `setAuthMode('${cfg.swapMode}')`);
    }
  }
  // re-paint i18n for new attributes
  if(window.MaisterRepaintI18n) window.MaisterRepaintI18n();
}

// ── password show/hide ──────────────────────────────────────────
function togglePwd(id, btn){
  const inp = document.getElementById(id);
  if(!inp) return;
  const wasPwd = inp.type === 'password';
  inp.type = wasPwd ? 'text' : 'password';
  // swap icon (open vs closed eye)
  btn.innerHTML = wasPwd
    ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8z"/><line x1="2" y1="14" x2="14" y2="2"/></svg>'
    : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
}

// ── password strength meter (illustrative, not real crypto) ─────
function updatePwdStrength(v){
  const meter = document.getElementById('pwd-strength');
  const hint  = document.getElementById('pwd-hint');
  if(!meter) return;
  let s = 0;
  if(v.length >= 8)  s = 1;
  if(v.length >= 12) s = 2;
  if(v.length >= 12 && /[A-Z]/.test(v) && /\d/.test(v)) s = 3;
  if(v.length >= 14 && /[A-Z]/.test(v) && /\d/.test(v) && /[^A-Za-z0-9]/.test(v)) s = 4;
  meter.setAttribute('data-strength', String(s));
  if(hint){
    const labels = ['Use 12+ characters with a mix of letters, numbers and symbols',
                    'Add more characters — at least 12.',
                    'OK · add a digit or symbol for stronger.',
                    'Strong.',
                    'Excellent.'];
    hint.textContent = labels[s];
    hint.classList.toggle('success', s >= 3);
    hint.classList.toggle('error', s === 1);
  }
}

// ── extend the existing i18n dictionary with auth strings ──────
(function extendI18n(){
  // Hook: 02-hifi.js exposes window.MaisterSetLang(lang) but its I18N dict is local.
  // Trick: monkey-patch MaisterSetLang to repaint our extra keys after every lang switch.
  const AUTH_I18N = {
    en: {
      'auth.eyebrow.login':    'Welcome back',
      'auth.eyebrow.register': 'Get started',
      'auth.eyebrow.magic':    'Email link',
      'auth.title.login':      'Sign in to your <em>control plane.</em>',
      'auth.title.register':   'Create your <em>control plane.</em>',
      'auth.title.magic':      'A link by email.',
      'auth.sub.login':        "Manage them all — projects, tasks, the SDLC, humans, agents, and every handoff between.",
      'auth.sub.register':     'Solo today, teams next. Spin up your first project in under a minute.',
      'auth.sub.magic':        "We'll email you a one-tap sign-in link. No password to remember.",
      'auth.tab.login':        'Sign in',
      'auth.tab.register':     'Create account',
      'auth.oauth.github':     'Continue with GitHub',
      'auth.oauth.github.signup':'Sign up with GitHub',
      'auth.oauth.google':     'Continue with Google',
      'auth.oauth.google.signup':'Sign up with Google',
      'auth.oauth.recommended':'recommended',
      'auth.oauth.fastest':    'fastest',
      'auth.divider':          'or with email',
      'auth.field.email':      'Email',
      'auth.field.password':   'Password',
      'auth.field.forgot':     'Forgot password?',
      'auth.field.name':       'Full name',
      'auth.field.invite':     'Invite code <span style="color:var(--mute);font-weight:400;text-transform:none;letter-spacing:0;">(optional, beta)</span>',
      'auth.field.remember':   'Keep me signed in for 30 days on this device',
      'auth.field.terms':      "I agree to the <a>Terms</a> and <a>Privacy Policy</a>, and I'm OK with operating a POC release on a single host.",
      'auth.hint.pwd':         'Use 12+ characters with a mix of letters, numbers and symbols',
      'auth.hint.magic':       "We'll email you a sign-in link. Expires in 10 minutes.",
      'auth.submit.login':     'Sign in <span class="arr">→</span>',
      'auth.submit.register':  'Create account <span class="arr">→</span>',
      'auth.submit.magic':     'Send magic link <span class="arr">→</span>',
      'auth.alt.magic':        'Email me a magic link instead <span class="arr">→</span>',
      'auth.alt.back':         '← Use password instead',
      'auth.terms-line':       'By creating an account you agree to receive critical product emails (HITL pings, run completions). No marketing — promise.',
      'auth.magic.sent.t':     'Check your inbox',
      'auth.magic.sent.d':     "We sent a sign-in link. Click it to come right back here.",
      'auth.swap.toRegister':  "No account yet?",
      'auth.swap.toLogin':     "Already have an account?",
      'auth.swap.signup':      'Create one',
      'auth.swap.signin':      'Sign in',

      // side panels
      'side.spine.eye':   'Live · this instance',
      'side.spine.h3':    '<em>Where ship happens.</em><br>Backlog &rarr; merge, with proof.',
      'side.spine.sub':   'Projects, tasks, agents, humans &mdash; and every handoff between. HITL where it counts. Autonomy where you trust it.',
      'side.spine.l1':    'Intent in flight',
      'side.spine.l2':    'Agent branch',
      'side.spine.l3':    'Merged',
      'side.inst.eye':    'Instance · live',
      'side.inst.h3':     'Already running. Last 24 hours.',
      'side.inst.s1':     'projects',
      'side.inst.s2':     'runs',
      'side.inst.s3':     'need you',
      'side.inst.recent': 'Recent activity',
      'side.inst.p.running':'running',
      'side.inst.p.needs':'needs you',
      'side.inst.p.done': 'done',
      'side.inst.p.queued':'queued',
      'side.inst.caption':'↳ Sign in to take action.',
      'side.q.eye':       'From the field',
      'side.q.quote':     '"<em>One surface for the whole SDLC.</em> Projects, tasks, humans, agents — and every handoff between. Stopped juggling five tabs. Started shipping."',
      'side.q.name':      'Alex K.',
      'side.q.role':      'Tech lead · 6 months on MAIster',
      'footer.motto':     'Ship Happens.',
      'status.docs':      'Docs ↗',
    },
    ru: {
      'auth.eyebrow.login':    'С возвращением',
      'auth.eyebrow.register': 'Начать работу',
      'auth.eyebrow.magic':    'Ссылка на email',
      'auth.title.login':      'Войти в <em>панель управления.</em>',
      'auth.title.register':   'Создать <em>панель управления.</em>',
      'auth.title.magic':      'Прислать ссылку.',
      'auth.sub.login':        'Управляй всем — проекты, задачи, весь SDLC, люди, агенты и каждая передача между ними.',
      'auth.sub.register':     'Сначала соло, потом команды. Первый проект — меньше чем за минуту.',
      'auth.sub.magic':        'Вышлем ссылку для входа в один клик. Пароль не нужен.',
      'auth.tab.login':        'Вход',
      'auth.tab.register':     'Регистрация',
      'auth.oauth.github':     'Войти через GitHub',
      'auth.oauth.github.signup':'Регистрация через GitHub',
      'auth.oauth.google':     'Войти через Google',
      'auth.oauth.google.signup':'Регистрация через Google',
      'auth.oauth.recommended':'рекомендуем',
      'auth.oauth.fastest':    'быстрее всего',
      'auth.divider':          'или email и пароль',
      'auth.field.email':      'Email',
      'auth.field.password':   'Пароль',
      'auth.field.forgot':     'Забыли пароль?',
      'auth.field.name':       'Полное имя',
      'auth.field.invite':     'Инвайт-код <span style="color:var(--mute);font-weight:400;text-transform:none;letter-spacing:0;">(опционально, бета)</span>',
      'auth.field.remember':   'Не выходить из системы 30 дней на этом устройстве',
      'auth.field.terms':      'Согласен с <a>Условиями</a> и <a>Политикой конфиденциальности</a>. Понимаю, что это POC-релиз на одном хосте.',
      'auth.hint.pwd':         'От 12 символов: буквы, цифры, символы',
      'auth.hint.magic':       'Вышлем ссылку для входа. Действует 10 минут.',
      'auth.submit.login':     'Войти <span class="arr">→</span>',
      'auth.submit.register':  'Создать аккаунт <span class="arr">→</span>',
      'auth.submit.magic':     'Прислать ссылку <span class="arr">→</span>',
      'auth.alt.magic':        'Прислать ссылку на email <span class="arr">→</span>',
      'auth.alt.back':         '← Войти с паролем',
      'auth.terms-line':       'При создании аккаунта вы соглашаетесь получать критичные продуктовые письма (HITL-уведомления, завершения запусков). Без маркетинга — обещаем.',
      'auth.magic.sent.t':     'Проверьте почту',
      'auth.magic.sent.d':     'Ссылка отправлена. Кликните — вернётесь сюда.',
      'auth.swap.toRegister':  'Ещё нет аккаунта?',
      'auth.swap.toLogin':     'Уже есть аккаунт?',
      'auth.swap.signup':      'Создать',
      'auth.swap.signin':      'Войти',

      // side panels (RU)
      'side.spine.eye':   'Вживую · этот инстанс',
      'side.spine.h3':    '<em>Where ship happens.</em><br>От бэклога до мержа, с доказательствами.',
      'side.spine.sub':   'Проекты, задачи, агенты, люди &mdash; и каждая передача между ними. HITL где важно. Автономия где доверяете.',
      'side.spine.l1':    'Интент в полёте',
      'side.spine.l2':    'Ветка агента',
      'side.spine.l3':    'Смержено',
      'side.inst.eye':    'Инстанс · вживую',
      'side.inst.h3':     'Уже работает. За 24 часа.',
      'side.inst.s1':     'проектов',
      'side.inst.s2':     'запусков',
      'side.inst.s3':     'нужно вам',
      'side.inst.recent': 'Недавняя активность',
      'side.inst.p.running':'идёт',
      'side.inst.p.needs':'нужно вам',
      'side.inst.p.done': 'готово',
      'side.inst.p.queued':'в очереди',
      'side.inst.caption':'↳ Войдите, чтобы взять в работу.',
      'side.q.eye':       'С передовой',
      'side.q.quote':     '«<em>Одна поверхность для всего SDLC.</em> Проекты, задачи, люди, агенты &mdash; и каждая передача между ними. Перестал прыгать между пятью вкладками. Начал отгружать.»',
      'side.q.name':      'Алексей К.',
      'side.q.role':      'Tech lead · 6 месяцев на MAIster',
      'footer.motto':     'Ship Happens.',
      'status.docs':      'Документация ↗',
    }
  };

  function repaint(){
    const lang = document.documentElement.getAttribute('lang') === 'ru' ? 'ru' : 'en';
    const dict = AUTH_I18N[lang];
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if(dict[key] !== undefined) el.innerHTML = dict[key];
    });
  }
  window.MaisterRepaintI18n = repaint;

  // Patch MaisterSetLang so auth strings repaint after the base i18n runs.
  const origSetLang = window.MaisterSetLang;
  if(typeof origSetLang === 'function'){
    window.MaisterSetLang = function(lang){
      origSetLang(lang);
      repaint();
    };
  }

  // The base button's click handler is bound to the local `paint` fn, which
  // bypasses our patched window.MaisterSetLang — so auth strings would stay
  // in the previous language. Intercept the click in the capture phase and
  // route it through the patched setter instead. (We don't clone the button
  // because that would orphan the #lang-label / #lang-other spans the base
  // paint function targets.)
  const btn = document.getElementById('lang-toggle');
  if(btn && typeof window.MaisterSetLang === 'function'){
    btn.addEventListener('click', (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
      const cur = document.documentElement.getAttribute('lang') === 'en' ? 'ru' : 'en';
      window.MaisterSetLang(cur);
    }, true);
  }

  // Initial paint after a tick so 02-hifi.js has run its initLang first.
  setTimeout(repaint, 0);
})();

// ── expose auth-layout setter ──────────────────────────────────
(function initAuthLayout(){
  window.MaisterSetAuthLayout = function(layout){
    const page = document.querySelector('.auth-page');
    if(!page) return;
    page.setAttribute('data-layout', layout || 'centered');
    // graph engine may need to restart when panel becomes visible
    if(layout === 'split-spine' && window.__spineGraphStart) window.__spineGraphStart();
  };
})();

// ── sticky nav · backdrop on scroll ────────────────────────────
(function initStickyNav(){
  const wrap = document.querySelector('.nav-wrap.minimal');
  if(!wrap) return;
  const onScroll = () => {
    wrap.classList.toggle('scrolled', window.scrollY > 6);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();

// ════════════════════════════════════════════════════════════════
// ── live delivery graph · particles flowing + node pings ──────
// ════════════════════════════════════════════════════════════════
(function initSpineGraph(){
  const NS  = 'http://www.w3.org/2000/svg';
  let started = false;
  let timers  = [];

  // node centers map (id → {x,y})
  const NODE_AT = {
    n1:{x:35,  y:110}, n2:{x:95,  y:110}, n3:{x:160, y:110},
    n4:{x:220, y:110}, n5:{x:280, y:110}, n6:{x:340, y:110},
    n7:{x:425, y:110}
  };

  function nearestNodeAt(x, y){
    let best = null, bd = Infinity;
    for(const id in NODE_AT){
      const n = NODE_AT[id];
      const d = Math.hypot(n.x - x, n.y - y);
      if(d < bd){ bd = d; best = id; }
    }
    // only "hit" if within ~12px of a node center
    return bd < 12 ? best : null;
  }

  function pingNode(svg, nodeId, variant){
    if(!nodeId) return;
    const n = NODE_AT[nodeId];
    if(!n) return;
    const pings = svg.querySelector('#g-pings');
    if(!pings) return;
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', n.x); c.setAttribute('cy', n.y); c.setAttribute('r', 5);
    c.setAttribute('class', 'g-node-ping' + (variant ? ' ' + variant : ''));
    pings.appendChild(c);
    setTimeout(() => c.remove(), 900);

    // briefly highlight the actual node
    const node = svg.querySelector(`.g-node[data-id="${nodeId}"]`);
    if(node){
      const wasMerged = node.classList.contains('is-merged');
      node.classList.add(variant === 'is-merged' ? 'is-merged' : 'is-hot');
      setTimeout(() => {
        if(!wasMerged) node.classList.remove('is-hot');
        if(variant !== 'is-merged') node.classList.remove('is-hot');
      }, 700);
    }
  }

  function spawnParticle(svg, pathSel, opts){
    const path = svg.querySelector(pathSel);
    const layer = svg.querySelector('#g-particles');
    if(!path || !layer) return;
    const total = path.getTotalLength();
    const dur = opts.duration || 4200;
    const color = opts.color || 'var(--amber)';
    const cls = 'g-particle' + (opts.cls ? ' ' + opts.cls : '');

    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('r', '3');
    dot.setAttribute('fill', color);
    dot.setAttribute('class', cls);
    layer.appendChild(dot);

    let lastHit = null;
    const start = performance.now();
    function step(now){
      const k = (now - start) / dur;
      if(k >= 1){
        // final ping at endpoint if endpoint is a node
        const pt = path.getPointAtLength(total);
        const hit = nearestNodeAt(pt.x, pt.y);
        if(hit && hit !== lastHit) pingNode(svg, hit, opts.endVariant || opts.pingVariant);
        dot.remove();
        if(opts.onEnd) opts.onEnd();
        return;
      }
      const pt = path.getPointAtLength(total * k);
      dot.setAttribute('cx', pt.x);
      dot.setAttribute('cy', pt.y);

      // ping nodes the particle crosses
      const hit = nearestNodeAt(pt.x, pt.y);
      if(hit && hit !== lastHit){
        lastHit = hit;
        if(opts.pingVariant !== null) pingNode(svg, hit, opts.pingVariant);
      }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ── review-gate helpers ──
  function flashHuman(svg, state, ms){
    const h = svg.querySelector('#g-human');
    if(!h) return;
    h.classList.remove('is-pass','is-reject');
    h.classList.add(state);
    timers.push(setTimeout(() => h.classList.remove(state), ms));
  }
  function flashReviewNode(svg, ms){
    const n = svg.querySelector('.g-node[data-id="n6"]');
    if(!n) return;
    n.classList.add('is-reject');
    timers.push(setTimeout(() => n.classList.remove('is-reject'), ms));
  }
  function flashReviewBackTrack(svg, ms){
    const t = svg.querySelector('#g-review-back');
    if(!t) return;
    t.classList.add('is-active');
    timers.push(setTimeout(() => t.classList.remove('is-active'), ms));
  }

  // Spawn a particle that travels intent → review, then the review gate
  // decides: every 3rd arrival rejects (bounce back to flow); others approve
  // (continue to ship). The human icon blinks accordingly.
  let reviewArrivals = 0;
  function spawnReviewedIntent(svg, opts){
    const cls = opts.cls || '';
    const color = opts.color || 'var(--amber)';
    spawnParticle(svg, '#g-intent-to-review', {
      color, cls, duration: 3600,
      pingVariant: cls === 'is-accent' ? 'is-accent' : 'is-hot',
      onEnd: () => {
        reviewArrivals++;
        const reject = (reviewArrivals % 3 === 0);
        if(reject){
          flashHuman(svg, 'is-reject', 1500);
          flashReviewNode(svg, 1500);
          flashReviewBackTrack(svg, 2600);
          // particle bounces back along review→flow
          timers.push(setTimeout(() => {
            spawnParticle(svg, '#g-review-back', {
              color: '#d9534f', cls: 'is-reject', duration: 2400,
              pingVariant: 'is-reject'
            });
          }, 250));
        } else {
          flashHuman(svg, 'is-pass', 1100);
          // particle continues to ship
          timers.push(setTimeout(() => {
            spawnParticle(svg, '#g-review-to-ship', {
              color, cls, duration: 1700,
              pingVariant: cls === 'is-accent' ? 'is-accent' : 'is-hot',
              endVariant: 'is-merged'
            });
          }, 200));
        }
      }
    });
  }

  // choreographed waves of activity
  function runChoreo(svg){
    let beat = 0;
    function tick(){
      const m = beat % 8;
      if(m === 0){
        // a fresh intent traverses intent→review → (gate decision) → ship or back to flow
        spawnReviewedIntent(svg, { color:'var(--amber)' });
      }
      if(m === 1){
        // claude picks up branch A
        spawnParticle(svg, '#g-branch-a', { color:'var(--amber)', duration:3600,
          pingVariant:'is-hot' });
      }
      if(m === 2){
        // a parallel intent — accent color, same review gate logic
        spawnReviewedIntent(svg, { color:'var(--accent-3)', cls:'is-accent' });
      }
      if(m === 3){
        // codex on branch B (parallel)
        spawnParticle(svg, '#g-branch-b', { color:'var(--accent-3)', duration:3200,
          cls:'is-accent', pingVariant:'is-accent' });
      }
      if(m === 4){
        // rework feedback · ship → platform-agent → intent
        spawnParticle(svg, '#g-rework', { color:'var(--mute)', duration:6200,
          pingVariant:null });
      }
      if(m === 5){
        // open / pending branch — slower, no merge
        spawnParticle(svg, '#g-branch-c', { color:'var(--mute-2)', duration:5400 });
      }
      if(m === 6){
        spawnParticle(svg, '#g-branch-a', { color:'var(--amber)', duration:3000,
          pingVariant:'is-hot' });
      }
      if(m === 7){
        // a second rework cycle, offset
        spawnParticle(svg, '#g-rework', { color:'var(--mute)', duration:6800,
          pingVariant:null });
      }
      beat++;
    }
    tick();
    timers.push(setInterval(tick, 900));
  }

  // ── terminal printing ──
  // sequence of (style, text) lines that loop. The active row types out
  // char-by-char, then commits up and a new active line starts.
  const LOG = [
    ['is-prompt', '$ maister status'],
    ['is-note',   '↳ daemon up · localhost:3000 · 12 intents'],
    ['is-prompt', '$ maister run --autonomous'],
    ['is-note',   '↳ intent #427 → task t-7c2e on backlog'],
    ['is-note',   '↳ flow f-auth created · 4 steps'],
    ['is-hot',    '⚡ t-7c2e · claim by claude/sonnet'],
    ['is-note',   '· tests 12/12 · lint ok · types ok'],
    ['is-ok',     '✓ review by you · approved'],
    ['is-ok',     '✓ t-7c2e merged → main@4f2a · shipped'],
    ['is-prompt', '$ platform-agent --tail logs'],
    ['is-note',   '↳ scan: 14k lines · 3 anomalies'],
    ['is-hot',    '⚠ error rate +0.4% on /auth/* (post-ship)'],
    ['is-note',   '↳ distill → task t-7c2f on backlog'],
    ['is-hot',    '⚡ t-7c30 · claim by codex'],
    ['is-reject', '✗ review by you · rejected · spec ambiguous'],
    ['is-note',   '↳ flow f-auth reopened · revised'],
    ['is-tagline','// where ship happens.'],
  ];

  function startTerminal(){
    const term = document.getElementById('spine-term');
    if(!term) return;
    const rows  = [...term.querySelectorAll('.term-line[data-row]:not(.is-active)')];
    const activeEl = term.querySelector('.term-line.is-active');
    const textEl   = document.getElementById('term-text');
    if(!activeEl || !textEl) return;

    // history of recent lines (style + text), most recent last
    const history = [];
    let idx = 0;

    function paintHistory(){
      for(let i = 0; i < rows.length; i++){
        const row = rows[i];
        // map history (newest last) to rows (newest = bottom row = last)
        const h = history[history.length - rows.length + i];
        row.className = 'term-line';
        if(h){
          row.classList.add(h.style);
          row.textContent = h.text;
        } else {
          row.textContent = '';
        }
      }
    }

    function typeNext(){
      const [style, text] = LOG[idx % LOG.length];
      idx++;

      // reset active row's class for new style
      activeEl.className = 'term-line is-active ' + style;
      textEl.textContent = '';

      let i = 0;
      function typeChar(){
        textEl.textContent = text.slice(0, i + 1);
        i++;
        if(i < text.length){
          const ch = text[i - 1];
          let delay = 18 + Math.random() * 28;
          if(ch === ' ') delay = 14;
          if(/[.,:;!?]/.test(ch)) delay = 90;
          timers.push(setTimeout(typeChar, delay));
        } else {
          // hold for a beat, then commit to history and start next
          timers.push(setTimeout(() => {
            history.push({ style, text });
            if(history.length > rows.length + 4) history.shift();
            paintHistory();
            textEl.textContent = '';
            timers.push(setTimeout(typeNext, 350 + Math.random() * 250));
          }, 650));
        }
      }
      typeChar();
    }

    typeNext();
  }

  function clearTimers(){
    timers.forEach(t => { clearInterval(t); clearTimeout(t); });
    timers = [];
  }

  function start(){
    if(started) return;
    const svg = document.getElementById('spine-graph');
    if(!svg) return;
    started = true;
    clearTimers();
    runChoreo(svg);
    startTerminal();
  }

  window.__spineGraphStart = start;

  // observe panel visibility — start only when spine panel is rendered
  // (it's hidden on non-spine layouts, so animating it would be wasted work)
  function observe(){
    const panel = document.querySelector('.side-panel.spine');
    if(!panel) return;
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => { if(e.isIntersecting) start(); });
    }, { threshold: 0.05 });
    io.observe(panel);
    // also start immediately if already visible
    if(panel.offsetParent !== null) start();
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', observe);
  } else {
    observe();
  }
})();
