/* ═══════════════════════════════════════════════════════════════
   MAIster · Landing · Hi-fi · interactions + i18n
   ═══════════════════════════════════════════════════════════════ */

// ── theme toggle ────────────────────────────────────────────────
(function initTheme(){
  const root = document.documentElement;
  const btn = document.getElementById('theme-toggle');
  const lbl = document.getElementById('theme-label');
  const icon = document.getElementById('theme-icon');

  function paint(t){
    root.setAttribute('data-theme', t);
    btn.setAttribute('aria-pressed', t === 'dark');
    lbl.textContent = t === 'dark' ? 'Dark' : 'Light';
    icon.innerHTML = t === 'dark'
      ? '<path d="M13 8.5A5.5 5.5 0 1 1 7.5 3a4.5 4.5 0 0 0 5.5 5.5z"/>'
      : '<path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 2v1.5M8 12.5V14M14 8h-1.5M3.5 8H2M12.24 3.76l-1.06 1.06M4.82 11.18l-1.06 1.06M12.24 12.24l-1.06-1.06M4.82 4.82L3.76 3.76"/>';
    try{ localStorage.setItem('maister-theme', t); }catch(e){}
  }
  let initial = 'light';
  try{
    const saved = localStorage.getItem('maister-theme');
    if(saved) initial = saved;
    else if(window.matchMedia('(prefers-color-scheme: dark)').matches) initial = 'dark';
  }catch(e){}
  paint(initial);
  btn.addEventListener('click', () => paint(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  window.MaisterSetTheme = paint;
})();

// ── i18n EN / RU ─────────────────────────────────────────────────
const I18N = {
  en: {
    'nav.product':'Product','nav.docs':'Docs','nav.roadmap':'Roadmap','nav.decisions':'Decisions',
    'hero.kicker':'MAIster · The shared control plane for agentic AI software delivery',
    'hero.h1':'One place<br>to manage them all. <em>Humans and agents alike.</em>',
    'hero.sub':'A shared dev-management platform for <b>teams of humans and agents</b>, collaborating in every direction. Tasks, flows, workspaces, reviews, merges — one place. <b>Path to autonomy</b> when you trust it, <b>tight oversight</b> when you don\'t.',
    'hero.cta1':'Get started <span class="arr">→</span>',
    'hero.cta2':'Read the docs ↗',
    'hero.cta3':'github.com/kanischev/mAIster · MIT',
    'hero.stage.title':'Configurable spine',
    'hero.stage.sub':'· HITL anywhere · path to autonomy',
    'hero.stage.bugfix':'bugfix',
    'hero.stage.spec':'spec-clarify',
    'hero.stage.auto':'autonomous',

    'spine.eye':'§ Product spine',
    'spine.h2':'<em>Backlog to merge.</em><br>Humans, agents, and the <span class="amber">path</span> in between.',
    'spine.sub':'The spine isn\'t a pipeline — it\'s a <b>configurable surface</b>. Each step accepts a human or an agent (or both). HITL is decided <b>per flow, per task</b>, not at one fixed point. Solo today; teams and full agentization next.',
    'spine.legend.on':'HITL on',
    'spine.legend.maybe':'configurable',
    'spine.legend.off':'autonomous',
    'step.intent.t':'Intent','step.intent.d':'A task — from a human, an agent, or a signal.',
    'step.flow.t':'Flow','step.flow.d':'Pick + configure a flow plugin. Flows aren\'t one.',
    'step.ws.t':'Workspace','step.ws.d':'An isolated git worktree per run.',
    'step.agents.t':'Agents','step.agents.d':'Claude · Codex — via ACP. Cursor & Aider soon.',
    'step.iterate.t':'Iterate','step.iterate.d':'Step loops with HITL when needed. Ralph-loop friendly.',
    'step.review.t':'Review','step.review.d':'Diff + judge artifact + accept / request-changes.',
    'step.merge.t':'Merge','step.merge.d':'--no-ff to main/dev. Conflict = manual.',
    'step.lessons.t':'Lessons','step.lessons.d':'Bugs evolve project rules. Optional.',
    'autonomy.l':'Tight oversight','autonomy.r':'→ Full autonomy',

    'int.eye':'§ Four ways to collaborate',
    'int.h2':'<em>Humans, agents,</em><br>and every <span class="amber">combination</span> of both.',
    'int.sub':'A control plane that treats agents as first-class teammates, not a service queue. Every interaction has a clear surface, an artifact, and a queue.',
    'int.hh.t':'Human ↔ Human',
    'int.hh.d':'Team backlog. Peer review on a diff. Hand-off comments on a HITL ticket. Tickets queue across projects.',
    'int.ha.t':'Human → Agent',
    'int.ha.d':'Launch a task with prompt + flow + executor. Approve a permission. Send corrections back to the work loop.',
    'int.ah.t':'Agent → Human',
    'int.ah.d':'NeedsInput artifacts. Schema-driven forms in the run page. Inbox badge across projects. Keep-alive + checkpoint/resume.',
    'int.aa.t':'Agent ↔ Agent <span class="phase">Phase 2</span>',
    'int.aa.d':'Agent-to-agent hand-off inside a flow. Sub-agents spawned per step. Reviewer / log / dependency watchers.',

    'jtbd.eye':'§ Built for',
    'jtbd.h2':'Whoever\'s <em>running things.</em>',
    'jtbd.sub':'A collaborative <b>surface for agentic AI SDLC</b> — humans and agents role-play across design, plan, build, review, ship and learn. Solo today, teams next.',
    'jtbd.more':'more personas <span class="arr">→</span>',
    'persona.cto.role':'Solo-architect / CTO',
    'persona.cto.q':'"When I manage five projects, <span class="em">I want one dashboard for active work, blocked runs, ready reviews and pending decisions,</span> so I know where my attention is needed."',
    'persona.cto.j1':'Portfolio view across N projects',
    'persona.cto.j2':'"Needs you" inbox, cross-project',
    'persona.cto.j3':'3 concurrent runs · queue the rest',
    'persona.tl.role':'Tech lead',
    'persona.tl.q':'"When I assign work to an agent, <span class="em">I want it to run headlessly with visible progress and a clean diff to review,</span> so I can run multiple tasks in parallel safely."',
    'persona.tl.j1':'Per-run isolated workspace',
    'persona.tl.j2':'Live SSE log, piped to disk',
    'persona.tl.j3':'git diff + merge --no-ff',
    'persona.se.role':'Staff engineer',
    'persona.se.q':'"When a task is ambiguous, <span class="em">I want the agent to ask questions in a form, not a chat,</span> so requirements are clarified without losing context."',
    'persona.se.j1':'Schema-driven HITL forms',
    'persona.se.j2':'Keep-alive + checkpoint/resume',
    'persona.se.j3':'Retry-loop friendly (1 task, N runs)',
    'persona.lead.role':'Team lead',
    'persona.lead.q':'"When my team and our agents share work, <span class="em">I want one queue across people and bots,</span> so hand-offs don\'t fall through."',
    'persona.lead.j1':'Shared backlog + assign-to-anyone',
    'persona.lead.j2':'Role-based HITL routing',
    'persona.lead.j3':'a→a hand-offs visible in the run',

    'glue.eye':'§ Nine pieces of glue',
    'glue.h2':'<em>Connective tissue</em> for the tools you already use.',
    'glue.sub':'No new IDE. No new agent. No new task tracker. MAIster is the layer between them.',
    'glue.portfolio.t':'Multi-project portfolio',
    'glue.portfolio.d':'One grid of every active workspace across every registered project. Filter by status. "Needs you (N)" badge counts pending HITL across all projects, all flows.',
    'glue.board.t':'Per-project board',
    'glue.board.d':'Backlog | In Flight. One-click Launch. Ralph-loop friendly: 1 task → N runs.',
    'glue.exec.t':'Multi-executor · ACP',
    'glue.exec.d':'Claude Code + Codex on day one. Cursor & Aider land in Phase 2 with no protocol changes.',
    'glue.hitl.t':'Configurable HITL',
    'glue.hitl.d':'Per-step, per-flow, per-task. Schema-driven forms, not chat. Keep-alive + checkpoint/resume so an active review never times out mid-thought.',
    'glue.diff.t':'Diff review & merge',
    'glue.diff.d':'Raw git diff, accept / request-changes, --no-ff to main. Conflicts abort to manual resolve. No auto-clobber.',
    'glue.sse.t':'Live SSE everything',
    'glue.sse.d':'Every agent stdout line streams over SSE, piped to disk in parallel. Last-Event-ID reconnect works without replaying from RAM. Per-run cost accounting in cost.jsonl.',
    'glue.tight.t':'Project-tightened agents runtime',
    'glue.tight.d':'Each project gets its own agent runtime — skills, MCPs, rules and tools pinned per repo. Agents don\'t drift across projects.',
    'glue.team.t':'Team collaboration',
    'glue.team.d':'Shared backlog, role-based HITL routing, a→a hand-offs. Solo today, team next.',
    'glue.memory.t':'Project memory',
    'glue.memory.d':'Bugs and reviews evolve project rules. Optional and curated — not a chat firehose.',

    'exec.title':'Speaks fluent',
    'exec.via':'via <b>Agent Client Protocol</b> · ACP 0.22.1',

    'oss.eye':'§ Open source',
    'oss.h2':'MIT-licensed.<br>Single host.<br><em>Yours to fork.</em>',
    'oss.p':'The whole thing fits on one machine: Postgres, Next.js, a supervisor daemon, two agent binaries. <code>docker compose up</code> and you\'re in.',
    'oss.cta1':'Get started <span class="arr">→</span>',
    'oss.cta2':'Quick start ↗',

    'footer.motto':'Ship Happens.',
    'footer.tagline':'The control plane for AI-powered software delivery. <b>One place to manage them all.</b>',
    'footer.product':'Product','footer.docs':'Docs','footer.decisions':'Decisions','footer.project':'Project',

    'badge.p2':'Phase 2','phase.soon':'Soon',
  },

  ru: {
    'nav.product':'Продукт','nav.docs':'Документация','nav.roadmap':'Дорожная карта','nav.decisions':'Решения',
    'hero.kicker':'MAIster · Единая управляющая платформа для агентной AI-разработки',
    'hero.h1':'Одно место,<br>чтобы управлять всеми. <em>И людьми, и агентами.</em>',
    'hero.sub':'Общая платформа управления разработкой для <b>команд людей и агентов</b>, взаимодействующих во всех направлениях. Задачи, флоу, рабочие пространства, ревью, мержи — в одном месте. <b>Путь к автономии</b>, когда доверяете, <b>жёсткий контроль</b>, когда нет.',
    'hero.cta1':'Начать <span class="arr">→</span>',
    'hero.cta2':'Документация ↗',
    'hero.cta3':'github.com/kanischev/mAIster · MIT',
    'hero.stage.title':'Настраиваемый стержень',
    'hero.stage.sub':'· HITL где угодно · путь к автономии',
    'hero.stage.bugfix':'багфикс',
    'hero.stage.spec':'уточнение',
    'hero.stage.auto':'автономно',

    'spine.eye':'§ Продуктовый стержень',
    'spine.h2':'<em>От бэклога до мержа.</em><br>Люди, агенты и <span class="amber">путь</span> между ними.',
    'spine.sub':'Стержень — это не пайплайн, а <b>настраиваемая поверхность</b>. Каждый шаг принимает человека или агента (или обоих). HITL решается <b>под флоу, под задачу</b>, а не в одной фиксированной точке. Сначала соло; команды и полная агентизация — следующий шаг.',
    'spine.legend.on':'HITL включён',
    'spine.legend.maybe':'настраивается',
    'spine.legend.off':'автономно',
    'step.intent.t':'Намерение','step.intent.d':'Задача — от человека, агента или сигнала.',
    'step.flow.t':'Флоу','step.flow.d':'Выбрать + настроить плагин-флоу. Флоу не один.',
    'step.ws.t':'Workspace','step.ws.d':'Изолированный git worktree на каждый запуск.',
    'step.agents.t':'Агенты','step.agents.d':'Claude · Codex — через ACP. Cursor и Aider — скоро.',
    'step.iterate.t':'Итерация','step.iterate.d':'Шаг крутится с HITL при необходимости. Ralph-loop friendly.',
    'step.review.t':'Ревью','step.review.d':'Diff + артефакт judge + accept / request-changes.',
    'step.merge.t':'Мерж','step.merge.d':'--no-ff в main/dev. Конфликт — руками.',
    'step.lessons.t':'Уроки','step.lessons.d':'Баги превращаются в правила проекта. Опционально.',
    'autonomy.l':'Жёсткий контроль','autonomy.r':'→ Полная автономия',

    'int.eye':'§ Четыре способа взаимодействия',
    'int.h2':'<em>Люди, агенты</em><br>и любая <span class="amber">комбинация</span> из них.',
    'int.sub':'Управляющая платформа, в которой агенты — полноправные участники команды, а не очередь к сервису. У каждого взаимодействия — своя поверхность, артефакт и очередь.',
    'int.hh.t':'Человек ↔ Человек',
    'int.hh.d':'Командный бэклог. Peer-ревью на diff. Передачи в HITL-тикетах. Очередь тикетов кросс-проектная.',
    'int.ha.t':'Человек → Агент',
    'int.ha.d':'Запуск задачи с промптом + флоу + executor. Подтверждение прав. Корректировки обратно в рабочую петлю.',
    'int.ah.t':'Агент → Человек',
    'int.ah.d':'Артефакты NeedsInput. Schema-driven формы на странице запуска. Бейдж в инбоксе кросс-проектно. Keep-alive + checkpoint/resume.',
    'int.aa.t':'Агент ↔ Агент <span class="phase">Phase 2</span>',
    'int.aa.d':'Agent-to-agent передачи внутри флоу. Суб-агенты на каждый шаг. Reviewer / log / dependency наблюдатели.',

    'jtbd.eye':'§ Для кого',
    'jtbd.h2':'Для тех, кто <em>управляет процессом.</em>',
    'jtbd.sub':'Совместная <b>поверхность для агентного AI SDLC</b> — люди и агенты исполняют роли в дизайне, планировании, разработке, ревью, релизах и обучении. Сначала соло, потом команды.',
    'jtbd.more':'ещё персон <span class="arr">→</span>',
    'persona.cto.role':'Соло-архитектор / CTO',
    'persona.cto.q':'«Когда веду пять проектов, <span class="em">мне нужен один дашборд активной работы, заблокированных запусков, готовых ревью и решений,</span> чтобы знать, где я нужен.»',
    'persona.cto.j1':'Портфолио на N проектов',
    'persona.cto.j2':'Инбокс "нужно ваше внимание" кросс-проектно',
    'persona.cto.j3':'3 параллельных запуска · остальное в очередь',
    'persona.tl.role':'Tech lead',
    'persona.tl.q':'«Когда отдаю работу агенту, <span class="em">хочу, чтобы он работал безголово, с видимым прогрессом и чистым diff на ревью,</span> чтобы я мог безопасно гонять несколько задач параллельно.»',
    'persona.tl.j1':'Изолированный workspace на запуск',
    'persona.tl.j2':'Живой SSE-лог, пишется на диск',
    'persona.tl.j3':'git diff + merge --no-ff',
    'persona.se.role':'Staff engineer',
    'persona.se.q':'«Когда задача неоднозначна, <span class="em">хочу, чтобы агент задавал вопросы формой, а не в чате,</span> чтобы требования уточнялись без потери контекста.»',
    'persona.se.j1':'Schema-driven HITL формы',
    'persona.se.j2':'Keep-alive + checkpoint/resume',
    'persona.se.j3':'Retry-loop friendly (1 задача — N запусков)',
    'persona.lead.role':'Team lead',
    'persona.lead.q':'«Когда команда и наши агенты делят работу, <span class="em">мне нужна одна очередь для людей и ботов,</span> чтобы передачи не терялись.»',
    'persona.lead.j1':'Общий бэклог + назначение на кого угодно',
    'persona.lead.j2':'Маршрутизация HITL по ролям',
    'persona.lead.j3':'a→a передачи видны в запуске',

    'glue.eye':'§ Девять кусков клея',
    'glue.h2':'<em>Соединительная ткань</em> для уже привычных вам инструментов.',
    'glue.sub':'Без нового IDE. Без нового агента. Без нового таск-трекера. MAIster — это слой между ними.',
    'glue.portfolio.t':'Портфолио проектов',
    'glue.portfolio.d':'Одна сетка всех активных workspaces по всем проектам. Фильтр по статусу. Бейдж "Нужно ваше внимание (N)" считает HITL во всех проектах и флоу.',
    'glue.board.t':'Доска проекта',
    'glue.board.d':'Backlog | В работе. Запуск в один клик. Ralph-loop friendly: 1 задача → N запусков.',
    'glue.exec.t':'Multi-executor · ACP',
    'glue.exec.d':'Claude Code + Codex с первого дня. Cursor и Aider — Phase 2, без изменений протокола.',
    'glue.hitl.t':'Настраиваемый HITL',
    'glue.hitl.d':'На шаг, на флоу, на задачу. Schema-driven формы, не чат. Keep-alive + checkpoint/resume — активное ревью не вылетает на полу-мысли.',
    'glue.diff.t':'Ревью diff и мерж',
    'glue.diff.d':'Сырой git diff, accept / request-changes, --no-ff в main. Конфликт прерывается на ручное разрешение. Никакой автоматической перезаписи.',
    'glue.sse.t':'Живой SSE везде',
    'glue.sse.d':'Каждая строка stdout агента идёт через SSE, параллельно пишется на диск. Last-Event-ID-реконнект работает без replay из RAM. Учёт стоимости в cost.jsonl на каждый запуск.',
    'glue.tight.t':'Привязанный runtime агентов',
    'glue.tight.d':'У каждого проекта свой runtime агентов — skills, MCP, правила и инструменты прикреплены к репо. Агенты не дрейфуют между проектами.',
    'glue.team.t':'Командная работа',
    'glue.team.d':'Общий бэклог, маршрутизация HITL по ролям, a→a передачи. Соло сегодня, команда завтра.',
    'glue.memory.t':'Память проекта',
    'glue.memory.d':'Баги и ревью эволюционируют в правила проекта. Опционально и курируется — не чат-помойка.',

    'exec.title':'Свободно говорит на',
    'exec.via':'через <b>Agent Client Protocol</b> · ACP 0.22.1',

    'oss.eye':'§ Open source',
    'oss.h2':'MIT-лицензия.<br>Один хост.<br><em>Форкайте на здоровье.</em>',
    'oss.p':'Всё это помещается на одну машину: Postgres, Next.js, supervisor-демон, два бинаря агентов. <code>docker compose up</code> — и вы внутри.',
    'oss.cta1':'Начать <span class="arr">→</span>',
    'oss.cta2':'Быстрый старт ↗',

    'footer.motto':'Ship Happens.',
    'footer.tagline':'Управляющая платформа для AI-разработки. <b>Одно место, чтобы управлять всеми.</b>',
    'footer.product':'Продукт','footer.docs':'Документация','footer.decisions':'Решения','footer.project':'Проект',

    'badge.p2':'Phase 2','phase.soon':'Скоро',
  }
};

(function initLang(){
  const btn = document.getElementById('lang-toggle');
  const lbl = document.getElementById('lang-label');
  const other = document.getElementById('lang-other');
  const root = document.documentElement;

  function paint(lang){
    root.setAttribute('lang', lang);
    const dict = I18N[lang];
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if(dict[key] !== undefined) el.innerHTML = dict[key];
    });
    lbl.textContent = lang.toUpperCase();
    other.textContent = '· ' + (lang === 'en' ? 'RU' : 'EN');
    try{ localStorage.setItem('maister-lang', lang); }catch(e){}
  }

  let initial = 'en';
  try{ const saved = localStorage.getItem('maister-lang'); if(saved && I18N[saved]) initial = saved; }catch(e){}
  paint(initial);
  btn.addEventListener('click', () => paint(root.getAttribute('lang') === 'en' ? 'ru' : 'en'));
  window.MaisterSetLang = paint;
})();

