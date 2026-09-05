import type { Locale } from "@/lib/locale";

type LinkCopy = {
  label: string;
  ariaLabel: string;
};

type FeatureCopy = {
  number: string;
  title: string;
  body: string;
  meta: string;
};

export type TourShotId = "portfolio" | "board" | "run" | "inbox" | "review";

type LandingContent = {
  meta: {
    title: string;
    description: string;
  };
  nav: {
    why: string;
    product: string;
    workflow: string;
    controls: string;
    packages: string;
    compare: string;
    docs: string;
  };
  controls: {
    skip: string;
    themeLight: string;
    themeDark: string;
    themeLightShort: string;
    themeDarkShort: string;
    language: string;
  };
  hero: {
    eyebrow: string;
    title: string;
    accent: string;
    body: string;
    primary: string;
    secondary: string;
    install: {
      label: string;
      command: string;
      copy: string;
      copied: string;
      hint: string;
      hintLink: string;
      scriptLink: string;
    };
    rail: ReadonlyArray<{ label: string; value: string }>;
  };
  problem: {
    eyebrow: string;
    title: string;
    accent: string;
    body: string;
    items: ReadonlyArray<{
      before: string;
      after: string;
      body: string;
    }>;
  };
  tour: {
    eyebrow: string;
    title: string;
    body: string;
    shots: ReadonlyArray<{
      id: TourShotId;
      label: string;
      title: string;
      body: string;
      alt: string;
    }>;
  };
  workflow: {
    eyebrow: string;
    title: string;
    body: string;
    nodes: ReadonlyArray<{ label: string; detail: string }>;
    note: string;
  };
  controlsSection: {
    eyebrow: string;
    title: string;
    body: string;
    features: ReadonlyArray<FeatureCopy>;
  };
  autonomy: {
    eyebrow: string;
    title: string;
    body: string;
    levels: ReadonlyArray<{ mode: string; artifact: string }>;
    link: string;
  };
  packages: {
    eyebrow: string;
    title: string;
    body: string;
    items: ReadonlyArray<{ id: string; name: string; body: string }>;
    link: LinkCopy;
  };
  compare: {
    eyebrow: string;
    title: string;
    body: string;
    columns: {
      criterion: string;
      kanban: string;
      runners: string;
      maister: string;
    };
    rows: ReadonlyArray<{
      criterion: string;
      kanban: string;
      runners: string;
      maister: string;
    }>;
    note: string;
  };
  repository: {
    eyebrow: string;
    title: string;
    body: string;
    open: LinkCopy;
    connected: string;
    loading: string;
    error: string;
    retry: string;
    stars: string;
    forks: string;
    issues: string;
    license: string;
    branch: string;
    updated: string;
    dogfood: {
      label: string;
      title: string;
      body: string;
    };
    links: {
      discussions: string;
      issues: string;
      contributing: string;
    };
  };
  services: {
    eyebrow: string;
    title: string;
    body: string;
    offers: ReadonlyArray<{ name: string; duration: string; body: string }>;
    cta: LinkCopy;
    note: string;
  };
  faq: {
    eyebrow: string;
    title: string;
    items: ReadonlyArray<{ question: string; answer: string }>;
  };
  final: {
    eyebrow: string;
    title: string;
    body: string;
    primary: string;
    secondary: string;
  };
  footer: {
    motto: string;
    tagline: string;
    taglineAccent: string;
    product: {
      title: string;
      why: string;
      tour: string;
      workflow: string;
      compare: string;
    };
    docs: {
      title: string;
      gettingStarted: string;
      home: string;
      hitl: string;
      costs: string;
    };
    platform: {
      title: string;
      agents: string;
      evidence: string;
      flows: string;
      rah: string;
    };
    project: {
      title: string;
      source: string;
      contributing: string;
      issues: string;
      discussions: string;
      security: string;
      conduct: string;
      license: string;
    };
    contacts: {
      title: string;
      github: string;
      telegram: string;
    };
    copyright: string;
    status: string;
  };
};

