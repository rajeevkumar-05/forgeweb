import {
  ArrowRight,
  Braces,
  Check,
  ChevronRight,
  CircleDot,
  Code2,
  Database,
  GitBranch,
  Globe2,
  KeyRound,
  LockKeyhole,
  Network,
  Search,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  WandSparkles,
  Workflow,
  Zap,
} from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { gsap } from "gsap";
import BorderGlow from "./components/react-bits/BorderGlow";
import ScrollStack, { ScrollStackItem } from "./components/react-bits/ScrollStack";
import { MorphingSigil } from "./components/MorphingSigil";
import { KineticStatement } from "./components/KineticStatement";
import { LanguageShowcase } from "./components/LanguageShowcase";
import SiteNav from "./components/SiteNav";
import BuildProposal from "./components/BuildProposal";
import ProjectLibrary from "./components/ProjectLibrary";
import OwnerAccess from "./components/OwnerAccess";
import { projectSelectionUrl, selectedProjectId } from "./lib/project-selection";
import {
  activateSafeGeneration,
  confirmBuild,
  confirmSafeBuild,
  createBuild,
  createSafeBuild,
  getLlmStatus,
  getSafeGenerationStatus,
  getOwnerSession,
  getProjectWorkspace,
  getBuild,
  reviseBuild,
  waitForBuild,
  type BuildResponse,
  type LlmStatus,
  type SafeGenerationStatus,
  type OwnerSession,
} from "./lib/forgeweb-api";

const floatingLinesGradient = ["#50c7f0", "#000000", "#0ac0e0"];
const FloatingLines = lazy(() => import("./components/react-bits/FloatingLines"));

const quickPrompts = [
  "Client portal",
  "Inventory OS",
  "Team scheduler",
];

const buildStages = [
  { label: "Master spec", detail: "18 requirements mapped", icon: Braces },
  { label: "Secure build", detail: "42 files generated", icon: Code2 },
  { label: "Review graph", detail: "156 relations indexed", icon: Network },
  { label: "Validation", detail: "37 checks passed", icon: ShieldCheck },
];

function visibleBuildStage(build: BuildResponse): number {
  if (build.status === "completed" || build.status === "validating") return 3;
  if (build.status === "reviewing") return 2;
  if (build.status === "planning" || build.status === "awaiting_confirmation" || build.status === "generating") return 1;
  if (build.status === "specifying") return 0;
  return -1;
}

function visibleBuildDetail(build: BuildResponse): string {
  if (build.status === "completed" || build.status === "failed" || build.status === "needs_context") return build.stageDetail;
  if (build.status === "queued" || build.status === "specifying") return `Master spec — ${build.stageDetail}`;
  if (build.status === "awaiting_confirmation") return `Architecture ready — ${build.stageDetail}`;
  if (build.status === "planning" || build.status === "generating") return `Secure build — ${build.stageDetail}`;
  if (build.status === "reviewing") return `Review graph — ${build.stageDetail}`;
  return `Validation — ${build.stageDetail}`;
}

const apiExamples = [
  { name: "Open-Meteo", category: "Weather", auth: "No key", cors: "CORS" },
  { name: "REST Countries", category: "Geography", auth: "No key", cors: "CORS" },
  { name: "Art Institute", category: "Art & Design", auth: "No key", cors: "CORS" },
  { name: "Frankfurter", category: "Exchange", auth: "No key", cors: "CORS" },
];

function BrandMark() {
  return (
    <a href="#top" className="group flex items-center gap-2.5" aria-label="ForgeWeb home">
      <img className="brand-mark-logo" src="/forgeweb-logo-gold.png" alt="" aria-hidden="true" />
      <span className="text-[15px] font-semibold text-white">ForgeWeb</span>
    </a>
  );
}