// ── logo iterations (click to cycle) ────────────────────────────
(function initLogo(){
  const logo = document.getElementById('brand-logo');
  const mark = document.getElementById('logo-mark');
  if(!logo || !mark) return;

  // 3 iterations on direction E (loop / iteration arrow). Robot/AI motifs near the ring.
  const variants = [
    // E1 · iteration loop with antenna nub + two AI eye dots inside the ring
    '<path d="M22 12 a8 8 0 1 1 -2.34 -5.66"/><polyline points="22 5 22 9 18 9"/><line x1="14" y1="2" x2="14" y2="4.5"/><circle cx="14" cy="1.6" r="1" fill="currentColor" stroke="none"/><circle cx="11" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
    // E2 · closed ring with antenna + chip dots on the perimeter (circuit-y)
    '<circle cx="14" cy="12" r="8"/><path d="M14 12 L17 9"/><line x1="14" y1="2" x2="14" y2="4"/><circle cx="14" cy="1.4" r="1" fill="currentColor" stroke="none"/><circle cx="6" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="22" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="14" cy="20" r="1.1" fill="currentColor" stroke="none"/>',
    // E3 · double-arrow loop (iterate forever) + center AI dot
    '<path d="M6 9 a7 7 0 0 1 13 -1.5"/><polyline points="19 4 19 8 15 8"/><path d="M22 15 a7 7 0 0 1 -13 1.5"/><polyline points="9 20 9 16 13 16"/><circle cx="14" cy="12" r="1.6" fill="currentColor" stroke="none"/>'
  ];
  let idx = 0;
  function paint(i){
    idx = ((i % variants.length) + variants.length) % variants.length;
    mark.innerHTML = variants[idx];
    mark.dataset.variant = 'E' + (idx + 1);
  }
  logo.addEventListener('click', e => { e.preventDefault(); paint(idx + 1); });
  window.MaisterSetLogo = (n) => paint(n);
  paint(0);
})();

