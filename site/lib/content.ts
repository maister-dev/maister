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

type LandingContent = {
  meta: {
    title: string;
    description: string;
  };
  nav: {
    product: string;
    workflow: string;
    agentization: string;
    controls: string;
    architecture: string;
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
    scope: ReadonlyArray<{ label: string; value: string }>;
    graphTitle: string;
    graphLive: string;
    graphLabels: ReadonlyArray<string>;
    terminal: ReadonlyArray<string>;
  };
  positioning: {
    eyebrow: string;
    title: string;
    body: string;
    items: ReadonlyArray<{
      label: string;
      title: string;
      body: string;
    }>;
    dogfood: {
      label: string;
      title: string;
      body: string;
    };
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
  workflow: {
    eyebrow: string;
    title: string;
    body: string;
    nodes: ReadonlyArray<{ label: string; detail: string }>;
    note: string;
  };
  collaboration: {
    eyebrow: string;
    title: string;
    accent: string;
    body: string;
    diagramLabel: string;
    humanLabel: string;
    agentLabel: string;
    modes: ReadonlyArray<{
      from: "human" | "agent";
      to: "human" | "agent";
      direction: "→" | "↔";
      title: string;
      body: string;
      meta: string;
    }>;
  };
  controlsSection: {
    eyebrow: string;
    title: string;
    body: string;
    spotlights: ReadonlyArray<{
      kicker: string;
      title: string;
      body: string;
      status: string;
      points: ReadonlyArray<string>;
    }>;
    features: ReadonlyArray<FeatureCopy>;
  };
  autonomy: {
    eyebrow: string;
    title: string;
    body: string;
    humanLabel: string;
    systemLabel: string;
    levels: ReadonlyArray<{
      mode: string;
      artifact: string;
      title: string;
      body: string;
      human: string;
      system: string;
    }>;
    builtIns: {
      eyebrow: string;
      title: string;
      body: string;
      agents: ReadonlyArray<{
        id: string;
        name: string;
        trigger: string;
        body: string;
      }>;
    };
  };
  architecture: {
    eyebrow: string;
    title: string;
    body: string;
    current: string;
    nodes: {
      operator: string;
      control: string;
      ledger: string;
      host: string;
      hostActive: string;
      hostFuture: string;
      agents: string;
      workspace: string;
    };
    adapters: string;
    ready: string;
    gated: string;
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
      overview: string;
      workflow: string;
      collaboration: string;
      architecture: string;
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
      issues: string;
      discussions: string;
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
      product: "Why MAIster",
      workflow: "Delivery spine",
      agentization: "Agentization",
      controls: "Controls",
      architecture: "Architecture",
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
      eyebrow: "Self-hosted · private code · MIT licensed",
      title: "Turn AI coding from a terminal habit into",
      accent: "a delivery system.",
      body:
        "MAIster runs versioned software-delivery Flows across your repositories. Agents work in isolated worktrees, humans enter at declared gates, and evidence decides what can ship.",
      primary: "Get started",
      secondary: "Read the docs",
      scope: [
        { label: "runtime", value: "ACP" },
        { label: "process", value: "graph Flows" },
        { label: "proof", value: "typed evidence" },
        { label: "control", value: "HITL + review" },
      ],
      graphTitle: "~/private-repos · governed delivery",
      graphLive: "running",
      graphLabels: ["intent", "flow", "work", "evidence", "review", "ship"],
      terminal: [
        "run/TASK-427 · flow feature@1.8.0",
        "↳ isolated workspace · package core@v1.8.0",
        "⚡ implementation claimed by codex",
        "✓ tests · types · evidence current",
        "? human review · approval required",
        "✓ promoted → main@4f2a",
      ],
    },
    positioning: {
      eyebrow: "Product view",
      title: "A private development control plane for solo founders and tiny teams.",
      body:
        "Run parallel feature work across a portfolio of products without spending the day in coding-agent terminals.",
      items: [
        {
          label: "Audience",
          title: "One technical owner or a tiny team",
          body: "Low-ops setup, direct control, and enough governance to delegate more work without adding enterprise process.",
        },
        {
          label: "Portfolio",
          title: "Many features across several products",
          body: "A cross-project portfolio, Kanban boards, task graph, priority queue, isolated workspaces, and one attention inbox keep parallel delivery readable.",
        },
        {
          label: "API-first",
          title: "Web for people. REST and MCP for personal agents.",
          body: "Your assistant can create tasks, launch Runs, inspect readiness, report evidence, and follow results through scoped tokens and the same audit trail.",
        },
        {
          label: "Privacy",
          title: "Install MAIster on your own machines",
          body: "Repositories, prompts, diffs, secrets, and artifact bodies stay inside your infrastructure. The control plane and execution host remain under your administration.",
        },
        {
          label: "ACP + provider access",
          title: "Use agent subscriptions without giving up control",
          body: "MAIster starts Codex, Claude Code, and other coding-agent CLIs through ACP using authentication configured on the execution host, including supported subscription-backed sessions; API providers stay in the same runner catalog. The supervisor keeps the channel two-way: an agent can request permission or a human decision, while MAIster can return the answer, send a corrective prompt, stop the session, or checkpoint it and resume later. Teams get the familiar CLI interaction model inside a governed Flow and shared audit trail, without forcing every run into YOLO mode.",
        },
        {
          label: "Execution fleet",
          title: "One control plane with a path to multiple supervisors",
          body: "The current release uses one trusted execution host. Durable host identity, assignments, epoch fencing, command receipts, and workspace handles now form the base for multi-server placement and transport.",
        },
      ],
      dogfood: {
        label: "Built with MAIster",
        title: "MAIster is built in MAIster.",
        body: "The team uses MAIster packages, Flows, agents, evidence, review, and promotion to develop MAIster itself. Product gaps surface in real delivery work.",
      },
    },
    problem: {
      eyebrow: "The operating gap",
      title: "Coding agents execute.",
      accent: "MAIster makes the work governable.",
      body:
        "The hard part is no longer producing code. It is keeping parallel agent work repeatable, reviewable, constrained, and connected to the way software actually ships.",
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
    workflow: {
      eyebrow: "The delivery spine",
      title: "A process you can inspect from intent to promotion.",
      body:
        "MAIster is not another coding agent and not a generic workflow canvas. It is the execution layer that gives your existing agents a repeatable path through real software delivery.",
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
    collaboration: {
      eyebrow: "Four ways to collaborate",
      title: "Humans, agents,",
      accent: "and every direction between them.",
      body:
        "MAIster gives people and agents one shared delivery surface. Each handoff carries a task, artifact, decision, or typed result, so the team can trace ownership and the next action.",
      diagramLabel: "Four collaboration directions between humans and AI agents",
      humanLabel: "Human",
      agentLabel: "Agent",
      modes: [
        {
          from: "human",
          to: "human",
          direction: "↔",
          title: "Human ↔ Human",
          body:
            "Plan work in one task graph, assign decisions, review diffs, and hand work across products without losing its Run history.",
          meta: "tasks · assignments · review",
        },
        {
          from: "human",
          to: "agent",
          direction: "→",
          title: "Human → Agent",
          body:
            "Start a Scratch Run, launch a versioned Flow, or summon a platform agent. You set intent, access, policy, budget, and the points that require a decision.",
          meta: "scratch · Flow · platform agent",
        },
        {
          from: "agent",
          to: "human",
          direction: "→",
          title: "Agent → Human",
          body:
            "When an agent needs a human decision, MAIster opens the request in the inbox and on the Run page: a permission, form, review, or escalation. The same request can also reach an external channel, such as chat through a personal assistant, and the answer returns to the originating Run.",
          meta: "MAIster UI · optional channels · scoped response",
        },
        {
          from: "agent",
          to: "agent",
          direction: "↔",
          title: "Agent ↔ Agent",
          body:
            "Orchestrators delegate bounded child Runs to agents or Flows, exchange typed results, and send one independently checked implementation into review.",
          meta: "Run tree · RAH · independent judge",
        },
      ],
    },
    controlsSection: {
      eyebrow: "The product, not just the runner",
      title: "MAIster keeps the system around the agents visible.",
      body:
        "The deterministic spine stays small: ownership, state, evidence, budgets, and promotion. Around it, MAIster adds shared and private memory, artifact authoring and improvement, comparison, and the operating surfaces required for sustained agent work.",
      spotlights: [
        {
          kicker: "Project Brain · memory · improvement",
          title: "Carry experience forward and turn repeated signals into reviewed changes.",
          body:
            "Project Brain combines vector-indexed code and analytics with owned sources and accepted lessons. Each attached platform agent can keep separate durable memory. Brain Improver groups recurring evidence and drafts changes to rules, skills, Flows, architecture decisions, roadmaps, or project state for human review.",
          status: "Implemented foundation",
          points: [
            "Shared project memory and private per-agent memory remain separate",
            "Every improvement proposal cites the evidence that produced it",
            "The team reviews changes before MAIster creates a draft or a normal delivery task",
          ],
        },
        {
          kicker: "Engineering control · business interfaces",
          title: "Engineers configure delivery. Business keeps its own front door.",
          body:
            "The engineering team versions Flow packages, policies, and platform agents. Domain-event agents can watch failed or crashed Runs and failed gates, investigate errors, create follow-up work, or call in a person. Scoped REST/MCP, the assistant pulse, and signed webhooks connect that system to a chat, personal assistant, customer portal, or internal bot.",
          status: "Agent substrate · external API · webhooks implemented",
          points: [
            "Flows, policies, and agents ship together in trusted packages",
            "Flow Studio's visual editor and AI assistant create new Flows, fork packaged Flows into editable local versions, attach them to projects, and launch tasks through them",
            "run.failed, run.crashed, and gate.failed can trigger monitoring or recovery agents",
            "REST/MCP surfaces accept commands; activity feeds and signed webhooks publish events",
          ],
        },
        {
          kicker: "Attention inbox · human focus",
          title: "Give each teammate one queue for decisions.",
          body:
            "MAIster collects work that needs a person: permissions, forms, clarification, review, promotion, and escalated failures. Autonomous Flows and agents stay out of the inbox while they remain within policy. Give a personal assistant a user token with project access plus the exact HITL scopes; it can bring an inbox card into chat, take the human answer, close the request in MAIster, and let the same Run resume.",
          status: "Implemented",
          points: [
            "Inbox card → assistant message in chat",
            "Human reply → scoped hitl_respond → Run resumes",
            "Project membership and hitl:inbox:read + hitl:respond:human bound access",
          ],
        },
        {
          kicker: "Task graph · execution queue",
          title: "One intent, explicit dependencies, many comparable Runs.",
          body:
            "A task persists as the unit of intent. Typed relations connect work across the plan, the priority queue admits it as capacity frees, and every implementation attempt remains attached to the same task.",
          status: "Implemented",
          points: [
            "Typed blocks, depends-on, parent, requirement, and duplicate relations",
            "Priority, pause, concurrency, queue position, and safe auto-start",
            "One task → many Runs with preserved lineage, evidence, cost, and outcome",
          ],
        },
        {
          kicker: "Run economics · Observatory",
          title: "See the resource bill for every Run of a task.",
          body:
            "Run Inspector shows input, output, cache-read, and cache-creation tokens beside active and wall-clock time. Runs remain linked to their task, so you can compare attempts and find where the team spends its agent budget.",
          status: "Tokens + time implemented · currency pricing pending",
          points: [
            "Rollups by Run, node attempt, Run tree, runner, and model",
            "Warn → escalate → terminate budget ladder",
            "Portfolio and project views expose throughput, retries, and resource use",
          ],
        },
        {
          kicker: "Flow routing · agents and models",
          title: "Match each stage to the right coding agent and model.",
          body:
            "A Flow assigns a coding agent, runner profile, and model to each stage. Use a faster, lower-cost model for routine tasks and a more capable one for complex planning, implementation, or review. The package preserves the routing, so the team reduces delivery time and resource use without switching CLIs or settings by hand.",
          status: "Implemented",
          points: [
            "Mix coding agents and models across planning, implementation, verification, and judging",
            "Route simple tasks to faster, lower-cost models and complex work to more capable ones",
            "Track the agent, model, runner, time, and token cost for each stage",
            "Flow packages, skills, and platform-agent instructions are portable artifacts you can move between projects and MAIster installations",
          ],
        },
        {
          kicker: "Studio · Evaluation Lab",
          title: "Run one task several ways and compare the result.",
          body:
            "Flow Studio provides visual graph and package-aware authoring. A Study can launch or reuse 2..N Runs of one task, each with a different Flow revision and runner/model recipe. Objective checks and independent AI judges compare quality; token and time rollups put resource use beside each result.",
          status: "Implemented · currency pricing pending",
          points: [
            "Flow A versus Flow B, or one Flow across different runners and models",
            "Versioned N-way, pairwise, and tournament methods",
            "Immutable evidence, AI disagreement, resource use, and a human verdict",
          ],
        },
        {
          kicker: "RAH · recursive orchestration",
          title: "A governed agent harness with a visible Run tree.",
          body:
            "RAH lets an orchestrator decompose work into bounded agent or Flow children, collect typed public results, reduce them, and pass a single implementation to independent verification and human review.",
          status: "Implemented engine · packaged Flow",
          points: [
            "Recursive Run tree with depth, fan-out, active-child, token, and time bounds",
            "Typed run results with schema identity, revisions, and deterministic collection",
            "Read-only researchers → one writer → independent judge → human review",
          ],
        },
        {
          kicker: "PR lifecycle · branch sync",
          title: "MAIster watches pull requests and returns conflicted branches to the work loop.",
          body:
            "The scheduler checks the provider for pull request state and conflict changes. MAIster handles a clean branch sync with git alone. A conflict starts a fresh ACP resolver session; after it finishes, MAIster verifies the tree and returns the Run to review before pushing or landing the result.",
          status: "Scheduler + AI resolver implemented",
          points: [
            "The scheduler records open, merged, closed, and conflicted pull request states",
            "A clean rebase or merge completes without spending an agent session",
            "A conflict starts a fresh resolver session, then a verification gate checks the result",
          ],
        },
        {
          kicker: "Execution hosts",
          title: "One control plane, with a deliberate path to many supervisors.",
          body:
            "Today MAIster runs one trusted local execution host. That host already has durable identity, epoch-fenced assignments, idempotent command receipts, and opaque workspace handles—the boundary needed before multiple supervisor hosts are safe.",
          status: "Stage A now · multi-host next",
          points: [
            "Current: one local supervisor and shared storage",
            "Ready foundation: addressed hosts, assignment history, fencing",
            "Next: placement, remote transport, and cross-host recovery",
          ],
        },
      ],
      features: [
        {
          number: "01",
          title: "Versioned Flow packages",
          body: "Install, inspect, trust, enable, upgrade, roll back, and keep active runs pinned to their original revision.",
          meta: "provenance · compatibility · trust",
        },
        {
          number: "02",
          title: "Graph execution",
          body: "Typed nodes, named transitions, bounded rework, dynamic decisions, orchestration, and consensus without hiding the run ledger.",
          meta: "engine 3 · append-only attempts",
        },
        {
          number: "03",
          title: "Evidence-gated readiness",
          body: "A Flow can bring up an isolated application stack and its dependencies, run integration and E2E suites, and keep reports and logs as required evidence. Together with AI judgments, external checks, and human review, that evidence blocks or clears promotion.",
          meta: "system bring-up · E2E · promotion gate",
        },
        {
          number: "04",
          title: "Human attention by design",
          body: "Permissions, forms, plan review, manual takeover, rework, and conflict resolution appear when the Flow says they matter.",
          meta: "HITL · assignments · inbox",
        },
        {
          number: "05",
          title: "Governed multi-agent work",
          body: "Run trees, package agents, triggers, and consensus share budgets and audit instead of creating an invisible swarm.",
          meta: "orchestration · budgets · audit",
        },
        {
          number: "06",
          title: "Artifact review and deliberate landing",
          body: "Review the diff, reports, plans, and other production artifacts together. Approve the result, return the Run for rework with actionable comments, or promote it to the selected branch through a PR or local merge.",
          meta: "artifact review · rework · promote",
        },
        {
          number: "07",
          title: "Kanban visibility across the portfolio",
          body: "Each project board shows which tasks are queued, running, blocked, awaiting review, or done. The portfolio and attention inbox keep the same state visible across repositories without following every terminal.",
          meta: "Kanban · queue · needs you",
        },
        {
          number: "08",
          title: "Scoped runtime capabilities",
          body: "Materialize only the declared skills, MCP servers, tools, environment, and guardrails for each ACP session.",
          meta: "capabilities · sandbox · policy",
        },
        {
          number: "09",
          title: "Compare Flows, agents, and models",
          body: "Run one task with different Flow revisions, coding agents, and models. Compare evidence and AI-judge scores with elapsed time, token usage, and the calculated cost of every Run.",
          meta: "Flow · agent · model · quality · cost",
        },
      ],
    },
    autonomy: {
      eyebrow: "The path to agentization",
      title: "Grow from one co-working session to governed platform agents.",
      body:
        "MAIster separates agentization into four stages. Each stage has its own durable object, control boundary, and observable handoff. Move right when the previous level becomes repeatable and produces evidence.",
      humanLabel: "Human",
      systemLabel: "MAIster",
      levels: [
        {
          mode: "Co-work",
          artifact: "Scratch Run",
          title: "Work beside the agent in one isolated workspace.",
          body: "A conversational coding session for an intent that is still being discovered. No task or reusable process is required yet.",
          human: "Frames the problem, steers the session, and decides what to keep.",
          system: "Pins runtime capabilities and records messages, files, cost, and workspace state.",
        },
        {
          mode: "Human in the loop",
          artifact: "Flow",
          title: "Turn repeatable work into an inspectable delivery graph.",
          body: "A versioned Flow declares agents, checks, rework, evidence, review, and the exact points where a person must decide.",
          human: "Approves permissions, answers forms, reviews plans or diffs, and resolves exceptions.",
          system: "Executes the graph, keeps the attempt ledger, and blocks promotion on unmet gates.",
        },
        {
          mode: "Adversarial · human on the loop",
          artifact: "Policy",
          title: "Let the system challenge itself while people supervise outcomes.",
          body: "Strict checks, judge and consensus nodes, bounded rework, budgets, and escalation rules move attention from every step to the exceptions.",
          human: "Sets risk boundaries, watches evidence and alerts, and intervenes when policy escalates.",
          system: "Applies a snapshotted execution policy for permissions, retries, gates, budgets, and promotion.",
        },
        {
          mode: "Full Agentic",
          artifact: "Platform Agent",
          title: "Give recurring work a durable, governed owner.",
          body: "A package-defined platform agent has identity, Project Brain access, private memory, project grants, triggers, a runner policy, and a budget.",
          human: "Defines the mandate, grants, policy, budget, and review expectations.",
          system: "Launches the agent manually, on schedule, by webhook, domain event, or mention—and keeps every Run visible.",
        },
      ],
      builtIns: {
        eyebrow: "Built into MAIster Core",
        title: "Start with useful platform agents, then ship your own in packages.",
        body:
          "The built-in core package demonstrates the same governed agent contract available to every trusted package: explicit identity, triggers, capabilities, policy, project attachment, and an auditable Run.",
        agents: [
          {
            id: "core:triager",
            name: "Triager",
            trigger: "task events · manual",
            body: "Routes incoming tasks: Flow, runner, branch, priority, duplicates, dependencies, clarification, and enqueue intent.",
          },
          {
            id: "core:improver",
            name: "Brain Improver",
            trigger: "schedule · manual",
            body: "Finds recurring Project Brain evidence clusters and drafts small, reviewable improvement proposals.",
          },
          {
            id: "core:experiment-judge",
            name: "Evaluation Judge",
            trigger: "Evaluation Lab",
            body: "Scores blinded Run candidates against a versioned rubric; advisory only, with the final verdict left to a person.",
          },
        ],
      },
    },
    architecture: {
      eyebrow: "Self-hosted boundary",
      title: "Your source stays where the work runs—from one host to a future fleet.",
      body:
        "The web control plane owns product state. A separate execution-host supervisor owns ACP sessions and agent processes. Postgres keeps the durable ledger; isolated git worktrees hold code and evidence payloads.",
      current:
        "Current: one trusted local supervisor with shared storage. Already implemented: durable host identity, addressable assignments, epochs, fencing, command receipts, and opaque workspace handles. Next: multiple simultaneous supervisor hosts, placement, remote transport, and cross-host recovery.",
      nodes: {
        operator: "Operator",
        control: "Web control plane",
        ledger: "Postgres ledger",
        host: "Execution-host supervisor",
        hostActive: "host 01 · active local",
        hostFuture: "host 02+ · multi-host stage",
        agents: "ACP agent adapters",
        workspace: "Isolated worktrees + evidence",
      },
      adapters: "One governed runtime catalog",
      ready: "Claude · Codex · Gemini · OpenCode · MiMo",
      gated: "Anthropic · OpenAI · OpenRouter · compatible providers",
    },
    repository: {
      eyebrow: "Built in the open",
      title: "Inspect the system, not a sales promise.",
      body:
        "MAIster is MIT licensed. Follow the implementation, architecture decisions, and delivery history directly in the repository. Feature requests, bug reports, and pull requests are welcome.",
      open: { label: "Open on GitHub", ariaLabel: "Open the MAIster repository on GitHub" },
      connected: "GitHub API connected",
      loading: "Loading live repository data…",
      error: "GitHub data is temporarily unavailable.",
      retry: "Try again",
      stars: "Stars",
      forks: "Forks",
      issues: "Open issues",
      license: "License",
      branch: "Default branch",
      updated: "Last push",
    },
    final: {
      eyebrow: "Start with one real process",
      title: "Replace one babysat terminal with a Flow you can trust.",
      body:
        "Run MAIster on your own host, connect a private repository, and qualify the first repeatable delivery process with evidence and review built in.",
      primary: "Read the quickstart",
      secondary: "Explore the repository",
    },
    footer: {
      motto: "Ship happens",
      tagline: "The control plane for software delivery by people and AI agents.",
      taglineAccent: "Work, evidence, and decisions in one place.",
      product: {
        title: "Product",
        overview: "Product view",
        workflow: "Delivery spine",
        collaboration: "Collaboration",
        architecture: "Architecture",
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
        issues: "Issues",
        discussions: "Discussions",
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
      product: "Зачем MAIster",
      workflow: "Контур доставки",
      agentization: "Агентизация",
      controls: "Контроль",
      architecture: "Архитектура",
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
      eyebrow: "На своих серверах · приватный код · лицензия MIT",
      title: "Превратите разработку с ИИ",
      accent: "в управляемую систему доставки.",
      body:
        "MAIster запускает версионированные процессы разработки над вашими репозиториями. Агенты работают в изолированных Git worktree, человек подключается на заданных контрольных точках, а готовность подтверждается доказательствами.",
      primary: "Начать",
      secondary: "Документация",
      scope: [
        { label: "среда", value: "ACP" },
        { label: "процесс", value: "графы Flow" },
        { label: "доказательства", value: "типизированные" },
        { label: "контроль", value: "решения человека" },
      ],
      graphTitle: "~/private-repos · управляемая доставка",
      graphLive: "в работе",
      graphLabels: ["идея", "Flow", "работа", "проверка", "решение", "готово"],
      terminal: [
        "запуск/TASK-427 · Flow feature@1.8.0",
        "↳ изолированная рабочая область · пакет core@v1.8.0",
        "⚡ реализацию взял codex",
        "✓ тесты · типы · доказательства актуальны",
        "? проверка человеком · требуется решение",
        "✓ отправлено → main@4f2a",
      ],
    },
    positioning: {
      eyebrow: "Позиционирование",
      title: "Приватный контур управления разработкой для независимых основателей и небольших команд.",
      body:
        "Ведите параллельную разработку множества функций в нескольких продуктах без постоянного наблюдения за терминалами агентов-разработчиков.",
      items: [
        {
          label: "Для кого",
          title: "Один технический владелец или маленькая команда",
          body: "Небольшая стоимость эксплуатации, прямой контроль и понятные правила делегирования без корпоративной бюрократии.",
        },
        {
          label: "Портфель",
          title: "Много функций в нескольких продуктах",
          body: "Портфель проектов, канбан-доски, граф задач, приоритетная очередь, изолированные рабочие области и единый раздел «Входящие» собирают параллельную разработку в одну картину.",
        },
        {
          label: "Управление через API",
          title: "Веб-интерфейс для людей. REST и MCP для личных агентов.",
          body: "Ваш помощник может создавать задачи, запускать процессы, проверять готовность, отправлять доказательства и следить за результатом через токены с ограниченными правами и общий журнал действий.",
        },
        {
          label: "Приватность",
          title: "Установите MAIster на свои машины",
          body: "Репозитории, запросы, изменения, секреты и содержимое артефактов остаются в вашей инфраструктуре. Контур управления и узел исполнения находятся под вашим контролем.",
        },
        {
          label: "ACP И АВТОРИЗАЦИЯ",
          title: "Используйте подписки на агентов и сохраняйте управление",
          body: "MAIster запускает Codex, Claude Code и другие консольные агенты через ACP, используя авторизацию узла исполнения, включая поддерживаемые подписочные сессии; API-провайдеры входят в тот же каталог профилей запуска. Супервизор держит двусторонний канал: агент запрашивает разрешение или решение человека, а MAIster возвращает ответ, отправляет корректирующий запрос, останавливает либо приостанавливает сессию с последующим продолжением. Команда получает привычную интерактивность консольных приложений внутри управляемого Flow и общего журнала, без обязательного YOLO-режима.",
        },
        {
          label: "Узлы исполнения",
          title: "Один контур управления с путём к нескольким супервизорам",
          body: "Текущая версия использует один доверенный узел исполнения. Постоянный идентификатор узла, защищённые назначения, квитанции команд и дескрипторы рабочих областей создают основу для распределения работы между серверами.",
        },
      ],
      dogfood: {
        label: "Собственное использование",
        title: "MAIster дорабатывается в MAIster.",
        body: "Команда использует пакеты, процессы, агентов, доказательства, проверку и выпуск MAIster для развития самого MAIster. Продуктовые пробелы проявляются в реальной работе.",
      },
    },
    problem: {
      eyebrow: "Операционный разрыв",
      title: "Агенты-разработчики выполняют работу.",
      accent: "MAIster делает её управляемой.",
      body:
        "Одного написанного кода мало. Параллельная работа агентов должна быть воспроизводимой, проверяемой, ограниченной и встроенной в процесс доставки ПО.",
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
    workflow: {
      eyebrow: "Контур доставки",
      title: "Процесс виден целиком: от намерения до доставки результата.",
      body:
        "MAIster проводит уже используемых вами агентов-разработчиков через воспроизводимый процесс: от постановки задачи до проверки и отправки результата.",
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
    collaboration: {
      eyebrow: "Четыре направления совместной работы",
      title: "Люди, ИИ-агенты",
      accent: "и совместная работа во всех направлениях.",
      body:
        "MAIster даёт людям и агентам общий контур поставки. Каждая передача сохраняет задачу, артефакт, решение или типизированный результат, поэтому команда видит ответственного и следующий шаг.",
      diagramLabel: "Четыре направления совместной работы людей и ИИ-агентов",
      humanLabel: "Человек",
      agentLabel: "Агент",
      modes: [
        {
          from: "human",
          to: "human",
          direction: "↔",
          title: "Человек ↔ Человек",
          body:
            "Команда планирует работу в одном графе задач, назначает ответственных, проверяет изменения и передаёт работу между продуктами без потери истории запусков.",
          meta: "задачи · ответственные · проверка",
        },
        {
          from: "human",
          to: "agent",
          direction: "→",
          title: "Человек → Агент",
          body:
            "Запустите пробную сессию, выберите версионированный Flow или запустите платформенного агента. Человек задаёт цель, доступ, правила, бюджет и точки принятия решений.",
          meta: "пробный запуск · Flow · платформенный агент",
        },
        {
          from: "agent",
          to: "human",
          direction: "→",
          title: "Агент → Человек",
          body:
            "Когда агенту нужно решение человека, MAIster открывает запрос во «Входящих» и на странице запуска: разрешение, форму, проверку или уведомление о проблеме. Тот же запрос можно вывести во внешний канал, например в чат через личного помощника; ответ вернётся в исходный запуск.",
          meta: "интерфейс MAIster · внешние каналы · ответ с ограниченными правами",
        },
        {
          from: "agent",
          to: "agent",
          direction: "↔",
          title: "Агент ↔ Агент",
          body:
            "Управляющий агент поручает ограниченные дочерние запуски агентам или процессам Flow, собирает типизированные результаты и передаёт одну реализацию на независимую проверку.",
          meta: "дерево запусков · RAH · независимый судья",
        },
      ],
    },
    controlsSection: {
      eyebrow: "Весь контур работы агентов",
      title: "MAIster делает видимой всю систему вокруг агентов.",
      body:
        "Небольшой детерминированный каркас хранит ответственных, состояние, доказательства, бюджеты и правила доставки. К нему MAIster добавляет общую и приватную память, создание и совершенствование артефактов, сравнение и рабочие интерфейсы для постоянной работы агентов.",
      spotlights: [
        {
          kicker: "Мозг проекта · память · улучшения",
          title: "Сохраняйте опыт и превращайте повторяющиеся сигналы в проверяемые изменения.",
          body:
            "Мозг проекта объединяет векторный индекс кода и аналитики с проверенными источниками и принятыми уроками. Каждый подключённый платформенный агент может вести отдельную долговременную память. Brain Improver группирует повторяющиеся доказательства и готовит для человека изменения правил, навыков, Flow, архитектурных решений, дорожной карты или состояния проекта.",
          status: "Базовый контур реализован",
          points: [
            "Общая память проекта отделена от приватной памяти каждого агента",
            "Каждое предложение ссылается на доказательства, из которых оно получено",
            "Команда проверяет изменения до создания черновика или обычной задачи на доработку",
          ],
        },
        {
          kicker: "Инженерный контур · бизнес-интерфейсы",
          title: "Инженеры настраивают поставку. Бизнес работает в привычном интерфейсе.",
          body:
            "Инженерная команда версионирует пакеты Flow, правила и платформенных агентов. Агенты следят за сбоями и непройденными проверками, разбирают ошибки, создают задачи на продолжение или зовут человека. REST/MCP с ограниченными правами и подписанные вебхуки подключают к этому контуру чат, личного помощника, портал заказчика или внутреннего бота.",
          status: "Среда агентов · внешний API · вебхуки реализованы",
          points: [
            "Процессы Flow, правила и агенты поставляются вместе в доверенных пакетах",
            "Визуальный редактор и ИИ-помощник в Студии создают Flow, ответвляют пакетные Flow в изменяемые локальные версии, подключают их к проектам и запускают по ним задачи",
            "События run.failed, run.crashed и gate.failed запускают агентов наблюдения или восстановления",
            "REST/MCP принимает команды, а ленты активности и подписанные вебхуки публикуют события",
          ],
        },
        {
          kicker: "Входящие · фокус человека",
          title: "Одна очередь решений вместо обхода терминалов.",
          body:
            "MAIster собирает во «Входящих» работу, где нужен человек: запросы доступа, формы, уточнения, проверку, доставку результата и сбои по правилам эскалации. Автономные процессы Flow и агенты не требуют внимания, пока соблюдают заданные правила. Личный помощник с ограниченными правами может принести карточку в чат, принять ответ человека и закрыть запрос в MAIster. Тот же запуск продолжит работу.",
          status: "Реализовано",
          points: [
            "Карточка во «Входящих» → сообщение помощника в чате",
            "Ответ человека → запрос закрыт → запуск продолжается",
            "Доступ к проекту и отдельные права на чтение и ответ ограничивают полномочия помощника",
          ],
        },
        {
          kicker: "Граф задач · очередь исполнения",
          title: "Одна задача, явные зависимости и несколько сравнимых запусков.",
          body:
            "Задача хранит исходную цель и всю историю исполнения. Типизированные связи соединяют работу в плане, приоритетная очередь запускает её по мере освобождения ресурсов, а каждая попытка реализации остаётся привязана к исходной задаче.",
          status: "Реализовано",
          points: [
            "Связи: блокирует, зависит от, родительская, требование и дубликат",
            "Приоритет, пауза, ограничение параллельности, позиция в очереди и безопасный автозапуск",
            "Одна задача → много запусков с общей историей, доказательствами, стоимостью и результатом",
          ],
        },
        {
          kicker: "Экономика запусков · обзор",
          title: "Посмотрите, сколько ресурсов стоил каждый запуск задачи.",
          body:
            "Инспектор запуска показывает входные, выходные и кешированные токены рядом с активным и полным временем работы. Запуски остаются привязаны к исходной задаче, поэтому попытки можно сравнить и увидеть, на что команда расходует агентный бюджет.",
          status: "Токены + время реализованы · денежные тарифы позже",
          points: [
            "Сводки по запуску, попытке узла, дереву запусков, профилю запуска и модели",
            "Порог бюджета: предупредить → позвать человека → остановить",
            "Портфель и проект показывают пропускную способность, повторные попытки и расход ресурсов",
          ],
        },
        {
          kicker: "Маршрутизация Flow · агенты и модели",
          title: "Подбирайте кодирующего агента и модель под каждый этап.",
          body:
            "Flow назначает каждому этапу кодирующего агента, профиль запуска и модель. Для типовых задач подойдут быстрые и недорогие модели, для сложного планирования, разработки или проверки можно выбрать более мощные. Команда закрепляет маршрутизацию в пакете и сокращает время и расход ресурсов без ручного переключения CLI и настроек.",
          status: "Реализовано",
          points: [
            "Разные кодирующие агенты и модели для планирования, разработки, проверки и оценки",
            "Быстрые и недорогие модели для простых задач, более мощные для сложных",
            "Агент, модель, профиль запуска, время и расход токенов видны по каждому этапу",
            "Flow-пакеты — такие же переносимые артефакты, как навыки и инструкции платформенных агентов: переносите их между проектами и инсталляциями MAIster",
          ],
        },
        {
          kicker: "Студия Flow · лаборатория сравнений",
          title: "Прогоните одну задачу несколькими способами и сравните результат.",
          body:
            "Студия Flow даёт визуальный редактор графа с учётом структуры пакета. Исследование запускает или подключает от двух запусков одной задачи с разными версиями Flow, профилями запуска и моделями. Объективные проверки и независимые ИИ-судьи сравнивают качество, а сводка токенов и времени показывает расход ресурсов рядом с результатом.",
          status: "Реализовано · денежные тарифы позже",
          points: [
            "Flow A против Flow B или один Flow на разных профилях запуска и моделях",
            "Версионированные сравнения всех со всеми, попарные и турнирные методики",
            "Неизменяемые доказательства, расхождение оценок ИИ, расход ресурсов и решение человека",
          ],
        },
        {
          kicker: "RAH · рекурсивная оркестрация",
          title: "Управляемая оркестрация с видимым деревом запусков.",
          body:
            "RAH позволяет управляющему агенту делить работу на ограниченные дочерние запуски агентов или процессов Flow, собирать их типизированные публичные результаты и передавать одну реализацию независимому судье и человеку.",
          status: "Движок реализован · Flow поставляется пакетом",
          points: [
            "Рекурсивное дерево запусков с пределами глубины, ветвления, активных потомков, токенов и времени",
            "Типизированные результаты запусков с версией схемы и воспроизводимым сбором",
            "Исследователи без права записи → один разработчик → независимый судья → проверка человеком",
          ],
        },
        {
          kicker: "Жизненный цикл PR · синхронизация веток",
          title: "MAIster следит за PR и возвращает конфликтные ветки в работу.",
          body:
            "Планировщик проверяет у провайдера состояние PR и наличие конфликтов. Чистую ветку MAIster синхронизирует средствами Git. При конфликте он запускает новую ACP-сессию ИИ-разрешателя, проверяет итоговое дерево и возвращает запуск на проверку до отправки результата.",
          status: "Планировщик и ИИ-разрешатель реализованы",
          points: [
            "Планировщик фиксирует открытие, слияние, закрытие и конфликты PR",
            "Чистое перебазирование или слияние проходит без отдельной сессии агента",
            "Конфликт запускает новую сессию разрешателя, после неё MAIster проверяет результат",
          ],
        },
        {
          kicker: "Узлы исполнения",
          title: "Один контур управления и путь к нескольким супервизорам.",
          body:
            "Сейчас MAIster работает с одним доверенным локальным узлом исполнения. У него есть постоянный идентификатор, назначения с защитой от устаревших команд, безопасные повторные команды и непрозрачные идентификаторы рабочих областей. Эти механизмы нужны для работы на нескольких узлах.",
          status: "Этап A готов · несколько узлов дальше",
          points: [
            "Сейчас: один локальный супервизор и общее хранилище",
            "Готовая основа: адресуемые узлы, история назначений и защита от устаревших команд",
            "Дальше: распределение работы, удалённый транспорт и восстановление на другом узле",
          ],
        },
      ],
      features: [
        {
          number: "01",
          title: "Версионированные пакеты Flow",
          body: "Устанавливайте, проверяйте, доверяйте, включайте, обновляйте и откатывайте пакеты, не меняя уже запущенные процессы.",
          meta: "происхождение · совместимость · доверие",
        },
        {
          number: "02",
          title: "Исполнение графа",
          body: "Типизированные узлы, именованные переходы, ограниченные циклы доработки, динамические решения, оркестрация и согласование с видимым реестром.",
          meta: "движок 3 · журнал попыток",
        },
        {
          number: "03",
          title: "Готовность по доказательствам",
          body: "Прямо внутри Flow можно поднять изолированный контур приложения с зависимостями, прогнать интеграционные и E2E-тесты, а отчёты и журналы сохранить как обязательные доказательства. Вместе с оценками ИИ, внешними проверками и решением человека они блокируют или разрешают доставку результата.",
          meta: "запуск системы · E2E · проверка доставки",
        },
        {
          number: "04",
          title: "Внимание человека по правилам",
          body: "Запросы доступа, формы, проверка плана, ручной перехват, доработка и разрешение конфликтов появляются там, где их объявляет Flow.",
          meta: "участие человека · ответственные · входящие",
        },
        {
          number: "05",
          title: "Управляемая работа нескольких агентов",
          body: "Деревья запусков, агенты из пакетов, условия запуска и согласование работают с общими бюджетами и журналом действий.",
          meta: "оркестрация · бюджеты · аудит",
        },
        {
          number: "06",
          title: "Проверка артефактов и доставка",
          body: "Проверяйте вместе изменения, отчёты, планы и другие производственные артефакты. Результат можно принять, вернуть запуск на доработку с конкретными комментариями или отправить в выбранную ветку через PR либо локальное слияние.",
          meta: "проверка артефактов · доработка · доставка",
        },
        {
          number: "07",
          title: "Канбан-доска и наблюдаемость портфеля",
          body: "Канбан-доска проекта показывает, какие задачи стоят в очереди, выполняются, заблокированы, ждут проверки или завершены. Портфель и раздел «Входящие» собирают ту же картину по всем репозиториям без обхода терминалов.",
          meta: "канбан · очередь · требуется внимание",
        },
        {
          number: "08",
          title: "Ограниченные возможности среды",
          body: "Каждая ACP-сессия получает только объявленные навыки, MCP-серверы, инструменты, переменные окружения и ограничения.",
          meta: "возможности · изоляция · правила",
        },
        {
          number: "09",
          title: "Сравнение Flow, агентов и моделей",
          body: "Запускайте одну задачу на разных версиях Flow, кодирующих агентах и моделях. Сопоставляйте доказательства и оценки ИИ-судей со временем, расходом токенов и рассчитанной стоимостью каждого запуска.",
          meta: "Flow · агент · модель · качество · стоимость",
        },
      ],
    },
    autonomy: {
      eyebrow: "Путь агентизации",
      title: "От совместной сессии до управляемых платформенных агентов.",
      body:
        "MAIster делит агентизацию на четыре уровня. У каждого есть сохраняемый объект, граница контроля и видимая передача работы. Переходите вправо, когда предыдущий уровень стал воспроизводимым и даёт доказательства.",
      humanLabel: "Человек",
      systemLabel: "MAIster",
      levels: [
        {
          mode: "Совместная работа",
          artifact: "Пробный запуск",
          title: "Работайте рядом с агентом в одной изолированной рабочей области.",
          body: "Диалоговая сессия с агентом-разработчиком подходит для задачи, которую вы ещё исследуете. Формальная задача и повторяемый процесс пока не нужны.",
          human: "Формулирует проблему, направляет сессию и решает, что сохранить.",
          system: "Закрепляет возможности среды и записывает сообщения, файлы, стоимость и состояние рабочей области.",
        },
        {
          mode: "Человек в контуре",
          artifact: "Flow",
          title: "Превратите повторяемую работу в проверяемый граф доставки.",
          body: "Версионированный Flow объявляет агентов, проверки, доработку, доказательства и конкретные точки решения человека.",
          human: "Подтверждает доступ, отвечает на формы, проверяет планы или изменения и разрешает исключения.",
          system: "Исполняет граф, ведёт реестр попыток и блокирует доставку при непройденных проверках.",
        },
        {
          mode: "Состязательная проверка · человек наблюдает",
          artifact: "Правила",
          title: "Пусть система оспаривает себя, пока человек контролирует результат.",
          body: "Строгие проверки, узлы ИИ-судей и согласования, ограниченная доработка, бюджеты и правила эскалации переводят внимание с каждого шага на исключения.",
          human: "Задаёт границы риска, наблюдает доказательства и предупреждения, вмешивается при эскалации.",
          system: "Применяет зафиксированные правила исполнения для доступа, повторных попыток, проверок, бюджетов и доставки.",
        },
        {
          mode: "Полная автономность",
          artifact: "Платформенный агент",
          title: "Передайте повторяемую работу постоянному управляемому владельцу.",
          body: "Платформенный агент из пакета имеет собственный идентификатор, доступ к мозгу проекта, приватную память, права в проектах, условия запуска, профиль исполнения и бюджет.",
          human: "Определяет мандат, доступы, правила, бюджет и требования к проверке.",
          system: "Запускает агента вручную, по расписанию, вебхуку, событию проекта или упоминанию. Каждый запуск остаётся видимым.",
        },
      ],
      builtIns: {
        eyebrow: "Встроено в ядро MAIster",
        title: "Начните с готовых платформенных агентов и поставляйте собственных в пакетах.",
        body:
          "Встроенный пакет использует тот же управляемый контракт, который доступен любому доверенному пакету: собственный идентификатор, условия запуска, возможности, правила, доступ к проектам и полный журнал каждого запуска.",
        agents: [
          {
            id: "core:triager",
            name: "Triager",
            trigger: "события задач · вручную",
            body: "Маршрутизирует входящие задачи: выбирает Flow, профиль запуска, ветку и приоритет, находит дубликаты и зависимости, запрашивает уточнение и ставит работу в очередь.",
          },
          {
            id: "core:improver",
            name: "Brain Improver",
            trigger: "по расписанию · вручную",
            body: "Находит повторяющиеся группы доказательств в мозге проекта и готовит небольшие предложения для проверки человеком.",
          },
          {
            id: "core:experiment-judge",
            name: "Evaluation Judge",
            trigger: "лаборатория сравнений",
            body: "Оценивает скрытые варианты запусков по версионированной методике. Агент даёт рекомендацию, а итоговое решение принимает человек.",
          },
        ],
      },
    },
    architecture: {
      eyebrow: "Граница самостоятельного размещения",
      title: "Код остаётся на узлах, где агенты выполняют работу.",
      body:
        "Веб-контур управления хранит состояние продукта. Отдельный супервизор узла исполнения управляет ACP-сессиями и процессами агентов. Postgres хранит постоянный реестр, а изолированные Git worktree содержат код и данные доказательств.",
      current:
        "Сейчас MAIster работает с одним доверенным локальным супервизором и общим хранилищем. Уже реализованы постоянные идентификаторы узлов, адресуемые назначения, эпохи владения, защита от устаревших команд, безопасные повторы и непрозрачные идентификаторы рабочих областей. Следующий этап: несколько супервизоров, распределение работы, удалённый транспорт и восстановление на другом узле.",
      nodes: {
        operator: "Оператор",
        control: "Веб-контур управления",
        ledger: "Реестр Postgres",
        host: "Супервизор узла исполнения",
        hostActive: "узел 01 · активен локально",
        hostFuture: "узлы 02+ · следующий этап",
        agents: "ACP-адаптеры",
        workspace: "Изолированные worktree + доказательства",
      },
      adapters: "Единый каталог сред исполнения",
      ready: "Claude · Codex · Gemini · OpenCode · MiMo",
      gated: "Anthropic · OpenAI · OpenRouter · совместимые провайдеры",
    },
    repository: {
      eyebrow: "Разрабатывается открыто",
      title: "Проверьте реализацию прямо в репозитории.",
      body:
        "MAIster распространяется по лицензии MIT. Реализацию, архитектурные решения и историю разработки можно проверить прямо в репозитории. Предлагайте новые возможности, сообщайте об ошибках и присылайте изменения через PR — мы рады участию.",
      open: { label: "Открыть GitHub", ariaLabel: "Открыть репозиторий MAIster на GitHub" },
      connected: "GitHub API подключён",
      loading: "Загружаем данные репозитория…",
      error: "Данные GitHub временно недоступны.",
      retry: "Повторить",
      stars: "Звёзды",
      forks: "Форки",
      issues: "Открытые задачи",
      license: "Лицензия",
      branch: "Основная ветка",
      updated: "Последнее обновление",
    },
    final: {
      eyebrow: "Начните с одного реального процесса",
      title: "Замените один терминал под присмотром на Flow, которому можно доверять.",
      body:
        "Запустите MAIster на своём узле, подключите приватный репозиторий и проверьте первый воспроизводимый процесс со встроенными доказательствами и проверкой человеком.",
      primary: "Открыть инструкцию",
      secondary: "Изучить репозиторий",
    },
    footer: {
      motto: "Ship happens",
      tagline: "Контур управления разработкой для команд из людей и ИИ-агентов.",
      taglineAccent: "Работа, доказательства и решения в одном месте.",
      product: {
        title: "Продукт",
        overview: "Позиционирование",
        workflow: "Контур доставки",
        collaboration: "Совместная работа",
        architecture: "Архитектура",
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
        issues: "Задачи",
        discussions: "Обсуждения",
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