function Hero() {
  const [prompt, setPrompt] = useState("Build a secure client portal for a creative agency with projects, invoices, files, and role-based access.");
  const [stage, setStage] = useState(-1);
  const [running, setRunningState] = useState(false);
  const [build, setBuild] = useState<BuildResponse | null>(null);
  const [projectRefreshToken, setProjectRefreshToken] = useState(0);
  const [statusDetail, setStatusDetail] = useState("Ready — your prompt becomes a versioned specification before code is generated.");
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [workflowMode, setWorkflowMode] = useState<"legacy" | "safe">("legacy");
  const [safeStatus, setSafeStatus] = useState<SafeGenerationStatus | null>(null);
  const [activationToken, setActivationToken] = useState("");
  const [ownerSession, setOwnerSession] = useState<OwnerSession>({ user: null, migration: { standard: 0, verified: 0 } });
  const [ownerLoading, setOwnerLoading] = useState(true);
  const selectionSequence = useRef(0);
  const selectionProjectId = useRef(selectedProjectId(window.location.href));
  const runningRef = useRef(false);
  // History listeners must see busy changes immediately, without a stale render closure.
  const setRunning = (value: boolean) => {
    runningRef.current = value;
    setRunningState(value);
  };
  const rememberProject = (projectId?: string) => {
    selectionSequence.current++;
    const href = projectSelectionUrl(window.location.href, projectId);
    selectionProjectId.current = selectedProjectId(href);
    window.history.replaceState(null, "", href);
  };
  const refreshOwner = async () => {
    rememberProject();
    const session = await getOwnerSession();
    setOwnerSession(session);
    setSafeStatus(await getSafeGenerationStatus());
    setActivationToken("");
    setBuild(null);
    setProjectRefreshToken(value => value + 1);
  };
  const activeStage = buildStages[Math.max(stage, 0)];
  const ActiveStageIcon = activeStage.icon;

  useEffect(() => {
    getLlmStatus().then((status) => {
      console.log("[ForgeWeb] LLM status:", JSON.stringify(status));
      setLlmStatus(status);
    }).catch((err) => {
      console.error("[ForgeWeb] LLM status fetch failed:", err);
    });
    getSafeGenerationStatus().then(setSafeStatus).catch(() => setSafeStatus(null));
    getOwnerSession().then(setOwnerSession).catch(() => setStatusDetail("Account service unavailable. Refresh and try again.")).finally(() => setOwnerLoading(false));
  }, []);

  useEffect(() => {
    if (ownerLoading) return;
    if (!ownerSession.user) { rememberProject(); return; }
    const restoreSelection = () => {
      const projectId = selectedProjectId(window.location.href);
      selectionProjectId.current = projectId;
      const sequence = ++selectionSequence.current;
      if (!projectId) return;
      const reopen = async () => {
        try {
          const workspace = await getProjectWorkspace(projectId);
          if (sequence !== selectionSequence.current) return;
          if (!workspace.project.currentBuildId) throw new Error("PROJECT_BUILD_UNAVAILABLE");
          const saved = await getBuild(workspace.project.currentBuildId);
          if (sequence !== selectionSequence.current) return;
          if (saved.projectId !== projectId) throw new Error("PROJECT_LINKAGE_INVALID");
          openSavedProject(saved);
        } catch {
          if (sequence !== selectionSequence.current) return;
          rememberProject();
          setStatusDetail("Saved project could not be reopened. Select an owned project from Projects.");
        }
      };
      void reopen();
    };
    const reconcileHistory = () => {
      if (selectedProjectId(window.location.href) === selectionProjectId.current) return;
      if (runningRef.current) {
        window.history.replaceState(null, "", projectSelectionUrl(window.location.href, selectionProjectId.current));
        return;
      }
      setBuild(null);
      setStage(-1);
      setStatusDetail("Ready for a new project.");
      restoreSelection();
    };
    restoreSelection();
    window.addEventListener("popstate", reconcileHistory);
    return () => {
      selectionSequence.current++;
      window.removeEventListener("popstate", reconcileHistory);
    };
  }, [ownerLoading, ownerSession.user?.id]);

  useEffect(() => {
    if (build?.projectId) rememberProject(build.projectId);
  }, [build?.projectId]);

  const launchDemo = async (event: FormEvent) => {
    event.preventDefault();
    if (running) return;

    rememberProject();
    setRunning(true);
    setBuild(null);
    setStage(-1);
    setStatusDetail("Master spec — submitting the idea to the private build workspace…");
    try {
      if (workflowMode === "safe" && !safeStatus?.authenticated) {
        setStatusDetail("Verified workflow — authenticating...");
        try {
          setSafeStatus(await activateSafeGeneration(activationToken));
        } finally {
          setActivationToken("");
        }
      }
      const created = workflowMode === "safe" ? await createSafeBuild(prompt) : await createBuild(prompt);
      setProjectRefreshToken((value) => value + 1);
      const completed = await waitForBuild(created.id, (build) => {
        setBuild(build);
        setStage(visibleBuildStage(build));
        setStatusDetail(visibleBuildDetail(build));
      });
      if (completed.status === "failed" || completed.status === "needs_context") {
        throw new Error(completed.error?.message ?? completed.stageDetail);
      }
      setBuild(completed);
      setProjectRefreshToken((value) => value + 1);
      if (completed.status === "awaiting_confirmation") {
        setStage(1);
        setStatusDetail("Architecture ready — review the requirements and confirm before any source is generated.");
      } else {
        setStage(3);
        setStatusDetail(completed.stageDetail);
      }
    } catch (error) {
      setStage(-1);
      setStatusDetail(error instanceof Error ? `Build stopped — ${error.message}` : "Build stopped unexpectedly.");
    } finally {
      setRunning(false);
    }
  };

  const confirmProposal = async () => {
    if (!build || running || build.status !== "awaiting_confirmation") return;
    setRunning(true);
    setStatusDetail("Secure build — requirements confirmed; starting frontend and backend generation…");
    try {
      const confirmed = build.generationMode === "safe" ? await confirmSafeBuild(build.id) : await confirmBuild(build.id);
      setBuild(confirmed);
      const completed = await waitForBuild(confirmed.id, (progress) => {
        setBuild(progress);
        setStage(visibleBuildStage(progress));
        setStatusDetail(visibleBuildDetail(progress));
      });
      if (completed.status === "failed" || completed.status === "needs_context") {
        throw new Error(completed.error?.message ?? completed.stageDetail);
      }
      setBuild(completed);
      setProjectRefreshToken((value) => value + 1);
      setStage(3);
      setStatusDetail(completed.stageDetail);
    } catch (error) {
      if (build.generationMode === "safe") setProjectRefreshToken((value) => value + 1);
      setStatusDetail(error instanceof Error ? `Build stopped — ${error.message}` : "Build stopped unexpectedly.");
    } finally {
      setRunning(false);
    }
  };

  const reviseProposal = async (notes: string) => {
    if (!build || running || build.status !== "awaiting_confirmation") return;
    setRunning(true);
    setStage(-1);
    setStatusDetail("Master spec — revising the specification from your feedback…");
    try {
      const revised = await reviseBuild(build.id, notes);
      const completed = await waitForBuild(revised.id, (progress) => {
        setBuild(progress);
        setStage(visibleBuildStage(progress));
        setStatusDetail(visibleBuildDetail(progress));
      });
      if (completed.status === "failed" || completed.status === "needs_context") {
        throw new Error(completed.error?.message ?? completed.stageDetail);
      }
      setBuild(completed);
      if (completed.status === "awaiting_confirmation") {
        setStage(1);
        setStatusDetail("Architecture ready — review the revised requirements and confirm before any source is generated.");
      } else {
        setStage(3);
        setStatusDetail(completed.stageDetail);
      }
    } catch (error) {
      setStage(-1);
      setStatusDetail(error instanceof Error ? `Revision failed — ${error.message}` : "Revision failed unexpectedly.");
    } finally {
      setRunning(false);
    }
  };

  const handleProjectDeleted = (projectId: string) => {
    if (build?.projectId === projectId || selectedProjectId(window.location.href) === projectId) {
      rememberProject();
      setBuild(null);
      setStage(-1);
      setStatusDetail("Project deleted.");
    }
    setProjectRefreshToken(value => value + 1);
  };

  const openSavedProject = (savedBuild: BuildResponse) => {
    rememberProject(savedBuild.projectId);
    setWorkflowMode(savedBuild.generationMode === "safe" ? "safe" : "legacy");
    setBuild(savedBuild);
    setStage(visibleBuildStage(savedBuild));
    setStatusDetail(savedBuild.status === "completed" ? `Saved project opened — ${savedBuild.stageDetail}` : visibleBuildDetail(savedBuild));
  };

  return (
    <section id="top" className="hero-immersive">
      <div className="hero-waves-overlay" aria-hidden="true" />
      <SiteNav
        logo="/forgeweb-logo-gold.png"
        logoAlt="ForgeWeb gold FW monogram"
        items={[
          { label: "Home", href: "#top" },
          { label: "System", href: "#system" },
          { label: "Languages", href: "#languages" },
          { label: "Graph", href: "#graph" },
          { label: "APIs", href: "#integrations" },
        ]}
      />
      <div className="hero-sigil-wrap" aria-hidden="true"><MorphingSigil /></div>
      <div className="hero-content relative z-10 mx-auto flex w-full max-w-[1180px] items-center justify-center px-5 pb-24 pt-32 sm:px-8 sm:pt-36 lg:px-12">
        <div className="hero-center w-full text-center">
          <motion.div
            className="hero-badge mb-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.07] px-3 py-1.5 text-xs font-medium text-white shadow-sm"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
          >
            <Sparkles className="size-3.5 text-acid" />
            Intelligence you can inspect
            {llmStatus && (
              <span
                className={`ml-2 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                  llmStatus.mode === "ai-powered"
                    ? "bg-emerald-500/20 text-emerald-400"
                    : "bg-amber-500/20 text-amber-400"
                }`}
                title={llmStatus.mode === "ai-powered" ? `${llmStatus.provider} · ${llmStatus.model}` : "LLM not connected — using built-in templates"}
              >
                <span className={`inline-block size-1.5 rounded-full ${llmStatus.mode === "ai-powered" ? "bg-emerald-400" : "bg-amber-400"}`} />
                {llmStatus.mode === "ai-powered" ? "AI" : "Templates"}
              </span>
            )}
          </motion.div>
          <h1 className="sr-only">ForgeWeb secure full-stack application builder</h1>
          <KineticStatement />
          <p className="hero-support-copy mx-auto mt-5 max-w-2xl text-pretty text-base leading-7 text-white/68 sm:text-lg">
            ForgeWeb turns a rough brief into a secure full-stack app—then maps every requirement, file, test, and decision so you can trust what shipped.
          </p>

          <BorderGlow
            edgeSensitivity={32}
            glowColor="280 90 72"
            backgroundColor="#120F17"
            borderRadius={24}
            glowRadius={36}
            glowIntensity={0.8}
            coneSpread={25}
            animated={false}
            alwaysOn
            colors={["#c084fc", "#f472b6", "#38bdf8"]}
            className="hero-chat-shell mx-auto mt-8 w-full max-w-4xl text-left"
          >
            <form onSubmit={launchDemo} className="hero-chat-form">
              <div className="hero-chat-header">
                <div className="hero-chat-label"><span /> Ask ForgeWeb</div>
                <div className="hero-chat-security"><LockKeyhole className="size-3" /> {workflowMode === "safe" && safeStatus?.authenticated ? "Verified session active" : "Private build workspace"}</div>
              </div>
              {safeStatus?.enabled && (
                <div className="hero-workflow-row">
                  <div className="hero-workflow-switch" role="group" aria-label="Generation workflow">
                    <button type="button" className={workflowMode === "legacy" ? "is-active" : ""} onClick={() => setWorkflowMode("legacy")}>Standard</button>
                    <button type="button" className={workflowMode === "safe" ? "is-active" : ""} onClick={() => setWorkflowMode("safe")}><ShieldCheck /> Verified</button>
                  </div>
                  {workflowMode === "safe" && !safeStatus.authenticated && (
                    <input
                      type="password"
                      value={activationToken}
                      onChange={(event) => setActivationToken(event.target.value)}
                      className="hero-activation-token"
                      aria-label="Verified workflow activation token"
                      placeholder="Activation token"
                      autoComplete="off"
                    />
                  )}
                </div>
              )}
              <label className="sr-only" htmlFor="product-prompt">Describe your application</label>
              <textarea
                id="product-prompt"
                rows={4}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                className="hero-chat-input"
                placeholder="Describe the product you want to build…"
              />
              <div className="hero-chat-actions">
                <div className="flex flex-wrap gap-1.5">
                  {quickPrompts.map((item) => (
                    <button
                      type="button"
                      key={item}
                      onClick={() => setPrompt(`Build a secure ${item.toLowerCase()} with role-based access, tests, and a polished responsive interface.`)}
                      className="hero-chat-chip"
                    >
                      {item}
                    </button>
                  ))}
                </div>
                <button type="submit" className="button button-acid shrink-0" disabled={!ownerSession.user || running || prompt.trim().length < 12 || (workflowMode === "safe" && !safeStatus?.authenticated && activationToken.length < 1)}>
                  {running ? "Forging…" : "Forge this idea"}
                  {running ? <CircleDot className="size-4 animate-pulse" /> : <ArrowRight className="size-4" />}
                </button>
              </div>
              <div className="hero-build-status" aria-live="polite">
                <div className="hero-build-status-copy">
                  <span className="hero-build-status-icon"><ActiveStageIcon className="size-3.5" /></span>
                  <span>
                    {statusDetail}
                  </span>
                </div>
                <div className="hero-build-progress" aria-hidden="true">
                  {buildStages.map((item, index) => (
                    <i className={index <= stage ? "is-complete" : ""} key={item.label} />
                  ))}
                </div>
              </div>
            </form>
          </BorderGlow>
          <div className="hero-trust-row mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-white/55">
            <span className="flex items-center gap-1.5"><ShieldCheck className="size-3.5" /> Security gates included</span>
            <span className="flex items-center gap-1.5"><GitBranch className="size-3.5" /> Git-native history</span>
            <span className="flex items-center gap-1.5"><KeyRound className="size-3.5" /> Managed or BYOK</span>
          </div>
          <ProjectLibrary activeProjectId={build?.projectId} refreshToken={projectRefreshToken} userId={ownerSession.user?.id} busy={running} migration={ownerSession.migration}
            account={<OwnerAccess user={ownerSession.user} loading={ownerLoading} busy={running} onChanged={refreshOwner} />}
            onOpen={openSavedProject}
            onNew={() => { rememberProject(); setBuild(null); setStage(-1); setPrompt(""); setStatusDetail("Ready for a new project."); document.getElementById("product-prompt")?.focus(); window.scrollTo({ top: 0, behavior: "smooth" }); }}
            onDeleted={handleProjectDeleted}
            onClaimed={async () => { setOwnerSession(await getOwnerSession()); setProjectRefreshToken(value => value + 1); }} />
          <BuildProposal build={build} busy={running} onConfirm={confirmProposal} onRevise={build?.generationMode === "safe" ? undefined : reviseProposal} onProjectUpdated={() => setProjectRefreshToken((value) => value + 1)} />
        </div>
      </div>
      <div className="hero-scroll-cue"><span>SCROLL TO TRACE THE SYSTEM</span><i /></div>
    </section>
  );
}