// ── flow picker (hero spine + spine board) ──────────────────────
(function initFlowPickers(){
  // each flow defines the HITL pin pattern across 8 steps
  // values: 'on' | 'maybe' | 'off'
  const FLOWS = {
    bugfix: ['off','maybe','off','off','on','on','off','off'],
    spec:   ['on','on','off','off','on','off','off','off'],
    auto:   ['off','off','off','off','off','off','off','off']
  };

  // Hero SVG ping positions
  const HERO_PINGS = {
    bugfix: [
      {step:5, x:450, delay:0},
      {step:6, x:550, delay:0.4}
    ],
    spec: [
      {step:1, x:50,  delay:0},
      {step:2, x:150, delay:0.3},
      {step:5, x:450, delay:0.6}
    ],
    auto: []
  };

  function paintBoard(flowKey){
    const pattern = FLOWS[flowKey];
    const cells = document.querySelectorAll('#board-hitl .hitl-cell');
    cells.forEach((c, i) => {
      c.classList.remove('on','maybe');
      const state = pattern[i];
      if(state === 'on') c.classList.add('on');
      else if(state === 'maybe') c.classList.add('maybe');
      const hint = c.querySelector('.hint');
      if(hint) hint.remove();
      if(state === 'on'){
        const span = document.createElement('span');
        span.className = 'hint';
        span.textContent = 'HITL';
        c.appendChild(span);
      }
    });
  }

  function paintHero(flowKey){
    const container = document.getElementById('hitl-pings');
    if(!container) return;
    container.innerHTML = '';
    const NS = 'http://www.w3.org/2000/svg';
    HERO_PINGS[flowKey].forEach(p => {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class','ping');
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', p.x); line.setAttribute('y1', 170);
      line.setAttribute('x2', p.x); line.setAttribute('y2', 100);
      line.setAttribute('stroke', 'var(--amber)');
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('stroke-dasharray', '3 3');
      g.appendChild(line);

      const circ = document.createElementNS(NS, 'circle');
      circ.setAttribute('cx', p.x); circ.setAttribute('cy', 100);
      circ.setAttribute('r', 9);
      circ.setAttribute('fill', 'var(--amber)');
      const a1 = document.createElementNS(NS, 'animate');
      a1.setAttribute('attributeName','r'); a1.setAttribute('values','9;12;9');
      a1.setAttribute('dur','1.4s'); a1.setAttribute('begin', p.delay + 's');
      a1.setAttribute('repeatCount','indefinite');
      circ.appendChild(a1);
      const a2 = document.createElementNS(NS, 'animate');
      a2.setAttribute('attributeName','opacity'); a2.setAttribute('values','1;0.55;1');
      a2.setAttribute('dur','1.4s'); a2.setAttribute('begin', p.delay + 's');
      a2.setAttribute('repeatCount','indefinite');
      circ.appendChild(a2);
      g.appendChild(circ);

      const txt = document.createElementNS(NS, 'text');
      txt.setAttribute('x', p.x); txt.setAttribute('y', 80);
      txt.setAttribute('font-family','JetBrains Mono, monospace');
      txt.setAttribute('font-size','10');
      txt.setAttribute('fill','var(--amber)');
      txt.setAttribute('text-anchor','middle');
      txt.setAttribute('font-weight','600');
      txt.textContent = 'HITL';
      g.appendChild(txt);

      container.appendChild(g);
    });
  }

  // wire both pickers
  document.querySelectorAll('.flow-picker').forEach(picker => {
    const isBoard = picker.id === 'board-flow-picker';
    picker.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const flow = btn.getAttribute('data-flow');
        picker.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', b === btn));
        // also sync the OTHER picker so both stay together
        document.querySelectorAll('.flow-picker').forEach(other => {
          if(other === picker) return;
          other.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', b.getAttribute('data-flow') === flow));
        });
        paintHero(flow);
        paintBoard(flow);
      });
    });
  });

  paintHero('bugfix');
  paintBoard('bugfix');
})();