const CONTENT = {
  en: {
    meta: {
      title: "MAIster — Governed AI software delivery",
      description:
        "Self-hosted execution and governance for repeatable AI-powered SDLC processes over private code.",
    },
    nav: {
      why: "Why MAIster",
      product: "Product",
      workflow: "How it works",
      controls: "Controls",
      packages: "Packages",
      compare: "Compare",
      docs: "Docs",
    },
    controls: {
      skip: "Skip to content",
      themeLight: "Use light theme",
      themeDark: "Use dark theme",
      themeLightShort: "Light",
      themeDarkShort: "Dark",
      language: "Language",
    },
    hero: {
      eyebrow: "Open source · self-hosted · MIT licensed",
      title: "Turn AI coding from a terminal habit into",
      accent: "a delivery system.",
      body: "MAIster runs versioned software-delivery Flows across your repositories. Agents work in isolated worktrees, humans enter at declared gates, and evidence decides what can ship.",
      primary: "Get started",
      secondary: "Read the docs",
      install: {
        label: "Run it on your own host",
        command: "curl -fsSL https://imaister.dev/quickstart.sh | bash",
        copy: "Copy",
        copied: "Copied",
        hint: "Postgres in Docker, two host processes, first governed run in about ten minutes.",
        hintLink: "Follow the quickstart",
        scriptLink: "Read the script",
      },
      rail: [
        {
          label: "coding agents",
          value: "Claude · Codex · Gemini · OpenCode · MiMo",
        },
        {
          label: "providers",
          value: "Anthropic · OpenAI · OpenRouter · compatible",
        },
        { label: "interfaces", value: "Web · REST · MCP · ACP" },
        { label: "runs on", value: "your host · Postgres · git worktrees" },
      ],
    },
    problem: {
      eyebrow: "The operating gap",
      title: "Coding agents execute.",
      accent: "MAIster makes the work governable.",
      body: "The hard part is no longer producing code. It is keeping parallel agent work repeatable, reviewable, constrained, and connected to the way software actually ships.",
      items: [
        {
          before: "Many terminals",
          after: "One operating picture",
          body: "Portfolio, project boards, active workspaces, and a shared needs-you inbox replace console babysitting.",
        },
        {
          before: "Prompts drift",
          after: "Processes stay pinned",
          body: "Flows ship as trusted, versioned packages. Every run records the exact package, engine, and runner it used.",
        },
        {
          before: "Looks finished",
          after: "Get verified results",
          body: "Typed artifacts and blocking gates expose what passed, failed, went stale, or still needs a decision.",
        },
        {
          before: "Agents get everything",
          after: "Capabilities are scoped",
          body: "Each session receives only its declared skills, MCPs, tools, environment, and restrictions at the ACP seam.",
        },
      ],
    },
    tour: {
      eyebrow: "Product tour",
      title: "One control plane for every project, Run, and decision.",
      body: "MAIster is designed for a technical owner or small engineering team operating multiple private repositories and coding agents on its own infrastructure. Web for people, REST and MCP for personal agents.",
      shots: [
        {
          id: "portfolio",
          label: "Portfolio",
          title: "Every project and active workspace on one screen.",
          body: "Projects, active workspaces, runner readiness, and the needs-you count stay visible without opening a single terminal.",
          alt: "MAIster portfolio: project cards with active workspaces, runner readiness, and the launch button",
        },
        {
          id: "board",
          label: "Board",
          title: "Kanban visibility across the portfolio.",
          body: "Each project board shows which tasks are queued, running, blocked, awaiting review, or done. The same state stays visible across repositories without following every terminal.",
          alt: "MAIster project board with Backlog, Prepare, In production, and On review columns",
        },
        {
          id: "run",
          label: "Run",
          title: "A Flow you can inspect while it runs.",
          body: "The Run page shows the graph, the current node, readiness, tokens, and the branch the work lives on. Every attempt stays in the ledger.",
          alt: "MAIster Run page with the Flow graph, readiness state, and the run inspector",
        },
        {
          id: "inbox",
          label: "Inbox",
          title: "Give each teammate one queue for decisions.",
          body: "When an agent needs a human decision, MAIster opens the request in the inbox and on the Run page: a permission, form, review, or escalation. The answer returns to the originating Run.",
          alt: "MAIster inbox with two human review requests waiting for a decision",
        },
        {
          id: "review",
          label: "Review & promote",
          title: "Artifact review and deliberate landing.",
          body: "Review the diff, reports, plans, and other production artifacts together. Approve the result, return the Run for rework with actionable comments, or promote it to the selected branch through a PR or local merge.",
          alt: "MAIster review workspace with the changed files tree and the diff viewer",
        },
      ],
    },
    workflow: {
      eyebrow: "The delivery spine",
      title: "A process you can inspect from intent to promotion.",
      body: "MAIster is not another coding agent and not a generic workflow canvas. It is the execution layer that gives your existing agents a repeatable path through real software delivery.",
      nodes: [
        { label: "Project", detail: "private repository" },
        { label: "Flow package", detail: "versioned process" },
        { label: "Task / Scratch", detail: "controlled intake" },
        { label: "Run", detail: "immutable attempt" },
        { label: "Workspace", detail: "isolated worktree" },
        { label: "Agents", detail: "ACP sessions" },
        { label: "HITL", detail: "declared decisions" },
        { label: "Evidence", detail: "typed readiness" },
        { label: "Review", detail: "human judgment" },
        { label: "Promote", detail: "PR or local merge" },
      ],
      note: "Every handoff leaves a ledger entry. Every promotion crosses the same readiness choke point.",
    },
    controlsSection: {
      eyebrow: "The product, not just the runner",
      title: "MAIster keeps the system around the agents visible.",
      body: "The deterministic spine stays small: ownership, state, evidence, budgets, and promotion. Around it, MAIster adds shared and private memory, artifact authoring and improvement, comparison, and the operating surfaces required for sustained agent work.",
      features: [
        {
          number: "01",
          title: "Versioned Flow packages",
          body: "Install, inspect, trust, enable, upgrade, roll back, and keep active runs pinned to their original revision.",
          meta: "provenance · compatibility · trust",
        },
        {
          number: "02",
          title: "Evidence-gated readiness",
          body: "A Flow can bring up an isolated application stack and its dependencies, run integration and E2E suites, and keep reports and logs as required evidence. Together with AI judgments, external checks, and human review, that evidence blocks or clears promotion.",
          meta: "system bring-up · E2E · promotion gate",
        },
        {
          number: "03",
          title: "Human attention by design",
          body: "Permissions, forms, plan review, manual takeover, rework, and conflict resolution appear when the Flow says they matter.",
          meta: "HITL · assignments · inbox",
        },
        {
          number: "04",
          title: "Governed multi-agent work",
          body: "Run trees, package agents, triggers, and consensus share budgets and audit instead of creating an invisible swarm.",
          meta: "orchestration · budgets · audit",
        },
        {
          number: "05",
          title: "Scoped runtime capabilities",
          body: "Materialize only the declared skills, MCP servers, tools, environment, and guardrails for each ACP session.",
          meta: "capabilities · sandbox · policy",
        },
        {
          number: "06",
          title: "Compare Flows, agents, and models",
          body: "Run one task with different Flow revisions, coding agents, and models. Compare evidence and AI-judge scores with elapsed time, token usage, and the calculated cost of every Run.",
          meta: "Flow · agent · model · quality · cost",
        },
      ],
    },
    autonomy: {
      eyebrow: "The path to agentization",
      title: "Grow from one co-working session to governed platform agents.",
      body: "MAIster separates agentization into four stages. Each stage has its own durable object, control boundary, and observable handoff. Move right when the previous level becomes repeatable and produces evidence.",
      levels: [
        { mode: "Co-work", artifact: "Scratch Run" },
        { mode: "Human in the loop", artifact: "Flow" },
        { mode: "Adversarial · human on the loop", artifact: "Policy" },
        { mode: "Full Agentic", artifact: "Platform Agent" },
      ],
      link: "Read about the four stages",
    },
    packages: {
      eyebrow: "Flow packages",
      title: "Bring your method as a versioned package.",
      body: "Flows, skills, agents, and MCP templates ship together in trusted packages, installed from git and pinned by tag. The public catalog already carries the methods teams use with coding agents, so a Flow written for one project moves to the next installation unchanged.",
      items: [
        {
          id: "aif",
          name: "AI Factory",
          body: "Plan, implement, review, evolve: five governed flows with their skills and agents.",
        },
        {
          id: "superpowers",
          name: "Superpowers",
          body: "Four typed flows with structured design, verification, and review handoffs.",
        },
        {
          id: "spec-kit",
          name: "Spec Kit",
          body: "Spec-driven development from GitHub as governed flows.",
        },
        {
          id: "openspec",
          name: "OpenSpec",
          body: "Spec-driven flows with typed change and review handoffs.",
        },
        {
          id: "bmad",
          name: "BMAD Method",
          body: "Planning, build, test architecture, and creative flows with platform agents.",
        },
        {
          id: "pstack",
          name: "pstack",
          body: "Evidence-first engineering with typed result profiles and an evaluation method.",
        },
        {
          id: "env-e2e",
          name: "env-e2e",
          body: "An ephemeral docker-compose stack plus Playwright E2E as readiness evidence.",
        },
        {
          id: "core",
          name: "core",
          body: "Triage, Brain Improver, the evaluation judge, and Java, React, and Postgres skill packs.",
        },
      ],
      link: {
        label: "Browse the catalog",
        ariaLabel: "Open the maister-plugins catalog on GitHub",
      },
    },
    compare: {
      eyebrow: "Compare",
      title: "Not another Kanban for agents. Not an unattended runner.",
      body: "Boards give you a worktree per agent and a diff to read. Runners give you unattended runs and a pull request to check. MAIster gives your existing agents a repeatable, evidence-gated path through real delivery.",
      columns: {
        criterion: "",
        kanban: "Kanban orchestrators",
        runners: "Autonomous runners",
        maister: "MAIster",
      },
      rows: [
        {
          criterion: "Process",
          kanban: "A board and a worktree per agent",
          runners: "An issue tracker as the queue",
          maister: "A versioned Flow package pinned to every Run",
        },
        {
          criterion: "Proof before merge",
          kanban: "Read the diff",
          runners: "Check the pull request",
          maister: "Typed evidence gates, readiness, and human review",
        },
        {
          criterion: "Human checkpoints",
          kanban: "Approve when the CLI asks",
          runners: "Watch the PR",
          maister:
            "Declared in the Flow: permission, form, review, escalation, one inbox",
        },
        {
          criterion: "Budgets",
          kanban: "None",
          runners: "Per agent",
          maister: "Per Run, node, and Run tree: warn → escalate → terminate",
        },
        {
          criterion: "Capabilities",
          kanban: "Whatever the CLI has",
          runners: "Whatever the CLI has",
          maister:
            "Only the declared skills, MCPs, tools, and environment per session",
        },
        {
          criterion: "Agents",
          kanban: "Several CLIs side by side",
          runners: "Usually one vendor",
          maister:
            "Claude, Codex, Gemini, OpenCode, MiMo through ACP, including subscriptions",
        },
        {
          criterion: "Compare variants",
          kanban: "By hand",
          runners: "By hand",
          maister:
            "Evaluation Lab: one task, several Flows, agents, and models",
        },
        {
          criterion: "Where it runs",
          kanban: "Your laptop",
          runners: "Their cloud or yours",
          maister: "Your host, MIT",
        },
      ],
      note: "Kanban orchestrators: Vibe Kanban, Superset, Paseo, and similar tools. Autonomous runners: Symphony, Paperclip, and similar. Categories, not verdicts: several of them are good at what they do.",
    },
    repository: {
      eyebrow: "Built in the open",
      title: "Inspect the system, not a sales promise.",
      body: "MAIster is MIT licensed. Follow the implementation, architecture decisions, and delivery history directly in the repository. Feature requests, bug reports, and pull requests are welcome.",
      open: {
        label: "Open on GitHub",
        ariaLabel: "Open the MAIster repository on GitHub",
      },
      connected: "GitHub API connected",
      loading: "Loading live repository data…",
      error: "Live repository data is unavailable right now.",
      retry: "Try again",
      stars: "Stars",
      forks: "Forks",
      issues: "Open issues",
      license: "License",
      branch: "Default branch",
      updated: "Last push",
      dogfood: {
        label: "Built with MAIster",
        title: "MAIster is built in MAIster.",
        body: "The team uses MAIster packages, Flows, agents, evidence, review, and promotion to develop MAIster itself. Product gaps surface in real delivery work.",
      },
      links: {
        discussions: "Discussions",
        issues: "Issues",
        contributing: "Contributing guide",
      },
    },
    services: {
      eyebrow: "Services",
      title: "Need this running in your team?",
      body: "MAIster is free and MIT licensed. If you want it in production without spending your own weeks on it, the maintainer works with teams directly.",
      offers: [
        {
          name: "Agentic SDLC assessment",
          duration: "one week",
          body: "Where your team's agent work loses time and quality, and which process to automate first. You get a written report and two Flow packages for your own process.",
        },
        {
          name: "Implementation sprint",
          duration: "two to four weeks",
          body: "MAIster on your host, connected to your git provider and CI. Flows for bugfix, feature, review, docs, and dependencies; gates, budgets, and roles; a trained team; thirty days of support.",
        },
        {
          name: "Support and evolution",
          duration: "monthly",
          body: "Upgrades, new packages, incident review, and priority in the roadmap.",
        },
      ],
      cta: {
        label: "Book a call",
        ariaLabel: "Contact the maintainer on Telegram",
      },
      note: "Replies within one working day.",
    },
    faq: {
      eyebrow: "Questions",
      title: "Before you install",
      items: [
        {
          question: "Does my code leave my infrastructure?",
          answer:
            "No. Repositories, prompts, diffs, secrets, and artifact bodies stay inside your infrastructure. The control plane and execution host remain under your administration. MAIster ships no analytics and no telemetry; the only outbound traffic goes to the model providers, git remotes, and MCP servers you configure.",
        },
        {
          question: "Which coding agents work?",
          answer:
            "Claude Code, Codex, Gemini CLI, OpenCode, and MiMo run through the Agent Client Protocol. MAIster starts the CLIs with the authentication configured on the execution host, including supported subscription-backed sessions; API providers such as Anthropic, OpenAI, and OpenRouter stay in the same runner catalog.",
        },
        {
          question: "Can I keep the method my team already uses?",
          answer:
            "Yes. Spec Kit, OpenSpec, BMAD, Superpowers, and AI Factory already ship as packages, and any git repository with a flow.yaml can become one. Flow Studio edits packaged Flows visually and forks them into local versions.",
        },
        {
          question: "What does a first run look like?",
          answer:
            "Register a repository, create a task, pick a Flow, launch. The Run gets an isolated worktree, a recorded Flow revision, and an observable outcome. Promotion stays a separate, explicit action.",
        },
        {
          question: "How does it run?",
          answer:
            "The web control plane owns product state. A separate execution-host supervisor owns ACP sessions and agent processes. Postgres keeps the durable ledger; isolated git worktrees hold code and evidence payloads. Today both processes share one trusted host; multi-host placement is on the roadmap.",
        },
        {
          question: "What does it cost?",
          answer:
            "MAIster is MIT licensed; you pay only your model providers. Run Inspector shows input, output, cache-read, and cache-creation tokens beside active and wall-clock time, and budgets warn, escalate, and terminate. Currency pricing is on the roadmap.",
        },
      ],
    },
    final: {
      eyebrow: "Start with one real process",
      title: "Replace one babysat terminal with a Flow you can trust.",
      body: "Run MAIster on your own host, connect a private repository, and qualify the first repeatable delivery process with evidence and review built in.",
      primary: "Read the quickstart",
      secondary: "Explore the repository",
    },
    footer: {
      motto: "Ship happens",
      tagline:
        "The control plane for software delivery by people and AI agents.",
      taglineAccent: "Work, evidence, and decisions in one place.",
      product: {
        title: "Product",
        why: "Why MAIster",
        tour: "Product tour",
        workflow: "Delivery spine",
        compare: "Compare",
      },
      docs: {
        title: "Docs",
        gettingStarted: "Getting started",
        home: "Documentation home",
        hitl: "Human in the loop",
        costs: "Costs and budgets",
      },
      platform: {
        title: "Platform",
        agents: "Project Brain and agents",
        evidence: "Evidence and review",
        flows: "Flow manifest",
        rah: "Recursive agent harness",
      },
      project: {
        title: "Project",
        source: "GitHub",
        contributing: "Contributing",
        issues: "Issues",
        discussions: "Discussions",
        security: "Security",
        conduct: "Code of Conduct",
        license: "License (MIT)",
      },
      contacts: {
        title: "Contact",
        github: "GitHub profile",
        telegram: "Contact on Telegram",
      },
      copyright: "© 2026 MAIster · MIT",
      status: "self-hosted · API-first · private",
    },
  },
  ru: {
    meta: {
      title: "MAIster — управляемая разработка с ИИ",
      description:
        "Устанавливаемый в своей инфраструктуре контур исполнения и контроля воспроизводимой разработки с ИИ над приватным кодом.",
    },
    nav: {
      why: "Зачем MAIster",
      product: "Продукт",
      workflow: "Как работает",
      controls: "Контроль",
      packages: "Пакеты",
      compare: "Сравнение",
      docs: "Документация",
    },
    controls: {
      skip: "Перейти к содержанию",
      themeLight: "Включить светлую тему",
      themeDark: "Включить тёмную тему",
      themeLightShort: "Светлая",
      themeDarkShort: "Тёмная",
      language: "Язык",
    },
    hero: {
      eyebrow: "Открытый код · на своих серверах · лицензия MIT",
      title: "Превратите разработку с ИИ",
      accent: "в управляемую систему доставки.",
      body: "MAIster запускает версионированные процессы разработки над вашими репозиториями. Агенты работают в изолированных Git worktree, человек подключается на заданных контрольных точках, а готовность подтверждается доказательствами.",
      primary: "Начать",
      secondary: "Документация",
      install: {
        label: "Запустите на своём узле",
        command: "curl -fsSL https://imaister.dev/quickstart.sh | bash",
        copy: "Копировать",
        copied: "Скопировано",
        hint: "Postgres в Docker, два процесса на узле, первый управляемый запуск примерно через десять минут.",
        hintLink: "Открыть инструкцию",
        scriptLink: "Посмотреть скрипт",
      },
      rail: [
        { label: "агенты", value: "Claude · Codex · Gemini · OpenCode · MiMo" },
        {
          label: "провайдеры",
          value: "Anthropic · OpenAI · OpenRouter · совместимые",
        },
        { label: "интерфейсы", value: "Web · REST · MCP · ACP" },
        { label: "работает на", value: "вашем узле · Postgres · Git worktree" },
      ],
    },
    problem: {
      eyebrow: "Операционный разрыв",
      title: "Агенты-разработчики выполняют работу.",
      accent: "MAIster делает её управляемой.",
      body: "Одного написанного кода мало. Параллельная работа агентов должна быть воспроизводимой, проверяемой, ограниченной и встроенной в процесс доставки ПО.",
      items: [
        {
          before: "Много терминалов",
          after: "Одна картина работы",
          body: "Портфель проектов, канбан-доски, активные рабочие области и общий раздел «Входящие» заменяют постоянное наблюдение за консолями.",
        },
        {
          before: "Инструкции меняются",
          after: "Процессы закреплены",
          body: "Flow поставляются как доверенные версионированные пакеты. Каждый запуск хранит точную версию пакета, движка и профиля запуска.",
        },
        {
          before: "Похоже, готово",
          after: "Получайте проверенный результат",
          body: "Типизированные артефакты и блокирующие проверки показывают, что прошло, сломалось, устарело или ждёт решения.",
        },
        {
          before: "Агенту доступно всё",
          after: "Возможности ограничены",
          body: "Каждая сессия получает только объявленные навыки, MCP-серверы, инструменты, переменные окружения и ограничения на границе ACP.",
        },
      ],
    },
    tour: {
      eyebrow: "Экскурсия по продукту",
      title: "Один контур управления для всех проектов, запусков и решений.",
      body: "MAIster создан для технического владельца или небольшой команды, которая ведёт несколько приватных репозиториев и агентов-разработчиков в своей инфраструктуре. Веб-интерфейс для людей, REST и MCP для личных агентов.",
      shots: [
        {
          id: "portfolio",
          label: "Портфель",
          title: "Все проекты и активные рабочие области на одном экране.",
          body: "Проекты, активные рабочие области, готовность профилей запуска и счётчик «требуют внимания» видны без единого открытого терминала.",
          alt: "Портфель MAIster: карточки проектов с активными рабочими областями, готовностью профилей запуска и кнопкой запуска",
        },
        {
          id: "board",
          label: "Доска",
          title: "Канбан-доска и наблюдаемость портфеля.",
          body: "Канбан-доска проекта показывает, какие задачи стоят в очереди, выполняются, заблокированы, ждут проверки или завершены. Та же картина собирается по всем репозиториям без обхода терминалов.",
          alt: "Доска проекта MAIster с колонками Бэклог, Подготовка, В производстве и На ревью",
        },
        {
          id: "run",
          label: "Запуск",
          title: "Flow, который можно рассмотреть прямо во время работы.",
          body: "Страница запуска показывает граф, текущий узел, готовность, токены и ветку, в которой идёт работа. Каждая попытка остаётся в реестре.",
          alt: "Страница запуска MAIster с графом Flow, состоянием готовности и инспектором запуска",
        },
        {
          id: "inbox",
          label: "Входящие",
          title: "Одна очередь решений вместо обхода терминалов.",
          body: "Когда агенту нужно решение человека, MAIster открывает запрос во «Входящих» и на странице запуска: разрешение, форму, проверку или уведомление о проблеме. Ответ возвращается в исходный запуск.",
          alt: "Раздел «Входящие» MAIster с двумя запросами на проверку, ожидающими решения",
        },
        {
          id: "review",
          label: "Проверка и доставка",
          title: "Проверка артефактов и доставка результата.",
          body: "Проверяйте вместе изменения, отчёты, планы и другие производственные артефакты. Результат можно принять, вернуть запуск на доработку с конкретными комментариями или отправить в выбранную ветку через PR либо локальное слияние.",
          alt: "Рабочая область проверки MAIster с деревом изменённых файлов и просмотром изменений",
        },
      ],
    },
    workflow: {
      eyebrow: "Контур доставки",
      title: "Процесс виден целиком: от намерения до доставки результата.",
      body: "MAIster проводит уже используемых вами агентов-разработчиков через воспроизводимый процесс: от постановки задачи до проверки и отправки результата.",
      nodes: [
        { label: "Проект", detail: "приватный репозиторий" },
        { label: "Пакет Flow", detail: "версионированный процесс" },
        { label: "Задача / пробный запуск", detail: "контролируемый вход" },
        { label: "Запуск", detail: "неизменяемая попытка" },
        { label: "Рабочая область", detail: "изолированный Git worktree" },
        { label: "Агенты", detail: "ACP-сессии" },
        { label: "Участие человека", detail: "заданные решения" },
        { label: "Доказательства", detail: "проверка готовности" },
        { label: "Проверка", detail: "решение человека" },
        { label: "Доставка", detail: "PR или локальное слияние" },
      ],
      note: "Каждая передача оставляет запись в реестре. Перед доставкой результата MAIster проверяет его готовность.",
    },
    controlsSection: {
      eyebrow: "Весь контур работы агентов",
      title: "MAIster делает видимой всю систему вокруг агентов.",
      body: "Небольшой детерминированный каркас хранит ответственных, состояние, доказательства, бюджеты и правила доставки. К нему MAIster добавляет общую и приватную память, создание и совершенствование артефактов, сравнение и рабочие интерфейсы для постоянной работы агентов.",
      features: [
        {
          number: "01",
          title: "Версионированные пакеты Flow",
          body: "Устанавливайте, проверяйте, доверяйте, включайте, обновляйте и откатывайте пакеты, не меняя уже запущенные процессы.",
          meta: "происхождение · совместимость · доверие",
        },
        {
          number: "02",
          title: "Готовность по доказательствам",
          body: "Прямо внутри Flow можно поднять изолированный контур приложения с зависимостями, прогнать интеграционные и E2E-тесты, а отчёты и журналы сохранить как обязательные доказательства. Вместе с оценками ИИ, внешними проверками и решением человека они блокируют или разрешают доставку результата.",
          meta: "запуск системы · E2E · проверка доставки",
        },
        {
          number: "03",
          title: "Внимание человека по правилам",
          body: "Запросы доступа, формы, проверка плана, ручной перехват, доработка и разрешение конфликтов появляются там, где их объявляет Flow.",
          meta: "участие человека · ответственные · входящие",
        },
        {
          number: "04",
          title: "Управляемая работа нескольких агентов",
          body: "Деревья запусков, агенты из пакетов, условия запуска и согласование работают с общими бюджетами и журналом действий.",
          meta: "оркестрация · бюджеты · аудит",
        },
        {
          number: "05",
          title: "Ограниченные возможности среды",
          body: "Каждая ACP-сессия получает только объявленные навыки, MCP-серверы, инструменты, переменные окружения и ограничения.",
          meta: "возможности · изоляция · правила",
        },
        {
          number: "06",
          title: "Сравнение Flow, агентов и моделей",
          body: "Запускайте одну задачу на разных версиях Flow, кодирующих агентах и моделях. Сопоставляйте доказательства и оценки ИИ-судей со временем, расходом токенов и рассчитанной стоимостью каждого запуска.",
          meta: "Flow · агент · модель · качество · стоимость",
        },
      ],
    },
    autonomy: {
      eyebrow: "Путь агентизации",
      title: "От совместной сессии до управляемых платформенных агентов.",
      body: "MAIster делит агентизацию на четыре уровня. У каждого есть сохраняемый объект, граница контроля и видимая передача работы. Переходите вправо, когда предыдущий уровень стал воспроизводимым и даёт доказательства.",
      levels: [
        { mode: "Совместная работа", artifact: "Пробный запуск" },
        { mode: "Человек в контуре", artifact: "Flow" },
        {
          mode: "Состязательная проверка · человек наблюдает",
          artifact: "Правила",
        },
        { mode: "Полная автономность", artifact: "Платформенный агент" },
      ],
      link: "Подробнее о четырёх уровнях",
    },
    packages: {
      eyebrow: "Пакеты Flow",
      title: "Принесите свою методику как версионированный пакет.",
      body: "Flow, навыки, агенты и шаблоны MCP поставляются вместе в доверенных пакетах: устанавливаются из Git и закрепляются тегом. В открытом каталоге уже есть методики, которые команды используют с агентами-разработчиками, поэтому Flow, написанный для одного проекта, без изменений переезжает в следующую инсталляцию.",
      items: [
        {
          id: "aif",
          name: "AI Factory",
          body: "Планирование, реализация, проверка, развитие: пять управляемых Flow со своими навыками и агентами.",
        },
        {
          id: "superpowers",
          name: "Superpowers",
          body: "Четыре типизированных Flow со структурированным проектированием, проверкой и передачей на ревью.",
        },
        {
          id: "spec-kit",
          name: "Spec Kit",
          body: "Разработка от спецификации от GitHub в виде управляемых Flow.",
        },
        {
          id: "openspec",
          name: "OpenSpec",
          body: "Flow от спецификации с типизированной передачей изменений и проверки.",
        },
        {
          id: "bmad",
          name: "BMAD Method",
          body: "Планирование, сборка, тестовая архитектура и творческие Flow с платформенными агентами.",
        },
        {
          id: "pstack",
          name: "pstack",
          body: "Инженерия от доказательств с типизированными профилями результата и методикой оценки.",
        },
        {
          id: "env-e2e",
          name: "env-e2e",
          body: "Временный контур docker-compose и Playwright E2E как доказательство готовности.",
        },
        {
          id: "core",
          name: "core",
          body: "Триаж, Brain Improver, судья оценок и наборы навыков для Java, React и Postgres.",
        },
      ],
      link: {
        label: "Открыть каталог",
        ariaLabel: "Открыть каталог maister-plugins на GitHub",
      },
    },
    compare: {
      eyebrow: "Сравнение",
      title: "Не ещё одна канбан-доска для агентов. Не автономный исполнитель.",
      body: "Доски дают worktree на агента и изменения для чтения. Автономные исполнители дают запуски без присмотра и PR для проверки. MAIster проводит уже используемых вами агентов по воспроизводимому процессу с проверкой готовности по доказательствам.",
      columns: {
        criterion: "",
        kanban: "Канбан-оркестраторы",
        runners: "Автономные исполнители",
        maister: "MAIster",
      },
      rows: [
        {
          criterion: "Процесс",
          kanban: "Доска и worktree на агента",
          runners: "Трекер задач как очередь",
          maister:
            "Версионированный пакет Flow, закреплённый за каждым запуском",
        },
        {
          criterion: "Доказательства до слияния",
          kanban: "Прочитать изменения",
          runners: "Проверить PR",
          maister: "Типизированные проверки, готовность и решение человека",
        },
        {
          criterion: "Точки участия человека",
          kanban: "Подтвердить, когда спросит CLI",
          runners: "Следить за PR",
          maister:
            "Объявлены во Flow: разрешение, форма, проверка, эскалация, один раздел «Входящие»",
        },
        {
          criterion: "Бюджеты",
          kanban: "Нет",
          runners: "На агента",
          maister:
            "На запуск, узел и дерево запусков: предупредить → позвать человека → остановить",
        },
        {
          criterion: "Возможности",
          kanban: "Всё, что есть у CLI",
          runners: "Всё, что есть у CLI",
          maister:
            "Только объявленные навыки, MCP, инструменты и окружение на сессию",
        },
        {
          criterion: "Агенты",
          kanban: "Несколько CLI рядом",
          runners: "Обычно один вендор",
          maister:
            "Claude, Codex, Gemini, OpenCode, MiMo через ACP, включая подписки",
        },
        {
          criterion: "Сравнение вариантов",
          kanban: "Вручную",
          runners: "Вручную",
          maister:
            "Лаборатория сравнений: одна задача, несколько Flow, агентов и моделей",
        },
        {
          criterion: "Где работает",
          kanban: "На ноутбуке",
          runners: "В их облаке или у вас",
          maister: "На вашем узле, MIT",
        },
      ],
      note: "Канбан-оркестраторы: Vibe Kanban, Superset, Paseo и похожие инструменты. Автономные исполнители: Symphony, Paperclip и похожие. Это категории, а не приговор: многие из них хорошо делают своё дело.",
    },
    repository: {
      eyebrow: "Разрабатывается открыто",
      title: "Проверьте реализацию прямо в репозитории.",
      body: "MAIster распространяется по лицензии MIT. Реализацию, архитектурные решения и историю разработки можно проверить прямо в репозитории. Предлагайте новые возможности, сообщайте об ошибках и присылайте изменения через PR — мы рады участию.",
      open: {
        label: "Открыть GitHub",
        ariaLabel: "Открыть репозиторий MAIster на GitHub",
      },
      connected: "GitHub API подключён",
      loading: "Загружаем данные репозитория…",
      error: "Данные репозитория сейчас недоступны.",
      retry: "Повторить",
      stars: "Звёзды",
      forks: "Форки",
      issues: "Открытые задачи",
      license: "Лицензия",
      branch: "Основная ветка",
      updated: "Последнее обновление",
      dogfood: {
        label: "Собственное использование",
        title: "MAIster дорабатывается в MAIster.",
        body: "Команда использует пакеты, процессы, агентов, доказательства, проверку и выпуск MAIster для развития самого MAIster. Продуктовые пробелы проявляются в реальной работе.",
      },
      links: {
        discussions: "Обсуждения",
        issues: "Задачи",
        contributing: "Как внести вклад",
      },
    },
    services: {
      eyebrow: "Услуги",
      title: "Нужно, чтобы это заработало у вашей команды?",
      body: "MAIster бесплатен и распространяется по лицензии MIT. Если хотите запустить его в работу, не тратя собственные недели, автор работает с командами напрямую.",
      offers: [
        {
          name: "Аудит агентной разработки",
          duration: "одна неделя",
          body: "Где работа команды с агентами теряет время и качество и какой процесс автоматизировать первым. Результат: письменный отчёт и два пакета Flow под ваш процесс.",
        },
        {
          name: "Спринт внедрения",
          duration: "две–четыре недели",
          body: "MAIster на вашем узле, подключённый к вашему Git-провайдеру и CI. Flow для исправлений, фич, ревью, документации и зависимостей; проверки, бюджеты и роли; обученная команда; тридцать дней поддержки.",
        },
        {
          name: "Поддержка и развитие",
          duration: "помесячно",
          body: "Обновления, новые пакеты, разбор инцидентов и приоритет в дорожной карте.",
        },
      ],
      cta: { label: "Обсудить", ariaLabel: "Написать автору в Telegram" },
      note: "Ответ в течение одного рабочего дня.",
    },
    faq: {
      eyebrow: "Вопросы",
      title: "Перед установкой",
      items: [
        {
          question: "Код уходит из моей инфраструктуры?",
          answer:
            "Нет. Репозитории, запросы, изменения, секреты и содержимое артефактов остаются в вашей инфраструктуре. Контур управления и узел исполнения находятся под вашим контролем. В MAIster нет аналитики и телеметрии; наружу уходят только обращения к провайдерам моделей, Git-репозиториям и MCP-серверам, которые вы настроили.",
        },
        {
          question: "Какие агенты-разработчики поддерживаются?",
          answer:
            "Claude Code, Codex, Gemini CLI, OpenCode и MiMo работают через Agent Client Protocol. MAIster запускает консольные агенты с авторизацией узла исполнения, включая поддерживаемые подписочные сессии; API-провайдеры Anthropic, OpenAI и OpenRouter входят в тот же каталог профилей запуска.",
        },
        {
          question: "Можно оставить методику, которую команда уже использует?",
          answer:
            "Да. Spec Kit, OpenSpec, BMAD, Superpowers и AI Factory уже поставляются пакетами, а пакетом может стать любой Git-репозиторий с flow.yaml. Студия Flow редактирует пакетные Flow визуально и ответвляет их в локальные версии.",
        },
        {
          question: "Как выглядит первый запуск?",
          answer:
            "Зарегистрируйте репозиторий, создайте задачу, выберите Flow и запустите. Запуск получает изолированный worktree, зафиксированную версию Flow и наблюдаемый результат. Доставка результата остаётся отдельным явным действием.",
        },
        {
          question: "Как это устроено?",
          answer:
            "Веб-контур управления хранит состояние продукта. Отдельный супервизор узла исполнения управляет ACP-сессиями и процессами агентов. Postgres хранит постоянный реестр, а изолированные Git worktree содержат код и данные доказательств. Сейчас оба процесса работают на одном доверенном узле; работа на нескольких узлах в дорожной карте.",
        },
        {
          question: "Сколько это стоит?",
          answer:
            "MAIster распространяется по лицензии MIT; вы платите только провайдерам моделей. Инспектор запуска показывает входные, выходные и кешированные токены рядом с активным и полным временем работы, а бюджеты предупреждают, зовут человека и останавливают запуск. Денежные тарифы в дорожной карте.",
        },
      ],
    },
    final: {
      eyebrow: "Начните с одного реального процесса",
      title:
        "Замените один терминал под присмотром на Flow, которому можно доверять.",
      body: "Запустите MAIster на своём узле, подключите приватный репозиторий и проверьте первый воспроизводимый процесс со встроенными доказательствами и проверкой человеком.",
      primary: "Открыть инструкцию",
      secondary: "Изучить репозиторий",
    },
    footer: {
      motto: "Ship happens",
      tagline:
        "Контур управления разработкой для команд из людей и ИИ-агентов.",
      taglineAccent: "Работа, доказательства и решения в одном месте.",
      product: {
        title: "Продукт",
        why: "Зачем MAIster",
        tour: "Экскурсия по продукту",
        workflow: "Контур доставки",
        compare: "Сравнение",
      },
      docs: {
        title: "Документация",
        gettingStarted: "Начало работы",
        home: "Главная документации",
        hitl: "Участие человека",
        costs: "Стоимость и бюджеты",
      },
      platform: {
        title: "Платформа",
        agents: "Мозг проекта и агенты",
        evidence: "Доказательства и проверка",
        flows: "Манифест Flow",
        rah: "Рекурсивная оркестрация",
      },
      project: {
        title: "Проект",
        source: "GitHub",
        contributing: "Как внести вклад",
        issues: "Задачи",
        discussions: "Обсуждения",
        security: "Безопасность",
        conduct: "Кодекс поведения",
        license: "Лицензия MIT",
      },
      contacts: {
        title: "Связаться",
        github: "Профиль GitHub",
        telegram: "Написать в Telegram",
      },
      copyright: "© 2026 MAIster · MIT",
      status: "на своих серверах · управление через API · приватно",
    },
  },
} satisfies Record<Locale, LandingContent>;

export function getContent(locale: Locale): LandingContent {
  return CONTENT[locale];
}