function SignalBar() {
  return (
    <section className="border-y border-white/[0.08] bg-[#090b0c]" aria-label="Platform signals">
      <div className="mx-auto grid max-w-[1400px] divide-y divide-white/[0.08] px-5 sm:px-8 md:grid-cols-4 md:divide-x md:divide-y-0 lg:px-12">
        {[
          ["01", "Approved spec", "No generation before intent is clear."],
          ["02", "Secure sandbox", "Every build runs inside strict limits."],
          ["03", "Living graph", "Code and decisions stay connected."],
          ["04", "Evidence export", "Tests, security, and provenance included."],
        ].map(([index, title, copy]) => (
          <div className="py-6 md:px-6 md:first:pl-0 md:last:pr-0" key={index}>
            <p className="font-mono text-[10px] text-acid/70">/{index}</p>
            <p className="mt-2 text-sm font-semibold text-white">{title}</p>
            <p className="mt-1 text-pretty text-xs leading-5 text-white/45">{copy}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SystemSection() {
  const features = [
    {
      icon: WandSparkles,
      eyebrow: "CLARIFY",
      title: "It asks before it assumes.",
      copy: "A guided conversation turns your rough idea into a versioned master spec—with roles, data, flows, and security choices you can approve.",
    },
    {
      icon: Workflow,
      eyebrow: "ORCHESTRATE",
      title: "One build. Specialist stages.",
      copy: "Planning, architecture, code, tests, and security run as durable jobs with checkpoints, transparent progress, and bounded repair loops.",
    },
    {
      icon: ShieldCheck,
      eyebrow: "PROVE",
      title: "Success requires evidence.",
      copy: "ForgeWeb only marks a build complete when compilation, tests, security checks, graph integrity, and documentation meet the release gate.",
    },
  ];

  return (
    <section id="system" className="bg-[#090b0c] py-24 text-white sm:py-32">
      <div className="mx-auto max-w-[1400px] px-5 sm:px-8 lg:px-12">
        <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div>
            <p className="eyebrow"><Zap className="size-3.5" /> A better generation loop</p>
            <h2 className="mt-5 max-w-xl text-balance text-4xl font-semibold leading-tight text-white sm:text-6xl">From vague request to accountable software.</h2>
          </div>
          <p className="max-w-lg text-pretty text-base leading-7 text-white/52 lg:ml-auto">
            Most generators stop at files. ForgeWeb keeps the chain of intent intact—from your first sentence to the exact commit you export.
          </p>
        </div>

        <ScrollStack className="mt-16">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <ScrollStackItem key={feature.title} className={`scroll-stack-theme-${index + 1}`}>
                <div className="scroll-stack-number">0{index + 1}</div>
                <div className="scroll-stack-icon"><Icon /></div>
                <div className="scroll-stack-copy">
                  <p>{feature.eyebrow}</p>
                  <h3>{feature.title}</h3>
                  <span>{feature.copy}</span>
                </div>
                <div className="scroll-stack-signal">
                  {Array.from({ length: 9 }, (_, signal) => <i style={{ height: `${24 + ((signal * 19 + index * 13) % 72)}%` }} key={signal} />)}
                </div>
              </ScrollStackItem>
            );
          })}
        </ScrollStack>
      </div>
    </section>
  );
}

function GraphCanvas() {
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!root.current) return;

    const context = gsap.context(() => {
      const media = gsap.matchMedia();
      media.add("(prefers-reduced-motion: no-preference)", () => {
        const timeline = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });
        timeline
          .fromTo(".graph-edge", { strokeDashoffset: 90, opacity: 0.15 }, { strokeDashoffset: 0, opacity: 0.7, duration: 0.8, stagger: 0.08, ease: "power2.out" })
          .fromTo(".graph-node", { scale: 0.72, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.35, stagger: 0.06, transformOrigin: "center", ease: "back.out(1.4)" }, "-=0.5")
          .to(".graph-pulse", { scale: 1.55, opacity: 0, duration: 0.9, stagger: 0.18, transformOrigin: "center", ease: "power2.out" }, "+=0.35");
        return () => timeline.kill();
      });
      return () => media.revert();
    }, root);

    return () => context.revert();
  }, []);

  return (
    <div ref={root} className="relative min-h-[430px] overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.025]">
      <div className="graph-grid absolute inset-0" />
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 760 470" role="img" aria-label="Requirement to code and validation relationship graph">
        <g fill="none" stroke="#dfff68" strokeWidth="1.4" strokeDasharray="7 7">
          <path className="graph-edge" d="M147 234C226 234 228 114 318 114" />
          <path className="graph-edge" d="M147 234C236 234 230 234 318 234" />
          <path className="graph-edge" d="M147 234C226 234 228 354 318 354" />
          <path className="graph-edge" d="M358 114C443 114 448 179 525 179" />
          <path className="graph-edge" d="M358 234C442 234 445 234 525 234" />
          <path className="graph-edge" d="M358 354C445 354 448 289 525 289" />
          <path className="graph-edge" d="M565 179C632 179 625 234 678 234" />
          <path className="graph-edge" d="M565 234H678" />
          <path className="graph-edge" d="M565 289C632 289 625 234 678 234" />
        </g>

        {[
          { cx: 125, cy: 234, fill: "#dfff68", radius: 22 },
          { cx: 338, cy: 114, fill: "#f4f5ef", radius: 17 },
          { cx: 338, cy: 234, fill: "#f4f5ef", radius: 17 },
          { cx: 338, cy: 354, fill: "#f4f5ef", radius: 17 },
          { cx: 545, cy: 179, fill: "#dfff68", radius: 15 },
          { cx: 545, cy: 234, fill: "#dfff68", radius: 15 },
          { cx: 545, cy: 289, fill: "#dfff68", radius: 15 },
          { cx: 700, cy: 234, fill: "#f4f5ef", radius: 22 },
        ].map(({ cx, cy, fill, radius }, index) => (
          <g key={index}>
            {(index === 0 || index === 7) && <circle className="graph-pulse" cx={cx} cy={cy} r={radius + 8} fill="none" stroke="#dfff68" strokeWidth="1" />}
            <circle className="graph-node" cx={cx} cy={cy} r={radius} fill={fill} />
          </g>
        ))}
      </svg>
      <div className="absolute left-[5%] top-[43%] rounded-lg bg-ink/90 px-3 py-2 text-xs text-white shadow-lg">
        <span className="font-mono text-[9px] text-acid">REQ-014</span>
        <p className="mt-0.5 font-medium">Client file access</p>
      </div>
      <div className="absolute left-[38%] top-[12%] hidden rounded-lg border border-white/10 bg-[#1c211f] px-3 py-2 text-xs text-white sm:block">route.ts</div>
      <div className="absolute left-[38%] top-[42%] hidden rounded-lg border border-white/10 bg-[#1c211f] px-3 py-2 text-xs text-white sm:block">file-policy.ts</div>
      <div className="absolute left-[38%] bottom-[14%] hidden rounded-lg border border-white/10 bg-[#1c211f] px-3 py-2 text-xs text-white sm:block">file-access.spec.ts</div>
      <div className="absolute right-[2%] top-[42%] rounded-lg bg-white px-3 py-2 text-xs text-ink shadow-lg">
        <span className="font-mono text-[9px] text-muted">COMMIT</span>
        <p className="mt-0.5 font-semibold">4f2a91c</p>
      </div>
    </div>
  );
}