// ── tweaks bridge (palette / vibe / wordmark / hero-mode / headline) ──
(function initTweakBridge(){
  const root = document.documentElement;

  window.MaisterSetPalette = (p) => root.setAttribute('data-palette', p);
  window.MaisterSetVibe    = (v) => root.setAttribute('data-vibe', v);

  // wordmark style: 'lower' (m + bold ai + ster) | 'upper' (m + AI + ster)
  window.MaisterSetWordmark = (style) => {
    document.querySelectorAll('.logo .wm').forEach(el => {
      el.classList.remove('upper','lower');
      el.classList.add(style === 'upper' ? 'upper' : 'lower');
    });
  };

  // hero stage mode: 'spine' | 'ui' | 'terminal'
  window.MaisterSetHeroMode = (m) => {
    const stage = document.getElementById('hero-stage');
    if(!stage) return;
    stage.setAttribute('data-mode', m);
    const titleEl = stage.querySelector('.stage-title b');
    const subEl = stage.querySelector('.stage-title span:last-child');
    const picker = stage.querySelector('.flow-picker');
    if(titleEl){
      titleEl.textContent = m === 'spine' ? 'Configurable spine' : m === 'ui' ? 'Live portfolio' : 'Run · live stream';
    }
    if(subEl){
      subEl.textContent = m === 'spine' ? '· HITL anywhere · path to autonomy' : m === 'ui' ? '· 5 projects · 6 active runs' : '· SSE · cost.jsonl · checkpoint/resume';
    }
    if(picker){ picker.style.display = m === 'spine' ? '' : 'none'; }
  };

  // headline switcher
  const H1_OPTIONS = {
    a: { en: 'One place<br>to manage them all. <em>Humans and agents alike.</em>',
         ru: 'Одно место,<br>чтобы управлять всеми. <em>И людьми, и агентами.</em>' },
    b: { en: 'Stop babysitting<br>your coding agents. <em>Run them as a portfolio.</em>',
         ru: 'Хватит нянчить<br>кодящих агентов. <em>Управляйте ими как портфолио.</em>' },
    c: { en: 'Ship Happens.<br><em>Ship it anyway.</em>',
         ru: 'Ship Happens.<br><em>Релизьте всё равно.</em>' }
  };
  window.MaisterSetHeadline = (which) => {
    const h1 = document.querySelector('.hero .h-display');
    if(!h1) return;
    const lang = root.getAttribute('lang') === 'ru' ? 'ru' : 'en';
    const opt = H1_OPTIONS[which] || H1_OPTIONS.a;
    h1.innerHTML = opt[lang];
    h1.setAttribute('data-headline', which);
  };
})();
