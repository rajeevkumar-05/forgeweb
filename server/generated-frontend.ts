import type { MasterSpecification } from "./domain.ts";

export const GENERATED_FRONTEND_TEMPLATE = "forgeweb-professional-v2";

export function normalizeMasterSpecification(specification: MasterSpecification): MasterSpecification {
  if (specification.architecture) return specification;
  const domainEntities = specification.entities.filter((entity) => entity !== "User");
  const pages = ["Secure sign-in", "Role-aware dashboard", ...domainEntities.slice(0, 3).map((entity) => `${entity} workspace`), "Activity and audit history", "Settings and access management"];
  const diagram = "flowchart LR\n  Browser[React customer app] --> API[Typed backend API]\n  API --> Auth[Session and role policy]\n  API --> Domain[Domain modules]\n  Domain --> DB[PostgreSQL]";
  const markdown = [
    `# ${specification.productName} Architecture`,
    "",
    "## System shape",
    "",
    "- Professional React and TypeScript customer frontend",
    "- Typed Node.js backend with server-side role authorization",
    "- PostgreSQL data model with project-scoped ownership",
    "- Versioned validation, audit evidence, and project exports",
    "",
    "## Frontend",
    "",
    ...pages.map((page) => `- ${page}`),
    "",
    "## Security",
    "",
    "- Authorization is enforced on the server.",
    "- Inputs are validated at the API boundary.",
    "- Consequential actions retain audit evidence.",
    "",
  ].join("\n");
  const architecture: MasterSpecification["architecture"] = {
    systemShape: "Modular TypeScript application with a professional React client, typed backend, relational data, and versioned evidence.",
    frontend: {
      framework: "React 19 and TypeScript",
      pages,
      components: ["Responsive application shell", "Primary navigation", "Metric and records surfaces", "Activity timeline", "Accessible forms and states"],
      motion: ["GSAP entrance choreography", "Anime.js micro-interactions", "Reduced-motion alternatives"],
    },
    backend: {
      runtime: "Node.js and TypeScript",
      modules: ["Identity", "Authorization", ...specification.entities, "Audit", "Validation"],
      apiStyle: "Versioned JSON HTTP contracts with server-side validation",
      jobs: ["Long-running generation", "Notifications and integrations", "Evidence synchronization"],
    },
    data: {
      database: "PostgreSQL",
      entities: specification.entities,
      rules: ["Every mutable record has an ownership boundary", "Archive before destructive deletion", "Migrations are versioned"],
    },
    security: ["Secure session boundary", "Server-side role and ownership checks", "Validated contracts", "Secret isolation"],
    delivery: ["Git-native revisions", "Automated type, test, and accessibility checks", "Sanitized export"],
    diagram,
    markdown,
    capabilities: [
      { id: "react", name: "React", kind: "framework", sourceUrl: "https://react.dev/", usage: "Typed component-driven customer application frontend.", boundary: "Pinned generated application dependency." },
      { id: "git", name: "Git", kind: "source-control", sourceUrl: "https://git-scm.com/", usage: "Versioned source and evidence history.", boundary: "External remotes require explicit authorization." },
      { id: "gsap", name: "GSAP", kind: "motion", sourceUrl: "https://gsap.com/", usage: "Purposeful interface choreography.", boundary: "Reduced-motion fallbacks are mandatory." },
      { id: "animejs", name: "Anime.js", kind: "motion", sourceUrl: "https://animejs.com/", usage: "Lightweight micro-interactions.", boundary: "Motion never blocks core actions." },
      { id: "react-bits", name: "React Bits", kind: "component-source", sourceUrl: "https://reactbits.dev/", usage: "Reviewed visual-pattern reference.", boundary: "No blind runtime component ingestion." },
    ],
  };
  return { ...specification, architecture };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function words(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function title(value: string): string {
  return words(value).replace(/\b\w/g, (character) => character.toUpperCase());
}

function plural(value: string): string {
  const label = title(value);
  if (/s$/i.test(label)) return label;
  if (/y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  return `${label}s`;
}

function initials(value: string): string {
  return words(value).split(" ").slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "FW";
}

function model(specification: MasterSpecification) {
  const prompt = (specification.prompt || "").toLowerCase();
  const name = (specification.productName || "").toLowerCase();
  const domainEntities = specification.entities.filter((entity) => entity !== "User");
  const primaryEntity = domainEntities[0] ?? (/portfolio/i.test(prompt) || /portfolio/i.test(name) ? "Project" : /shop|store|e-?commerce/i.test(prompt) ? "Product" : /game/i.test(prompt) ? "ScoreEntry" : /blog/i.test(prompt) ? "Article" : "Project");
  const primaryLabel = title(primaryEntity);
  const primaryPlural = plural(primaryEntity);

  const isPortfolio = /portfolio|resume|cv|personal website/i.test(prompt) || /portfolio/i.test(name);
  const isCommerce = /shop|store|commerce|product catalog|market/i.test(prompt);
  const isGame = /game|snake|arcade|play/i.test(prompt);
  const isEducation = /student|school|course|learning|academy/i.test(prompt);

  let heroHeadline = `Keep every <em>${primaryLabel.toLowerCase()}</em> moving.`;
  let heroCta = `Create ${primaryLabel}`;
  let heroSecondary = "View activity";
  let visualTitle = "Performance";
  let visualSubtitle = "This quarter";
  let visualValue = "84.6%";
  let visualDelta = "+12.4%";
  let navItems = ["Overview", primaryPlural, domainEntities[1] ? plural(domainEntities[1]) : "Team", "Activity"];
  let metrics = [
    { label: `${primaryPlural} tracked`, value: "248", delta: "+12.4%", tone: "positive" },
    { label: "Completed this week", value: "64", delta: "+8.1%", tone: "positive" },
    { label: "Active collaborators", value: String(Math.max(8, specification.roles.length * 6)), delta: "Across all roles", tone: "neutral" },
    { label: "System health", value: "99.9%", delta: "All services normal", tone: "positive" },
  ];
  let records = [
    { name: `${primaryLabel} Alpha`, owner: "Maya Chen", status: "On track", progress: 82 },
    { name: `${primaryLabel} Northstar`, owner: "Noah Williams", status: "Review", progress: 64 },
    { name: `${primaryLabel} Meridian`, owner: "Ava Patel", status: "On track", progress: 91 },
    { name: `${primaryLabel} Atlas`, owner: "Liam Brooks", status: "At risk", progress: 43 },
  ];

  if (isPortfolio) {
    heroHeadline = `Crafting elegant, modern <em>digital experiences</em>.`;
    heroCta = "Explore Projects";
    heroSecondary = "Get in touch";
    visualTitle = "Code Quality";
    visualSubtitle = "Lighthouse & Test Score";
    visualValue = "98/100";
    visualDelta = "+5.2% vs avg";
    navItems = ["Overview", "Projects", "Skills", "Articles", "Contact"];
    metrics = [
      { label: "Projects completed", value: "32", delta: "+8 this year", tone: "positive" },
      { label: "Client satisfaction", value: "100%", delta: "5.0 ★ rating", tone: "positive" },
      { label: "GitHub stars", value: "1.8k", delta: "Across open source", tone: "positive" },
      { label: "Years experience", value: "6+", delta: "Full-stack & UI/UX", tone: "neutral" },
    ];
    records = [
      { name: "ForgeWeb AI Engine", owner: "React 19 + Node.js", status: "Featured", progress: 95 },
      { name: "Cloud Analytics Platform", owner: "TypeScript + Python", status: "Live", progress: 100 },
      { name: "E-Commerce Design System", owner: "Tailwind + GSAP", status: "Open Source", progress: 88 },
      { name: "Real-time Mobile Wallet", owner: "React Native + WebGL", status: "In progress", progress: 74 },
    ];
  } else if (isCommerce) {
    heroHeadline = `Modern storefront built for <em>effortless sales</em>.`;
    heroCta = "Browse Catalog";
    heroSecondary = "Track Orders";
    visualTitle = "Gross Volume";
    visualSubtitle = "Monthly recurring";
    visualValue = "$48.2k";
    visualDelta = "+24.8%";
    navItems = ["Overview", "Products", "Collections", "Orders", "Discounts"];
    metrics = [
      { label: "Products in stock", value: "1,240", delta: "+15 new items", tone: "positive" },
      { label: "Orders fulfilled", value: "892", delta: "99.4% on time", tone: "positive" },
      { label: "Average order value", value: "$68.50", delta: "+12% vs last mo", tone: "positive" },
      { label: "Customer rating", value: "4.9 ★", delta: "Over 500 reviews", tone: "positive" },
    ];
    records = [
      { name: "Minimalist Wireless Earbuds", owner: "Electronics", status: "In stock", progress: 92 },
      { name: "Ergonomic Mechanical Keyboard", owner: "Accessories", status: "Trending", progress: 85 },
      { name: "Matte Aluminum Laptop Stand", owner: "Workspace", status: "Low stock", progress: 34 },
      { name: "USB-C Fast Charging Hub", owner: "Peripherals", status: "In stock", progress: 78 },
    ];
  } else if (isGame) {
    heroHeadline = `Fast, responsive, and <em>fun gameplay</em>.`;
    heroCta = "Start Playing";
    heroSecondary = "Leaderboards";
    visualTitle = "High Score";
    visualSubtitle = "Global ranking";
    visualValue = "12,450";
    visualDelta = "Top 1%";
    navItems = ["Play", "Leaderboard", "Achievements", "Settings"];
    metrics = [
      { label: "Games played", value: "14,200", delta: "Across all players", tone: "positive" },
      { label: "Daily active players", value: "1,850", delta: "+18% growth", tone: "positive" },
      { label: "Achievements unlocked", value: "48", delta: "12 secret badges", tone: "neutral" },
      { label: "Server tick rate", value: "60 FPS", delta: "Zero input latency", tone: "positive" },
    ];
    records = [
      { name: "Champion Round #42", owner: "PixelNinja", status: "Victory", progress: 100 },
      { name: "Speedrun Challenge", owner: "ShadowFox", status: "2nd place", progress: 94 },
      { name: "Survival Mode Stage 8", owner: "CyberSam", status: "Active", progress: 68 },
      { name: "Arcade Gauntlet", owner: "RetroGamer", status: "Completed", progress: 100 },
    ];
  } else if (isEducation) {
    heroHeadline = `Empowering modern <em>learning & teaching</em>.`;
    heroCta = "Explore Courses";
    heroSecondary = "View Grades";
    visualTitle = "Student Success";
    visualSubtitle = "Course completion";
    visualValue = "92.4%";
    visualDelta = "+6.8%";
    navItems = ["Overview", "Courses", "Students", "Assignments", "Grades"];
    metrics = [
      { label: "Enrolled students", value: "1,450", delta: "+120 this semester", tone: "positive" },
      { label: "Active courses", value: "38", delta: "Accredited syllabus", tone: "positive" },
      { label: "Assignments submitted", value: "4,920", delta: "96% graded", tone: "positive" },
      { label: "Average GPA", value: "3.75", delta: "Top tier performance", tone: "positive" },
    ];
    records = [
      { name: "Advanced TypeScript & React", owner: "Dr. Sarah Lin", status: "Active", progress: 75 },
      { name: "Database Systems & PostgreSQL", owner: "Prof. James Wood", status: "Final exam", progress: 90 },
      { name: "UI/UX & Creative Engineering", owner: "Maya Chen", status: "Enrolling", progress: 40 },
      { name: "Distributed Systems Architecture", owner: "Dr. Alan Turing", status: "Active", progress: 60 },
    ];
  }

  const configuredAreas = specification.architecture?.frontend?.pages ?? [
    "Role-aware dashboard",
    ...domainEntities.slice(0, 3).map((entity) => `${title(entity)} workspace`),
    "Activity and audit history",
    "Settings and access management",
  ];
  const areas = configuredAreas.filter((area) => !/sign-in/i.test(area)).slice(0, 6);
  return { primaryEntity, primaryLabel, primaryPlural, navItems, areas, metrics, records, heroHeadline, heroCta, heroSecondary, visualTitle, visualSubtitle, visualValue, visualDelta };
}

export function buildGeneratedFrontend(specification: MasterSpecification): { app: string; styles: string; preview: string } {
  specification = normalizeMasterSpecification(specification);
  const view = model(specification);
  const productLiteral = JSON.stringify(specification.productName);
  const summaryLiteral = JSON.stringify(specification.summary);
  const primaryLabelLiteral = JSON.stringify(view.primaryLabel);
  const primaryPluralLiteral = JSON.stringify(view.primaryPlural);
  const navLiteral = JSON.stringify(view.navItems);
  const areasLiteral = JSON.stringify(view.areas);
  const metricsLiteral = JSON.stringify(view.metrics);
  const recordsLiteral = JSON.stringify(view.records);
  const initialsLiteral = JSON.stringify(initials(specification.productName));
  const heroHeadline = view.heroHeadline;
  const heroCta = view.heroCta;
  const heroSecondary = view.heroSecondary;
  const visualTitle = view.visualTitle;
  const visualSubtitle = view.visualSubtitle;
  const visualValue = view.visualValue;
  const visualDelta = view.visualDelta;

  const app = [
    'import { useLayoutEffect, useRef } from "react";',
    'import gsap from "gsap";',
    'import { animate, stagger } from "animejs";',
    'import "./styles.css";',
    "",
    `const templateVersion = ${JSON.stringify(GENERATED_FRONTEND_TEMPLATE)};`,
    `const productName = ${productLiteral};`,
    `const summary = ${summaryLiteral};`,
    `const primaryLabel = ${primaryLabelLiteral};`,
    `const primaryPlural = ${primaryPluralLiteral};`,
    `const brandInitials = ${initialsLiteral};`,
    `const navItems = ${navLiteral};`,
    `const areas = ${areasLiteral};`,
    `const metrics = ${metricsLiteral};`,
    `const records = ${recordsLiteral};`,
    "",
    "export default function App() {",
    "  const root = useRef<HTMLDivElement>(null);",
    "  useLayoutEffect(() => {",
    '    if (!root.current || matchMedia("(prefers-reduced-motion: reduce)").matches) return;',
    '    const context = gsap.context(() => { gsap.from(".reveal", { y: 20, opacity: 0, stagger: 0.07, duration: 0.7, ease: "power3.out" }); }, root);',
    '    animate(".signal-dot", { scale: [0.75, 1.2], opacity: [0.45, 1], delay: stagger(90), loop: true, alternate: true, duration: 900 });',
    "    return () => context.revert();",
    "  }, []);",
    "  return (",
    '    <div ref={root} className="generated-shell" data-forgeweb-template={templateVersion}>',
    '      <header className="app-nav">',
    '        <div className="preview-container nav-inner">',
    '          <a className="brand" href="#overview" aria-label={`${productName} home`}><span className="brand-mark">{brandInitials}</span><span>{productName}</span></a>',
    '          <nav className="nav-links" aria-label="Primary navigation">{navItems.map((item, index) => <a className={index === 0 ? "is-active" : ""} href={`#${item.toLowerCase().replaceAll(" ", "-")}`} key={item}>{item}</a>)}</nav>',
    '          <div className="nav-actions"><button className="search-button" type="button"><span>Search</span><kbd>⌘ K</kbd></button><button className="avatar" type="button" aria-label="Open account menu">MC</button></div>',
    "        </div>",
    "      </header>",
    '      <main className="preview-container">',
    '        <section id="overview" className="generated-hero app-hero">',
    `          <div className="hero-copy reveal"><p className="eyebrow"><i className="signal-dot" /> Live workspace · Preview data</p><h1>${heroHeadline}</h1><p className="hero-summary">{summary}</p><div className="hero-actions"><a className="primary-action" href="#workspace">${heroCta}<span>↗</span></a><a className="secondary-action" href="#activity">${heroSecondary}</a></div><div className="hero-proof"><span className="avatar-stack"><i>MC</i><i>NW</i><i>AP</i></span><p><strong>{Math.max(8, navItems.length * 4)} teammates</strong><br />working securely today</p></div></div>`,
    `          <div className="hero-visual reveal" aria-label={\`\${primaryLabel} performance overview\`}><div className="visual-top"><div><span>${visualTitle}</span><strong>${visualSubtitle}</strong></div><button type="button">•••</button></div><div className="visual-value"><strong>${visualValue}</strong><span>${visualDelta}</span></div><div className="chart" aria-hidden="true">{[38, 54, 44, 67, 58, 79, 72, 92, 84, 100].map((height, index) => <i style={{ height: \`\${height}%\` }} key={index} />)}</div><div className="visual-axis"><span>Week 1</span><span>Week 10</span></div></div>`,
    "        </section>",
    '        <section className="metric-grid" aria-label="Workspace metrics">{metrics.map((metric) => <article className="metric-card reveal" key={metric.label}><div><span>{metric.label}</span><button type="button" aria-label={`More about ${metric.label}`}>↗</button></div><strong>{metric.value}</strong><p className={metric.tone}>{metric.delta}</p></article>)}</section>',
    '        <section id="workspace" className="workspace-layout">',
    '          <article className="workspace-card generated-card reveal"><div className="section-heading"><div><span>Workspace</span><h2>{primaryPlural}</h2></div><a href="#all-records">View all <span>↗</span></a></div><div className="record-table"><div className="record-row table-head"><span>Name</span><span>Owner</span><span>Progress</span><span>Status</span></div>{records.map((record) => <div className="record-row" key={record.name}><strong><i>{record.name.slice(-1)}</i>{record.name}</strong><span>{record.owner}</span><span className="progress"><i><b style={{ width: `${record.progress}%` }} /></i>{record.progress}%</span><span className={`status status-${record.status.toLowerCase().replaceAll(" ", "-")}`}>{record.status}</span></div>)}</div></article>',
    '          <aside id="activity" className="activity-card generated-card reveal"><div className="section-heading"><div><span>Live feed</span><h2>Activity</h2></div><i className="live-dot" /></div><ol><li><i>MC</i><p><strong>Maya completed a review</strong><span>2 minutes ago</span></p></li><li><i>NW</i><p><strong>Noah invited a collaborator</strong><span>18 minutes ago</span></p></li><li><i>AP</i><p><strong>Ava updated access rules</strong><span>1 hour ago</span></p></li><li><i>LB</i><p><strong>Liam archived a record</strong><span>Yesterday</span></p></li></ol><a href="#activity-log">Open activity log <span>↗</span></a></aside>',
    "        </section>",
    '        <section className="capability-section"><div className="section-heading reveal"><div><span>Designed around the work</span><h2>Everything your team needs.</h2></div><p>Clear workflows, secure boundaries, and a responsive interface generated from your approved architecture.</p></div><div className="generated-grid">{areas.map((area, index) => <article className="capability-card generated-card reveal" key={area}><span>0{index + 1}</span><i aria-hidden="true">{["⌁", "◇", "↗", "◎", "⌘", "△"][index % 6]}</i><h3>{area}</h3><p>Connected to typed APIs, role policy, validation, and auditable project history.</p></article>)}</div></section>',
    '        <footer><a className="brand" href="#overview"><span className="brand-mark">{brandInitials}</span><span>{productName}</span></a><p>Secure by design. Built from an approved architecture.</p><a href="#overview">Back to top ↑</a></footer>',
    "      </main>",
    "    </div>",
    "  );",
    "}",
    "",
  ].join("\n");

  const styles = [
    ":root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif; background: #060909; color: #f5f7f2; font-synthesis: none; }",
    "* { box-sizing: border-box; } html { scroll-behavior: smooth; } body { margin: 0; min-width: 320px; background: #060909; } button, a { font: inherit; } button { cursor: pointer; } a { color: inherit; text-decoration: none; }",
    ".generated-shell { min-height: 100vh; overflow: hidden; background: radial-gradient(circle at 84% 8%, rgba(33, 204, 211, .14), transparent 30rem), radial-gradient(circle at 0 34%, rgba(209, 255, 92, .07), transparent 27rem), #060909; }",
    ".preview-container { width: min(1220px, calc(100% - 48px)); margin-inline: auto; }",
    ".app-nav { position: sticky; z-index: 20; top: 0; border-bottom: 1px solid rgba(255,255,255,.075); background: rgba(6,9,9,.82); backdrop-filter: blur(20px); }",
    ".nav-inner { display: grid; grid-template-columns: minmax(170px, 1fr) auto minmax(170px, 1fr); align-items: center; min-height: 76px; gap: 1.5rem; }",
    ".brand { display: inline-flex; align-items: center; gap: .7rem; width: max-content; font-size: .88rem; font-weight: 720; letter-spacing: -.02em; }",
    ".brand-mark { display: grid; width: 2.1rem; height: 2.1rem; place-items: center; border: 1px solid rgba(216,255,98,.36); border-radius: .65rem; color: #d8ff62; background: linear-gradient(145deg, rgba(216,255,98,.14), rgba(255,255,255,.02)); font: 800 .68rem ui-monospace, monospace; box-shadow: 0 8px 28px rgba(157,205,24,.09); }",
    ".nav-links { display: flex; align-items: center; justify-content: center; gap: .25rem; padding: .25rem; border: 1px solid rgba(255,255,255,.06); border-radius: 999px; background: rgba(255,255,255,.025); }",
    ".nav-links a { border-radius: 999px; padding: .52rem .78rem; color: rgba(255,255,255,.48); font-size: .7rem; font-weight: 650; transition: 160ms ease; } .nav-links a:hover { color: white; } .nav-links a.is-active { color: #090b0b; background: #d8ff62; }",
    ".nav-actions { display: flex; align-items: center; justify-content: flex-end; gap: .55rem; } .search-button { display: flex; align-items: center; gap: .8rem; border: 1px solid rgba(255,255,255,.08); border-radius: .65rem; padding: .55rem .65rem; color: rgba(255,255,255,.45); background: rgba(255,255,255,.025); font-size: .65rem; } .search-button kbd { border: 1px solid rgba(255,255,255,.1); border-radius: .3rem; padding: .15rem .3rem; color: rgba(255,255,255,.35); font: .55rem ui-monospace, monospace; } .avatar { width: 2.1rem; height: 2.1rem; border: 0; border-radius: 50%; color: #101313; background: linear-gradient(145deg, #d8ff62, #79e5cd); font-size: .62rem; font-weight: 800; }",
    ".app-hero { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(330px, .72fr); align-items: center; gap: clamp(2rem, 6vw, 6.5rem); min-height: 590px; padding-block: clamp(4rem, 8vw, 7rem); }",
    ".eyebrow { display: flex; align-items: center; gap: .55rem; margin: 0; color: #d8ff62; font: 700 .63rem ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase; } .signal-dot, .live-dot { display: inline-block; width: .5rem; height: .5rem; border-radius: 50%; background: #d8ff62; box-shadow: 0 0 18px rgba(216,255,98,.7); }",
    ".app-hero h1 { max-width: 780px; margin: 1.35rem 0 1.2rem; font-size: clamp(3.8rem, 7vw, 7.2rem); line-height: .88; letter-spacing: -.075em; } .app-hero h1 em { color: #d8ff62; font-style: normal; } .hero-summary { max-width: 650px; margin: 0; color: rgba(255,255,255,.52); font-size: clamp(.95rem, 1.4vw, 1.12rem); line-height: 1.7; }",
    ".hero-actions { display: flex; flex-wrap: wrap; gap: .65rem; margin-top: 1.8rem; } .primary-action, .secondary-action { display: inline-flex; align-items: center; justify-content: center; gap: 1.2rem; min-height: 3rem; border-radius: .72rem; padding: 0 1rem; font-size: .72rem; font-weight: 750; } .primary-action { color: #0a0d0c; background: #d8ff62; box-shadow: 0 12px 36px rgba(174,220,42,.12); } .secondary-action { border: 1px solid rgba(255,255,255,.1); color: rgba(255,255,255,.72); background: rgba(255,255,255,.025); }",
    ".hero-proof { display: flex; align-items: center; gap: .8rem; margin-top: 2rem; } .avatar-stack { display: flex; padding-left: .45rem; } .avatar-stack i { display: grid; width: 2rem; height: 2rem; place-items: center; margin-left: -.45rem; border: 2px solid #070a0a; border-radius: 50%; color: #0d1211; background: #b8c9c1; font: 750 .52rem ui-monospace, monospace; } .avatar-stack i:nth-child(2) { background: #d8ff62; } .avatar-stack i:nth-child(3) { background: #79e5cd; } .hero-proof p { margin: 0; color: rgba(255,255,255,.34); font-size: .62rem; line-height: 1.45; } .hero-proof strong { color: rgba(255,255,255,.72); }",
    ".hero-visual { min-height: 340px; border: 1px solid rgba(255,255,255,.1); border-radius: 1.35rem; padding: 1.25rem; background: linear-gradient(145deg, rgba(255,255,255,.065), rgba(255,255,255,.018)); box-shadow: 0 32px 90px rgba(0,0,0,.28); transform: perspective(1100px) rotateY(-3deg) rotateX(1deg); } .visual-top, .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; } .visual-top div, .section-heading > div { display: flex; flex-direction: column; gap: .3rem; } .visual-top span, .section-heading > div > span { color: rgba(255,255,255,.34); font: 650 .56rem ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; } .visual-top strong { font-size: .72rem; } .visual-top button { border: 0; color: rgba(255,255,255,.3); background: none; } .visual-value { display: flex; align-items: baseline; gap: .75rem; margin-top: 2.5rem; } .visual-value strong { font-size: 2.6rem; letter-spacing: -.06em; } .visual-value span { color: #79e5cd; font-size: .65rem; font-weight: 700; }",
    ".chart { display: flex; height: 125px; align-items: flex-end; gap: .45rem; margin-top: 2rem; } .chart i { flex: 1; min-width: .4rem; border-radius: .3rem .3rem .1rem .1rem; background: linear-gradient(to top, rgba(216,255,98,.18), #d8ff62); } .chart i:nth-child(3n) { background: linear-gradient(to top, rgba(121,229,205,.12), #79e5cd); } .visual-axis { display: flex; justify-content: space-between; margin-top: .65rem; color: rgba(255,255,255,.26); font-size: .52rem; }",
    ".metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: .75rem; margin-bottom: clamp(4rem, 7vw, 6rem); } .metric-card { min-width: 0; border: 1px solid rgba(255,255,255,.075); border-radius: 1rem; padding: 1.15rem; background: rgba(255,255,255,.025); } .metric-card > div { display: flex; justify-content: space-between; gap: .6rem; color: rgba(255,255,255,.38); font-size: .6rem; } .metric-card button { border: 0; color: rgba(255,255,255,.28); background: none; } .metric-card > strong { display: block; margin-top: 1.5rem; font-size: clamp(1.7rem, 3vw, 2.5rem); letter-spacing: -.055em; } .metric-card p { margin: .55rem 0 0; color: rgba(255,255,255,.32); font-size: .56rem; } .metric-card p.positive { color: #79e5cd; }",
    ".workspace-layout { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(260px, .68fr); gap: .8rem; } .workspace-card, .activity-card { min-width: 0; border: 1px solid rgba(255,255,255,.075); border-radius: 1.15rem; padding: 1.25rem; background: rgba(255,255,255,.025); } .section-heading h2 { margin: 0; font-size: 1.15rem; letter-spacing: -.035em; } .section-heading > a { color: #d8ff62; font-size: .62rem; }",
    ".record-table { margin-top: 1.3rem; overflow-x: auto; } .record-row { display: grid; grid-template-columns: minmax(180px,1.4fr) minmax(115px,.8fr) minmax(130px,.8fr) 88px; align-items: center; gap: .8rem; min-width: 650px; border-top: 1px solid rgba(255,255,255,.055); padding: .9rem .2rem; color: rgba(255,255,255,.42); font-size: .61rem; } .record-row.table-head { border: 0; padding-top: .25rem; color: rgba(255,255,255,.24); font-size: .52rem; text-transform: uppercase; } .record-row > strong { display: flex; align-items: center; gap: .65rem; color: rgba(255,255,255,.8); font-size: .65rem; } .record-row > strong > i { display: grid; width: 1.8rem; height: 1.8rem; flex: none; place-items: center; border-radius: .5rem; color: #d8ff62; background: rgba(216,255,98,.08); font-style: normal; } .progress { display: flex; align-items: center; gap: .5rem; } .progress > i { width: 58px; height: 3px; overflow: hidden; border-radius: 99px; background: rgba(255,255,255,.08); } .progress b { display: block; height: 100%; border-radius: inherit; background: #79e5cd; } .status { width: max-content; border-radius: 99px; padding: .3rem .45rem; color: #79e5cd; background: rgba(121,229,205,.08); font-size: .52rem; } .status-review { color: #f1c879; background: rgba(241,200,121,.08); } .status-at-risk { color: #ff879e; background: rgba(255,135,158,.08); }",
    ".activity-card ol { display: grid; gap: 0; margin: 1.1rem 0 0; padding: 0; list-style: none; } .activity-card li { display: flex; gap: .65rem; border-top: 1px solid rgba(255,255,255,.055); padding: .8rem 0; } .activity-card li > i { display: grid; width: 1.75rem; height: 1.75rem; flex: none; place-items: center; border-radius: 50%; color: #101312; background: #b8c9c1; font: 750 .5rem ui-monospace, monospace; } .activity-card li:nth-child(2) > i { background: #d8ff62; } .activity-card li:nth-child(3) > i { background: #79e5cd; } .activity-card li p { display: flex; min-width: 0; flex-direction: column; gap: .22rem; margin: 0; } .activity-card li strong { overflow: hidden; color: rgba(255,255,255,.72); font-size: .6rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; } .activity-card li span, .activity-card > a { color: rgba(255,255,255,.28); font-size: .52rem; } .activity-card > a { display: flex; justify-content: space-between; border-top: 1px solid rgba(255,255,255,.055); padding-top: .9rem; color: #d8ff62; }",
    ".capability-section { padding-block: clamp(5rem, 10vw, 9rem); } .capability-section > .section-heading { align-items: flex-end; } .capability-section .section-heading h2 { max-width: 620px; margin-top: .55rem; font-size: clamp(2.3rem, 5vw, 4.6rem); line-height: .95; letter-spacing: -.06em; } .capability-section .section-heading > p { max-width: 390px; margin: 0; color: rgba(255,255,255,.4); font-size: .72rem; line-height: 1.65; } .generated-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: .75rem; margin-top: 2.4rem; } .capability-card { position: relative; min-height: 260px; border: 1px solid rgba(255,255,255,.075); border-radius: 1rem; padding: 1.25rem; background: linear-gradient(145deg, rgba(255,255,255,.04), rgba(255,255,255,.018)); } .capability-card > span { color: #d8ff62; font: 700 .55rem ui-monospace, monospace; } .capability-card > i { position: absolute; top: 1.15rem; right: 1.2rem; color: rgba(255,255,255,.2); font-size: 1.4rem; font-style: normal; } .capability-card h3 { max-width: 14ch; margin: 5.4rem 0 .75rem; font-size: 1.18rem; line-height: 1.08; letter-spacing: -.035em; } .capability-card p { margin: 0; color: rgba(255,255,255,.35); font-size: .62rem; line-height: 1.6; }",
    "footer { display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; border-top: 1px solid rgba(255,255,255,.075); padding-block: 1.5rem 2rem; } footer p, footer > a:last-child { color: rgba(255,255,255,.3); font-size: .58rem; } footer > a:last-child { color: rgba(255,255,255,.55); }",
    "@media (max-width: 900px) { .nav-inner { grid-template-columns: 1fr auto; } .nav-links { display: none; } .app-hero { grid-template-columns: 1fr; min-height: auto; } .hero-visual { min-height: 310px; transform: none; } .metric-grid { grid-template-columns: repeat(2,minmax(0,1fr)); } .workspace-layout { grid-template-columns: 1fr; } .activity-card { min-height: auto; } .generated-grid { grid-template-columns: repeat(2,minmax(0,1fr)); } .capability-section > .section-heading { align-items: flex-start; flex-direction: column; } }",
    "@media (max-width: 600px) { .preview-container { width: min(100% - 28px, 1220px); } .nav-inner { min-height: 66px; } .brand { font-size: .78rem; } .search-button span, .search-button kbd { display: none; } .search-button::before { content: '⌕'; font-size: 1rem; } .app-hero { gap: 2.5rem; padding-block: 3.6rem; } .app-hero h1 { font-size: clamp(3.25rem, 16vw, 5rem); } .hero-actions > a { flex: 1; } .hero-visual { min-height: 285px; padding: 1rem; } .metric-grid { grid-template-columns: 1fr 1fr; } .metric-card { padding: .9rem; } .metric-card > strong { margin-top: 1.1rem; } .workspace-card, .activity-card { padding: .9rem; } .generated-grid { grid-template-columns: 1fr; } .capability-card { min-height: 225px; } .capability-card h3 { margin-top: 4.3rem; } footer { align-items: flex-start; flex-direction: column; } footer p { margin: 0; } }",
    "@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; scroll-behavior: auto !important; } }",
    "",
  ].join("\n");

  const navHtml = view.navItems.map((item, index) => `<a class="${index === 0 ? "is-active" : ""}" href="#${item.toLowerCase().replaceAll(" ", "-")}">${escapeHtml(item)}</a>`).join("");
  const metricsHtml = view.metrics.map((metric) => `<article class="metric-card reveal"><div><span>${escapeHtml(metric.label)}</span><button type="button" aria-label="More about ${escapeHtml(metric.label)}">↗</button></div><strong>${escapeHtml(metric.value)}</strong><p class="${metric.tone}">${escapeHtml(metric.delta)}</p></article>`).join("");
  const recordsHtml = view.records.map((record) => `<div class="record-row"><strong><i>${escapeHtml(record.name.slice(-1))}</i>${escapeHtml(record.name)}</strong><span>${escapeHtml(record.owner)}</span><span class="progress"><i><b style="width:${record.progress}%"></b></i>${record.progress}%</span><span class="status status-${record.status.toLowerCase().replaceAll(" ", "-")}">${escapeHtml(record.status)}</span></div>`).join("");
  const areasHtml = view.areas.map((area, index) => `<article class="capability-card generated-card reveal"><span>0${index + 1}</span><i aria-hidden="true">${["⌁", "◇", "↗", "◎", "⌘", "△"][index % 6]}</i><h3>${escapeHtml(area)}</h3><p>Connected to typed APIs, role policy, validation, and auditable project history.</p></article>`).join("");
  const barsHtml = [38, 54, 44, 67, 58, 79, 72, 92, 84, 100].map((height) => `<i style="height:${height}%"></i>`).join("");
  const brand = `<a class="brand" href="#overview" aria-label="${escapeHtml(specification.productName)} home"><span class="brand-mark">${escapeHtml(initials(specification.productName))}</span><span>${escapeHtml(specification.productName)}</span></a>`;
  const preview = [
    "<!doctype html>",
    `<html lang="en" data-forgeweb-template="${GENERATED_FRONTEND_TEMPLATE}">`,
    "<head>",
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `<meta name="description" content="${escapeHtml(specification.summary)}" />`,
    `<title>${escapeHtml(specification.productName)} · Workspace</title>`,
    `<style>${styles}</style>`,
    "</head>",
    "<body>",
    `<div class="generated-shell" data-forgeweb-template="${GENERATED_FRONTEND_TEMPLATE}">`,
    '<header class="app-nav"><div class="preview-container nav-inner">', brand,
    `<nav class="nav-links" aria-label="Primary navigation">${navHtml}</nav>`,
    '<div class="nav-actions"><button class="search-button" type="button"><span>Search</span><kbd>⌘ K</kbd></button><button class="avatar" type="button" aria-label="Open account menu">MC</button></div></div></header>',
    '<main class="preview-container">',
    '<section id="overview" class="generated-hero app-hero">',
    `<div class="hero-copy reveal"><p class="eyebrow"><i class="signal-dot"></i> Live workspace · Preview data</p><h1>${heroHeadline}</h1><p class="hero-summary">${escapeHtml(specification.summary)}</p><div class="hero-actions"><a class="primary-action" href="#workspace">${heroCta}<span>↗</span></a><a class="secondary-action" href="#activity">${heroSecondary}</a></div><div class="hero-proof"><span class="avatar-stack"><i>MC</i><i>NW</i><i>AP</i></span><p><strong>${Math.max(8, view.navItems.length * 4)} teammates</strong><br />working securely today</p></div></div>`,
    `<div class="hero-visual reveal" aria-label="${escapeHtml(view.primaryLabel)} performance overview"><div class="visual-top"><div><span>${visualTitle}</span><strong>${visualSubtitle}</strong></div><button type="button">•••</button></div><div class="visual-value"><strong>${visualValue}</strong><span>${visualDelta}</span></div><div class="chart" aria-hidden="true">${barsHtml}</div><div class="visual-axis"><span>Week 1</span><span>Week 10</span></div></div>`,
    "</section>",
    `<section class="metric-grid" aria-label="Workspace metrics">${metricsHtml}</section>`,
    '<section id="workspace" class="workspace-layout">',
    `<article class="workspace-card generated-card reveal"><div class="section-heading"><div><span>Workspace</span><h2>${escapeHtml(view.primaryPlural)}</h2></div><a href="#all-records">View all <span>↗</span></a></div><div class="record-table"><div class="record-row table-head"><span>Name</span><span>Owner</span><span>Progress</span><span>Status</span></div>${recordsHtml}</div></article>`,
    '<aside id="activity" class="activity-card generated-card reveal"><div class="section-heading"><div><span>Live feed</span><h2>Activity</h2></div><i class="live-dot"></i></div><ol><li><i>MC</i><p><strong>Maya completed a review</strong><span>2 minutes ago</span></p></li><li><i>NW</i><p><strong>Noah invited a collaborator</strong><span>18 minutes ago</span></p></li><li><i>AP</i><p><strong>Ava updated access rules</strong><span>1 hour ago</span></p></li><li><i>LB</i><p><strong>Liam archived a record</strong><span>Yesterday</span></p></li></ol><a href="#activity-log">Open activity log <span>↗</span></a></aside>',
    "</section>",
    `<section class="capability-section"><div class="section-heading reveal"><div><span>Designed around the work</span><h2>Everything your team needs.</h2></div><p>Clear workflows, secure boundaries, and a responsive interface generated from your approved architecture.</p></div><div class="generated-grid">${areasHtml}</div></section>`,
    `<footer>${brand}<p>Secure by design. Built from an approved architecture.</p><a href="#overview">Back to top ↑</a></footer>`,
    "</main></div></body></html>",
    "",
  ].join("\n");

  return { app, styles, preview };
}