function GraphSection() {
  return (
    <section id="graph" className="bg-[#090b0c] px-3 py-24 sm:px-5 sm:py-32">
      <div className="mx-auto max-w-[1370px] overflow-hidden rounded-[2rem] border border-white/[0.08] bg-[#101412] px-5 py-16 text-white sm:px-10 sm:py-20 lg:px-16">
        <div className="grid gap-10 lg:grid-cols-[0.72fr_1.28fr] lg:items-center">
          <div>
            <p className="eyebrow !border-white/10 !bg-white/5 !text-acid"><Network className="size-3.5" /> Code review graph</p>
            <h2 className="mt-6 text-balance text-4xl font-semibold leading-tight sm:text-6xl">See why every line exists.</h2>
            <p className="mt-6 max-w-md text-pretty text-sm leading-7 text-white/55 sm:text-base">
              ForgeWeb joins structural code intelligence with product intent. Trace a requirement to its route, policy, database entity, tests, security controls, and accepted commit.
            </p>
            <ul className="mt-8 space-y-3 text-sm text-white/72">
              {[
                "Preview impact before accepting a change",
                "Separate parser facts from AI inference",
                "Keep every graph snapshot tied to Git",
              ].map((item) => (
                <li className="flex items-center gap-3" key={item}>
                  <span className="grid size-5 place-items-center rounded-full bg-acid text-ink"><Check className="size-3" strokeWidth={3} /></span>
                  {item}
                </li>
              ))}
            </ul>
            <a className="mt-9 inline-flex items-center gap-2 text-sm font-semibold text-acid hover:underline" href="#start">
              Explore the system <ArrowRight className="size-4" />
            </a>
          </div>
          <GraphCanvas />
        </div>
      </div>
    </section>
  );
}

function IntegrationsSection() {
  return (
    <section id="integrations" className="bg-[#090b0c] py-24 text-white sm:py-32">
      <div className="mx-auto max-w-[1400px] px-5 sm:px-8 lg:px-12">
        <div className="grid gap-10 lg:grid-cols-[0.82fr_1.18fr]">
          <div>
            <p className="eyebrow"><Globe2 className="size-3.5" /> API atlas</p>
            <h2 className="mt-5 max-w-lg text-balance text-4xl font-semibold leading-tight text-white sm:text-6xl">The right integration, with the right guardrails.</h2>
            <p className="mt-6 max-w-md text-pretty text-base leading-7 text-white/52">
              A curated discovery layer based on the Public APIs catalog helps ForgeWeb suggest useful services. Every candidate is re-checked for HTTPS, authentication, CORS, terms, and reliability before code is generated.
            </p>
            <a href="https://github.com/public-apis/public-apis" target="_blank" rel="noreferrer" className="mt-7 inline-flex items-center gap-2 text-sm font-semibold text-acid hover:underline">
              View reference catalog <ArrowRight className="size-4" />
            </a>
          </div>
          <div className="rounded-2xl border border-white/[0.09] bg-[#101412] p-3 shadow-sm sm:p-4">
            <div className="flex flex-col gap-3 border-b border-white/[0.08] p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-white"><Database className="size-4 text-acid" /> Suggested integrations</div>
              <div className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs text-white/48">
                <Search className="size-3.5" /> Search 40+ categories
              </div>
            </div>
            <div className="mt-3 grid gap-2">
              {apiExamples.map((api, index) => (
                <motion.div
                  key={api.name}
                  className="group flex items-center gap-4 rounded-xl border border-white/[0.04] bg-white/[0.035] p-4 transition-colors duration-150 hover:border-white/15"
                  whileHover={{ x: 3 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#1a201d] text-acid"><TerminalSquare className="size-4" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-white">{api.name}</p>
                      {index === 0 && <span className="rounded-full bg-acid px-2 py-0.5 text-[9px] font-semibold text-ink">MATCH 96%</span>}
                    </div>
                    <p className="mt-1 text-xs text-white/42">{api.category}</p>
                  </div>
                  <div className="hidden items-center gap-1.5 sm:flex">
                    <span className="api-chip"><LockKeyhole className="size-3" /> HTTPS</span>
                    <span className="api-chip">{api.auth}</span>
                    <span className="api-chip">{api.cors}</span>
                  </div>
                  <ChevronRight className="size-4 text-white/35 transition-transform duration-150 group-hover:translate-x-0.5" />
                </motion.div>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between gap-4 px-3 py-2 text-[11px] text-white/38">
              <span>Catalog is discovery data, not a trust guarantee.</span>
              <span className="font-mono tabular-nums">4 / 1425</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section id="start" className="bg-[#090b0c] px-3 pb-3 sm:px-5 sm:pb-5">
      <div className="relative mx-auto max-w-[1370px] overflow-hidden rounded-[2rem] border border-white/[0.08] bg-[#101412] px-6 py-20 sm:px-12 sm:py-28 lg:px-20">
        <div className="cta-grid absolute inset-0 opacity-35" aria-hidden="true" />
        <div className="relative z-10 grid gap-10 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="font-mono text-xs font-semibold text-acid/70">YOUR NEXT PRODUCT / STARTS HERE</p>
            <h2 className="mt-5 max-w-4xl text-balance text-5xl font-semibold leading-[0.96] text-white sm:text-7xl lg:text-8xl">Build something worth trusting.</h2>
          </div>
          <a href="#product-prompt" className="button button-acid min-w-44 justify-center">
            Open ForgeWeb <ArrowRight className="size-4" />
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-white/[0.07] bg-[#090b0c]">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6 px-5 py-8 text-xs text-white/42 sm:px-8 md:flex-row md:items-center md:justify-between lg:px-12">
        <BrandMark />
        <p>From idea to verified software.</p>
        <div className="flex gap-5">
          <a className="hover:text-white" href="./docs/PRD.md">PRD</a>
          <a className="hover:text-white" href="./docs/ARCHITECTURE.md">Architecture</a>
          <span>© 2026 ForgeWeb</span>
        </div>
      </div>
    </footer>
  );
}

export default function App() {
  return (
    <AnimatePresence mode="wait">
      <main className="site-shell min-h-dvh font-sans text-white">
        <div className="floating-lines-backdrop" aria-hidden="true">
          <Suspense fallback={<div className="floating-lines-fallback size-full" />}>
            <FloatingLines
              linesGradient={floatingLinesGradient}
              animationSpeed={1}
              interactive
              bendRadius={5}
              bendStrength={-2}
              mouseDamping={0.03}
              parallax
              parallaxStrength={0.1}
            />
          </Suspense>
        </div>
        <Hero />
        <SignalBar />
        <SystemSection />
        <LanguageShowcase />
        <GraphSection />
        <IntegrationsSection />
        <FinalCta />
        <Footer />
      </main>
    </AnimatePresence>
  );
}
