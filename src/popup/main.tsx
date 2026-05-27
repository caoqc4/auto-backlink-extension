import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowUpRight,
  Boxes,
  ClipboardCheck,
  Database,
  FileDown,
  FileUp,
  Globe2,
  LayoutDashboard,
  MousePointerClick,
  Plus,
  Radar,
  RefreshCcw,
  Search,
  Settings,
  Sparkles,
  Wand2
} from "lucide-react";
import {
  allImports,
  allCheckLogs,
  allDiscoveryTargets,
  allPages,
  allProjects,
  allSources,
  allSubmissions,
  bulkSavePages,
  bulkSaveSources,
  clearResourcePool,
  findSourceByRootDomain,
  getSettings,
  nowIso,
  findPageByUrl,
  saveDiscoveryTarget,
  saveImportBatch,
  savePage,
  saveProject,
  saveSource,
  saveSettings,
  saveSubmission,
  uid,
  upsertDiscoveryTargets,
  upsertSourcesAndPages,
  upsertSourcesByRootDomain
} from "../shared/db";
import { classifySource, pageAnalysisToSourcePatch, priorityForSource } from "../shared/classifier";
import { parseCsv, toCsv } from "../shared/csv";
import {
  classifyDirectoryQuality,
  executionClassLabel,
  executionClassRank,
  executionResourceClass,
  type ExecutionResourceClass
} from "../shared/executionClassification";
import { extractSpreadsheetId, restoreLocalDataFromGoogleSheets, syncLocalDataToGoogleSheets } from "../shared/googleSheets";
import { translateUi, type UiLanguage } from "./i18n";
import type {
  BacklinkCategory,
  BacklinkSource,
  BacklinkPage,
  BacklinkSubmission,
  CheckLog,
  DiscoveryTarget,
  AppSettings,
  ImportBatch,
  LinkVerification,
  LinkRel,
  PageAnalysis,
  Project,
  SubmissionStatus
} from "../shared/types";
import { hostnameFromUrl, normalizeUrl, rootDomainFromUrl } from "../shared/url";
import "./styles.css";

type TabKey = "dashboard" | "projects" | "sources" | "execute" | "settings";
type CommentLinkMode = "auto_recommend" | "none" | "website_field" | "body_html_anchor" | "body_bbcode_link";

let activeUiLanguage: UiLanguage = "zh-CN";

function t(value: string) {
  return translateUi(value, activeUiLanguage);
}

interface PageContext {
  title: string;
  url: string;
  rootDomain: string;
  language: string;
  visibleText: string;
  headings: string[];
  nearbyComments: string[];
}

interface AutoScreenState {
  running: boolean;
  checked: number;
  skipped: number;
  stoppedOnUrl: string;
  message: string;
  startedAt: string;
  updatedAt: string;
}

interface SeoCaptureStatus {
  status: "idle" | "captured" | "imported" | "failed" | "duplicate";
  provider: string;
  competitorDomain: string;
  rowCount: number;
  createdCount: number;
  updatedCount: number;
  pageCreatedCount: number;
  pageUpdatedCount: number;
  requestLabel?: string;
  message: string;
  updatedAt: string;
}

type OpportunityFilter = "all" | "direct" | "review" | "engage" | "skip";
type OpportunityKind = Exclude<OpportunityFilter, "all">;
type DiscoverySortMode = "new_opportunity" | "quality" | "occurrence" | "recent";
type SourceListItem = {
  source: BacklinkSource;
  pages: BacklinkPage[];
  opportunity: { kind: OpportunityKind; label: string };
  summaryLabel: string;
  queueRank: number;
  searchText: string;
};
type ResourcePoolModel = ReturnType<typeof buildResourcePoolModel>;

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("dashboard");
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>("zh-CN");
  const [projects, setProjects] = useState<Project[]>([]);
  const [sources, setSources] = useState<BacklinkSource[]>([]);
  const [pages, setPages] = useState<BacklinkPage[]>([]);
  const [submissions, setSubmissions] = useState<BacklinkSubmission[]>([]);
  const [imports, setImports] = useState<ImportBatch[]>([]);
  const [checkLogs, setCheckLogs] = useState<CheckLog[]>([]);
  const [discoveryTargets, setDiscoveryTargets] = useState<DiscoveryTarget[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [analysis, setAnalysis] = useState<PageAnalysis | null>(null);
  const [notice, setNotice] = useState("");

  activeUiLanguage = uiLanguage;
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0];

  async function refresh() {
    const [projectRows, sourceRows, pageRows, submissionRows, importRows, checkLogRows, discoveryTargetRows] = await Promise.all([
      allProjects(),
      allSources(),
      allPages(),
      allSubmissions(),
      allImports(),
      allCheckLogs(),
      allDiscoveryTargets()
    ]);
    setProjects(projectRows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    const usefulSources = sourceRows.filter((source) => !isSearchResultUrl(source.sourceUrl));
    const usefulPages = pageRows.filter((page) => !isSearchResultUrl(page.pageUrl));
    setSources(usefulSources.sort((a, b) => priorityRank(a.priorityLevel) - priorityRank(b.priorityLevel)));
    setPages(usefulPages);
    setSubmissions(submissionRows.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt)));
    setImports(importRows.sort((a, b) => b.importedAt.localeCompare(a.importedAt)));
    setCheckLogs(checkLogRows.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt)));
    setDiscoveryTargets(discoveryTargetRows.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)));
    if (!selectedProjectId && projectRows[0]) setSelectedProjectId(projectRows[0].id);
  }

  useEffect(() => {
    void refresh();
    void getSettings().then((settings) => setUiLanguage(settings.uiLanguage));
  }, []);

  const resourcePool = useMemo(() => buildResourcePoolModel(sources, pages), [sources, pages]);

  const stats = useMemo(() => {
    const candidateItems = resourcePool.items.filter((item) => sourcePassedDetectionFromPages(item.source, item.pages, item.opportunity));
    const skippedItems = resourcePool.items.filter((item) => item.opportunity.kind === "skip");
    const byPriority = candidateItems.reduce<Record<string, number>>((acc, item) => {
      acc[item.source.priorityLevel] = (acc[item.source.priorityLevel] ?? 0) + 1;
      return acc;
    }, {});
    return {
      projects: projects.length,
      sources: resourcePool.stats.totalDomains,
      activeSources: candidateItems.length,
      skippedSources: skippedItems.length,
      submissions: submissions.length,
      live: submissions.filter((item) => item.status.startsWith("live")).length,
      aLevel: byPriority.A ?? 0
    };
  }, [projects, sources, resourcePool.items, submissions]);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Backlink Forge</p>
          <h1>{t("外链工作台")}</h1>
        </div>
        <div className="headerActions">
          <button className="iconButton" onClick={() => void openSidePanel()} title={t("打开侧边栏")}>
            <MousePointerClick size={17} />
          </button>
          <button className="iconButton" onClick={() => openWorkbenchTab()} title={t("打开常驻工作台")}>
            <ArrowUpRight size={17} />
          </button>
          <button className="iconButton" onClick={() => void refresh()} title={t("刷新")}>
            <RefreshCcw size={17} />
          </button>
        </div>
      </header>

      <nav className="tabs">
        <TabButton active={activeTab === "dashboard"} icon={<LayoutDashboard size={16} />} label="总览" onClick={() => setActiveTab("dashboard")} />
        <TabButton active={activeTab === "projects"} icon={<Boxes size={16} />} label="项目" onClick={() => setActiveTab("projects")} />
        <TabButton active={activeTab === "sources"} icon={<Database size={16} />} label="资源池" onClick={() => setActiveTab("sources")} />
        <TabButton active={activeTab === "execute"} icon={<MousePointerClick size={16} />} label="执行" onClick={() => setActiveTab("execute")} />
        <TabButton active={activeTab === "settings"} icon={<Settings size={16} />} label="设置" onClick={() => setActiveTab("settings")} />
      </nav>

      {notice && <div className="notice">{notice}</div>}

      {activeTab === "dashboard" && (
        <Dashboard stats={stats} resourcePool={resourcePool} imports={imports} submissions={submissions} />
      )}
      {activeTab === "projects" && (
        <ProjectsPanel projects={projects} onSaved={() => void refresh()} />
      )}
      {activeTab === "sources" && (
        <SourcesPanel
          sources={sources}
          pages={pages}
          resourcePool={resourcePool}
          imports={imports}
          checkLogs={checkLogs}
          discoveryTargets={discoveryTargets}
          onRefresh={() => void refresh()}
          onNotice={setNotice}
          onImported={(message) => {
            setNotice(message);
            void refresh();
          }}
        />
      )}
      {activeTab === "execute" && (
        <ExecutePanel
          projects={projects}
          selectedProject={selectedProject}
          setSelectedProjectId={setSelectedProjectId}
          sources={sources}
          pages={pages}
          resourcePool={resourcePool}
          submissions={submissions}
          analysis={analysis}
          setAnalysis={setAnalysis}
          onNotice={setNotice}
          onSaved={() => void refresh()}
        />
      )}
      {activeTab === "settings" && <SettingsPanel uiLanguage={uiLanguage} onLanguageChange={setUiLanguage} onSaved={() => void refresh()} />}
    </main>
  );
}

function TabButton(props: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={props.active ? "tab active" : "tab"} onClick={props.onClick}>
      {props.icon}
      <span>{t(props.label)}</span>
    </button>
  );
}

function isBackgroundSyncMessage(message: string) {
  return message.includes("Google Sheets") && message.includes("同步");
}

function useAutoScreenState(onNotice: (message: string) => void, onSaved: () => void) {
  const [autoScreenState, setAutoScreenState] = useState<AutoScreenState | null>(null);
  const lastAutoScreenUpdateRef = useRef("");
  const lastAutoScreenDataRefreshRef = useRef(0);
  const onNoticeRef = useRef(onNotice);
  const onSavedRef = useRef(onSaved);

  useEffect(() => {
    onNoticeRef.current = onNotice;
    onSavedRef.current = onSaved;
  }, [onSaved, onNotice]);

  useEffect(() => {
    let cancelled = false;
    const loadState = async () => {
      const state = await chrome.runtime.sendMessage({ type: "GET_AUTO_SCREEN_STATE" }) as AutoScreenState;
      if (!cancelled) setAutoScreenState(state);
      if (!cancelled && state?.updatedAt && state.updatedAt !== lastAutoScreenUpdateRef.current) {
        lastAutoScreenUpdateRef.current = state.updatedAt;
        if (state.message && !isBackgroundSyncMessage(state.message)) onNoticeRef.current(state.message);
        const now = Date.now();
        const shouldRefreshData = !state.running || Boolean(state.stoppedOnUrl) || now - lastAutoScreenDataRefreshRef.current > 5000;
        if (shouldRefreshData) {
          lastAutoScreenDataRefreshRef.current = now;
          onSavedRef.current();
        }
      }
    };
    void loadState();
    const timer = window.setInterval(() => void loadState(), 1400);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return autoScreenState;
}

function useSeoCaptureStatus(onSaved: () => void) {
  const [status, setStatus] = useState<SeoCaptureStatus | null>(null);
  const lastUpdateRef = useRef("");
  const onSavedRef = useRef(onSaved);

  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  useEffect(() => {
    let cancelled = false;
    const loadStatus = async () => {
      const result = await chrome.storage.local.get("seoCaptureStatus") as { seoCaptureStatus?: SeoCaptureStatus };
      const nextStatus = result.seoCaptureStatus ?? null;
      if (!cancelled) setStatus(nextStatus);
      if (!cancelled && nextStatus?.updatedAt && nextStatus.updatedAt !== lastUpdateRef.current) {
        lastUpdateRef.current = nextStatus.updatedAt;
        if (nextStatus.status === "imported") onSavedRef.current();
      }
    };
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return status;
}

function Dashboard(props: {
  stats: { projects: number; sources: number; activeSources: number; skippedSources: number; submissions: number; live: number; aLevel: number };
  resourcePool: ResourcePoolModel;
  imports: ImportBatch[];
  submissions: BacklinkSubmission[];
}) {
  const topItems = props.resourcePool.items
    .filter((item) => sourcePassedDetectionFromPages(item.source, item.pages, item.opportunity))
    .slice(0, 5);
  return (
    <section className="panelStack">
      <div className="metricGrid">
        <Metric icon={<Boxes />} label="项目" value={props.stats.projects} />
        <Metric icon={<Database />} label="可执行" value={props.stats.activeSources} />
        <Metric icon={<Database />} label="总资源" value={props.stats.sources} />
        <Metric icon={<Radar />} label="已跳过" value={props.stats.skippedSources} />
        <Metric icon={<Radar />} label="A级资源" value={props.stats.aLevel} />
        <Metric icon={<ClipboardCheck />} label="已发布" value={props.stats.live} />
      </div>
      <section className="section">
        <div className="sectionHeader">
          <h2>{t("优先资源")}</h2>
          <span>{topItems.length} {t("条")}</span>
        </div>
        <SourceList items={topItems} compact />
      </section>
      <section className="section twoCol">
        <div>
          <h2>{t("最近导入")}</h2>
          <MiniList items={props.imports.slice(0, 4).map((item) => `${item.label || item.source}: ${item.createdCount} ${t("条")}`)} />
        </div>
        <div>
          <h2>{t("最近提交")}</h2>
          <MiniList items={props.submissions.slice(0, 4).map((item) => `${item.targetDomain} · ${item.status}`)} />
        </div>
      </section>
    </section>
  );
}

function Metric({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: number | string; detail?: string }) {
  return (
    <div className="metric">
      <div className="metricIcon">{icon}</div>
      <span>{t(label)}</span>
      <strong>{value}</strong>
      {detail && <small>{t(detail)}</small>}
    </div>
  );
}

function ResourceStatsExplainer({ stats, latestImport }: { stats: ResourcePoolModel["stats"]; latestImport?: ImportBatch }) {
  const importLine = latestImport
    ? `${t("最近导入")}：${latestImport.label || latestImport.source}，读取 ${latestImport.rowCount} 行，新增 ${latestImport.createdCount} 个域名，合并更新 ${latestImport.updatedCount} 个域名。`
    : `${t("最近导入")}：${t("暂无数据")}。`;
  return (
    <p className="sectionHint statsExplainer">
      {importLine}
      {" "}
      {activeUiLanguage === "en"
        ? `Cleaned XLSX imports are marked as analyzed resources, so they usually increase actionable candidates rather than pending prechecks. Total domains ${stats.totalDomains} = excluded ${stats.excludedDomains} + active ${stats.activeDomains}; active ${stats.activeDomains} = pending ${stats.pendingDetection} + review ${stats.secondReviewDomains} + actionable ${stats.passedDetection}. Excluded records are kept for audit and deduplication.`
        : `整理好的 XLSX 会直接标记为已分析资源，所以通常会增加“可执行候选”，不一定增加“待预检测”。总域名 ${stats.totalDomains} = 已排除 ${stats.excludedDomains} + 未排除 ${stats.activeDomains}；未排除 ${stats.activeDomains} = 待检测 ${stats.pendingDetection} + 待二检 ${stats.secondReviewDomains} + 可执行 ${stats.passedDetection}。已排除记录仍保留，用于审计和防重复导入。`}
    </p>
  );
}

function MiniList({ items }: { items: string[] }) {
  return items.length ? (
    <ul className="miniList">{items.map((item) => <li key={item}>{item}</li>)}</ul>
  ) : (
    <p className="empty">{t("暂无数据")}</p>
  );
}

function ProjectsPanel({ projects, onSaved }: { projects: Project[]; onSaved: () => void }) {
  const [draft, setDraft] = useState(defaultProject());
  const [targetKeywordsText, setTargetKeywordsText] = useState("");
  const [anchorTextsText, setAnchorTextsText] = useState("");

  async function save() {
    const current = nowIso();
    await saveProject({
      ...draft,
      id: draft.id || uid("prj"),
      targetKeywords: splitList(targetKeywordsText),
      anchorTexts: splitList(anchorTextsText),
      socialLinks: splitList(draft.socialLinks.join(",")),
      createdAt: draft.createdAt || current,
      updatedAt: current
    });
    setDraft(defaultProject());
    setTargetKeywordsText("");
    setAnchorTextsText("");
    onSaved();
  }

  function editProject(project: Project) {
    setDraft(project);
    setTargetKeywordsText(project.targetKeywords.join(", "));
    setAnchorTextsText(project.anchorTexts.join(", "));
  }

  return (
    <section className="panelStack">
      <section className="section">
        <div className="sectionHeader">
          <h2>{t("新增项目")}</h2>
          <button className="primaryButton" onClick={() => void save()}>
            <Plus size={16} /> {t("保存")}
          </button>
        </div>
        <div className="fieldGuide">
          <strong>{t("字段用途")}</strong>
          <span>{t("这些资料会同时用于外链平台表单、AI 生成评论/描述时的参考，以及你自己的项目管理记录。")}</span>
        </div>
        <div className="formGrid">
          <Field label="项目名" help="内部管理用，通常不提交给外链平台。" value={draft.projectName} onChange={(value) => setDraft({ ...draft, projectName: value })} />
          <Field label="网站 URL" help="提交表单里的网站/产品链接，也用于检测页面是否已出现你的外链。" value={draft.siteUrl} onChange={(value) => setDraft({ ...draft, siteUrl: value })} />
          <Field label="品牌名" help="提交给平台的产品名/昵称，也会作为 AI 生成内容的主语。" value={draft.brandName} onChange={(value) => setDraft({ ...draft, brandName: value })} />
          <Field label="联系邮箱" help="博客评论、目录提交、账号注册可能会用到。" value={draft.contactEmail} onChange={(value) => setDraft({ ...draft, contactEmail: value })} />
          <Field label="作者名" help="博客评论/Profile 的名称。可以是真人名或品牌相关作者名。" value={draft.authorName} onChange={(value) => setDraft({ ...draft, authorName: value })} />
          <Field label="分类" help="给目录站选择分类，也给 AI 判断项目语境。" value={draft.category} onChange={(value) => setDraft({ ...draft, category: value })} />
          <Field wide label="一句话描述" help="主要提交给目录站，也给 AI 生成短评论/简介时参考。" value={draft.shortDescription} onChange={(value) => setDraft({ ...draft, shortDescription: value })} />
          <Field wide multiline label="详细描述" help="给 AI 做上下文，不一定原样提交。适合写清楚功能、受众、差异点。" value={draft.longDescription} onChange={(value) => setDraft({ ...draft, longDescription: value })} />
          <Field wide label="目标关键词" help="给 AI 参考和资源分类用。支持空格短语，用逗号或换行分隔，如：ai video generator, free online games。" value={targetKeywordsText} onChange={setTargetKeywordsText} />
          <Field wide label="备用锚文本（可选）" help="不是必须填。AI 会优先根据页面内容自然生成；这里填可选候选，如：free AI video generator。" value={anchorTextsText} onChange={setAnchorTextsText} />
        </div>
      </section>
      <section className="section">
        <h2>{t("项目库")}</h2>
        <div className="projectList">
          {projects.map((project) => (
            <article className="projectRow" key={project.id}>
              <div>
                <strong>{project.projectName || project.brandName}</strong>
                <span>{project.siteUrl}</span>
              </div>
              <button className="ghostButton" onClick={() => editProject(project)}>{t("编辑")}</button>
            </article>
          ))}
          {!projects.length && <p className="empty">{t("先添加一个要推广的网站。")}</p>}
        </div>
      </section>
    </section>
  );
}

function SourcesPanel({
  sources,
  pages,
  resourcePool,
  imports,
  checkLogs,
  discoveryTargets,
  onImported,
  onNotice,
  onRefresh
}: {
  sources: BacklinkSource[];
  pages: BacklinkPage[];
  resourcePool: ResourcePoolModel;
  imports: ImportBatch[];
  checkLogs: CheckLog[];
  discoveryTargets: DiscoveryTarget[];
  onImported: (message: string) => void;
  onNotice: (message: string) => void;
  onRefresh: () => void;
}) {
  const [domain, setDomain] = useState("");
  const [query, setQuery] = useState("");
  const [opportunityFilter, setOpportunityFilter] = useState<OpportunityFilter>("all");
  const [page, setPage] = useState(1);
  const [activeTabUrl, setActiveTabUrl] = useState("");
  const autoScreenState = useAutoScreenState(onNotice, onRefresh);
  const seoCaptureStatus = useSeoCaptureStatus(onRefresh);
  const stats = resourcePool.stats;
  const prioritizeCheckLog = Boolean(autoScreenState?.running);
  const filtered = useMemo(() => {
    const cleanQuery = query.toLowerCase().trim();
    return resourcePool.items.filter((item) =>
      (!cleanQuery || item.searchText.includes(cleanQuery)) &&
      (opportunityFilter === "all" || item.opportunity.kind === opportunityFilter)
    );
  }, [resourcePool.items, query, opportunityFilter]);
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleItems = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => {
    setPage(1);
  }, [query, opportunityFilter]);

  useEffect(() => {
    let cancelled = false;
    const loadActiveUrl = async () => {
      const tab = await getActiveTab();
      if (!cancelled) setActiveTabUrl(tab?.url ?? "");
    };
    void loadActiveUrl();
    const timer = window.setInterval(() => void loadActiveUrl(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function handleFile(file: File) {
    const lowerName = file.name.toLowerCase();
    const result = lowerName.endsWith(".json")
      ? await importJson(await file.text(), file.name)
      : lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")
        ? await importXlsx(await file.arrayBuffer(), file.name)
        : await importCsv(await file.text(), file.name);
    onImported(
      `导入完成：读取 ${result.rowCount} 条，识别 ${result.validRowCount} 条；` +
      `新增 ${result.createdCount} 个域名，更新 ${result.updatedCount} 个域名；` +
      `页面新增 ${result.pageCreatedCount} 条，更新 ${result.pageUpdatedCount} 条`
    );
  }

  function openAhrefs() {
    const cleanDomain = rootDomainFromUrl(domain.trim());
    if (!cleanDomain) return;
    void recordManualDiscoveryDomain(cleanDomain, "ahrefs");
    chrome.runtime.sendMessage({ type: "OPEN_AHREFS", domain: cleanDomain });
  }

  function openSemrush() {
    const cleanDomain = rootDomainFromUrl(domain.trim());
    if (!cleanDomain) return;
    void recordManualDiscoveryDomain(cleanDomain, "semrush");
    chrome.runtime.sendMessage({ type: "OPEN_SEMRUSH", domain: cleanDomain });
  }

  async function exportSources() {
    const csv = toCsv(sources.map((source) => flatten(source as unknown as Record<string, unknown>)));
    downloadFile("backlink-sources.csv", csv, "text/csv");
  }

  async function clearSources() {
    const confirmed = window.confirm(
      "确认清空资源池？\n\n这会删除本地资源域名、外链页面、导入记录、检测流水和待拓展网站队列。Google Sheets 中已同步的数据不会自动删除。"
    );
    if (!confirmed) return;
    await clearResourcePool();
    onImported("资源池已清空，可以重新导入测试");
  }

  async function togglePrecheck() {
    if (autoScreenState?.running) {
      await chrome.runtime.sendMessage({ type: "STOP_AUTO_SCREEN" });
      onNotice("已请求关闭自动检查");
      return;
    }
    await chrome.runtime.sendMessage({ type: "START_AUTO_SCREEN", continuous: true, stopOnActionable: false, screenMode: "unverified" });
    onNotice("自动检查已开启；会持续检测未预检资源，直到列表结束或手动关闭");
  }

  async function precheckNextResource() {
    await chrome.runtime.sendMessage({ type: "START_AUTO_SCREEN", limit: 1, stopOnActionable: false, screenMode: "unverified" });
    onNotice("已启动单条资源预检测；会打开下一条候选资源并自动分析");
  }

  async function keepActiveResourcePage(scope: "page" | "domain") {
    const tab = await getActiveTab();
    const url = tab?.url ?? activeTabUrl;
    if (!isHttpUrl(url)) {
      onNotice("当前页不是可记录的网站页面");
      return;
    }
    if (scope === "domain") {
      await keepRootDomain(url, sources, onRefresh, onNotice, "Manually kept current domain from resource precheck panel");
    } else {
      await keepPageUrl(url, sources, onRefresh, onNotice, "Manually kept current page from resource precheck panel");
    }
  }

  async function skipActiveResourcePage(scope: "page" | "domain") {
    const tab = await getActiveTab();
    const url = tab?.url ?? activeTabUrl;
    if (!isHttpUrl(url)) {
      onNotice("当前页不是可记录的网站页面");
      return;
    }
    if (scope === "domain") {
      await skipRootDomain(url, sources, pages, onRefresh, onNotice, "Manually skipped current domain from resource precheck panel");
    } else {
      await skipPageUrl(url, sources, onRefresh, onNotice, "Manually skipped current page from resource precheck panel");
    }
  }

  async function enrichDiscoveryTargets() {
    const result = await chrome.runtime.sendMessage({ type: "ENRICH_DISCOVERY_TARGETS", limit: 8 }) as { ok?: boolean; checked?: number; updated?: number; failed?: number; message?: string };
    onNotice(result.message || `发现队列域名年龄补充完成：检查 ${result.checked ?? 0}，更新 ${result.updated ?? 0}，失败 ${result.failed ?? 0}`);
    onRefresh();
  }

  async function expandNextDiscoveryTarget(provider: "ahrefs" | "semrush") {
    const nextTarget = rankedDiscoveryTargets(discoveryTargets, "new_opportunity").find((target) => shouldExpandDiscoveryTarget(target));
    if (!nextTarget) {
      onNotice("发现队列里暂时没有待拓展的域名；可以先从执行页分析外链页，或手动输入竞品域名");
      return;
    }
    await queueDiscoveryTargetForSeo(nextTarget, provider);
    openSeoForDomain(nextTarget.rootDomain, provider);
    onNotice(`已从发现队列打开 ${provider}：${nextTarget.rootDomain}；结果页加载后点“导入当前页面外链结果”`);
    onRefresh();
  }

  return (
    <section className="panelStack">
      <section className="section">
        <div className="sectionHeader">
          <h2>{t("收集外链资源")}</h2>
          <button className="ghostButton" onClick={() => void exportSources()}>
            <FileDown size={16} /> {t("导出")}
          </button>
        </div>
        <div className="actionBands">
          <div className="actionBand">
            <div>
              <strong>{t("拓展外链数据")}</strong>
              <small>{t("打开 Ahrefs/Semrush 或导入 SEO 结果，用来补 DR、流量、引用域和新资源。")}</small>
            </div>
            <div className="toolbar sourceToolbar">
              <div className="inputWithIcon">
                <Globe2 size={16} />
                <input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder={t("输入竞品域名，如 example.com")} />
              </div>
              <button className="primaryButton" onClick={openAhrefs}>
                <ArrowUpRight size={16} /> {t("打开 Ahrefs")}
              </button>
              <button className="ghostButton" onClick={openSemrush}>
                <ArrowUpRight size={16} /> {t("打开 Semrush")}
              </button>
              <button className="ghostButton" onClick={() => void scrapeCurrentPage(onImported)}>
                <Activity size={16} /> {t("导入当前页面外链结果")}
              </button>
              <button className="ghostButton" onClick={() => void expandNextDiscoveryTarget("ahrefs")}>
                <ArrowUpRight size={16} /> {t("拓展下个域名外链 Ahrefs")}
              </button>
              <button className="ghostButton" onClick={() => void expandNextDiscoveryTarget("semrush")}>
                <ArrowUpRight size={16} /> {t("拓展下个域名外链 Semrush")}
              </button>
              <button className="ghostButton" onClick={() => void enrichDiscoveryTargets()}>
                <Radar size={16} /> {t("补充域名年龄")}
              </button>
            </div>
          </div>
          <div className="actionBand">
            <div>
              <strong>{t("资源预检测")}</strong>
              <small>{t("自动打开候选资源页，判断是否可留言、注册、提交；当前页可手动保留或跳过。")}</small>
            </div>
            <div className="toolbar sourceToolbar">
              <button className={autoScreenState?.running ? "ghostButton danger" : "ghostButton"} onClick={() => void togglePrecheck()}>
                <Radar size={16} /> {t(autoScreenState?.running ? "关闭资源预检测" : "连续资源预检测")}
              </button>
              <button className="ghostButton" onClick={() => void precheckNextResource()}>
                <Activity size={16} /> {t("预检测下一条")}
              </button>
              <button className="ghostButton" onClick={() => void keepActiveResourcePage("page")}>{t("保留页面")}</button>
              <button className="ghostButton" onClick={() => void keepActiveResourcePage("domain")}>{t("保留域名")}</button>
              <button className="ghostButton danger" onClick={() => void skipActiveResourcePage("page")}>{t("跳过页面")}</button>
              <button className="ghostButton danger" onClick={() => void skipActiveResourcePage("domain")}>{t("跳过域名")}</button>
              <label className="fileButton">
                <FileUp size={16} /> {t("导入 CSV/JSON/XLSX")}
                <input
                  type="file"
                  accept=".csv,.json,.xlsx,.xls"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void handleFile(file);
                  }}
                />
              </label>
              <button className="ghostButton danger" onClick={() => void clearSources()}>
                {t("清空资源池")}
              </button>
            </div>
            {isHttpUrl(activeTabUrl) && <small>{t("当前活动页：")}{rootDomainFromUrl(activeTabUrl)}</small>}
          </div>
        </div>
        {autoScreenState?.message && !isBackgroundSyncMessage(autoScreenState.message) && (
          <p className="sectionHint">
            {t("后台状态：")}{autoScreenState.message}
            {autoScreenState.running ? ` · 已检查 ${autoScreenState.checked} · 已跳过 ${autoScreenState.skipped}` : ""}
          </p>
        )}
        {seoCaptureStatus?.message && (
          <p className="sectionHint">
            {t("SEO 结果：")}{seoCaptureStatus.message}
            {seoCaptureStatus.competitorDomain ? ` · ${seoCaptureStatus.competitorDomain}` : ""}
            {seoCaptureStatus.requestLabel ? ` · ${seoCaptureStatus.requestLabel}` : ""}
            {seoCaptureStatus.status === "imported" ? ` · 新增 ${seoCaptureStatus.createdCount} 域名 / ${seoCaptureStatus.pageCreatedCount} 页面` : ""}
            {seoCaptureStatus.updatedAt ? ` · ${formatTime(seoCaptureStatus.updatedAt)}` : ""}
          </p>
        )}
      </section>
      <div className="metricGrid">
        <Metric icon={<Database size={22} />} label="总域名" value={stats.totalDomains} detail="资源库 root domain 去重" />
        <Metric icon={<Radar size={22} />} label="未排除域名" value={stats.activeDomains} detail={`待检测 ${stats.pendingDetection} + 待二检 ${stats.secondReviewDomains} + 可执行 ${stats.passedDetection}`} />
        <Metric icon={<ClipboardCheck size={22} />} label="可执行候选" value={stats.passedDetection} detail="已识别可处理页面" />
        <Metric icon={<Activity size={22} />} label="已排除/待检测/待二检" value={`${stats.excludedDomains}/${stats.pendingDetection}/${stats.secondReviewDomains}`} detail="跳过 / 未预检 / 需人工判断" />
      </div>
      <ResourceStatsExplainer stats={stats} latestImport={imports[0]} />
      {prioritizeCheckLog && <CheckLogPanel logs={checkLogs.slice(0, 10)} totalCount={checkLogs.length} />}
      <DiscoveryTargetPanel targets={discoveryTargets} onRefresh={onRefresh} onNotice={onNotice} />
      {!prioritizeCheckLog && <CheckLogPanel logs={checkLogs.slice(0, 10)} totalCount={checkLogs.length} />}
      <section className="section">
        <div className="sectionHeader">
          <h2>{t("资源池")}</h2>
          <div className="filterCluster">
            <span>{filtered.length ? `${(currentPage - 1) * pageSize + 1}-${(currentPage - 1) * pageSize + visibleItems.length} / ${filtered.length}` : "0 / 0"}</span>
            <select value={opportunityFilter} onChange={(event) => setOpportunityFilter(event.target.value as OpportunityFilter)}>
              <option value="all">{t("全部机会")}</option>
              <option value="direct">{t("可直接发外链")}</option>
              <option value="review">{t("人工判断")}</option>
              <option value="engage">{t("低价值互动")}</option>
              <option value="skip">{t("跳过")}</option>
            </select>
            <div className="inputWithIcon small">
              <Search size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索域名、URL、类型")} />
            </div>
          </div>
        </div>
        <p className="sectionHint">这里是全局资源总账。出现次数按不同竞品/发现来源去重累计；同一竞品同一页面重复出现只算一次。</p>
        <SourceList items={visibleItems} pages={pages} />
        {filtered.length > pageSize && (
          <div className="toolbar">
            <button className="ghostButton" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              {t("上一页")}
            </button>
            <span>{t("第")} {currentPage} / {totalPages}</span>
            <button className="ghostButton" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>
              {t("下一页")}
            </button>
          </div>
        )}
      </section>
    </section>
  );
}

function SourceList({
  sources = [],
  pages = [],
  items,
  compact = false
}: {
  sources?: BacklinkSource[];
  pages?: BacklinkPage[];
  items?: SourceListItem[];
  compact?: boolean;
}) {
  const [expandedSourceId, setExpandedSourceId] = useState("");
  const listItems = items ?? sources.map((source) => {
    const sourcePages = pagesForSource(source, pages);
    const opportunity = sourceDisplayOpportunityFromPages(source, sourcePages);
    return {
      source,
      pages: sourcePages,
      opportunity,
      summaryLabel: pageSummaryLabelFromPages(sourcePages),
      queueRank: sourceQueueRankFromPages(source, opportunity.kind, sourcePages),
      searchText: ""
    };
  });
  if (!listItems.length) return <p className="empty">{activeUiLanguage === "en" ? "No resources yet." : "暂无资源。"}</p>;
  return (
    <div className={compact ? "sourceList compact" : "sourceList"}>
      {listItems.map((item) => {
        const { source, opportunity } = item;
        const sourcePages = item.pages;
        const isSearchArtifact = isSearchResultUrl(source.sourceUrl);
        return (
          <article className="sourceCard" key={source.id}>
            <div className="sourceRow">
              <div className={`priority p${source.priorityLevel}`}>{source.priorityLevel}</div>
              <div className="sourceMain">
                <strong>{source.sourceDomain || source.rootDomain}</strong>
                <span>{source.sourceUrl}</span>
              </div>
              <div className="sourceMeta">
                <span>{opportunity.label}</span>
                <span>{item.summaryLabel}</span>
                <span>{labelForType(source.sourceType)}</span>
                <span>竞品出现 {sourceEvidenceCount(source)}</span>
                {source.discoveredOutboundDomains?.length ? <span>外链线索 {source.discoveredOutboundDomains.length}</span> : null}
                <span>{source.detectedRel}</span>
              </div>
              {!compact && (
                <div className="sourceActions">
                  <button className="ghostButton tiny" disabled={isSearchArtifact} onClick={() => openBestPageFromPages(source, sourcePages)}>{t("打开")}</button>
                  <button className="ghostButton tiny" onClick={() => setExpandedSourceId(expandedSourceId === source.id ? "" : source.id)}>
                    {t("页面")}
                  </button>
                </div>
              )}
            </div>
            {expandedSourceId === source.id && (
              <div className="pageList">
                {source.discoveredOutboundDomains?.length ? (
                  <div className="pageRow actionRow">
                    <span>外链扩展线索：{source.discoveredOutboundDomains.slice(0, 5).join(" / ")}</span>
                    <button className="ghostButton tiny" onClick={() => openSeoForDomain(source.discoveredOutboundDomains?.[0] ?? "", "ahrefs")}>查 Ahrefs</button>
                    <button className="ghostButton tiny" onClick={() => openSeoForDomain(source.discoveredOutboundDomains?.[0] ?? "", "semrush")}>查 Semrush</button>
                  </div>
                ) : null}
                {sourcePages.length ? sourcePages.slice(0, 12).map((page) => (
                  <button className="pageRow" key={page.id} onClick={() => openUrl(page.pageUrl)}>
                    <span>{pageLabel(page)}</span>
                    <strong>{page.opportunity} · 出现 {pageEvidenceCount(page)}</strong>
                  </button>
                )) : <p className="empty">这个域名还没有页面机会。</p>}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function CheckLogPanel({ logs, totalCount }: { logs: CheckLog[]; totalCount: number }) {
  return (
    <section className="section">
      <div className="sectionHeader">
        <h2>{activeUiLanguage === "en" ? "Check Log" : "检测流水"}</h2>
        <span>{logs.length ? (activeUiLanguage === "en" ? `Recent ${logs.length} / local ${totalCount}` : `最近 ${logs.length} 条 / 本地保留 ${totalCount} 条`) : t("暂无数据")}</span>
      </div>
      <p className="sectionHint">{activeUiLanguage === "en" ? "Shows the latest 10 background checks. Candidate domains are deduplicated by root domain." : "这里固定展示最近 10 条后台检测记录；候选域名按 root domain 去重，不代表本轮新增页面数。"}</p>
      <div className="checkLogList">
        {logs.map((log) => (
          <article className={`checkLogRow ${log.result}`} key={log.id}>
            <div>
              <strong>{checkLogResultLabel(log)}</strong>
              <span>{formatTime(log.checkedAt)} · {log.sourceRootDomain}{log.finalRootDomain && log.finalRootDomain !== log.sourceRootDomain ? ` -> ${log.finalRootDomain}` : ""}</span>
            </div>
            <div>
              <span>{activeUiLanguage === "en" ? "Queued: " : "候选："}{truncate(log.queuedUrl, 78)}</span>
              <span>{activeUiLanguage === "en" ? "Final: " : "落地："}{truncate(log.finalUrl, 78)}</span>
            </div>
            <div>
              <span>{log.reason}</span>
              <span>scope: {log.skipScope}</span>
            </div>
          </article>
        ))}
        {!logs.length && <p className="empty">{activeUiLanguage === "en" ? "After starting resource precheck, checked pages will appear here." : "启动资源预检测后，这里会显示后台实际检查过的页面。"}</p>}
      </div>
    </section>
  );
}

function ExecutionQueue(props: {
  sources: BacklinkSource[];
  pages: BacklinkPage[];
  resourcePool: ResourcePoolModel;
  project?: Project;
  submissions: BacklinkSubmission[];
  executionFilter: ExecutionFilter;
  executionQueueMode: ExecutionQueueMode;
  onAnalyzeItem: (item: { source: BacklinkSource; opportunity: { kind: OpportunityKind; label: string }; url: string }) => Promise<void>;
  onSaved: () => void;
  onNotice: (message: string) => void;
}) {
  const [expandedSourceId, setExpandedSourceId] = useState("");
  const executedRootDomains = projectExecutedRootDomains(props.submissions, props.project?.id);
  const queueOptions = executionQueueOptions(props.executionQueueMode);
  const allActionableCount = queueSourceItemsFromModel(props.resourcePool, new Set(), new Set(), queueOptions).length;
  const rawProjectEligible = queueSourceItemsFromModel(props.resourcePool, executedRootDomains, new Set(), queueOptions);
  const projectEligible = filterExecutionItems(rawProjectEligible, props.executionFilter);
  const actionable = projectEligible.slice(0, 25);
  const hiddenForProjectCount = Math.max(allActionableCount - rawProjectEligible.length, 0);
  const actionablePageCount = candidatePageCount(actionable);

  return (
    <section className="section">
      <div className="sectionHeader">
        <h2>{activeUiLanguage === "en" ? "Execution Candidates" : "待执行候选资源"}</h2>
        <span>{activeUiLanguage === "en" ? `${actionable.length} domains · ${actionablePageCount} pages${hiddenForProjectCount ? ` · processed ${hiddenForProjectCount}` : ""}` : `${actionable.length} 个域名 · ${actionablePageCount} 个页面${hiddenForProjectCount ? ` · 本项目已处理 ${hiddenForProjectCount}` : ""}`}</span>
      </div>
      <p className="sectionHint">{activeUiLanguage === "en" ? "Shows candidate domains for the current execution mode. Full review includes second-review items; actionable-only shows machine-confirmed pages." : "这里展示当前执行模式下的候选域名；全量人工队列包含待二检和可执行，只跑可执行则只显示机器已确认可处理的页面。"}</p>
      <div className="sourceList compact">
        {actionable.map(({ source, opportunity, pages: sourcePages, summaryLabel, url }) => {
          return (
            <article className="sourceCard" key={source.id}>
              <div className="sourceRow">
                <div className={`priority p${source.priorityLevel}`}>{source.priorityLevel}</div>
                <div className="sourceMain">
                  <strong>{source.sourceDomain || source.rootDomain}</strong>
                  <span>{source.sourceUrl}</span>
                </div>
                <div className="sourceMeta">
                  <span>{t(sourcePassedDetectionFromPages(source, sourcePages, opportunity) ? "可执行" : "待二检")}</span>
                  <span>{t(opportunity.label)}</span>
                  <span>{summaryLabel}</span>
                  <span>{executionClassDisplayLabel(source, sourcePages)}</span>
                  <span>{labelForType(source.sourceType)}</span>
                </div>
                <div className="sourceActions">
                  <button className="ghostButton tiny" onClick={() => void props.onAnalyzeItem({ source, opportunity, url })}>{t("分析")}</button>
                  <button className="ghostButton tiny" onClick={() => openBestPageFromPages(source, sourcePages)}>{t("打开")}</button>
                  <button className="ghostButton tiny" onClick={() => openUrl(source.sourceUrl, true)}>{t("来源")}</button>
                  <button className="ghostButton tiny" onClick={() => setExpandedSourceId(expandedSourceId === source.id ? "" : source.id)}>
                    {t("页面")}
                  </button>
                  <button className="ghostButton tiny" onClick={() => void keepSource(source, props.onSaved, props.onNotice, "Manually kept from execution queue")}>
                    {t("保留")}
                  </button>
                  <button className="ghostButton tiny" onClick={() => void skipSource(source, props.pages, props.onSaved, props.onNotice)}>
                    {t("跳过")}
                  </button>
                </div>
              </div>
              {expandedSourceId === source.id && (
                <div className="pageList scrollable">
                  {sourcePages.length ? sourcePages.map((page) => (
                    <div className="pageRow actionRow" key={page.id}>
                      <button onClick={() => openUrl(page.pageUrl, true)}>
                        <span>{pageLabel(page)}</span>
                        <strong>{t(page.opportunity)} · {activeUiLanguage === "en" ? "seen" : "出现"} {pageEvidenceCount(page)}</strong>
                      </button>
                      <button className="ghostButton tiny" onClick={() => void keepPage(page, props.sources, props.onSaved, props.onNotice, "Manually kept page from execution queue")}>{t("保留")}</button>
                      <button className="ghostButton tiny" onClick={() => void skipPageUrl(page.pageUrl, props.sources, props.onSaved, props.onNotice, "Manually skipped page from execution queue")}>{t("跳过")}</button>
                    </div>
                  )) : <p className="empty">{activeUiLanguage === "en" ? "This domain has no page opportunities yet." : "这个域名还没有页面机会。"}</p>}
              </div>
              )}
            </article>
          );
        })}
        {!actionable.length && <p className="empty">{activeUiLanguage === "en" ? "No execution candidates right now. Run resource precheck from the pool first." : "当前没有可执行候选资源；可先到资源池自动预检测一批。"}</p>}
      </div>
    </section>
  );
}

function DiscoveryTargetPanel({
  targets,
  onRefresh,
  onNotice
}: {
  targets: DiscoveryTarget[];
  onRefresh: () => void;
  onNotice: (message: string) => void;
}) {
  const [filter, setFilter] = useState<"expand" | "missing" | "failed">("expand");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sortMode, setSortMode] = useState<DiscoverySortMode>("new_opportunity");
  const activeTargets = useMemo(() => rankedDiscoveryTargets(targets, sortMode).filter((target) => target.status !== "imported" && target.status !== "ignored"), [targets, sortMode]);
  const expandableTargets = useMemo(() => activeTargets.filter(shouldExpandDiscoveryTarget), [activeTargets]);
  const missingDataTargets = useMemo(() => activeTargets.filter((target) => target.status !== "failed" && hasMissingDiscoveryQualityData(target)), [activeTargets]);
  const failedTargets = useMemo(() => activeTargets.filter((target) => target.status === "failed"), [activeTargets]);
  const filteredTargets = filter === "failed" ? failedTargets : filter === "missing" ? missingDataTargets : expandableTargets;
  const totalPages = Math.max(1, Math.ceil(filteredTargets.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visible = filteredTargets.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const completedCount = targets.filter((target) => target.status === "imported").length;
  const ignoredCount = targets.filter((target) => target.status === "ignored").length;
  const nextExpandable = expandableTargets[0];

  useEffect(() => {
    setPage(1);
  }, [filter, pageSize, sortMode, targets.length]);

  if (!targets.length) return null;
  async function expandNext(provider: "ahrefs" | "semrush") {
    if (!nextExpandable) {
      onNotice("待拓展网站里暂时没有可处理的域名");
      return;
    }
    await queueDiscoveryTargetForSeo(nextExpandable, provider);
    openSeoForDomain(nextExpandable.rootDomain, provider);
    onNotice(`已打开 ${provider} 拓展：${nextExpandable.rootDomain}`);
    onRefresh();
  }
  async function ignoreTarget(target: DiscoveryTarget) {
    await saveDiscoveryTarget({
      ...target,
      status: "ignored",
      lastSeenAt: nowIso(),
      notes: appendNote(target.notes, "Ignored from discovery target queue")
    });
    onNotice(`已忽略待拓展网站：${target.rootDomain}`);
    onRefresh();
  }
  return (
    <section className="section discoverySection">
      <div className="sectionHeader">
        <h2>{t("待拓展网站")}</h2>
        <span>
          {t("待拓展")} {expandableTargets.length} · {t("待补数据")} {missingDataTargets.length} · {t("失败")} {failedTargets.length} · {t("已完成")} {completedCount}
        </span>
        <div className="sourceActions">
          <button className="ghostButton tiny" onClick={() => void expandNext("ahrefs")}>{t("拓展下个域名外链 Ahrefs")}</button>
          <button className="ghostButton tiny" onClick={() => void expandNext("semrush")}>{t("拓展下个域名外链 Semrush")}</button>
        </div>
      </div>
      <p className="sectionHint">{activeUiLanguage === "en" ? "Shows only domains that still need action. Full records are in the Google Sheets discovery_targets sheet. Default sorting prioritizes newer high-quality opportunities." : "这里仅展示还需要操作的网站；完整记录在 Google Sheets 的 discovery_targets。默认按“新站机会”排序：DR、流量、引用域高且域名年龄短的网站优先。"}</p>
      <div className="discoveryToolbar">
        <div className="classSummary discoveryTabs">
          <button className={filter === "expand" ? "active" : ""} onClick={() => setFilter("expand")}>{t("待拓展")} {expandableTargets.length}</button>
          <button className={filter === "missing" ? "active" : ""} onClick={() => setFilter("missing")}>{t("待补数据")} {missingDataTargets.length}</button>
          <button className={filter === "failed" ? "active" : ""} onClick={() => setFilter("failed")}>{t("失败重试")} {failedTargets.length}</button>
        </div>
        <div className="filterCluster">
          <span>{filteredTargets.length ? `${(currentPage - 1) * pageSize + 1}-${(currentPage - 1) * pageSize + visible.length} / ${filteredTargets.length}` : "0 / 0"}</span>
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value as DiscoverySortMode)}>
            <option value="new_opportunity">{t("新站机会")}</option>
            <option value="quality">{t("高质量优先")}</option>
            <option value="occurrence">{t("出现次数")}</option>
            <option value="recent">{t("最近发现")}</option>
          </select>
          <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
            <option value={10}>{t("每页 10")}</option>
            <option value={20}>{t("每页 20")}</option>
            <option value={50}>{t("每页 50")}</option>
          </select>
        </div>
      </div>
      {!visible.length && (
        <p className="empty">
          {activeUiLanguage === "en" ? (filter === "expand" ? "No domains to expand right now. Analyze backlink pages from Execute, or enter a competitor domain manually." : "No records in this group.") : (filter === "expand" ? "当前没有待拓展网站；可以从执行页分析外链页，或手动输入竞品域名。" : "当前分组没有记录。")}
        </p>
      )}
      <div className="sourceList compact">
        {visible.map((target) => (
          <article className="sourceCard" key={target.id}>
            <div className="sourceRow">
              <div className={`priority ${priorityClassForDiscovery(target)}`}>{discoveryPriorityLabel(target)}</div>
              <div className="sourceMain">
                <strong>{target.rootDomain}</strong>
                <span>{target.sourcePageUrl || sourceLabelForDiscovery(target)}</span>
              </div>
              <div className="sourceMeta">
                <span>{t(discoveryStatusLabel(target))}</span>
                <span>{t(discoveryScoreLabel(sortMode))} {Math.round(discoveryTargetScore(target, sortMode))}</span>
                <span>DR {formatOptionalNumber(target.dr)}</span>
                <span>{activeUiLanguage === "en" ? "Traffic" : "流量"} {formatOptionalNumber(target.traffic)}</span>
                <span>{activeUiLanguage === "en" ? "Ref domains" : "引用域"} {formatOptionalNumber(target.refDomains)}</span>
                <span>{activeUiLanguage === "en" ? "Age" : "年龄"} {formatDomainAge(target)}</span>
                <span>{activeUiLanguage === "en" ? "Seen" : "出现"} {target.occurrenceCount}</span>
                <span>{activeUiLanguage === "en" ? "Sources" : "来源"} {target.seenSourceRootDomains?.length || target.discoveredOnPages?.length || 1}</span>
              </div>
              <div className="sourceActions">
                <button className="ghostButton tiny" onClick={() => void queueAndOpenDiscoveryTarget(target, "ahrefs", onRefresh)}>Ahrefs</button>
                <button className="ghostButton tiny" onClick={() => void queueAndOpenDiscoveryTarget(target, "semrush", onRefresh)}>Semrush</button>
                <button className="ghostButton tiny danger" onClick={() => void ignoreTarget(target)}>{t("忽略")}</button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {filteredTargets.length > pageSize && (
        <div className="toolbar">
          <button className="ghostButton" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>{t("上一页")}</button>
          <span>{t("第")} {currentPage} / {totalPages}</span>
          <button className="ghostButton" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>{t("下一页")}</button>
        </div>
      )}
      {(completedCount > 0 || ignoredCount > 0) && (
        <p className="sectionHint">{activeUiLanguage === "en" ? `${completedCount} completed and ${ignoredCount} ignored records are hidden by default. See Google Sheets for the full record.` : `已完成 ${completedCount} 个、已忽略 ${ignoredCount} 个默认隐藏，可在 Google Sheets 查看完整记录。`}</p>
      )}
    </section>
  );
}

function shouldExpandDiscoveryTarget(target: DiscoveryTarget) {
  return !target.seoCheckedAt && !["ignored", "imported", "seo_queued"].includes(target.status);
}

function rankedDiscoveryTargets(targets: DiscoveryTarget[], sortMode: DiscoverySortMode = "new_opportunity") {
  return [...targets].sort((a, b) => {
    if (sortMode === "recent") return b.lastSeenAt.localeCompare(a.lastSeenAt);
    if (sortMode === "occurrence") {
      const occurrenceDelta = (b.occurrenceCount || 1) - (a.occurrenceCount || 1);
      if (occurrenceDelta) return occurrenceDelta;
    }
    const scoreDelta = discoveryTargetScore(b, sortMode) - discoveryTargetScore(a, sortMode);
    if (scoreDelta) return scoreDelta;
    return b.lastSeenAt.localeCompare(a.lastSeenAt);
  });
}

function discoveryTargetScore(target: DiscoveryTarget, sortMode: DiscoverySortMode = "new_opportunity") {
  if (sortMode === "quality") return discoveryQualityScore(target);
  if (sortMode === "occurrence") return discoveryOccurrenceScore(target);
  return discoveryNewOpportunityScore(target);
}

function discoveryNewOpportunityScore(target: DiscoveryTarget) {
  const sourceCount = target.seenSourceRootDomains?.length || target.discoveredOnPages?.length || 1;
  const drScore = Math.min(target.dr ?? 0, 100);
  const trafficScore = target.traffic ? Math.min(Math.log10(target.traffic + 1) * 22, 130) : 0;
  const refDomainScore = target.refDomains ? Math.min(Math.log10(target.refDomains + 1) * 16, 80) : 0;
  const ageScore = newSiteAgeScore(target);
  const occurrenceScore = Math.min((target.occurrenceCount || 1) * 8, 60);
  const sourceScore = Math.min(sourceCount * 12, 60);
  const queuedPenalty = target.status === "seo_queued" ? 80 : 0;
  const failedPenalty = target.status === "failed" ? 35 : 0;
  const missingAgePenalty = target.domainAgeMonths === undefined ? 45 : 0;
  return drScore + trafficScore + refDomainScore + ageScore + occurrenceScore + sourceScore - queuedPenalty - failedPenalty - missingAgePenalty;
}

function discoveryQualityScore(target: DiscoveryTarget) {
  const sourceCount = target.seenSourceRootDomains?.length || target.discoveredOnPages?.length || 1;
  const occurrenceScore = Math.min((target.occurrenceCount || 1) * 14, 120);
  const sourceScore = Math.min(sourceCount * 24, 120);
  const drScore = Math.min(target.dr ?? 0, 100);
  const trafficScore = target.traffic ? Math.min(Math.log10(target.traffic + 1) * 18, 110) : 0;
  const refDomainScore = target.refDomains ? Math.min(Math.log10(target.refDomains + 1) * 18, 90) : 0;
  const ageScore = target.domainAgeMonths !== undefined ? Math.min(target.domainAgeMonths / 3, 80) : 0;
  const queuedPenalty = target.status === "seo_queued" ? 80 : 0;
  const failedPenalty = target.status === "failed" ? 25 : 0;
  return occurrenceScore + sourceScore + drScore + trafficScore + refDomainScore + ageScore - queuedPenalty - failedPenalty;
}

function discoveryOccurrenceScore(target: DiscoveryTarget) {
  const sourceCount = target.seenSourceRootDomains?.length || target.discoveredOnPages?.length || 1;
  const occurrenceScore = Math.min((target.occurrenceCount || 1) * 40, 240);
  const sourceScore = Math.min(sourceCount * 30, 160);
  const qualityScore = Math.min(target.dr ?? 0, 80) + (target.refDomains ? Math.min(Math.log10(target.refDomains + 1) * 10, 50) : 0);
  return occurrenceScore + sourceScore + qualityScore;
}

function newSiteAgeScore(target: DiscoveryTarget) {
  if (target.domainAgeMonths === undefined) return 0;
  if (target.domainAgeMonths <= 6) return 140;
  if (target.domainAgeMonths <= 24) return 140 - (target.domainAgeMonths - 6) * 3;
  if (target.domainAgeMonths <= 60) return 86 - (target.domainAgeMonths - 24) * 1.6;
  return Math.max(0, 28 - (target.domainAgeMonths - 60) * 0.3);
}

function discoveryScoreLabel(sortMode: DiscoverySortMode) {
  if (sortMode === "new_opportunity") return "机会分";
  if (sortMode === "quality") return "质量分";
  if (sortMode === "occurrence") return "出现分";
  return "排序分";
}

function hasMissingDiscoveryQualityData(target: DiscoveryTarget) {
  return !target.whoisCheckedAt || target.domainAgeMonths === undefined || target.dr === undefined || target.traffic === undefined || target.refDomains === undefined;
}

function discoveryPriorityLabel(target: DiscoveryTarget) {
  const score = discoveryTargetScore(target);
  if (score >= 260) return "A";
  if (score >= 180) return "B";
  if (score >= 100) return "C";
  return "D";
}

function priorityClassForDiscovery(target: DiscoveryTarget) {
  return `p${discoveryPriorityLabel(target)}`;
}

function discoveryStatusLabel(target: DiscoveryTarget) {
  if (target.status === "new") return "待拓展";
  if (target.status === "queued") return "已入队";
  if (target.status === "enriched") return "已补数据";
  if (target.status === "seo_queued") return "已打开";
  if (target.status === "failed") return "失败";
  if (target.status === "ignored") return "已忽略";
  return "已完成";
}

function sourceLabelForDiscovery(target: DiscoveryTarget) {
  if (target.discoveredFrom === "manual") return "手动输入";
  if (target.discoveredFrom === "ahrefs") return "Ahrefs 结果发现";
  if (target.discoveredFrom === "semrush") return "Semrush 结果发现";
  if (target.discoveredFrom === "import") return "导入发现";
  return target.sourceRootDomain ? `来自 ${target.sourceRootDomain}` : "页面外链发现";
}

function formatOptionalNumber(value?: number) {
  return value === undefined || value === null ? "未知" : value.toLocaleString();
}

function formatDomainAge(target: DiscoveryTarget) {
  if (target.domainAgeMonths !== undefined) {
    if (target.domainAgeMonths >= 12) return `${Math.floor(target.domainAgeMonths / 12)}年${target.domainAgeMonths % 12}月`;
    return `${target.domainAgeMonths}月`;
  }
  return target.domainCreatedAt ? target.domainCreatedAt.slice(0, 10) : "未知";
}

async function queueAndOpenDiscoveryTarget(target: DiscoveryTarget, provider: "ahrefs" | "semrush", onRefresh: () => void) {
  await queueDiscoveryTargetForSeo(target, provider);
  openSeoForDomain(target.rootDomain, provider);
  onRefresh();
}

async function queueDiscoveryTargetForSeo(target: DiscoveryTarget, provider: "ahrefs" | "semrush") {
  await saveDiscoveryTarget({
    ...target,
    provider,
    status: "seo_queued",
    seoCheckedAt: target.seoCheckedAt || "",
    lastSeenAt: nowIso(),
    notes: appendNote(target.notes, `Queued for ${provider} expansion`)
  });
}

async function recordManualDiscoveryDomain(rootDomain: string, provider: "ahrefs" | "semrush") {
  const current = nowIso();
  await upsertDiscoveryTargets([{
    id: uid("disc"),
    rootDomain,
    sourceRootDomain: "",
    sourcePageUrl: "",
    discoveredFrom: "manual",
    provider,
    status: "seo_queued",
    firstSeenAt: current,
    lastSeenAt: current,
    occurrenceCount: 1,
    discoveredOnPages: [],
    seenSourceRootDomains: [],
    whoisCheckedAt: "",
    seoCheckedAt: "",
    lastError: "",
    notes: `User entered domain and opened ${provider}`
  }]);
}

function PendingSubmissionList({
  submissions,
  onSaved,
  onNotice
}: {
  submissions: BacklinkSubmission[];
  onSaved: () => void;
  onNotice: (message: string) => void;
}) {
  const visible = submissions
    .filter(isValidSubmissionTarget)
    .slice()
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
    .slice(0, 6);
  if (!visible.length) return null;
  const validCount = submissions.filter(isValidSubmissionTarget).length;

  return (
    <section className="section">
      <div className="sectionHeader">
        <h2>{t("待查发布记录")}</h2>
        <span>{validCount} {t("条")}</span>
      </div>
      <p className="sectionHint">{activeUiLanguage === "en" ? "These are filled, submitted, or review records that are not confirmed live yet. Open the page, confirm manually, then click Check Result." : "这里是已模拟填表、已提交或待复查但还没确认上线的记录。打开页面后，人工确认评论已提交，再点“检查结果”。"}</p>
      <div className="sourceList compact">
        {visible.map((submission) => (
          <article className="sourceCard" key={submission.id}>
            <div className="sourceRow">
              <div className="priority pC">{activeUiLanguage === "en" ? "P" : "待"}</div>
              <div className="sourceMain">
                <strong>{submission.targetDomain || rootDomainFromUrl(submission.submittedUrl || submission.targetUrl)}</strong>
                <span>{submission.submittedUrl || submission.targetUrl}</span>
              </div>
              <div className="sourceMeta">
                <span>{submission.status}</span>
                <span>{submission.rel}</span>
                <span>{submission.checkedAt ? new Date(submission.checkedAt).toLocaleString() : t("未检查")}</span>
              </div>
              <div className="sourceActions">
                <button className="ghostButton tiny" onClick={() => openUrl(submission.submittedUrl || submission.targetUrl, true)}>{t("打开")}</button>
                <button className="ghostButton tiny danger" onClick={() => void rejectSubmission(submission, onSaved, onNotice)}>{t("未通过")}</button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

async function rejectSubmission(submission: BacklinkSubmission, onSaved: () => void, onNotice: (message: string) => void) {
  await saveSubmission({
    ...submission,
    status: "rejected",
    isLive: false,
    checkedAt: nowIso(),
    nextCheckAt: "",
    failureReason: submission.failureReason || "Manually marked as not approved or no longer visible",
    notes: appendNote(submission.notes, "Manually closed from pending publication records")
  });
  onSaved();
  onNotice(`已把 ${submission.targetDomain || rootDomainFromUrl(submission.targetUrl)} 标记为未通过，不再进入待查记录`);
}

function ExecutePanel(props: {
  projects: Project[];
  selectedProject?: Project;
  setSelectedProjectId: (id: string) => void;
  sources: BacklinkSource[];
  pages: BacklinkPage[];
  resourcePool: ResourcePoolModel;
  submissions: BacklinkSubmission[];
  analysis: PageAnalysis | null;
  setAnalysis: (analysis: PageAnalysis | null) => void;
  onNotice: (message: string) => void;
  onSaved: () => void;
}) {
  const [comment, setComment] = useState("");
  const [translatingComment, setTranslatingComment] = useState(false);
  const [commentLinkMode, setCommentLinkMode] = useState<CommentLinkMode>("auto_recommend");
  const [decisionNotice, setDecisionNotice] = useState("");
  const [publishNotice, setPublishNotice] = useState("");
  const [executionFilter, setExecutionFilter] = useState<ExecutionFilter>("all");
  const [executionQueueMode, setExecutionQueueMode] = useState<ExecutionQueueMode>("full_review");
  const [transientExcludedRoots, setTransientExcludedRoots] = useState<Set<string>>(() => new Set());
  const autoScreenState = useAutoScreenState(props.onNotice, props.onSaved);
  const [activeTabUrl, setActiveTabUrl] = useState("");
  const activeRootDomain = isHttpUrl(activeTabUrl) ? rootDomainFromUrl(activeTabUrl) : "";
  const activeSources = activeRootDomain ? props.sources.filter((source) => source.rootDomain === activeRootDomain) : [];

  useEffect(() => {
    let cancelled = false;
    const loadActiveUrl = async () => {
      const tab = await getActiveTab();
      if (!cancelled) setActiveTabUrl(tab?.url ?? "");
    };
    void loadActiveUrl();
    const timer = window.setInterval(() => void loadActiveUrl(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function analyzeActivePage() {
    let tab: chrome.tabs.Tab | undefined;
    const pendingUrl = await getPendingExecutionUrl();
    try {
      tab = await getActiveTab();
      if (!tab.id) return;
      const currentSource = sourceForUrl(props.sources, tab.url ?? "");
      const response = await sendTabMessage<PageAnalysis>(tab.id, {
        type: "ANALYZE_PAGE_V2",
        targetUrl: props.selectedProject?.siteUrl ?? "",
        competitorUrl: currentSource?.competitorDomain ?? ""
      }, { forceInject: true });
      props.setAnalysis(response);
      const effectiveOpportunity = currentSource
        ? opportunityFromAnalysisForSource(response, currentSource, props.pages)
        : opportunityFromAnalysis(response);
      await syncAnalyzedPage(response, effectiveOpportunity);
      if (pendingUrl && shouldMarkPendingUrl(response, pendingUrl)) {
        await syncAnalyzedPage(unavailableAnalysisFromUrl(pendingUrl, "Original URL redirected or became unavailable"));
        await clearPendingExecutionUrl();
      }
      props.onSaved();
      const message = effectiveOpportunity === "skip"
        ? `当前页面已标记为跳过：${analysisWorkflowLabel(response, currentSource, props.pages, effectiveOpportunity)}，队列已刷新`
        : `当前页面分析完成：${analysisWorkflowLabel(response, currentSource, props.pages, effectiveOpportunity)}，队列已刷新`;
      setDecisionNotice(message);
      props.onNotice(message);
    } catch (error) {
      if (tab?.url && isHttpUrl(tab.url)) {
        if (isContentScriptRuntimeError(error) && !isBrowserErrorTab(tab)) {
          await clearPendingExecutionUrl();
          const message = `当前页面已打开，但分析脚本报错，未标记跳过：${errorMessage(error)}`;
          setDecisionNotice(message);
          props.onNotice(message);
          return;
        }
        const fallback = unavailableAnalysisFromTab(tab);
        props.setAnalysis(fallback);
        await syncAnalyzedPage(fallback);
        if (pendingUrl && !sameUrl(pendingUrl, fallback.url)) {
          await syncAnalyzedPage(unavailableAnalysisFromUrl(pendingUrl, "Original URL redirected to blocked or unavailable page"));
        }
        await clearPendingExecutionUrl();
        props.onSaved();
        const message = "当前页面无法访问或浏览器阻止脚本，已标记为跳过，队列已刷新";
        setDecisionNotice(message);
        props.onNotice(message);
        return;
      }
      const message = errorMessage(error);
      setDecisionNotice(message);
      props.onNotice(message);
    }
  }

  async function captureActivePageDiscovery(outboundLimit = 250) {
    try {
      const tab = await getActiveTab();
      if (!tab.id || !isHttpUrl(tab.url ?? "")) {
        const message = "当前页不是可抓取的网站页面";
        setDecisionNotice(message);
        props.onNotice(message);
        return;
      }
      const response = await sendTabMessage<PageAnalysis>(tab.id, {
        type: "ANALYZE_PAGE_V2",
        targetUrl: props.selectedProject?.siteUrl ?? "",
        competitorUrl: sourceForUrl(props.sources, tab.url ?? "")?.competitorDomain ?? "",
        outboundLimit
      }, { forceInject: true });
      props.setAnalysis(response);
      const outboundDomains = outboundDomainsFromAnalysis(response);
      await recordDiscoveryTargetsFromAnalysis(response, outboundDomains);
      if (outboundDomains.length) {
        void chrome.runtime.sendMessage({
          type: "ENRICH_DISCOVERY_TARGETS",
          limit: Math.min(outboundDomains.length, 50),
          sourceRootDomain: response.rootDomain,
          sourcePageUrl: response.url
        }).catch(() => undefined);
      }
      props.onSaved();
      const message = outboundDomains.length
        ? `已${outboundLimit > 250 ? "深度" : ""}抓取当前页 ${outboundDomains.length} 个竞品网站：${outboundDomains.slice(0, 6).join("、")}${outboundDomains.length > 6 ? "..." : ""}；已加入待拓展网站并开始补注册时间`
        : "当前页没有发现可抓取的竞品网站";
      setDecisionNotice(message);
      props.onNotice(message);
    } catch (error) {
      const message = errorMessage(error);
      setDecisionNotice(message);
      props.onNotice(message);
    }
  }

  async function fillActivePage() {
    if (!props.selectedProject) {
      props.onNotice("请先创建并选择项目");
      return;
    }
    try {
      const tab = await getActiveTab();
      if (!tab.id) return;
      const currentUrl = tab.url ?? "";
      if (!isHttpUrl(currentUrl)) {
        const message = "当前标签不是网站页面，不会记录待查发布记录";
        setPublishNotice(message);
        props.onNotice(message);
        return;
      }
      const result = await sendTabMessage<{ ok: boolean; filled: number; message: string }>(tab.id, {
        type: "HUMAN_FILL_V2",
        payload: {
          project: props.selectedProject,
          commentText: comment,
          titleText: titleForCurrentDraft(props.selectedProject, props.analysis, comment),
          commentLinkMode
        }
      });
      if (result?.ok && result.filled > 0) {
        await recordSubmission(props.selectedProject, props.analysis, currentUrl);
        props.onSaved();
      }
      const message = result?.message ?? "已填表，请人工检查后提交";
      setPublishNotice(`${message}；人工提交后再点“检查结果”。`);
      props.onNotice(message);
    } catch (error) {
      const message = errorMessage(error);
      setPublishNotice(message);
      props.onNotice(message);
    }
  }

  function nextQueueItem(excludedUrls = new Set<string>(), excludedRootDomains = new Set<string>()) {
    const executedRootDomains = projectExecutedRootDomains(props.submissions, props.selectedProject?.id);
    transientExcludedRoots.forEach((rootDomain) => executedRootDomains.add(rootDomain));
    excludedRootDomains.forEach((rootDomain) => executedRootDomains.add(rootDomain));
    return filterExecutionItems(
      queueSourceItemsFromModel(props.resourcePool, executedRootDomains, excludedUrls, executionQueueOptions(executionQueueMode)),
      executionFilter
    )[0];
  }

  async function inspectQueueItem(
    next: { source: BacklinkSource; opportunity: { kind: OpportunityKind; label: string }; url: string },
    options: { announceSkip: boolean }
  ) {
    const url = next.url || bestPageUrl(next.source, props.pages);
    if (!url) {
      return "empty" as const;
    }

    let tab: chrome.tabs.Tab | undefined;
    try {
      await rememberPendingExecutionUrl(url);
      tab = await chrome.tabs.create({ url, active: true });
      if (!tab.id) return;
      const tabId = tab.id;
      await waitForTabComplete(tabId, 10000);
      tab = await chrome.tabs.get(tabId);

      const currentSource = sourceForUrl(props.sources, tab.url ?? "") || next.source;
      const response = await sendTabMessage<PageAnalysis>(tabId, {
        type: "ANALYZE_PAGE_V2",
        targetUrl: props.selectedProject?.siteUrl ?? "",
        competitorUrl: currentSource.competitorDomain ?? ""
      }, { forceInject: true });
      props.setAnalysis(response);
      const effectiveOpportunity = opportunityFromAnalysisForSource(response, currentSource, props.pages);
      await syncAnalyzedPage(response, effectiveOpportunity);
      if (shouldMarkPendingUrl(response, url)) {
        await syncAnalyzedPage(unavailableAnalysisFromUrl(url, "Original URL redirected or became unavailable"));
      }
      await clearPendingExecutionUrl();
      props.onSaved();
      const discoveredDomains = discoveredDomainsFromAnalysis(response);
      const discoveryText = discoveredDomains.length
        ? `；已提取 ${discoveredDomains.length} 个页面外链域名并开始补注册时间：${discoveredDomains.slice(0, 4).join("、")}${discoveredDomains.length > 4 ? "..." : ""}`
        : "";

      if (effectiveOpportunity === "skip") {
        await chrome.tabs.update(tabId, { active: true });
        if (options.announceSkip) {
          props.onNotice(`下一条建议跳过：${analysisWorkflowLabel(response, currentSource, props.pages, effectiveOpportunity)}，已停留在当前页，需人工确认后再跳过或保留${discoveryText}`);
        }
        return "skip" as const;
      }
      await chrome.tabs.update(tabId, { active: true });
      props.onNotice(`发现可继续处理的页面：${analysisWorkflowLabel(response, currentSource, props.pages, effectiveOpportunity)}，已停留在当前页${discoveryText}`);
      return "stop" as const;
    } catch (error) {
      if (tab?.id && isHttpUrl(tab.url ?? "") && !isBrowserErrorTab(tab)) {
        await clearPendingExecutionUrl();
        await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
        if (options.announceSkip) props.onNotice(`下一条页面已打开，但分析脚本报错，已停留在当前页且未标记跳过：${errorMessage(error)}`);
        return "stop" as const;
      }
      const fallback = tab?.url
        ? unavailableAnalysisFromTab({ ...tab, url: url || tab.url })
        : unavailableAnalysisFromUrl(url, "Page unavailable");
      props.setAnalysis(fallback);
      await syncAnalyzedPage(fallback);
      if (url && !sameUrl(url, fallback.url)) {
        await syncAnalyzedPage(unavailableAnalysisFromUrl(url, "Original URL redirected to blocked or unavailable page"));
      }
      await clearPendingExecutionUrl();
      props.onSaved();
      if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => undefined);
      if (options.announceSkip) props.onNotice(`下一条无法访问，已标记跳过：${errorMessage(error)}`);
      return "skip" as const;
    }
  }

  async function autoCheckNext() {
    const next = nextQueueItem();
    if (!next) {
      props.onNotice("没有可检查的下一条资源");
      return;
    }
    const result = await inspectQueueItem(next, { announceSkip: true });
    if (result === "skip") {
      setTransientExcludedRoots((current) => new Set([...current, next.source.rootDomain]));
    }
    if (result === "empty") props.onNotice("下一条资源没有可打开的 URL");
  }

  async function analyzeQueueItem(item: { source: BacklinkSource; opportunity: { kind: OpportunityKind; label: string }; url: string }) {
    const result = await inspectQueueItem(item, { announceSkip: true });
    if (result === "empty") props.onNotice("这个候选资源没有可打开的 URL");
  }

  async function autoScreenBatch() {
    await chrome.runtime.sendMessage({ type: "START_AUTO_SCREEN", projectId: props.selectedProject?.id, limit: 10, stopOnActionable: true });
    props.onNotice("后台自动筛选已启动；popup 关闭后任务也会继续");
  }

  async function stopAutoScreen() {
    await chrome.runtime.sendMessage({ type: "STOP_AUTO_SCREEN" });
    props.onNotice("已请求停止后台自动筛选");
  }

  async function skipActiveDomain() {
    const tab = await getActiveTab();
    const url = tab?.url ?? activeTabUrl;
    if (!isHttpUrl(url)) {
      setDecisionNotice("当前页不是可记录的网站页面");
      props.onNotice("当前页不是可记录的网站页面");
      return;
    }
    await skipRootDomain(url, props.sources, props.pages, props.onSaved, props.onNotice, "Manually skipped current domain from execution panel");
    await resumeAutoScreenIfPausedOn(url, props.selectedProject?.id, props.onNotice);
    await closeTabIfCurrent(tab);
  }

  async function skipActivePage() {
    const tab = await getActiveTab();
    const url = tab?.url ?? activeTabUrl;
    if (!isHttpUrl(url)) {
      setDecisionNotice("当前页不是可记录的网站页面");
      props.onNotice("当前页不是可记录的网站页面");
      return;
    }
    await skipPageUrl(url, props.sources, props.onSaved, props.onNotice, "Manually skipped current page from execution panel");
    const pendingUrl = await getPendingExecutionUrl();
    if (pendingUrl && !sameUrl(pendingUrl, url)) {
      await skipPageUrl(pendingUrl, props.sources, props.onSaved, props.onNotice, "Original opened URL skipped after redirect/current page review", false);
      await clearPendingExecutionUrl();
    }
    await resumeAutoScreenIfPausedOn(url, props.selectedProject?.id, props.onNotice);
    await closeTabIfCurrent(tab);
  }

  async function keepActiveDomain() {
    const tab = await getActiveTab();
    const url = tab?.url ?? activeTabUrl;
    if (!isHttpUrl(url)) {
      setDecisionNotice("当前页不是可记录的网站页面");
      props.onNotice("当前页不是可记录的网站页面");
      return;
    }
    await keepRootDomain(url, props.sources, props.onSaved, props.onNotice, "Manually kept current domain from execution panel");
    await closeTabIfCurrent(tab);
  }

  async function keepActivePage() {
    const tab = await getActiveTab();
    const url = tab?.url ?? activeTabUrl;
    if (!isHttpUrl(url)) {
      setDecisionNotice("当前页不是可记录的网站页面");
      props.onNotice("当前页不是可记录的网站页面");
      return;
    }
    await keepPageUrl(url, props.sources, props.onSaved, props.onNotice, "Manually kept current page from execution panel");
    await closeTabIfCurrent(tab);
  }

  async function markActiveProjectPendingReview() {
    if (!props.selectedProject) {
      props.onNotice("请先创建并选择项目");
      return;
    }
    const tab = await getActiveTab();
    const url = tab?.url ?? activeTabUrl;
    if (!isHttpUrl(url)) {
      setDecisionNotice("当前页不是可记录的网站页面");
      props.onNotice("当前页不是可记录的网站页面");
      return;
    }
    const rootDomain = rootDomainFromUrl(url);
    await recordProjectPendingReview(props.selectedProject, props.analysis, url, props.sources);
    await clearPendingExecutionUrl();
    props.onSaved();
    const next = nextQueueItem(new Set(), new Set([rootDomain]));
    await closeTabIfCurrent(tab);
    if (!next) {
      const message = `已把 ${rootDomain} 记为本项目待复查；没有可检查的下一条资源`;
      setDecisionNotice(message);
      props.onNotice(message);
      return;
    }
    const message = `已把 ${rootDomain} 记为本项目待复查，正在打开下一条`;
    setDecisionNotice(message);
    props.onNotice(message);
    const result = await inspectQueueItem(next, { announceSkip: true });
    if (result === "empty") props.onNotice("下一条资源没有可打开的 URL");
  }

  async function generateNaturalComment() {
    if (!props.selectedProject) {
      props.onNotice("请先创建并选择项目");
      return;
    }
    try {
      const settings = await getSettings();
      if (settings.aiProvider === "none" || !settings.aiApiKey || !settings.aiModel) {
        const message = "请先在设置里配置 AI 服务商、API Key 和模型";
        setPublishNotice(message);
        props.onNotice(message);
        return;
      }
      const tab = await getActiveTab();
      if (!tab.id) return;
      const context = await sendTabMessage<PageContext>(tab.id, { type: "EXTRACT_PAGE_CONTEXT_V2" }, { forceInject: true });
      const generated = await generateCommentWithAi(settings, props.selectedProject, props.analysis, context, commentLinkMode);
      setComment(generated.comment);
      const message = `AI 建议：${generated.recommendation}。已生成 ${generated.linkPlan}，请人工检查后再模拟填表。`;
      setPublishNotice(message);
      props.onNotice(message);
    } catch (error) {
      const message = errorMessage(error);
      setPublishNotice(message);
      props.onNotice(message);
    }
  }

  async function translateCommentToEnglish() {
    if (!props.selectedProject) {
      props.onNotice("请先创建并选择项目");
      return;
    }
    const sourceText = comment.trim();
    if (!sourceText) {
      const message = "请先输入或生成要翻译的文案";
      setPublishNotice(message);
      props.onNotice(message);
      return;
    }
    try {
      const settings = await getSettings();
      if (settings.aiProvider === "none" || !settings.aiApiKey || !settings.aiModel) {
        const message = "请先在设置里配置 AI 服务商、API Key 和模型";
        setPublishNotice(message);
        props.onNotice(message);
        return;
      }
      setTranslatingComment(true);
      let context: PageContext | null = null;
      const tab = await getActiveTab();
      if (tab.id) {
        try {
          context = await sendTabMessage<PageContext>(tab.id, { type: "EXTRACT_PAGE_CONTEXT_V2" }, { forceInject: true });
        } catch {
          context = null;
        }
      }
      const translated = await translateDraftToEnglish(settings, props.selectedProject, props.analysis, context, sourceText, commentLinkMode);
      setComment(translated);
      const message = "已翻译成英文，请人工检查语气、链接和平台规则后再模拟填表。";
      setPublishNotice(message);
      props.onNotice(message);
    } catch (error) {
      const message = errorMessage(error);
      setPublishNotice(message);
      props.onNotice(message);
    } finally {
      setTranslatingComment(false);
    }
  }

  async function verifyActivePage() {
    if (!props.selectedProject?.siteUrl) {
      props.onNotice("请先创建并选择项目，且项目里要有网站 URL");
      return;
    }
    try {
      const tab = await getActiveTab();
      if (!tab.id) return;
      const result = await sendTabMessage<LinkVerification>(tab.id, {
        type: "VERIFY_BACKLINK_V2",
        targetUrl: props.selectedProject.siteUrl,
        targetAnchors: [
          props.selectedProject.brandName,
          props.selectedProject.projectName,
          ...props.selectedProject.anchorTexts,
          ...props.selectedProject.targetKeywords
        ].filter(Boolean)
      }, { forceInject: true });
      await recordVerification(props.selectedProject, result, props.sources, props.submissions);
      props.onSaved();
      const message = result.found
        ? `检测到 ${result.count} 个项目链接：${verificationRelSummary(result)}，锚文本：${result.anchors.join(" / ") || "无文本"}`
        : result.suspectedLinks?.length
          ? `找到疑似锚文本但 href 不匹配：${result.suspectedLinks.map((link) => `${link.anchor} -> ${link.href}`).join("；")}，已记录为待复查`
        : result.textMentionFound
          ? `页面文字出现项目提及（${result.textMentions?.join(" / ") || "命中"}），但没有检测到真实 href 链接，已记录为待复查`
          : result.isPrivateArea
            ? `${result.privateAreaReason || "当前是后台设置页"}；请打开公开个人主页、About 页或帖子页后再检查`
          : "当前页没有检测到项目链接，已记录为待复查";
      setPublishNotice(message);
      props.onNotice(message);
    } catch (error) {
      const message = errorMessage(error);
      setPublishNotice(message);
      props.onNotice(message);
    }
  }

  const executedRootDomains = projectExecutedRootDomains(props.submissions, props.selectedProject?.id);
  const queueOptions = executionQueueOptions(executionQueueMode);
  const allProjectCandidates = queueSourceItemsFromModel(props.resourcePool, new Set(), new Set(), queueOptions);
  const rawCurrentProjectCandidates = queueSourceItemsFromModel(props.resourcePool, executedRootDomains, new Set(), queueOptions);
  const currentProjectCandidates = filterExecutionItems(rawCurrentProjectCandidates, executionFilter);
  const projectSubmissions = props.selectedProject
    ? props.submissions.filter((submission) => submission.projectId === props.selectedProject?.id)
    : [];
  const projectPendingRecords = projectSubmissions.filter((submission) =>
    ["filled", "waiting_manual_submit", "submitted", "pending_review"].includes(submission.status) &&
    isValidSubmissionTarget(submission)
  );
  const projectLiveSubmissions = projectSubmissions.filter((submission) => submission.status.startsWith("live")).length;
  const todayProcessedDomains = todayProjectProcessedRootDomains(projectSubmissions).size;
  const projectHiddenCount = Math.max(allProjectCandidates.length - currentProjectCandidates.length, 0);
  const currentProjectPageCount = candidatePageCount(currentProjectCandidates);
  const executionSummary = executionClassSummary(rawCurrentProjectCandidates);
  const fullReviewCount = queueSourceItemsFromModel(props.resourcePool, executedRootDomains, new Set(), executionQueueOptions("full_review")).length;
  const actionableOnlyCount = queueSourceItemsFromModel(props.resourcePool, executedRootDomains, new Set(), executionQueueOptions("actionable_only")).length;
  const activeStrategy = strategyForAnalysis(props.analysis);

  return (
    <section className="panelStack">
      <section className="section">
        <div className="sectionHeader">
          <h2>{t("项目执行台")}</h2>
          <select value={props.selectedProject?.id ?? ""} onChange={(event) => props.setSelectedProjectId(event.target.value)}>
            {props.projects.map((project) => (
              <option value={project.id} key={project.id}>{project.projectName || project.brandName}</option>
            ))}
          </select>
        </div>
        <div className="metricGrid compactMetrics executionMetrics">
          <Metric icon={<ClipboardCheck size={20} />} label="待执行域名" value={currentProjectCandidates.length} />
          <Metric icon={<Database size={20} />} label="候选页面" value={currentProjectPageCount} />
          <Metric icon={<Activity size={20} />} label="本项目已处理域名" value={projectHiddenCount} />
          <Metric icon={<MousePointerClick size={20} />} label="今日处理域名" value={todayProcessedDomains} />
          <Metric icon={<Sparkles size={20} />} label="待查/上线记录" value={`${projectPendingRecords.length}/${projectLiveSubmissions}`} />
        </div>
        <p className="sectionHint">{activeUiLanguage === "en" ? "The execution queue advances by domain and opens the best page by default. Full review includes second-review and actionable items; actionable-only limits the queue to confirmed candidates." : "执行队列以域名推进，每个域名默认打开最优子页面；全量人工队列包含待二检和可执行，也可以切到只跑可执行候选。"}</p>
        <div className="classSummary">
          <button
            type="button"
            className={executionQueueMode === "full_review" ? "active" : ""}
            onClick={() => setExecutionQueueMode("full_review")}
          >
            {t("全量人工队列")} {fullReviewCount}
          </button>
          <button
            type="button"
            className={executionQueueMode === "actionable_only" ? "active" : ""}
            onClick={() => setExecutionQueueMode("actionable_only")}
          >
            {t("只跑可执行")} {actionableOnlyCount}
          </button>
        </div>
        <div className="classSummary">
          {executionSummary.map((item) => (
            <button
              type="button"
              className={executionFilter === item.filter ? "active" : ""}
              key={item.filter}
              onClick={() => setExecutionFilter(item.filter)}
            >
              {t(item.label)} {item.count}
            </button>
          ))}
        </div>
        <div className="executionFlow">
          <div className="flowBlock primaryFlow">
            <span>{t("任务入口")}</span>
            <div className="toolbar compactToolbar">
              <button className="primaryButton" onClick={() => void autoCheckNext()}>
                <Activity size={16} /> {t("开始下一条")}
              </button>
            </div>
            <small>{activeUiLanguage === "en" ? (executionQueueMode === "full_review" ? "Open the first item in the full manual queue; review items stop for human judgment." : "Only open machine-confirmed actionable candidates.") : (executionQueueMode === "full_review" ? "打开全量人工队列第一条；待二检项会停留给人工判断，不能用就跳过，能用就生成文案/填表。" : "只打开机器已确认可执行的候选，适合后续更自动化的执行流程。")}</small>
            {executionFilter !== "all" && <small>{activeUiLanguage === "en" ? "Current filter: " : "当前只执行："}{t(executionFilterLabel(executionFilter))}。</small>}
          </div>
          <div className="flowBlock">
            <span>{t("当前页判定")}</span>
            <div className="toolbar compactToolbar">
              <button className="ghostButton" onClick={() => void analyzeActivePage()}>
                <Radar size={16} /> {t("重新分析")}
              </button>
              <button className="ghostButton" onClick={() => void captureActivePageDiscovery(250)}>
                <Activity size={16} /> {t("抓取竞品网站")}
              </button>
              <button className="ghostButton" onClick={() => void captureActivePageDiscovery(1000)}>
                <Radar size={16} /> {t("深度抓取")}
              </button>
              <button className="ghostButton" onClick={() => void keepActivePage()}>
                {t("保留页面")}
              </button>
              <button className="ghostButton" onClick={() => void keepActiveDomain()}>
                {t("保留域名")}
              </button>
              <button className="ghostButton" onClick={() => void markActiveProjectPendingReview()}>
                {t("本项目待复查/下一条")}
              </button>
              <button className="ghostButton danger" onClick={() => void skipActivePage()}>
                {t("跳过页面")}
              </button>
              <button className="ghostButton danger" onClick={() => void skipActiveDomain()}>
                {t("跳过域名")}
              </button>
            </div>
            <small>{activeUiLanguage === "en" ? "After the page loads, scrolling, registration, login, or field changes, run analysis again." : "页面加载完成、滚动到底部、注册/登录后字段变化时，再点重新分析。"}</small>
            {decisionNotice && <div className="inlineNotice">{decisionNotice}</div>}
          </div>
          <div className="flowBlock">
            <span>{t("发布动作")} · {t(activeStrategy.label)}</span>
            <div className="toolbar compactToolbar">
              <button className="ghostButton" onClick={() => void generateNaturalComment()}>
                <Sparkles size={16} /> {t(activeStrategy.generateLabel)}
              </button>
              <button className="ghostButton" disabled={translatingComment} onClick={() => void translateCommentToEnglish()}>
                <Globe2 size={16} /> {t(translatingComment ? "翻译中" : "翻译成英文")}
              </button>
              <button className="primaryButton warm" onClick={() => void fillActivePage()}>
                <Wand2 size={16} /> {t(activeStrategy.fillLabel)}
              </button>
              <button className="ghostButton" onClick={() => void verifyActivePage()}>
                <ClipboardCheck size={16} /> {t("检查结果")}
              </button>
            </div>
            <small>{t(activeStrategy.hint)}</small>
            {publishNotice && <div className="inlineNotice">{publishNotice}</div>}
          </div>
        </div>
        {autoScreenState?.message && (
          <p className="sectionHint">
            {t("后台状态：")}{autoScreenState.message}
            {autoScreenState.running ? ` · 已检查 ${autoScreenState.checked} · 已跳过 ${autoScreenState.skipped}` : ""}
          </p>
        )}
        {activeRootDomain && (
          <div className="currentPageBox">
            <span>{t("当前页：")}{activeRootDomain}</span>
            <strong>{activeSources.length ? `匹配 ${activeSources.length} 条资源` : "资源池暂无匹配，仍可跳过当前域名"}</strong>
            {activeSources.slice(0, 2).map((source) => (
              <small key={source.id}>{source.sourceDomain || source.rootDomain} · {source.status} · {sourceDisplayOpportunity(source, props.pages).label}</small>
            ))}
          </div>
        )}
        <label className="stackedField">
          <span>{t("评论/说明文本，可留空自动生成")}</span>
          {publishNotice && <small className="fieldNotice">{publishNotice}</small>}
          <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={4} placeholder={t("写入要填到评论框或说明字段里的内容。")} />
        </label>
        <label className="stackedField">
          <span>{t("评论链接方式")}</span>
          <select value={commentLinkMode} onChange={(event) => setCommentLinkMode(event.target.value as typeof commentLinkMode)}>
            <option value="auto_recommend">{t("自动判断推荐")}</option>
            <option value="none">{t("不在评论里放链接")}</option>
            <option value="website_field">{t("只填 Website/URL 字段")}</option>
            <option value="body_html_anchor">{t("正文 HTML 锚文本（人工确认）")}</option>
            <option value="body_bbcode_link">{t("正文 BBCode 链接（论坛/Profile）")}</option>
          </select>
          <small>博客评论默认优先试 HTML 锚文本；Profile 默认生成自然简介加裸链，也可切换 HTML 或 BBCode 链接重试。提交后点“检查发布结果”。</small>
        </label>
      </section>
      <ExecutionQueue
        sources={props.sources}
        pages={props.pages}
        resourcePool={props.resourcePool}
        project={props.selectedProject}
        submissions={props.submissions}
        executionFilter={executionFilter}
        executionQueueMode={executionQueueMode}
        onAnalyzeItem={analyzeQueueItem}
        onSaved={props.onSaved}
        onNotice={props.onNotice}
      />
      <PendingSubmissionList submissions={projectPendingRecords} onSaved={props.onSaved} onNotice={props.onNotice} />
      <section className="section">
        <h2>{t("页面分析结果")}</h2>
        {props.analysis ? (
          <>
            <div className="analysisGrid">
              <Badge label="类型" value={labelForType(props.analysis.pageType)} />
              <Badge label="页面状态" value={props.analysis.pageUnavailable ? "不存在/404" : "可访问"} />
              <Badge label="可发布表单" value={props.analysis.hasForm ? "有" : "无"} />
              <Badge label="登录" value={props.analysis.loginRequired ? "需要" : "未见"} />
              <Badge label="注册" value={props.analysis.registerRequired ? "可能需要" : "未见"} />
              <Badge label="验证码" value={props.analysis.captchaDetected ? "检测到" : "未见"} />
              <Badge label="目录提交信号" value={props.analysis.directorySubmissionDetected ? "有" : "未见"} />
              <Badge label="Profile 信号" value={props.analysis.profileCandidateDetected ? "有" : "未见"} />
              <Badge label="正文锚文本" value={props.analysis.commentHtmlAnchorLikely ? "可试" : "未见"} />
              <Badge label="提交入口" value={`${props.analysis.submissionLinks.length}`} />
              <Badge label="账号入口" value={`${props.analysis.accountLinks.length}`} />
              <Badge label="检测项目" value={props.selectedProject?.siteUrl ? rootDomainFromUrl(props.selectedProject.siteUrl) : "未设置"} />
              <Badge label="项目链接" value={projectLinkStatus(props.analysis, props.selectedProject)} />
              <Badge label="竞品链接" value={competitorLinkStatus(props.analysis)} />
              <Badge label="竞品锚文本" value={competitorAnchorStatus(props.analysis)} />
              <Badge label="发现竞品网站" value={discoveredDomainsStatus(props.analysis)} />
              <Badge label="付费/外链工厂" value={props.analysis.paidPlacementDetected ? "疑似" : "未见"} />
              <Badge label="noindex" value={props.analysis.noindex ? "是" : "否"} />
              <Badge label="可填字段" value={`${props.analysis.formFields.length}`} />
            </div>
            {discoveredDomainsFromAnalysis(props.analysis).length > 0 && (
              <div className="currentPageBox">
                <span>{t("本页发现的外链域名")}</span>
                <strong>{discoveredDomainsFromAnalysis(props.analysis).slice(0, 8).join(" · ")}</strong>
          <small>已写入待拓展网站；注册时间会自动补，DR/流量/引用域需打开 Ahrefs/Semrush 并导入或等待结果捕获后补齐。</small>
              </div>
            )}
          </>
        ) : (
          <p className="empty">{t("打开目标页面后点击分析。")}</p>
        )}
      </section>
    </section>
  );
}

function SettingsPanel({
  uiLanguage,
  onLanguageChange,
  onSaved
}: {
  uiLanguage: UiLanguage;
  onLanguageChange: (language: UiLanguage) => void;
  onSaved: () => void;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [syncingSheets, setSyncingSheets] = useState(false);
  const [restoringSheets, setRestoringSheets] = useState(false);
  const [syncNotice, setSyncNotice] = useState("");

  useEffect(() => {
    void getSettings().then(setSettings);
  }, []);

  async function save() {
    if (!settings) return;
    await saveSettings(settings);
    onLanguageChange(settings.uiLanguage);
  }

  async function updateUiLanguage(language: UiLanguage) {
    if (!settings) return;
    const nextSettings = { ...settings, uiLanguage: language };
    activeUiLanguage = language;
    setSettings(nextSettings);
    onLanguageChange(language);
    await saveSettings(nextSettings);
  }

  async function syncSheets() {
    if (!settings || syncingSheets) return;
    const spreadsheetId = extractSpreadsheetId(settings.googleSheetsId);
    if (!spreadsheetId) {
      setSyncNotice("请先填写 Google Sheets ID 或完整表格链接。");
      return;
    }
    if (!settings.googleOAuthClientId.trim()) {
      setSyncNotice("请先填写 Google OAuth Web Client ID。");
      return;
    }

    setSyncingSheets(true);
    setSyncNotice("准备同步到 Google Sheets");
    try {
      const nextSettings = { ...settings, googleSheetsId: spreadsheetId };
      setSettings(nextSettings);
      await saveSettings(nextSettings);
      const result = await syncLocalDataToGoogleSheets(spreadsheetId, nextSettings.googleOAuthClientId, setSyncNotice);
      const savedSettings = {
        ...nextSettings,
        lastGoogleSheetsSyncAt: result.syncedAt,
        lastGoogleSheetsSyncDirection: "push" as const
      };
      setSettings(savedSettings);
      await saveSettings(savedSettings);
      setSyncNotice(`同步完成：${result.tableCount} 个工作表，${result.rowCount} 行数据。`);
    } catch (error) {
      setSyncNotice(error instanceof Error ? error.message : "同步失败，请检查授权和表格权限。");
    } finally {
      setSyncingSheets(false);
    }
  }

  async function restoreFromSheets() {
    if (!settings || restoringSheets) return;
    const spreadsheetId = extractSpreadsheetId(settings.googleSheetsId);
    if (!spreadsheetId) {
      setSyncNotice("请先填写 Google Sheets ID 或完整表格链接。");
      return;
    }
    if (!settings.googleOAuthClientId.trim()) {
      setSyncNotice("请先填写 Google OAuth Web Client ID。");
      return;
    }
    const confirmed = window.confirm("会用 Google Sheets 中的数据覆盖本地资源池、页面、检测流水、项目和提交记录。继续吗？");
    if (!confirmed) return;

    setRestoringSheets(true);
    setSyncNotice("准备从 Google Sheets 恢复");
    try {
      const nextSettings = { ...settings, googleSheetsId: spreadsheetId };
      setSettings(nextSettings);
      await saveSettings(nextSettings);
      const result = await restoreLocalDataFromGoogleSheets(spreadsheetId, nextSettings.googleOAuthClientId, setSyncNotice);
      const savedSettings = {
        ...nextSettings,
        lastGoogleSheetsSyncAt: result.syncedAt,
        lastGoogleSheetsSyncDirection: "pull" as const
      };
      setSettings(savedSettings);
      await saveSettings(savedSettings);
      onSaved();
      setSyncNotice(`恢复完成：${result.rowCount} 行数据已写回本地。`);
    } catch (error) {
      setSyncNotice(error instanceof Error ? error.message : "恢复失败，请检查表格结构和授权。");
    } finally {
      setRestoringSheets(false);
    }
  }

  if (!settings) {
    return (
      <section className="section">
        <p className="empty">{t("正在加载设置。")}</p>
      </section>
    );
  }

  return (
    <section className="section">
      <div className="sectionHeader">
        <h2>{t("同步与 AI")}</h2>
        <button className="primaryButton" onClick={() => void save()}>{t("保存设置")}</button>
      </div>
      <div className="formGrid syncGrid">
        <label className="stackedField">
          <span>{t("UI 语言")}</span>
          <select value={settings.uiLanguage || uiLanguage} onChange={(event) => void updateUiLanguage(event.target.value as UiLanguage)}>
            <option value="zh-CN">{t("中文")}</option>
            <option value="en">{t("English")}</option>
          </select>
          <small>{t("界面语言会保存在本机扩展设置中。")}</small>
        </label>
        <Field
          wide
          label="Google Sheets ID / 链接"
          help="当前为单向快照同步：用本地资源池、页面、检测流水、项目和提交记录覆盖表格中的对应工作表。"
          value={settings.googleSheetsId}
          onChange={(value) => setSettings({ ...settings, googleSheetsId: value })}
        />
        <Field
          wide
          label="Google OAuth Web Client ID"
          help="在 Google Cloud 创建 OAuth 客户端时选择“Web 应用”，把生成的 client_id 填在这里。"
          value={settings.googleOAuthClientId}
          onChange={(value) => setSettings({ ...settings, googleOAuthClientId: value })}
        />
        <label className="stackedField">
          <span>{t("自动同步")}</span>
          <select
            value={settings.googleSheetsAutoSyncEnabled ? "on" : "off"}
            onChange={(event) => setSettings({ ...settings, googleSheetsAutoSyncEnabled: event.target.value === "on" })}
          >
            <option value="on">{t("开启")}</option>
            <option value="off">{t("关闭")}</option>
          </select>
          <small>{t("后台静默同步，不再占用执行页状态提示；如果授权缓存失效，会等你下一次手动同步。")}</small>
        </label>
        <Field
          label="变更阈值"
          help="后台检测累计多少条变更后自动推送一次。新安装默认 100，已有设置可手动调大。"
          value={String(settings.googleSheetsAutoSyncEveryChanges)}
          onChange={(value) => setSettings({ ...settings, googleSheetsAutoSyncEveryChanges: Math.max(1, Number(value) || 25) })}
        />
        <Field
          wide
          label="最小同步间隔（分钟）"
          help="作为低频定时兜底；新安装默认 30 分钟。"
          value={String(settings.googleSheetsAutoSyncMinIntervalMinutes)}
          onChange={(value) => setSettings({ ...settings, googleSheetsAutoSyncMinIntervalMinutes: Math.max(1, Number(value) || 10) })}
        />
        <div className="syncActions">
          <button className="primaryButton" disabled={syncingSheets || restoringSheets} onClick={() => void syncSheets()}>
            <FileUp size={15} />
            {t(syncingSheets ? "同步中" : "同步到 Google Sheets")}
          </button>
          <button className="ghostButton" disabled={syncingSheets || restoringSheets} onClick={() => void restoreFromSheets()}>
            <FileDown size={15} />
            {t(restoringSheets ? "恢复中" : "从 Google Sheets 恢复")}
          </button>
          {settings.googleSheetsId && (
            <button className="ghostButton" onClick={() => openUrl(`https://docs.google.com/spreadsheets/d/${extractSpreadsheetId(settings.googleSheetsId)}/edit`)}>
              <ArrowUpRight size={15} />
              {t("打开表格")}
            </button>
          )}
        </div>
        {syncNotice && <div className="notice wideNotice">{syncNotice}</div>}
        {settings.lastGoogleSheetsSyncAt && (
          <p className="sectionHint syncMeta">
            {t("最近同步：")}{t(settings.lastGoogleSheetsSyncDirection === "pull" ? "表格恢复到本地" : "本地推送到表格")} · {new Date(settings.lastGoogleSheetsSyncAt).toLocaleString()}
          </p>
        )}
      </div>
      <div className="formGrid">
        <label className="stackedField">
          <span>{t("AI 服务商")}</span>
          <select value={settings.aiProvider} onChange={(event) => setSettings({ ...settings, aiProvider: event.target.value as AppSettings["aiProvider"] })}>
            <option value="none">{t("不使用 AI")}</option>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="deepseek">DeepSeek</option>
            <option value="gemini">Gemini</option>
          </select>
          <small>{t("当前只用于“生成自然评论”，页面分析仍走本地规则。")}</small>
        </label>
        <Field label="模型" help="例如填你服务商支持的模型名；插件不强制默认模型。" value={settings.aiModel} onChange={(value) => setSettings({ ...settings, aiModel: value })} />
        <Field wide type="password" label="API Key" help="保存在本机扩展 IndexedDB，不会上传到我们的服务器。" value={settings.aiApiKey} onChange={(value) => setSettings({ ...settings, aiApiKey: value })} />
      </div>
      <div className="callout">
        <Sparkles size={18} />
        <span>{t("推荐先用轻量 AI 生成草稿，人检查后再模拟填表，最后人工提交。")}</span>
      </div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  help = "",
  wide = false,
  multiline = false,
  type = "text"
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string;
  wide?: boolean;
  multiline?: boolean;
  type?: string;
}) {
  return (
    <label className={wide ? "stackedField wide" : "stackedField"}>
      <span>{t(label)}</span>
      {multiline ? (
        <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={4} />
      ) : (
        <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
      )}
      {help && <small>{t(help)}</small>}
    </label>
  );
}

function Badge({ label, value }: { label: string; value: string }) {
  return (
    <div className="badge">
      <span>{t(label)}</span>
      <strong>{t(value)}</strong>
    </div>
  );
}

async function importCsv(text: string, fileName: string) {
  const rows = parseCsv(text);
  const items = rows
    .map((row) => sourceAndPageFromRow(row, fileName))
    .filter((item) => item.source.sourceUrl && item.source.rootDomain && !isSearchResultUrl(item.source.sourceUrl));
  const result = await upsertSourcesAndPages(items);
  await saveImportBatch({
    id: uid("imp"),
    source: "csv",
    label: fileName,
    importedAt: nowIso(),
    rowCount: rows.length,
    createdCount: result.createdCount,
    updatedCount: result.updatedCount,
    notes: `Popup CSV import; pages added ${result.pageCreatedCount}, updated ${result.pageUpdatedCount}`
  });
  return {
    rowCount: rows.length,
    validRowCount: items.length,
    createdCount: result.createdCount,
    updatedCount: result.updatedCount,
    pageCreatedCount: result.pageCreatedCount,
    pageUpdatedCount: result.pageUpdatedCount
  };
}

async function importJson(text: string, fileName: string) {
  const parsed = JSON.parse(text) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const items = rows
    .map((row) => sourceAndPageFromRow(row as Record<string, string>, fileName))
    .filter((item) => item.source.sourceUrl && item.source.rootDomain && !isSearchResultUrl(item.source.sourceUrl));
  const result = await upsertSourcesAndPages(items);
  await saveImportBatch({
    id: uid("imp"),
    source: "json",
    label: fileName,
    importedAt: nowIso(),
    rowCount: rows.length,
    createdCount: result.createdCount,
    updatedCount: result.updatedCount,
    notes: `Popup JSON import; pages added ${result.pageCreatedCount}, updated ${result.pageUpdatedCount}`
  });
  return {
    rowCount: rows.length,
    validRowCount: items.length,
    createdCount: result.createdCount,
    updatedCount: result.updatedCount,
    pageCreatedCount: result.pageCreatedCount,
    pageUpdatedCount: result.pageUpdatedCount
  };
}

async function importXlsx(buffer: ArrayBuffer, fileName: string) {
  const { default: readExcelFile } = await import("read-excel-file/browser");
  const sheets = await readExcelFile(buffer);
  const rows = sheets.flatMap(({ sheet, data }) => rowsFromSheetData(data, sheet));
  const items = rows
    .map((row) => sourceAndPageFromRow(row, fileName))
    .filter((item) => item.source.sourceUrl && item.source.rootDomain && !isSearchResultUrl(item.source.sourceUrl));
  const result = await upsertSourcesAndPages(items);
  const preparedTypeCounts = rows.reduce<Record<string, number>>((counts, row) => {
    const type = normalizedPreparedType(row) || "unknown";
    counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  }, {});
  await saveImportBatch({
    id: uid("imp"),
    source: "xlsx",
    label: fileName,
    importedAt: nowIso(),
    rowCount: rows.length,
    createdCount: result.createdCount,
    updatedCount: result.updatedCount,
    notes: [
      `Popup XLSX import; sheets ${sheets.length}`,
      `Pages added ${result.pageCreatedCount}, updated ${result.pageUpdatedCount}`,
      `Prepared types: ${Object.entries(preparedTypeCounts).map(([type, count]) => `${type}=${count}`).join(", ")}`
    ].join("\n")
  });
  return {
    rowCount: rows.length,
    validRowCount: items.length,
    createdCount: result.createdCount,
    updatedCount: result.updatedCount,
    pageCreatedCount: result.pageCreatedCount,
    pageUpdatedCount: result.pageUpdatedCount
  };
}

function rowsFromSheetData(data: unknown[][], sheetName: string) {
  const [headerRow, ...bodyRows] = data;
  const headers = (headerRow ?? []).map((value, index) => String(value ?? `Column ${index + 1}`).trim() || `Column ${index + 1}`);
  return bodyRows
    .map((row) => {
      const mapped: Record<string, unknown> = {};
      headers.forEach((header, index) => {
        mapped[header] = row[index] ?? "";
      });
      return normalizeImportRow(mapped, sheetName);
    })
    .filter((row) => Object.values(row).some(Boolean));
}

function normalizeImportRow(row: Record<string, unknown>, sheetName = "") {
  const normalized: Record<string, string> = {};
  Object.entries(row).forEach(([key, value]) => {
    normalized[String(key).trim()] = String(value ?? "").trim();
  });
  if (sheetName) normalized.__sheet = sheetName;
  return normalized;
}

function sourceAndPageFromRow(row: Record<string, string>, discoveredFrom: string): { source: BacklinkSource; page?: BacklinkPage } {
  const sourceUrl = normalizeUrl(
    firstValue(row, [
      "source_url",
      "Source URL",
      "Source Url",
      "Source url",
      "Referring page URL",
      "Referring Page URL",
      "Referring URL",
      "url",
      "URL",
      "backlink",
      "Backlink"
    ])
  );
  const preparedType = normalizedPreparedType(row);
  const linkStrategy = normalizedImportValue(firstValue(row, ["Link Strategy", "link_strategy", "strategy"]));
  const linkFormat = normalizedImportValue(firstValue(row, ["Link Format", "link_format", "format"]));
  const hasUrlField = booleanFromImport(firstValue(row, ["Has URL Field", "has_url_field", "URL Field"]));
  const hasCaptcha = booleanFromImport(firstValue(row, ["Has Captcha", "has_captcha", "Captcha"]));
  const sourceDiscoveredFrom = firstValue(row, ["Discovered From", "discovered_from", "discoveredFrom"]) || discoveredFrom;
  const targetUrl = firstValue(row, ["target_url", "Target URL", "Target Url", "Target url", "Target"]);
  const competitorDomain =
    firstValue(row, ["competitor", "Competitor", "target", "domain", "Domain"]) ||
    rootDomainFromUrl(targetUrl) ||
    competitorFromDiscoveredFrom(sourceDiscoveredFrom);
  const sourceTitle = firstValue(row, ["Source title", "Source Title", "title", "Title"]);
  const anchor = firstValue(row, ["Anchor", "anchor", "Anchor text", "Anchor Text"]);
  const firstSeen = firstValue(row, ["First seen", "First Seen", "first_seen"]);
  const lastSeen = firstValue(row, ["Last seen", "Last Seen", "last_seen"]);
  const classification = classifySource(sourceUrl, sourceTitle, JSON.stringify(row));
  const preparedCategory = categoryFromPreparedType(preparedType);
  const sourceType = preparedCategory ?? classification.type;
  const sourceTypeConfidence = preparedCategory ? 0.9 : classification.confidence;
  const current = nowIso();
  const isPreparedList = Boolean(preparedType);
  const isCaptcha = hasCaptcha === true;
  const source: BacklinkSource = {
    id: uid("src"),
    sourceDomain: hostnameFromUrl(sourceUrl),
    sourceUrl,
    rootDomain: rootDomainFromUrl(sourceUrl),
    discoveredFrom: sourceDiscoveredFrom,
    competitorDomain,
    sourceType,
    sourceTypeConfidence,
    dr: metricValue(firstValue(row, [
      "DR",
      "Domain Rating",
      "Domain rating",
      "domain_rating",
      "Ahrefs DR",
      "Authority Score",
      "Authority score",
      "Page ascore",
      "Page AS",
      "AS"
    ])),
    traffic: metricValue(firstValue(row, [
      "Traffic",
      "Organic traffic",
      "Organic Traffic",
      "Domain traffic",
      "Domain Traffic",
      "Referring domain traffic",
      "Referring Domain Traffic",
      "Referring page traffic",
      "Referring Page Traffic",
      "Page traffic",
      "Page Traffic",
      "Estimated traffic",
      "Estimated Traffic",
      "traffic"
    ])),
    firstSeenAt: firstSeen || current,
    lastSeenAt: lastSeen || current,
    occurrenceCount: 1,
    competitorCount: competitorDomain ? 1 : 0,
    requiresLogin: preparedType === "profile" ? true : null,
    requiresRegister: preparedType === "profile" ? true : null,
    requiresPayment: null,
    hasCaptcha: hasCaptcha ?? null,
    hasCloudflare: null,
    hasSubmitForm: preparedType === "directory" ? true : null,
    hasCommentForm: preparedType === "blog_comment" ? true : null,
    hasProfileField: preparedType === "profile" ? true : null,
    detectedRel: relFromRow(row),
    isNoindex: null,
    priorityLevel: isSearchResultUrl(sourceUrl) ? "X" : "D",
    status: isSearchResultUrl(sourceUrl) || isCaptcha ? "skipped" : isPreparedList ? "analyzed" : "new",
    failureReason: isSearchResultUrl(sourceUrl) ? "Search result page artifact" : isCaptcha ? "Imported row has captcha" : "",
    notes: [
      preparedType ? `Prepared type: ${preparedType}` : "",
      linkStrategy ? `Link strategy: ${linkStrategy}` : "",
      linkFormat ? `Link format: ${linkFormat}` : "",
      hasUrlField !== null ? `Has URL field: ${hasUrlField ? "yes" : "no"}` : "",
      hasCaptcha !== null ? `Has captcha: ${hasCaptcha ? "yes" : "no"}` : "",
      row.__sheet ? `Sheet: ${row.__sheet}` : "",
      sourceTitle ? `Title: ${sourceTitle}` : "",
      anchor ? `Anchor: ${anchor}` : "",
      targetUrl ? `Target: ${targetUrl}` : "",
      sourceDiscoveredFrom !== discoveredFrom ? `Discovered from: ${sourceDiscoveredFrom}` : "",
      firstSeen ? `First seen: ${firstSeen}` : "",
      lastSeen ? `Last seen: ${lastSeen}` : ""
    ].filter(Boolean).join("\n")
  };
  source.priorityLevel = priorityForSource(source);
  return { source, page: pageFromRow(source, row, sourceTitle, anchor, targetUrl, sourceDiscoveredFrom, current) };
}

function sourceFromRow(row: Record<string, string>, discoveredFrom: string): BacklinkSource {
  return sourceAndPageFromRow(row, discoveredFrom).source;
}

function pageFromRow(
  source: BacklinkSource,
  row: Record<string, string>,
  sourceTitle: string,
  anchor: string,
  targetUrl: string,
  discoveredFrom: string,
  current: string
): BacklinkPage | undefined {
  if (
    !source.sourceUrl ||
    source.status === "blacklisted" ||
    source.hasCloudflare ||
    source.hasCaptcha ||
    source.requiresPayment ||
    isSearchResultUrl(source.sourceUrl)
  ) return undefined;
  const preparedType = normalizedPreparedType(row);
  const linkStrategy = normalizedImportValue(firstValue(row, ["Link Strategy", "link_strategy", "strategy"]));
  const linkFormat = normalizedImportValue(firstValue(row, ["Link Format", "link_format", "format"]));
  const hasUrlField = booleanFromImport(firstValue(row, ["Has URL Field", "has_url_field", "URL Field"]));
  const isPreparedList = Boolean(preparedType);
  return {
    id: uid("pg"),
    sourceId: source.id,
    rootDomain: source.rootDomain,
    pageUrl: source.sourceUrl,
    pageTitle: sourceTitle,
    pageType: source.sourceType,
    discoveredFrom,
    competitorDomain: source.competitorDomain,
    competitorTargetUrl: targetUrl,
    competitorAnchor: anchor,
    competitorLinkCount: 1,
    occurrenceCount: 1,
    detectedRel: source.detectedRel,
    requiresLogin: preparedType === "profile" ? true : null,
    requiresRegister: preparedType === "profile" ? true : null,
    hasCaptcha: source.hasCaptcha,
    hasCloudflare: null,
    hasSubmitForm: preparedType === "directory" ? true : null,
    hasCommentForm: preparedType === "blog_comment" ? true : null,
    hasProfileField: preparedType === "profile" ? true : null,
    opportunity: opportunityFromPreparedRow(preparedType, linkStrategy, hasUrlField),
    status: isPreparedList ? "analyzed" : "new",
    failureReason: "",
    firstSeenAt: current,
    lastSeenAt: current,
    lastAnalyzedAt: isPreparedList ? current : "",
    notes: [
      preparedType ? `Prepared type: ${preparedType}` : "",
      linkStrategy ? `Link strategy: ${linkStrategy}` : "",
      linkFormat ? `Link format: ${linkFormat}` : "",
      hasUrlField !== null ? `Has URL field: ${hasUrlField ? "yes" : "no"}` : "",
      row["External links"] ? `External links: ${row["External links"]}` : "",
      row["Internal links"] ? `Internal links: ${row["Internal links"]}` : ""
    ].filter(Boolean).join("\n")
  };
}

function normalizedPreparedType(row: Record<string, string>) {
  const type = normalizedImportValue(firstValue(row, ["Type", "type", "Resource Type", "resource_type"]));
  if (["blog_comment", "blog-comment", "comment"].includes(type)) return "blog_comment";
  if (["profile", "profile_link", "profile-link"].includes(type)) return "profile";
  if (["directory", "product_submission", "product-submission", "submit_site", "submit-site"].includes(type)) return "directory";
  if (["forum_post", "forum-post", "thread", "reply"].includes(type)) return "forum_post";
  return "";
}

function categoryFromPreparedType(type: string): BacklinkCategory | null {
  if (type === "directory") return "product_submission";
  if (type === "blog_comment" || type === "profile" || type === "forum_post") return "ugc_comment_profile";
  return null;
}

function normalizedImportValue(value: string) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
}

function booleanFromImport(value: string): boolean | null {
  const clean = normalizedImportValue(value);
  if (!clean) return null;
  if (["true", "1", "yes", "y", "有", "是"].includes(clean)) return true;
  if (["false", "0", "no", "n", "无", "否"].includes(clean)) return false;
  return null;
}

function competitorFromDiscoveredFrom(value: string) {
  const clean = String(value ?? "").trim();
  if (!clean) return "";
  const candidate = clean.includes(":") ? clean.split(":").pop() ?? "" : clean;
  return rootDomainFromUrl(candidate);
}

function seoProviderFromUrl(url: string): "ahrefs" | "semrush" | "page" {
  const root = rootDomainFromUrl(url);
  if (root.includes("ahrefs")) return "ahrefs";
  if (root.includes("semrush")) return "semrush";
  return "page";
}

function competitorDomainFromSeoUrl(url: string) {
  try {
    const parsed = new URL(url);
    const candidate = parsed.searchParams.get("input") ||
      parsed.searchParams.get("q") ||
      parsed.searchParams.get("target") ||
      parsed.searchParams.get("domain") ||
      "";
    return candidate ? rootDomainFromUrl(candidate) : "";
  } catch {
    return "";
  }
}

function opportunityFromPreparedRow(type: string, linkStrategy: string, hasUrlField: boolean | null) {
  if (type === "blog_comment") return hasUrlField || linkStrategy === "url_field" ? "direct" : "review";
  if (type === "profile" || type === "forum_post") return "engage";
  if (type === "directory") return "review";
  return "review";
}

async function scrapeCurrentPage(onImported: (message: string) => void) {
  const tab = await getActiveTab();
  if (!tab.id) return;
  let response: { rows: Array<{ url: string; text: string; rel: string; rowText?: string; dr?: string; traffic?: string; targetUrl?: string }> };
  try {
    response = await sendTabMessage<{ rows: Array<{ url: string; text: string; rel: string; rowText?: string; dr?: string; traffic?: string; targetUrl?: string }> }>(tab.id, {
      type: "SCRAPE_AHREFS_ROWS"
    }, { forceInject: true });
  } catch (error) {
    onImported(errorMessage(error));
    return;
  }
  const current = nowIso();
  const provider = seoProviderFromUrl(tab.url ?? "");
  const competitorDomain = competitorDomainFromSeoUrl(tab.url ?? "") || rootDomainFromUrl(tab.url ?? "");
  const items = response.rows
    .filter((row) => /^https?:\/\//.test(row.url))
    .filter((row) => rootDomainFromUrl(row.url) !== rootDomainFromUrl(tab.url ?? ""))
    .map((row) => {
      const classification = classifySource(row.url, `${row.text} ${row.rowText ?? ""}`);
      const rootDomain = rootDomainFromUrl(row.url);
      const source: BacklinkSource = {
        id: uid("src"),
        sourceDomain: hostnameFromUrl(row.url),
        sourceUrl: row.url,
        rootDomain,
        discoveredFrom: provider,
        competitorDomain,
        sourceType: classification.type,
        sourceTypeConfidence: classification.confidence,
        dr: metricValue(row.dr ?? ""),
        traffic: metricValue(row.traffic ?? ""),
        firstSeenAt: current,
        lastSeenAt: current,
        occurrenceCount: 1,
        competitorCount: competitorDomain ? 1 : 0,
        requiresLogin: null,
        requiresRegister: null,
        requiresPayment: null,
        hasCaptcha: null,
        hasCloudflare: null,
        hasSubmitForm: null,
        hasCommentForm: null,
        hasProfileField: null,
        detectedRel: inferLinkRel(row.rel || row.rowText || ""),
        isNoindex: null,
        priorityLevel: "D",
        status: "new",
        failureReason: "",
        notes: [
          `Captured from ${provider}`,
          row.text ? `Anchor text: ${row.text}` : "",
          row.rowText ? `Row: ${truncate(row.rowText, 240)}` : ""
        ].filter(Boolean).join("\n")
      };
      source.priorityLevel = priorityForSource(source);
      const page: BacklinkPage = {
        id: uid("pg"),
        sourceId: source.id,
        rootDomain,
        pageUrl: row.url,
        pageTitle: row.text,
        pageType: source.sourceType,
        discoveredFrom: provider,
        competitorDomain,
        competitorTargetUrl: row.targetUrl || "",
        competitorAnchor: row.text,
        competitorLinkCount: 1,
        occurrenceCount: 1,
        detectedRel: source.detectedRel,
        requiresLogin: null,
        requiresRegister: null,
        hasCaptcha: null,
        hasCloudflare: null,
        hasSubmitForm: null,
        hasCommentForm: null,
        hasProfileField: null,
        opportunity: "review",
        status: "new",
        failureReason: "",
        firstSeenAt: current,
        lastSeenAt: current,
        lastAnalyzedAt: "",
        notes: row.rowText ? `Captured row: ${truncate(row.rowText, 240)}` : ""
      };
      return { source, page };
    });
  const result = await upsertSourcesAndPages(items);
  if ((provider === "ahrefs" || provider === "semrush") && competitorDomain) {
    await markDiscoveryTargetSeoImported(competitorDomain, provider, result.createdCount + result.updatedCount + result.pageCreatedCount + result.pageUpdatedCount);
  }
  await saveImportBatch({
    id: uid("imp"),
    source: provider === "semrush" ? "semrush" : provider === "ahrefs" ? "ahrefs" : "page",
    label: tab.title || tab.url || "current page",
    importedAt: current,
    rowCount: response.rows.length,
    createdCount: result.createdCount,
    updatedCount: result.updatedCount,
    notes: `Scraped visible links from ${provider}; pages added ${result.pageCreatedCount}, updated ${result.pageUpdatedCount}`
  });
  onImported(`当前页抓取完成：新增 ${result.createdCount} 个域名，更新 ${result.updatedCount} 个域名；页面新增 ${result.pageCreatedCount} 条`);
}

async function markDiscoveryTargetSeoImported(rootDomain: string, provider: "ahrefs" | "semrush", importedRecords: number) {
  const cleanRoot = rootDomainFromUrl(rootDomain);
  if (!cleanRoot) return;
  const target = (await allDiscoveryTargets()).find((item) => item.rootDomain === cleanRoot);
  if (!target) return;
  await saveDiscoveryTarget({
    ...target,
    provider,
    status: "imported",
    seoCheckedAt: nowIso(),
    lastSeenAt: nowIso(),
    notes: appendNote(target.notes, `Imported ${importedRecords} visible SEO records from ${provider}`)
  });
}

async function recordSubmission(project: Project, analysis: PageAnalysis | null, fallbackUrl: string) {
  const currentUrl = isHttpUrl(analysis?.url ?? "") ? analysis?.url ?? "" : fallbackUrl;
  if (!isHttpUrl(currentUrl)) return;
  const classification: BacklinkCategory = analysis?.pageType ?? "unknown";
  const sourcePatch = analysis ? pageAnalysisToSourcePatch(analysis) : null;
  const existing = await findSourceByRootDomain(rootDomainFromUrl(currentUrl));
  const source: BacklinkSource = existing
    ? {
        ...existing,
        sourceDomain: hostnameFromUrl(currentUrl),
        sourceType: sourcePatch?.sourceType ?? existing.sourceType,
        sourceTypeConfidence: Math.max(existing.sourceTypeConfidence, sourcePatch?.sourceTypeConfidence ?? 0),
        lastSeenAt: nowIso(),
        requiresLogin: sourcePatch?.requiresLogin ?? existing.requiresLogin,
        requiresRegister: sourcePatch?.requiresRegister ?? existing.requiresRegister,
        requiresPayment: sourcePatch?.requiresPayment ?? existing.requiresPayment,
        hasCaptcha: sourcePatch?.hasCaptcha ?? existing.hasCaptcha,
        hasCloudflare: sourcePatch?.hasCloudflare ?? existing.hasCloudflare,
        hasSubmitForm: sourcePatch?.hasSubmitForm ?? existing.hasSubmitForm,
        hasCommentForm: sourcePatch?.hasCommentForm ?? existing.hasCommentForm,
        hasProfileField: sourcePatch?.hasProfileField ?? existing.hasProfileField,
        detectedRel: sourcePatch?.detectedRel ?? existing.detectedRel,
        isNoindex: sourcePatch?.isNoindex ?? existing.isNoindex,
        status: "analyzed",
        notes: [existing.notes, `Executed for project: ${project.projectName || project.brandName}`].filter(Boolean).join("\n")
      }
    : {
        id: uid("src"),
        sourceDomain: hostnameFromUrl(currentUrl),
        sourceUrl: currentUrl,
        rootDomain: rootDomainFromUrl(currentUrl),
        discoveredFrom: "manual_execute",
        competitorDomain: "",
        sourceType: sourcePatch?.sourceType ?? classification,
        sourceTypeConfidence: sourcePatch?.sourceTypeConfidence ?? 0.5,
        firstSeenAt: nowIso(),
        lastSeenAt: nowIso(),
        occurrenceCount: 1,
        competitorCount: 0,
        requiresLogin: sourcePatch?.requiresLogin ?? null,
        requiresRegister: sourcePatch?.requiresRegister ?? null,
        requiresPayment: sourcePatch?.requiresPayment ?? null,
        hasCaptcha: sourcePatch?.hasCaptcha ?? null,
        hasCloudflare: sourcePatch?.hasCloudflare ?? null,
        hasSubmitForm: sourcePatch?.hasSubmitForm ?? null,
        hasCommentForm: sourcePatch?.hasCommentForm ?? null,
        hasProfileField: sourcePatch?.hasProfileField ?? null,
        detectedRel: sourcePatch?.detectedRel ?? "unknown",
        isNoindex: sourcePatch?.isNoindex ?? null,
        priorityLevel: "D",
        status: "analyzed",
        failureReason: "",
        notes: "Created from execute panel"
      };
  source.priorityLevel = priorityForSource(source);
  await saveSource(source);
  await saveSubmission({
    id: uid("sub"),
    projectId: project.id,
    sourceId: source.id,
    targetDomain: source.rootDomain,
    targetUrl: source.sourceUrl,
    submittedUrl: source.sourceUrl,
    backlinkType: source.sourceType,
    anchorText: project.anchorTexts[0] ?? project.brandName,
    contentUsed: "",
    accountUsed: "",
    emailUsed: project.contactEmail,
    status: "waiting_manual_submit",
    rel: analysis?.existingLinkRel ?? "unknown",
    isLive: analysis?.existingTargetLink ?? null,
    isIndexed: null,
    submittedAt: "",
    checkedAt: nowIso(),
    nextCheckAt: "",
    failureReason: "",
    notes: "Fields filled; waiting for manual submit"
  });
}

async function recordVerification(
  project: Project,
  verification: LinkVerification,
  sources: BacklinkSource[],
  submissions: BacklinkSubmission[]
) {
  const current = nowIso();
  const source = sourceForUrl(sources, verification.checkedUrl) ?? await findSourceByRootDomain(rootDomainFromUrl(verification.checkedUrl));
  const sourceId = source?.id ?? uid("src");
  if (!source) {
    const classification = classifySource(verification.checkedUrl, verification.checkedTitle);
    const newSource: BacklinkSource = {
      id: sourceId,
      sourceDomain: hostnameFromUrl(verification.checkedUrl),
      sourceUrl: verification.checkedUrl,
      rootDomain: rootDomainFromUrl(verification.checkedUrl),
      discoveredFrom: "verification",
      competitorDomain: "",
      sourceType: classification.type,
      sourceTypeConfidence: classification.confidence,
      firstSeenAt: current,
      lastSeenAt: current,
      occurrenceCount: 1,
      competitorCount: 0,
      requiresLogin: null,
      requiresRegister: null,
      requiresPayment: null,
      hasCaptcha: null,
      hasCloudflare: null,
      hasSubmitForm: null,
      hasCommentForm: null,
      hasProfileField: null,
      detectedRel: verification.rel,
      isNoindex: null,
      priorityLevel: "D",
      status: "analyzed",
      failureReason: "",
      notes: "Created from backlink verification"
    };
    newSource.priorityLevel = priorityForSource(newSource);
    await saveSource(newSource);
  } else {
    const updatedSource: BacklinkSource = {
      ...source,
      detectedRel: verification.found ? verification.rel : source.detectedRel,
      status: source.status === "skipped" ? source.status : "analyzed",
      lastSeenAt: current,
      notes: appendNote(source.notes, `Verified project link on ${verification.checkedUrl}: ${verification.found ? `${verification.count} · ${verification.rel}` : "not found"}`)
    };
    updatedSource.priorityLevel = priorityForSource(updatedSource);
    await saveSource(updatedSource);
  }

  const latestSubmissions = await allSubmissions();
  const existing = findPendingSubmissionForVerification(project.id, verification, latestSubmissions.length ? latestSubmissions : submissions);
  const status = statusFromVerification(verification);
  await saveSubmission({
    ...(existing ?? {}),
    id: existing?.id ?? uid("sub"),
    projectId: project.id,
    sourceId: existing?.sourceId || sourceId,
    targetDomain: rootDomainFromUrl(verification.checkedUrl),
    targetUrl: existing?.targetUrl || verification.checkedUrl,
    submittedUrl: verification.checkedUrl,
    backlinkType: source?.sourceType ?? "unknown",
    anchorText: verification.anchors[0] ?? existing?.anchorText ?? project.anchorTexts[0] ?? project.brandName,
    contentUsed: existing?.contentUsed ?? "",
    accountUsed: existing?.accountUsed ?? "",
    emailUsed: project.contactEmail,
    status,
    rel: verification.rel,
    isLive: verification.found,
    isIndexed: null,
    submittedAt: existing?.submittedAt || (verification.found ? current : ""),
    checkedAt: current,
    nextCheckAt: verification.found ? "" : nextCheckAt(current),
    failureReason: verification.found ? "" : "Project link not found on checked page",
    notes: appendNote(existing?.notes ?? "", [
      verification.hrefs.length ? `Hrefs: ${verification.hrefs.join(" | ")}` : "",
      verification.anchors.length ? `Anchors: ${verification.anchors.join(" | ")}` : "",
      verification.links?.length ? `Links: ${verification.links.map((link) => `${link.rel}${link.rawRel ? `(${link.rawRel})` : ""} ${link.anchor || "无文本"} -> ${link.href}`).join(" | ")}` : "",
      verification.suspectedLinks?.length ? `Suspected anchor text with non-target href: ${verification.suspectedLinks.map((link) => `${link.rel}${link.rawRel ? `(${link.rawRel})` : ""} ${link.anchor || "无文本"} -> ${link.href}`).join(" | ")}` : "",
      verification.textMentionFound ? `Text mentions without href: ${(verification.textMentions ?? []).join(" | ")}` : ""
    ].filter(Boolean).join("\n") || `Checked ${verification.checkedUrl}: ${verification.found ? status : "not found, keep pending"}`)
  });
}

async function recordProjectPendingReview(
  project: Project,
  analysis: PageAnalysis | null,
  currentUrl: string,
  sources: BacklinkSource[]
) {
  const current = nowIso();
  const rootDomain = rootDomainFromUrl(currentUrl);
  const sourcePatch = analysis && analysis.rootDomain === rootDomain ? pageAnalysisToSourcePatch(analysis) : null;
  const existingSource = sourceForUrl(sources, currentUrl) ?? await findSourceByRootDomain(rootDomain);
  const classification = classifySource(currentUrl, analysis?.title ?? "");
  const source: BacklinkSource = existingSource
    ? {
        ...existingSource,
        sourceDomain: hostnameFromUrl(currentUrl),
        sourceUrl: existingSource.sourceUrl || currentUrl,
        sourceType: sourcePatch?.sourceType ?? existingSource.sourceType,
        sourceTypeConfidence: Math.max(existingSource.sourceTypeConfidence, sourcePatch?.sourceTypeConfidence ?? 0),
        requiresLogin: sourcePatch?.requiresLogin ?? existingSource.requiresLogin,
        requiresRegister: sourcePatch?.requiresRegister ?? existingSource.requiresRegister,
        requiresPayment: sourcePatch?.requiresPayment ?? existingSource.requiresPayment,
        hasCaptcha: sourcePatch?.hasCaptcha ?? existingSource.hasCaptcha,
        hasCloudflare: sourcePatch?.hasCloudflare ?? existingSource.hasCloudflare,
        hasSubmitForm: sourcePatch?.hasSubmitForm ?? existingSource.hasSubmitForm,
        hasCommentForm: sourcePatch?.hasCommentForm ?? existingSource.hasCommentForm,
        hasProfileField: sourcePatch?.hasProfileField ?? existingSource.hasProfileField,
        detectedRel: sourcePatch?.detectedRel ?? existingSource.detectedRel,
        isNoindex: sourcePatch?.isNoindex ?? existingSource.isNoindex,
        status: existingSource.status === "skipped" ? "usable" : "analyzed",
        failureReason: existingSource.status === "skipped" ? "" : existingSource.failureReason,
        notes: appendNote(existingSource.notes, `Marked pending review for project: ${project.projectName || project.brandName} · ${current}`),
        lastSeenAt: current
      }
    : {
        id: uid("src"),
        sourceDomain: hostnameFromUrl(currentUrl),
        sourceUrl: currentUrl,
        rootDomain,
        discoveredFrom: "manual_execute",
        competitorDomain: analysis?.competitorDomain ?? "",
        sourceType: sourcePatch?.sourceType ?? classification.type,
        sourceTypeConfidence: sourcePatch?.sourceTypeConfidence ?? classification.confidence,
        firstSeenAt: current,
        lastSeenAt: current,
        occurrenceCount: 1,
        competitorCount: 0,
        requiresLogin: sourcePatch?.requiresLogin ?? analysis?.loginRequired ?? null,
        requiresRegister: sourcePatch?.requiresRegister ?? analysis?.registerRequired ?? null,
        requiresPayment: sourcePatch?.requiresPayment ?? analysis?.paidPlacementDetected ?? null,
        hasCaptcha: sourcePatch?.hasCaptcha ?? analysis?.captchaDetected ?? null,
        hasCloudflare: sourcePatch?.hasCloudflare ?? analysis?.cloudflareDetected ?? null,
        hasSubmitForm: sourcePatch?.hasSubmitForm ?? analysis?.directorySubmissionDetected ?? null,
        hasCommentForm: sourcePatch?.hasCommentForm ?? analysis?.commentHtmlAnchorLikely ?? null,
        hasProfileField: sourcePatch?.hasProfileField ?? analysis?.profileCandidateDetected ?? null,
        detectedRel: sourcePatch?.detectedRel ?? "unknown",
        isNoindex: sourcePatch?.isNoindex ?? analysis?.noindex ?? null,
        priorityLevel: "D",
        status: "analyzed",
        failureReason: "",
        notes: `Created while marking project pending review · ${current}`
      };
  source.priorityLevel = priorityForSource(source);
  await saveSource(source);

  const latestSubmissions = await allSubmissions();
  const existingSubmission = latestSubmissions
    .filter((submission) => submission.projectId === project.id && isValidSubmissionTarget(submission))
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
    .find((submission) => rootDomainFromUrl(submission.submittedUrl || submission.targetUrl) === rootDomain);

  await saveSubmission({
    ...(existingSubmission ?? {}),
    id: existingSubmission?.id ?? uid("sub"),
    projectId: project.id,
    sourceId: existingSubmission?.sourceId || source.id,
    targetDomain: rootDomain,
    targetUrl: existingSubmission?.targetUrl || currentUrl,
    submittedUrl: currentUrl,
    backlinkType: source.sourceType,
    anchorText: existingSubmission?.anchorText ?? project.anchorTexts[0] ?? project.brandName,
    contentUsed: existingSubmission?.contentUsed ?? "",
    accountUsed: existingSubmission?.accountUsed ?? "",
    emailUsed: project.contactEmail,
    status: "pending_review",
    rel: existingSubmission?.rel ?? source.detectedRel ?? "unknown",
    isLive: existingSubmission?.isLive ?? null,
    isIndexed: existingSubmission?.isIndexed ?? null,
    submittedAt: existingSubmission?.submittedAt ?? "",
    checkedAt: current,
    nextCheckAt: nextCheckAt(current),
    failureReason: "Manually marked as handled for this project",
    notes: appendNote(existingSubmission?.notes ?? "", `Project-only pending review: ${currentUrl} · ${current}`)
  });
}

function verificationRelSummary(verification: LinkVerification) {
  if (verification.rel !== "mixed") return verification.rel;
  const order: LinkRel[] = ["dofollow", "nofollow", "ugc", "sponsored", "unknown"];
  const parts = order
    .map((rel) => {
      const count = verification.relCounts?.[rel] ?? 0;
      return count ? `${rel} ${count}` : "";
    })
    .filter(Boolean);
  return parts.length ? `mixed（${parts.join(" / ")}）` : "mixed";
}

function findPendingSubmissionForVerification(projectId: string, verification: LinkVerification, submissions: BacklinkSubmission[]) {
  const checkedRoot = rootDomainFromUrl(verification.checkedUrl);
  const trackableStatuses = new Set<SubmissionStatus>([
    "filled",
    "waiting_manual_submit",
    "submitted",
    "pending_review",
    "live_dofollow",
    "live_nofollow",
    "live_ugc",
    "live_sponsored"
  ]);
  return submissions
    .filter((submission) =>
      submission.projectId === projectId &&
      trackableStatuses.has(submission.status) &&
      isValidSubmissionTarget(submission)
    )
    .sort((a, b) => submissionMatchRank(a) - submissionMatchRank(b) || b.checkedAt.localeCompare(a.checkedAt))
    .find((submission) => {
      const urls = [submission.submittedUrl, submission.targetUrl].filter(Boolean);
      return urls.some((url) => sameUrl(url, verification.checkedUrl)) ||
        rootDomainFromUrl(submission.submittedUrl || submission.targetUrl) === checkedRoot;
    });
}

function submissionMatchRank(submission: BacklinkSubmission) {
  if (["filled", "waiting_manual_submit", "submitted", "pending_review"].includes(submission.status)) return 0;
  if (submission.status.startsWith("live")) return 1;
  return 2;
}

function nextCheckAt(fromIso: string) {
  const date = new Date(fromIso);
  date.setDate(date.getDate() + 7);
  return date.toISOString();
}

function statusFromVerification(verification: LinkVerification): SubmissionStatus {
  if (!verification.found) return "pending_review";
  if (verification.rel === "dofollow") return "live_dofollow";
  if (verification.rel === "ugc") return "live_ugc";
  if (verification.rel === "sponsored") return "live_sponsored";
  return "live_nofollow";
}

async function skipSource(
  source: BacklinkSource,
  pages: BacklinkPage[],
  onSaved: () => void,
  onNotice: (message: string) => void
) {
  const current = nowIso();
  await bulkSaveSources([{
    ...source,
    status: "skipped",
    priorityLevel: "X",
    failureReason: source.failureReason || "Manually skipped from execution queue",
    lastSeenAt: current
  }]);
  const sourcePages = pages.filter((page) => page.sourceId === source.id || page.rootDomain === source.rootDomain);
  await bulkSavePages(sourcePages.map((page) => ({
    ...page,
    opportunity: "skip",
    status: "skipped",
    failureReason: page.failureReason || "Manually skipped from execution queue",
    lastAnalyzedAt: current,
    lastSeenAt: current
  })));
  onSaved();
  onNotice(`已跳过 ${source.sourceDomain || source.rootDomain}，同步 ${sourcePages.length} 个页面`);
}

async function skipRootDomain(
  url: string,
  sources: BacklinkSource[],
  pages: BacklinkPage[],
  onSaved: () => void,
  onNotice: (message: string) => void,
  reason: string
) {
  const current = nowIso();
  const rootDomain = rootDomainFromUrl(url);
  const matchingSources = sources.filter((source) => source.rootDomain === rootDomain);
  const matchingPages = pages.filter((page) => page.rootDomain === rootDomain);

  if (!matchingSources.length) {
    const sourceId = uid("src");
    await saveSource({
      id: sourceId,
      sourceDomain: hostnameFromUrl(url),
      sourceUrl: url,
      rootDomain,
      discoveredFrom: "manual_execute",
      competitorDomain: "",
      sourceType: "unknown",
      sourceTypeConfidence: 0.2,
      firstSeenAt: current,
      lastSeenAt: current,
      occurrenceCount: 1,
      competitorCount: 0,
      requiresLogin: null,
      requiresRegister: null,
      requiresPayment: null,
      hasCaptcha: null,
      hasCloudflare: null,
      hasSubmitForm: null,
      hasCommentForm: null,
      hasProfileField: null,
      detectedRel: "unknown",
      isNoindex: null,
      priorityLevel: "X",
      status: "skipped",
      failureReason: reason,
      notes: "Created while skipping current domain"
    });
  }

  await bulkSaveSources(matchingSources.map((source) => ({
    ...source,
    status: "skipped",
    priorityLevel: "X",
    failureReason: reason,
    lastSeenAt: current
  })));

  await bulkSavePages(matchingPages.map((page) => ({
    ...page,
    opportunity: "skip",
    status: "skipped",
    failureReason: reason,
    lastAnalyzedAt: current,
    lastSeenAt: current
  })));

  onSaved();
  onNotice(`已全局跳过 ${rootDomain}，同步 ${matchingSources.length || 1} 条资源、${matchingPages.length} 个页面`);
}

async function skipPageUrl(
  url: string,
  sources: BacklinkSource[],
  onSaved: () => void,
  onNotice: (message: string) => void,
  reason: string,
  announce = true
) {
  const current = nowIso();
  const rootDomain = rootDomainFromUrl(url);
  let source = sources.find((item) => item.rootDomain === rootDomain) ?? await findSourceByRootDomain(rootDomain);
  if (!source) {
    source = {
      id: uid("src"),
      sourceDomain: hostnameFromUrl(url),
      sourceUrl: url,
      rootDomain,
      discoveredFrom: "manual_execute",
      competitorDomain: "",
      sourceType: "unknown",
      sourceTypeConfidence: 0.2,
      firstSeenAt: current,
      lastSeenAt: current,
      occurrenceCount: 1,
      competitorCount: 0,
      requiresLogin: null,
      requiresRegister: null,
      requiresPayment: null,
      hasCaptcha: null,
      hasCloudflare: null,
      hasSubmitForm: null,
      hasCommentForm: null,
      hasProfileField: null,
      detectedRel: "unknown",
      isNoindex: null,
      priorityLevel: "D",
      status: "analyzed",
      failureReason: "",
      notes: "Created while skipping current page"
    };
    await saveSource(source);
  }

  const existingPage = await findPageByUrl(url);
  await savePage(existingPage
    ? {
        ...existingPage,
        opportunity: "skip",
        status: "skipped",
        failureReason: reason,
        lastAnalyzedAt: current,
        lastSeenAt: current
      }
    : {
        id: uid("pg"),
        sourceId: source.id,
        rootDomain,
        pageUrl: url,
        pageTitle: "",
        pageType: source.sourceType,
        discoveredFrom: "manual_execute",
        competitorDomain: source.competitorDomain,
        competitorTargetUrl: "",
        competitorAnchor: "",
        competitorLinkCount: 0,
        occurrenceCount: 1,
        detectedRel: "unknown",
        requiresLogin: null,
        requiresRegister: null,
        hasCaptcha: null,
        hasCloudflare: null,
        hasSubmitForm: null,
        hasCommentForm: null,
        hasProfileField: null,
        opportunity: "skip",
        status: "skipped",
        failureReason: reason,
        firstSeenAt: current,
        lastSeenAt: current,
        lastAnalyzedAt: current,
        notes: "Manually skipped page"
      });
  onSaved();
  if (announce) onNotice(`已跳过当前页面：${rootDomain}`);
}

async function resumeAutoScreenIfPausedOn(
  url: string,
  projectId: string | undefined,
  onNotice: (message: string) => void
) {
  try {
    const state = await chrome.runtime.sendMessage({ type: "GET_AUTO_SCREEN_STATE" }) as AutoScreenState;
    if (state?.running || !state?.stoppedOnUrl) return;
    const sameStoppedPage = sameUrl(url, state.stoppedOnUrl);
    const sameStoppedDomain = rootDomainFromUrl(url) === rootDomainFromUrl(state.stoppedOnUrl);
    if (!sameStoppedPage && !sameStoppedDomain) return;
    await chrome.runtime.sendMessage({ type: "START_AUTO_SCREEN", projectId, limit: 10 });
    onNotice("已跳过当前项，后台自动筛选继续检查下一条");
  } catch {
    // The skip itself already succeeded; failing to resume screening should not undo it.
  }
}

async function keepSource(
  source: BacklinkSource,
  onSaved: () => void,
  onNotice: (message: string) => void,
  reason = "Manually kept from execution queue"
) {
  const current = nowIso();
  await saveSource({
    ...source,
    status: "usable",
    failureReason: "",
    priorityLevel: source.priorityLevel === "X" ? "D" : source.priorityLevel,
    notes: appendNote(source.notes, `${reason} · ${current}`),
    lastSeenAt: current
  });
  onSaved();
  onNotice(`已保留 ${source.sourceDomain || source.rootDomain}，不会写入项目执行记录，其他项目仍可复用`);
}

async function keepRootDomain(
  url: string,
  sources: BacklinkSource[],
  onSaved: () => void,
  onNotice: (message: string) => void,
  reason: string
) {
  const current = nowIso();
  const rootDomain = rootDomainFromUrl(url);
  const matchingSources = sources.filter((source) => source.rootDomain === rootDomain);
  if (!matchingSources.length) {
    await saveSource({
      id: uid("src"),
      sourceDomain: hostnameFromUrl(url),
      sourceUrl: url,
      rootDomain,
      discoveredFrom: "manual_execute",
      competitorDomain: "",
      sourceType: "unknown",
      sourceTypeConfidence: 0.2,
      firstSeenAt: current,
      lastSeenAt: current,
      occurrenceCount: 1,
      competitorCount: 0,
      requiresLogin: null,
      requiresRegister: null,
      requiresPayment: null,
      hasCaptcha: null,
      hasCloudflare: null,
      hasSubmitForm: null,
      hasCommentForm: null,
      hasProfileField: null,
      detectedRel: "unknown",
      isNoindex: null,
      priorityLevel: "D",
      status: "usable",
      failureReason: "",
      notes: `${reason} · ${current}`
    });
  } else {
    await bulkSaveSources(matchingSources.map((source) => ({
      ...source,
      status: "usable",
      priorityLevel: source.priorityLevel === "X" ? "D" : source.priorityLevel,
      failureReason: "",
      notes: appendNote(source.notes, `${reason} · ${current}`),
      lastSeenAt: current
    })));
  }
  onSaved();
  onNotice(`已保留 ${rootDomain}，不会写入项目执行记录，其他项目仍可复用`);
}

async function keepPage(
  page: BacklinkPage,
  sources: BacklinkSource[],
  onSaved: () => void,
  onNotice: (message: string) => void,
  reason: string
) {
  await keepPageUrl(page.pageUrl, sources, onSaved, onNotice, reason);
}

async function keepPageUrl(
  url: string,
  sources: BacklinkSource[],
  onSaved: () => void,
  onNotice: (message: string) => void,
  reason: string
) {
  const current = nowIso();
  const rootDomain = rootDomainFromUrl(url);
  let source = sources.find((item) => item.rootDomain === rootDomain) ?? await findSourceByRootDomain(rootDomain);
  if (!source) {
    source = {
      id: uid("src"),
      sourceDomain: hostnameFromUrl(url),
      sourceUrl: url,
      rootDomain,
      discoveredFrom: "manual_execute",
      competitorDomain: "",
      sourceType: "unknown",
      sourceTypeConfidence: 0.2,
      firstSeenAt: current,
      lastSeenAt: current,
      occurrenceCount: 1,
      competitorCount: 0,
      requiresLogin: null,
      requiresRegister: null,
      requiresPayment: null,
      hasCaptcha: null,
      hasCloudflare: null,
      hasSubmitForm: null,
      hasCommentForm: null,
      hasProfileField: null,
      detectedRel: "unknown",
      isNoindex: null,
      priorityLevel: "D",
      status: "usable",
      failureReason: "",
      notes: `${reason} · ${current}`
    };
    await saveSource(source);
  } else if (source.status === "skipped" || source.priorityLevel === "X") {
    await saveSource({
      ...source,
      status: "usable",
      priorityLevel: source.priorityLevel === "X" ? "D" : source.priorityLevel,
      failureReason: "",
      notes: appendNote(source.notes, `${reason} · ${current}`),
      lastSeenAt: current
    });
  }

  const existingPage = await findPageByUrl(url);
  await savePage(existingPage
    ? {
        ...existingPage,
        opportunity: existingPage.opportunity === "skip" ? "review" : existingPage.opportunity,
        status: "analyzed",
        failureReason: "",
        lastAnalyzedAt: current,
        lastSeenAt: current,
        notes: appendNote(existingPage.notes, `${reason} · ${current}`)
      }
    : {
        id: uid("pg"),
        sourceId: source.id,
        rootDomain,
        pageUrl: url,
        pageTitle: "",
        pageType: source.sourceType,
        discoveredFrom: "manual_execute",
        competitorDomain: source.competitorDomain,
        competitorTargetUrl: "",
        competitorAnchor: "",
        competitorLinkCount: 0,
        occurrenceCount: 1,
        detectedRel: "unknown",
        requiresLogin: null,
        requiresRegister: null,
        hasCaptcha: null,
        hasCloudflare: null,
        hasSubmitForm: null,
        hasCommentForm: null,
        hasProfileField: null,
        opportunity: "review",
        status: "analyzed",
        failureReason: "",
        firstSeenAt: current,
        lastSeenAt: current,
        lastAnalyzedAt: current,
        notes: `${reason} · ${current}`
      });
  onSaved();
  onNotice(`已保留当前页面：${rootDomain}`);
}

async function syncAnalyzedPage(analysis: PageAnalysis, opportunityOverride?: OpportunityKind) {
  const sourcePatch = pageAnalysisToSourcePatch(analysis);
  const existing = await findSourceByRootDomain(analysis.rootDomain);
  const current = nowIso();
  const pageOpportunity = opportunityOverride ?? opportunityFromAnalysis(analysis);
  const skipScope = opportunityOverride && opportunityOverride !== "skip" ? "none" : skipScopeForAnalysis(analysis);
  const shouldSkipSource = skipScope === "domain";
  const sourceStatus = shouldSkipSource ? "skipped" : "analyzed";
  const failureReason = shouldSkipSource ? skipReasonForAnalysis(analysis) : existing?.failureReason ?? "";
  const pageStatus = pageOpportunity === "skip" ? "skipped" : "analyzed";
  const pageFailureReason = pageOpportunity === "skip" ? skipReasonForAnalysis(analysis) : "";
  const outboundDomains = outboundDomainsFromAnalysis(analysis);
  const nextSource: BacklinkSource = existing
    ? {
        ...existing,
        sourceDomain: hostnameFromUrl(analysis.url),
        sourceUrl: existing.sourceUrl || analysis.url,
        sourceType: sourcePatch.sourceType,
        sourceTypeConfidence: Math.max(existing.sourceTypeConfidence, sourcePatch.sourceTypeConfidence),
        requiresLogin: sourcePatch.requiresLogin,
        requiresRegister: sourcePatch.requiresRegister,
        requiresPayment: sourcePatch.requiresPayment,
        hasCaptcha: shouldSkipSource ? sourcePatch.hasCaptcha : existing.hasCaptcha,
        hasCloudflare: shouldSkipSource ? sourcePatch.hasCloudflare : existing.hasCloudflare,
        hasSubmitForm: sourcePatch.hasSubmitForm,
        hasCommentForm: sourcePatch.hasCommentForm,
        hasProfileField: sourcePatch.hasProfileField,
        detectedRel: analysis.existingTargetLink ? sourcePatch.detectedRel : existing.detectedRel,
        isNoindex: shouldSkipSource ? sourcePatch.isNoindex : existing.isNoindex,
        competitorCount: Math.max(existing.competitorCount, outboundDomains.length, existing.seenCompetitorDomains?.length ?? 0),
        seenCompetitorDomains: compactUnique([...(existing.seenCompetitorDomains ?? []), ...outboundDomains]),
        discoveredOutboundDomains: compactUnique([...(existing.discoveredOutboundDomains ?? []), ...outboundDomains]),
        lastSeenAt: current,
        status: sourceStatus,
        failureReason,
        notes: [existing.notes, `Analyzed page: ${analysis.url} · ${current} · ${analysis.title}`].filter(Boolean).join("\n")
      }
    : {
        id: uid("src"),
        sourceDomain: hostnameFromUrl(analysis.url),
        sourceUrl: analysis.url,
        rootDomain: analysis.rootDomain,
        discoveredFrom: "page_analysis",
        competitorDomain: "",
        sourceType: sourcePatch.sourceType,
        sourceTypeConfidence: sourcePatch.sourceTypeConfidence,
        firstSeenAt: current,
        lastSeenAt: current,
        occurrenceCount: 1,
        competitorCount: outboundDomains.length,
        seenCompetitorDomains: outboundDomains,
        discoveredOutboundDomains: outboundDomains,
        requiresLogin: sourcePatch.requiresLogin,
        requiresRegister: sourcePatch.requiresRegister,
        requiresPayment: sourcePatch.requiresPayment,
        hasCaptcha: shouldSkipSource ? sourcePatch.hasCaptcha : false,
        hasCloudflare: shouldSkipSource ? sourcePatch.hasCloudflare : false,
        hasSubmitForm: sourcePatch.hasSubmitForm,
        hasCommentForm: sourcePatch.hasCommentForm,
        hasProfileField: sourcePatch.hasProfileField,
        detectedRel: analysis.existingTargetLink ? sourcePatch.detectedRel : "unknown",
        isNoindex: shouldSkipSource ? sourcePatch.isNoindex : false,
        priorityLevel: "D",
        status: sourceStatus,
        failureReason,
        notes: `Analyzed: ${current} · ${analysis.title}`
      };
  nextSource.priorityLevel = priorityForSource(nextSource);
  await saveSource(nextSource);

  const existingPage = await findPageByUrl(analysis.url);
  const page: BacklinkPage = existingPage
    ? {
        ...existingPage,
        sourceId: nextSource.id,
        pageTitle: analysis.title,
        pageType: sourcePatch.sourceType,
        requiresLogin: sourcePatch.requiresLogin,
        requiresRegister: sourcePatch.requiresRegister,
        hasCaptcha: sourcePatch.hasCaptcha,
        hasCloudflare: sourcePatch.hasCloudflare,
        hasSubmitForm: sourcePatch.hasSubmitForm,
        hasCommentForm: sourcePatch.hasCommentForm,
        hasProfileField: sourcePatch.hasProfileField,
        competitorDomain: analysis.competitorDomain || existingPage.competitorDomain,
        competitorLinkCount: analysis.competitorLinkCount || existingPage.competitorLinkCount,
        competitorAnchor: analysis.competitorAnchors.join(" / ") || existingPage.competitorAnchor,
        seenCompetitorDomains: compactUnique([...(existingPage.seenCompetitorDomains ?? []), ...outboundDomains]),
        discoveredOutboundDomains: compactUnique([...(existingPage.discoveredOutboundDomains ?? []), ...outboundDomains]),
        detectedRel: analysis.competitorLinkRel !== "unknown" ? analysis.competitorLinkRel : existingPage.detectedRel,
        opportunity: pageOpportunity,
        status: pageStatus,
        failureReason: pageFailureReason,
        lastAnalyzedAt: current,
        lastSeenAt: current
      }
    : {
        id: uid("pg"),
        sourceId: nextSource.id,
        rootDomain: analysis.rootDomain,
        pageUrl: analysis.url,
        pageTitle: analysis.title,
        pageType: sourcePatch.sourceType,
        discoveredFrom: "page_analysis",
        competitorDomain: analysis.competitorDomain,
        competitorTargetUrl: "",
        competitorAnchor: analysis.competitorAnchors.join(" / "),
        competitorLinkCount: analysis.competitorLinkCount,
        seenCompetitorDomains: outboundDomains,
        discoveredOutboundDomains: outboundDomains,
        occurrenceCount: 1,
        detectedRel: analysis.competitorLinkRel,
        requiresLogin: sourcePatch.requiresLogin,
        requiresRegister: sourcePatch.requiresRegister,
        hasCaptcha: sourcePatch.hasCaptcha,
        hasCloudflare: sourcePatch.hasCloudflare,
        hasSubmitForm: sourcePatch.hasSubmitForm,
        hasCommentForm: sourcePatch.hasCommentForm,
        hasProfileField: sourcePatch.hasProfileField,
        opportunity: pageOpportunity,
        status: pageStatus,
        failureReason: pageFailureReason,
        firstSeenAt: current,
        lastSeenAt: current,
        lastAnalyzedAt: current,
        notes: `Analyzed page: ${analysis.title}`
      };
  await savePage(page);
  await recordDiscoveryTargetsFromAnalysis(analysis, outboundDomains);
  if (outboundDomains.length) {
    void chrome.runtime.sendMessage({
      type: "ENRICH_DISCOVERY_TARGETS",
      limit: Math.min(outboundDomains.length, 50),
      sourceRootDomain: analysis.rootDomain,
      sourcePageUrl: analysis.url
    }).catch(() => undefined);
  }

  if (shouldSkipSource) {
    const rootPages = await allPages();
    await Promise.all(rootPages
      .filter((item) => item.rootDomain === analysis.rootDomain && item.id !== page.id)
      .map((item) => savePage({
        ...item,
        opportunity: "skip",
        status: "skipped",
        failureReason: failureReason || item.failureReason || "Skipped after page analysis",
        lastAnalyzedAt: current
      })));
  }
}

function unavailableAnalysisFromTab(tab: chrome.tabs.Tab): PageAnalysis {
  return unavailableAnalysisFromUrl(tab.url ?? "", tab.title || "Page unavailable");
}

function isBrowserErrorTab(tab: chrome.tabs.Tab) {
  const haystack = `${tab.url ?? ""} ${tab.title ?? ""}`.toLowerCase();
  return /(chrome-error:|privacy error|your connection is not private|隐私设置错误|您的连接不是私密连接|net::err_|err_cert_|err_ssl_|err_connection_|err_name_not_resolved|err_timed_out)/i.test(haystack);
}

function unavailableAnalysisFromUrl(url: string, title = "Page unavailable"): PageAnalysis {
  return {
    url,
    rootDomain: rootDomainFromUrl(url),
    title,
    language: "unknown",
    pageType: "unknown",
    hasForm: false,
    formFields: [],
    submitButtons: [],
    directorySubmissionDetected: false,
    profileCandidateDetected: false,
    forumThreadDetected: false,
    forumReplyDetected: false,
    commentHtmlAnchorLikely: false,
    submissionLinks: [],
    accountLinks: [],
    loginRequired: false,
    registerRequired: false,
    captchaDetected: false,
    cloudflareDetected: false,
    existingTargetLink: false,
    existingLinkRel: "unknown",
    targetLinkCount: 0,
    competitorDomain: "",
    competitorLinkCount: 0,
    competitorLinkRel: "unknown",
    competitorAnchors: [],
    paidPlacementDetected: false,
    noindex: false,
    pageUnavailable: true,
    canonicalUrl: "",
  };
}

function shouldMarkPendingUrl(analysis: PageAnalysis, pendingUrl: string) {
  if (sameUrl(analysis.url, pendingUrl)) return false;
  return analysis.pageUnavailable || rootDomainFromUrl(analysis.url) !== rootDomainFromUrl(pendingUrl);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isHttpUrl(url: string) {
  return /^https?:\/\//i.test(url);
}

async function sendTabMessage<T>(tabId: number, message: unknown, options: { forceInject?: boolean } = {}): Promise<T> {
  if (options.forceInject) {
    await injectContentScript(tabId);
  }
  try {
    return await chrome.tabs.sendMessage(tabId, message) as T;
  } catch {
    try {
      await injectContentScript(tabId);
      await delay(80);
      return await chrome.tabs.sendMessage(tabId, message) as T;
    } catch (error) {
      throw new Error(`无法连接当前页面脚本。请刷新网页后再试；如果是 chrome:// 或扩展商店等受限页面，则浏览器不允许插件分析。${errorMessage(error)}`);
    }
  }
}

async function injectContentScript(tabId: number) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["assets/content.js"]
  });
  await delay(80);
}

async function generateCommentWithAi(
  settings: AppSettings,
  project: Project,
  analysis: PageAnalysis | null,
  context: PageContext,
  commentLinkMode: CommentLinkMode
) {
  const linkPlan = commentLinkPlan(project, analysis, commentLinkMode);
  const publishType = executionPublishType(analysis);
  if (publishType === "profile") {
    return {
      recommendation: profilePostingRecommendation(linkPlan),
      linkPlan: linkPlan.label,
      comment: profileDefaultText(project, linkPlan)
    };
  }
  const prompt = buildCommentPrompt(project, analysis, context, linkPlan);
  const content = settings.aiProvider === "gemini"
    ? await callGemini(settings, prompt)
    : await callOpenAiCompatible(settings, prompt);
  const comment = chooseBestComment(content, linkPlan, publishType);
  if (!isUsableGeneratedComment(comment, publishType)) {
    console.warn("Backlink Forge AI raw response:", content);
    throw new Error(`AI 返回未解析出合格评论：${truncate(content || "空内容", 180)}。请打开 popup console 查看完整返回。`);
  }
  return {
    recommendation: localPostingRecommendation(analysis, context),
    linkPlan: linkPlan.label,
    comment
  };
}

async function translateDraftToEnglish(
  settings: AppSettings,
  project: Project,
  analysis: PageAnalysis | null,
  context: PageContext | null,
  sourceText: string,
  commentLinkMode: CommentLinkMode
) {
  const linkPlan = commentLinkPlan(project, analysis, commentLinkMode);
  const publishType = executionPublishType(analysis);
  const prompt = buildEnglishTranslationPrompt(project, analysis, context, sourceText, linkPlan, publishType);
  const content = settings.aiProvider === "gemini"
    ? await callGemini(settings, prompt)
    : await callOpenAiCompatible(settings, prompt);
  const cleaned = cleanAiComment(content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^(TRANSLATION|Translation|translation|English|Output):\s*/gim, "")
  , publishType === "forum_thread");
  return enforceLinkPlan(cleaned || sourceText, linkPlan);
}

interface CommentLinkPlan {
  mode: "none" | "website_field" | "body_html_anchor" | "body_bbcode_link" | "plain_url";
  label: string;
  url: string;
  anchor: string;
}

function commentLinkPlan(
  project: Project,
  analysis: PageAnalysis | null,
  commentLinkMode: CommentLinkMode
): CommentLinkPlan {
  const url = normalizeUrl(project.siteUrl || "");
  const anchor = preferredAnchorText(project);
  const publishType = executionPublishType(analysis);
  if (!url || commentLinkMode === "none") {
    return { mode: "none", label: "不含链接的评论", url, anchor };
  }
  if (commentLinkMode === "body_html_anchor") {
    return { mode: "body_html_anchor", label: `正文锚文本：${anchor}`, url, anchor };
  }
  if (commentLinkMode === "body_bbcode_link") {
    return { mode: "body_bbcode_link", label: `BBCode 链接：${anchor}`, url, anchor };
  }
  if (commentLinkMode === "website_field") {
    return { mode: "website_field", label: "正文不放链接，只使用 Website 字段", url, anchor };
  }
  if (publishType === "profile") {
    return profileHasWebsiteField(analysis)
      ? { mode: "website_field", label: "Profile 默认：简介不放链接，只填 Website 字段", url, anchor }
      : { mode: "plain_url", label: "Profile 默认：简短简介 + 裸链", url, anchor };
  }
  if (publishType === "forum_thread") {
    return { mode: "body_bbcode_link", label: `论坛发帖 BBCode 链接：${anchor}（需人工确认）`, url, anchor };
  }
  if (publishType === "forum_reply") {
    return { mode: "body_bbcode_link", label: `论坛回复 BBCode 链接：${anchor}（需人工确认）`, url, anchor };
  }
  if (publishType === "blog_comment") {
    return { mode: "body_html_anchor", label: `正文锚文本：${anchor}`, url, anchor };
  }
  if (publishType === "tool_submission") {
    return { mode: "website_field", label: "提交站字段链接：产品 URL/Website 字段", url, anchor };
  }
  if (analysis?.commentHtmlAnchorLikely) {
    return { mode: "body_html_anchor", label: `正文锚文本：${anchor}`, url, anchor };
  }
  return { mode: "body_html_anchor", label: `正文锚文本：${anchor}（需人工确认）`, url, anchor };
}

type ExecutionPublishType = "tool_submission" | "blog_comment" | "profile" | "forum_thread" | "forum_reply" | "unknown";

function executionPublishType(analysis: PageAnalysis | null): ExecutionPublishType {
  if (!analysis) return "unknown";
  const hasCommentField = analysis.formFields.some((field) => field.purpose === "comment");
  const hasProductFields = analysis.formFields.some((field) => ["product_name", "product_url", "description", "category", "tags", "title"].includes(field.purpose));
  const blogCommentLike = hasCommentField || isBloggerCommentAnalysis(analysis) || isArticleCommentAnalysis(analysis) || isGenericBlogCommentAnalysis(analysis) || isBlogArticleUrl(analysis);
  const hasProfileFields = analysis.formFields.some((field) => field.purpose === "bio" || (field.purpose === "website" && !blogCommentLike));
  if (isBlogArticleUrl(analysis)) return "blog_comment";
  if (analysis.forumThreadDetected || isForumThreadAnalysis(analysis)) return "forum_thread";
  if (analysis.forumReplyDetected || isForumReplyAnalysis(analysis)) return "forum_reply";
  if (blogCommentLike) return "blog_comment";
  if (analysis.profileCandidateDetected || hasProfileFields || analysis.loginRequired || analysis.registerRequired) return "profile";
  if (analysis.directorySubmissionDetected || (hasProductFields && analysis.submissionLinks.length > 0)) return "tool_submission";
  return "unknown";
}

function profileHasWebsiteField(analysis: PageAnalysis | null) {
  return Boolean(analysis?.formFields.some((field) => field.purpose === "website"));
}

function isForumThreadAnalysis(analysis: PageAnalysis) {
  const haystack = `${analysis.url} ${analysis.title} ${analysis.formFields.map((field) => `${field.label} ${field.name} ${field.id} ${field.placeholder}`).join(" ")}`.toLowerCase();
  const hasThreadUrl = /[?&]action=post\b|[?&]boardid=|\/new(?:[/?#]|$)|\/newtopic|\/postarticle|\/post-thread|\/new-thread|\/create-thread/.test(haystack);
  const hasThreadWords = /create post|new post title|post title|post new topic|topic title|thread title|your message|create thread|start new thread|new topic/.test(haystack);
  const hasTitleField = analysis.formFields.some((field) => field.purpose === "title");
  const hasBodyField = analysis.formFields.some((field) => field.purpose === "comment" || field.purpose === "description");
  return (hasThreadUrl || hasThreadWords) && (hasTitleField || hasBodyField || analysis.hasForm);
}

function isForumReplyAnalysis(analysis: PageAnalysis) {
  if (isForumThreadAnalysis(analysis)) return false;
  const haystack = `${analysis.url} ${analysis.title} ${analysis.formFields.map((field) => `${field.label} ${field.name} ${field.id} ${field.placeholder}`).join(" ")}`.toLowerCase();
  const looksForumReply = /\/forum|\/forums?|\/threads?|\/topics?|reply|quick reply|post reply|new reply|formatting cheatsheet|@mention/.test(haystack);
  const hasReplyField = analysis.formFields.some((field) =>
    field.purpose === "comment" ||
    /(reply|message|post|body|editor|write|click here and begin writing)/i.test(`${field.label} ${field.name} ${field.id} ${field.placeholder} ${field.type}`)
  );
  return looksForumReply && hasReplyField;
}

function isBloggerCommentAnalysis(analysis: PageAnalysis) {
  const haystack = `${analysis.url} ${analysis.title}`.toLowerCase();
  return (analysis.hasForm || analysis.commentHtmlAnchorLikely || isBlogArticleUrl(analysis)) &&
    /(blogger|blogspot|blog\.|\.html(?:[?#]|$))/.test(haystack);
}

function isArticleCommentAnalysis(analysis: PageAnalysis) {
  const haystack = `${analysis.url} ${analysis.title}`.toLowerCase();
  if (analysis.pageUnavailable || analysis.directorySubmissionDetected || analysis.forumThreadDetected || analysis.forumReplyDetected) return false;
  if (/(usercp|\/profile|\/account|\/settings|action=profile|edit profile|signature)/.test(haystack)) return false;
  const articleUrl = /\.(html?|php)(?:[?#]|$)/.test(analysis.url) || /\/\d{4}\/\d{2}\//.test(analysis.url);
  const blogLikeTitle = /(blog|post|article|recipe|review|how|why|what|ryijy|kuinka|tein)/i.test(analysis.title);
  return articleUrl && blogLikeTitle && !analysis.loginRequired;
}

function isGenericBlogCommentAnalysis(analysis: PageAnalysis) {
  if (analysis.pageUnavailable || analysis.directorySubmissionDetected || analysis.forumThreadDetected || analysis.forumReplyDetected) return false;
  const fieldText = analysis.formFields.map((field) => `${field.label} ${field.placeholder} ${field.name} ${field.id} ${field.purpose}`).join(" ");
  const buttonText = analysis.submitButtons.join(" ");
  const haystack = `${analysis.url} ${analysis.title} ${fieldText} ${buttonText}`.toLowerCase();
  if (/(usercp|\/profile|\/account|\/settings|action=profile|edit profile|signature|\/wp-admin)/.test(haystack)) return false;
  const hasCommentSignal = /(leave a comment|leave a reply|post comment|submit comment|comment \*|type here|commentform|wp-comments-post|comment_post_id|respond|thoughts on)/i.test(haystack) ||
    analysis.commentHtmlAnchorLikely ||
    analysis.pageType === "ugc_comment_profile";
  const hasCommentField = analysis.formFields.some((field) =>
    field.purpose === "comment" ||
    /(comment|reply|message|type here)/i.test(`${field.label} ${field.placeholder} ${field.name} ${field.id}`)
  );
  const hasIdentityFields = analysis.formFields.some((field) => field.purpose === "name") &&
    analysis.formFields.some((field) => field.purpose === "email");
  const hasWebsiteField = analysis.formFields.some((field) => field.purpose === "website");
  const hasPostCommentButton = analysis.submitButtons.some((button) => /(post|submit|publish|send).{0,20}comment|comment.{0,20}(post|submit|publish|send)/i.test(button));
  return hasCommentSignal && (hasCommentField || hasPostCommentButton || (hasIdentityFields && hasWebsiteField));
}

function isBlogArticleUrl(analysis: PageAnalysis) {
  const haystack = `${analysis.url} ${analysis.title}`.toLowerCase();
  if (analysis.pageUnavailable || analysis.directorySubmissionDetected) return false;
  if (/(usercp|\/profile|\/account|\/settings|action=profile|edit profile|signature)/.test(haystack)) return false;
  return /(^https?:\/\/blog\.|\.blogspot\.|\/\d{4}\/\d{2}\/[^?#]+\.html(?:[?#]|$)|\/\d{4}\/\d{2}\/|\.html(?:[?#]|$))/i.test(haystack);
}

function strategyForAnalysis(analysis: PageAnalysis | null) {
  const type = executionPublishType(analysis);
  return {
    tool_submission: {
      label: "目录/提交站",
      generateLabel: "生成产品描述",
      fillLabel: "填提交表单",
      hint: "用于产品/工具/目录提交页：优先填产品名、URL、描述、分类、标签；遇到验证码前先填完所有字段。"
    },
    blog_comment: {
      label: "博客评论",
      generateLabel: "生成带链评论",
      fillLabel: "填评论表单",
      hint: "用于普通博客评论：正文锚文本会保留 href 换行 trick；提交后检查 rel，ugc/nofollow 不算真正成功。"
    },
    forum_thread: {
      label: "论坛发帖",
      generateLabel: "生成帖子草稿",
      fillLabel: "填发帖表单",
      hint: "用于论坛新主题/发布页：生成首帖正文草稿；默认用 BBCode 链接，提交后打开公开帖检查结果。"
    },
    forum_reply: {
      label: "论坛回复",
      generateLabel: "生成回复草稿",
      fillLabel: "填回复框",
      hint: "用于论坛帖子回复：结合当前主题语境写短回复；默认用 BBCode 链接，风险高时可切换为不放链接或只留签名。"
    },
    profile: {
      label: "Profile",
      generateLabel: "生成简介文本",
      fillLabel: "填 Profile 字段",
      hint: "用于账号资料页：注册/登录后重新分析，优先识别 Website、Bio、签名、phpBB/Discuz 资料字段。"
    },
    unknown: {
      label: "人工判断",
      generateLabel: "生成草稿",
      fillLabel: "模拟填表",
      hint: "当前页打法不明确，先人工确认页面语境；必要时重新分析或跳过页面/域名。"
    }
  }[type];
}

function analysisWorkflowLabel(analysis: PageAnalysis, source?: BacklinkSource, allPages: BacklinkPage[] = [], opportunityOverride?: OpportunityKind) {
  const opportunity = opportunityOverride ?? (source ? opportunityFromAnalysisForSource(analysis, source, allPages) : opportunityFromAnalysis(analysis));
  const type = executionPublishType(analysis);
  const sourcePages = source ? pagesForSource(source, allPages) : [];
  const quality = source ? classifyDirectoryQuality(source, sourcePages) : null;
  const action = {
    direct: "可直接处理",
    review: "待人工判断",
    engage: "低价值互动",
    skip: "建议跳过"
  }[opportunity];
  const qualityText = quality && quality.level !== "not_directory" ? ` · ${quality.label}（${quality.reason}）` : "";
  if (isBlogArticleUrl(analysis)) return `普通博客评论 · ${action} · 可试正文锚文本`;
  if (type === "blog_comment") return analysis.commentHtmlAnchorLikely
    ? `普通博客评论 · ${action} · 可试正文锚文本`
    : `普通博客评论 · ${action}`;
  if (analysis.paidPlacementDetected && (analysis.directorySubmissionDetected || type === "tool_submission")) {
    return `付费目录/买外链站 · ${action}${qualityText}`;
  }
  if (analysis.paidPlacementDetected) return `疑似付费外链站 · ${action}`;
  if (analysis.directorySubmissionDetected || type === "tool_submission") return `目录/提交站 · ${action}${qualityText}`;
  if (type === "forum_thread") return `论坛发帖页 · ${action}`;
  if (type === "forum_reply") return `论坛回复页 · ${action}`;
  if (type === "profile") return `Profile 资料页 · ${action}`;
  if (analysis.loginRequired || analysis.registerRequired) return `需账号验证 · ${action}`;
  return `待人工验证 · ${action}`;
}

function executionClassDisplayLabel(source: BacklinkSource, sourcePages: BacklinkPage[]) {
  const quality = classifyDirectoryQuality(source, sourcePages);
  if (quality.level !== "not_directory") return quality.label;
  return executionClassLabel(source, sourcePages);
}

function preferredAnchorText(project: Project) {
  const anchors = project.anchorTexts.map((item) => item.trim()).filter(Boolean);
  const keywords = project.targetKeywords.map((item) => item.trim()).filter(Boolean);
  return anchors[0] || keywords[0] || project.brandName || project.projectName || rootDomainFromUrl(project.siteUrl || "") || "this tool";
}

function profilePostingRecommendation(linkPlan: CommentLinkPlan) {
  if (linkPlan.mode === "body_html_anchor") return "Profile 文本建议：先试 HTML 锚文本，保存后打开公开资料页检查是否可见。";
  if (linkPlan.mode === "body_bbcode_link") return "Profile 文本建议：当前生成 BBCode 链接，适合论坛签名/简介字段，保存后检查公开页。";
  if (linkPlan.mode === "plain_url") return "Profile 文本建议：生成短简介，链接只在没有 Website 字段时追加。";
  if (linkPlan.mode === "website_field") return "Profile 文本建议：简介不放链接，只填 Website/URL 字段，更像普通账号资料。";
  return "Profile 文本建议：不放链接，仅用于测试字段是否可保存。";
}

function profileDefaultText(project: Project, linkPlan: CommentLinkPlan) {
  const anchor = linkPlan.anchor || preferredAnchorText(project);
  const url = linkPlan.url;
  const base = profileBioBase(project);
  if (!url || linkPlan.mode === "none") return base;
  if (linkPlan.mode === "website_field") return base;
  if (linkPlan.mode === "body_html_anchor") {
    return `${base} Lately I have been using <a href="${url}\n">${anchor}</a> when I want a quick random starting point.`;
  }
  if (linkPlan.mode === "body_bbcode_link") {
    return `${base} Lately I have been using [url=${url}]${anchor}[/url] when I want a quick random starting point.`;
  }
  return `${base} Lately I have been using ${anchor} when I want a quick random starting point: ${url}`;
}

function profileBioBase(project: Project) {
  const haystack = `${project.projectName} ${project.brandName} ${project.category} ${project.shortDescription} ${project.targetKeywords.join(" ")} ${project.anchorTexts.join(" ")}`.toLowerCase();
  if (/pokemon|pokémon/.test(haystack)) {
    return "I enjoy casual games, team ideas, and small web tools that make choosing things a little more fun.";
  }
  if (/game|gaming|roulette|random/.test(haystack)) {
    return "I enjoy casual games and small web tools for quick ideas when I do not want to overthink a choice.";
  }
  if (/home|automation|smart/.test(haystack)) {
    return "I like practical home tech, small automation ideas, and simple tools that make everyday projects easier.";
  }
  return "I like trying small web tools, practical ideas, and simple projects that are useful without getting too complicated.";
}

function titleForCurrentDraft(project: Project, analysis: PageAnalysis | null, comment: string) {
  if (executionPublishType(analysis) !== "forum_thread") return "";
  const firstLine = comment.split(/\n+/).map((line) => line.trim()).find(Boolean) ?? "";
  const titleMatch = firstLine.match(/^title:\s*(.+)$/i);
  if (titleMatch?.[1]) return truncate(titleMatch[1].replace(/[.!?]+$/, ""), 90);
  const keyword = project.targetKeywords[0] || project.anchorTexts[0] || project.category || "quick ideas";
  const brand = project.brandName || project.projectName || rootDomainFromUrl(project.siteUrl || "") || "tool";
  if (/pokemon/i.test(`${keyword} ${brand} ${project.shortDescription}`)) {
    return "Quick random Pokemon picker for casual game ideas";
  }
  return truncate(`Quick ${keyword} tool I found useful`, 90);
}

function buildCommentPrompt(project: Project, analysis: PageAnalysis | null, context: PageContext, linkPlan: CommentLinkPlan) {
  const brand = project.brandName || project.projectName;
  const projectSummary = [
    `Brand/name: ${brand}`,
    `Exact website URL to use if a link is allowed: ${linkPlan.url || "not provided"}`,
    `Exact anchor text to use if a body anchor is allowed: ${linkPlan.anchor}`,
    `Category: ${project.category || "not provided"}`,
    `Short description: ${project.shortDescription || "not provided"}`,
    `Keywords: ${project.targetKeywords.join(", ") || "not provided"}`
  ].join("\n");

  const pageSummary = [
    `URL: ${context.url}`,
    `Title: ${context.title}`,
    `Detected type: ${analysis ? labelForType(analysis.pageType) : "unknown"}`,
    `Publish form detected: ${analysis?.hasForm ? "yes" : "unknown"}`,
    `Needs login: ${analysis?.loginRequired ? "yes" : "unknown"}`,
    `Headings: ${context.headings.join(" / ") || "none"}`,
    `Visible page excerpt: ${context.visibleText || "none"}`
  ].join("\n");

  const competitorSummary = [
    `Competitor domain detected from backlink data: ${analysis?.competitorDomain || "none"}`,
    `Competitor appears on this page: ${analysis?.competitorLinkCount ? `${analysis.competitorLinkCount} time(s)` : "no or unknown"}`,
    `Competitor rel: ${analysis?.competitorLinkRel || "unknown"}`,
    `Competitor anchor/example wording: ${analysis?.competitorAnchors?.join(" / ") || "none"}`,
    `Nearby existing comments: ${context.nearbyComments.join(" | ") || "none"}`
  ].join("\n");

  const publishType = executionPublishType(analysis);
  const contentShape = {
    tool_submission: [
      "Page class: product/tool submission or paid placement page.",
      "- If asked for a comment-like text, write a concise product description, not a blog reply.",
      "- Mention what the promoted site does clearly and avoid pretending to react to an article."
    ],
    blog_comment: [
      "Page class: blog/article comment.",
      "- Write as a reader responding to this article.",
      "- The backlink belongs inside the comment when the link plan allows it."
    ],
    forum_thread: [
      "Page class: forum new thread / post article page.",
      "- Write a first post that transparently introduces the promoted project/tool to this community.",
      "- Use first person, be specific about why it fits the forum topic, and avoid sounding like a press release.",
      "- Do not write about editor controls, cover image buttons, formatting tools, or the act of creating a post.",
      "- It is okay to include a short feature list if the forum page is for project releases or resource sharing."
    ],
    forum_reply: [
      "Page class: forum thread reply.",
      "- Write as a reply to the current thread, not as a standalone product announcement.",
      "- Keep it casual and context-aware; mention the tool only where it fits the discussion.",
      "- If adding a link, make it feel like a useful reference, not a drive-by promotion."
    ],
    profile: [
      "Page class: profile/account/signature opportunity.",
      "- Do not write a blog-style comment.",
      "- Write a short bio/about text suitable for a profile field."
    ],
    unknown: [
      "Page class: uncertain.",
      "- Keep the text conservative and suitable for manual editing."
    ]
  }[publishType];

  const linkInstructions = {
    none: [
      "Link plan: no link in the comment.",
      "- Do not include any URL, domain, HTML anchor, or promotional CTA."
    ],
    website_field: [
      "Link plan: the extension will put the project URL into the Website field.",
      "- Do not include any URL, domain, HTML anchor, or promotional CTA in the comment body.",
      "- You may mention the concept naturally only if it fits the article."
    ],
    body_html_anchor: [
      "Link plan: include exactly one HTML anchor in the comment body.",
      `- The only allowed link markup is: <a href="${linkPlan.url}\\n">${escapePromptText(linkPlan.anchor)}</a>`,
      "- The newline inside href is intentional for WordPress comment testing; keep it as a real line break if you output the anchor.",
      "- Do not use any other href, domain, or URL.",
      "- The anchor must appear naturally inside a sentence, not as a standalone CTA.",
      "- Do not put the anchor in the first sentence."
    ],
    plain_url: [
      "Link plan: include one plain URL only if HTML is not possible.",
      `- The only allowed URL is: ${linkPlan.url}`,
      "- Do not use any other domain or URL."
    ],
    body_bbcode_link: [
      "Link plan: include exactly one BBCode link in the body.",
      `- The only allowed link markup is: [url=${linkPlan.url}]${escapePromptText(linkPlan.anchor)}[/url]`,
      "- Do not use any other domain or URL."
    ]
  }[linkPlan.mode];

  const taskIntro = {
    tool_submission: "Write one natural English product/tool description for manual review before submitting.",
    blog_comment: "Write one natural English blog/community comment for manual review before posting.",
    forum_thread: "Write one natural English forum thread body for manual review before posting.",
    forum_reply: "Write one natural English forum reply for manual review before posting.",
    profile: "Write one short English profile/about text for manual review before saving.",
    unknown: "Write one conservative English draft for manual review before posting."
  }[publishType];

  const lengthRule = publishType === "forum_thread"
    ? "- Write 90-180 words. Use 2-4 short paragraphs; simple bullets are allowed only for feature lists."
    : publishType === "forum_reply"
      ? "- Write 1 short paragraph, 30-80 words total."
      : "- Write 2-3 short sentences, 35-75 words total for blog comments; 20-45 words for profile/tool fields.";

  const formattingRule = publishType === "forum_thread"
    ? "- Output ONLY the post body. No title label, JSON, explanation, or code fence."
    : "- Output ONLY the comment text. No JSON, no labels, no Markdown, no explanation.";

  return [
    taskIntro,
    "The text must feel like it was written after reading the current page, not like outreach copy.",
    "",
    "Hard rules:",
    formattingRule,
    lengthRule,
    publishType === "forum_thread"
      ? "- Mention the community/site context or project category; do not react to the post editor UI itself."
      : "- Mention at least one concrete visible detail from the page title, heading, excerpt, or topic.",
    "- Keep the tone low-key and human: curious, useful, lightly conversational.",
    "- Do not sound like an ad, review pitch, SEO placement, press release, or AI summary.",
    "- Do not mention SEO, backlink, marketing, promotion, or outreach.",
    "- Avoid generic praise such as 'great post', 'nice roundup', 'thanks for sharing', 'very informative', or 'awesome article'.",
    "- Avoid exaggeration, sales language, hashtags, emojis, and questions that look fake.",
    "- If the page is about competitors or a list of tools, compare gently without attacking any listed site.",
    "- If the page is an old forum/profile/community thread, be shorter and more casual.",
    ...contentShape,
    ...linkInstructions,
    "",
    "Project to promote:",
    projectSummary,
    "",
    "Current target page:",
    pageSummary,
    "",
    "Competitor/backlink clue:",
    competitorSummary
  ].join("\n");
}

function buildEnglishTranslationPrompt(
  project: Project,
  analysis: PageAnalysis | null,
  context: PageContext | null,
  sourceText: string,
  linkPlan: CommentLinkPlan,
  publishType: ExecutionPublishType
) {
  const brand = project.brandName || project.projectName || rootDomainFromUrl(project.siteUrl || "") || "the project";
  const pageContext = context ? [
    `Target page URL: ${context.url}`,
    `Target page title: ${context.title}`,
    `Visible topic excerpt: ${context.visibleText || "none"}`
  ].join("\n") : "Target page context: not available";
  const linkRule = {
    none: "Remove URLs, HTML anchors, BBCode links, and promotional CTAs from the English output.",
    website_field: "Do not include any URL, domain, HTML anchor, or BBCode link. The extension will fill the Website/URL field separately.",
    plain_url: `Use only this plain URL if a URL is already needed by the source text: ${linkPlan.url}`,
    body_html_anchor: `Preserve exactly one HTML link if the source text uses a body link. The only allowed link markup is: <a href="${linkPlan.url}\\n">${escapePromptText(linkPlan.anchor)}</a>`,
    body_bbcode_link: `Preserve exactly one BBCode link if the source text uses a body link. The only allowed link markup is: [url=${linkPlan.url}]${escapePromptText(linkPlan.anchor)}[/url]`
  }[linkPlan.mode];
  const shapeRule = publishType === "forum_thread"
    ? "Keep paragraph breaks when useful. Output a forum post body only."
    : "Output one compact comment/profile/submission text only.";

  return [
    "Translate and lightly localize the draft into natural English for manual review before posting.",
    "Keep the original intent, but make it sound human, low-key, and context-aware rather than like outreach copy.",
    "Do not mention translation, AI, SEO, backlinks, marketing, promotion, or outreach.",
    "Do not add explanations, labels, Markdown, or quotes around the result.",
    "Avoid generic praise such as 'great post', 'thanks for sharing', or 'very informative'.",
    shapeRule,
    linkRule,
    "",
    `Project/brand: ${brand}`,
    `Project category: ${project.category || "not provided"}`,
    `Project summary: ${project.shortDescription || project.longDescription || "not provided"}`,
    `Detected publish type: ${publishType}`,
    pageContext,
    "",
    "Draft to translate:",
    sourceText
  ].join("\n");
}

function escapePromptText(value: string) {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function callOpenAiCompatible(settings: AppSettings, prompt: string) {
  const endpoint = {
    openai: "https://api.openai.com/v1/chat/completions",
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
    deepseek: "https://api.deepseek.com/chat/completions",
    none: "",
    gemini: ""
  }[settings.aiProvider];
  if (!endpoint) throw new Error("当前 AI 服务商未配置接口");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.aiApiKey}`,
      ...(settings.aiProvider === "openrouter" ? { "HTTP-Referer": location.origin, "X-Title": "Backlink Forge" } : {})
    },
    body: JSON.stringify({
      model: settings.aiModel,
      messages: [
        { role: "system", content: "You write specific, low-key, human comments for blog and community pages. You obey exact URL and anchor constraints." },
        { role: "user", content: prompt }
      ],
      temperature: 0.72,
      max_tokens: 500
    })
  });
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message || `AI 请求失败：${response.status}`);
  return data.choices?.[0]?.message?.content ?? "";
}

async function callGemini(settings: AppSettings, prompt: string) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.aiModel)}:generateContent?key=${encodeURIComponent(settings.aiApiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.72,
        maxOutputTokens: 500,
        responseMimeType: "text/plain",
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  });
  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(data.error?.message || `AI 请求失败：${response.status}`);
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
  if (candidate?.finishReason && candidate.finishReason !== "STOP") {
    console.warn("Backlink Forge Gemini finishReason:", candidate.finishReason, data);
  }
  return text;
}

function chooseBestComment(value: string, linkPlan: CommentLinkPlan, publishType: ExecutionPublishType) {
  const compact = value.replace(/\r/g, "\n").trim();
  const preserveBreaks = publishType === "forum_thread";
  const cleaned = cleanAiComment(compact
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^(COMMENT|Comment|comment|Answer|Output):\s*/gim, "")
  , preserveBreaks);
  return enforceLinkPlan(cleaned, linkPlan);
}

function cleanAiComment(value: string, preserveBreaks = false) {
  const stripped = value
    .replace(/^[-*\d.)\s]+/, "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/^(comment|body|post|reply):\s*/i, "");
  if (preserveBreaks) {
    return stripped
      .split(/\n{2,}/)
      .map((part) => part.replace(/[ \t]+/g, " ").trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  return stripped.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
}

function isUsableGeneratedComment(value: string, publishType: ExecutionPublishType = "unknown") {
  const words = value.split(/\s+/).filter(Boolean);
  const maxWords = publishType === "forum_thread" ? 260 : 95;
  const minWords = publishType === "forum_thread" ? 45 : 14;
  return words.length >= minWords && words.length <= maxWords && /[.!?]$/.test(value.trim());
}

function enforceLinkPlan(value: string, linkPlan: CommentLinkPlan) {
  let comment = value;
  const allowedUrl = linkPlan.url;
  if (linkPlan.mode !== "body_html_anchor") {
    comment = comment.replace(/<a\b[^>]*>(.*?)<\/a>/gi, "$1");
  } else if (allowedUrl) {
    comment = comment.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (match, href: string, text: string) => {
      return rootDomainFromUrl(href) === rootDomainFromUrl(allowedUrl) ? dofollowBypassAnchor(allowedUrl, text || linkPlan.anchor) : text;
    });
  }
  if (linkPlan.mode !== "body_bbcode_link") {
    comment = comment.replace(/\[url=[^\]]+\]([\s\S]*?)\[\/url\]/gi, "$1");
  }
  if (allowedUrl && linkPlan.mode !== "body_html_anchor" && linkPlan.mode !== "body_bbcode_link") {
    const allowedRoot = rootDomainFromUrl(allowedUrl);
    comment = comment.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
      const cleanUrl = url.replace(/[),.;!?]+$/, "");
      return rootDomainFromUrl(cleanUrl) === allowedRoot && linkPlan.mode === "plain_url" ? cleanUrl : "";
    });
    comment = comment.replace(/\s+/g, " ").trim();
  }
  if (linkPlan.mode === "body_bbcode_link" && allowedUrl && !comment.includes(`[url=${allowedUrl}]`)) {
    comment = `${comment.replace(/[.!?]$/, "")}: [url=${allowedUrl}]${linkPlan.anchor}[/url]`;
  }
  if (linkPlan.mode === "body_html_anchor" && allowedUrl && !comment.includes(`href="${allowedUrl}"`)) {
    const anchor = dofollowBypassAnchor(allowedUrl, linkPlan.anchor);
    comment = `${comment.replace(/[.!?]$/, "")}, especially when comparing it with a ${anchor}.`;
  }
  if (!/[.!?]$/.test(comment)) comment = `${comment}.`;
  return comment;
}

function dofollowBypassAnchor(url: string, anchor: string) {
  return `<a href="${url}\n">${anchor}</a>`;
}

function localPostingRecommendation(analysis: PageAnalysis | null, context: PageContext) {
  if (analysis?.existingTargetLink) return "建议跳过，当前页已经出现项目链接";
  const publishType = executionPublishType(analysis);
  if (publishType === "forum_thread") return "论坛发帖页：适合生成首帖草稿，先人工确认版规、分类和标题，再手动提交。";
  if (publishType === "forum_reply") return "论坛回复页：适合生成短回复，链接建议低调；提交后打开公开帖子页检查链接是否可见。";
  if (analysis && !analysis.hasForm) return "建议跳过，当前页未检测到可发布表单";
  if (/scratch\.mit\.edu/i.test(context.url)) return "谨慎软发，Scratch 社区不适合硬塞外链";
  if (analysis?.competitorLinkCount) return "谨慎软发，竞品链接存在但仍需人工确认语境";
  return "需人工判断，请检查页面语境和平台规则";
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isContentScriptRuntimeError(error: unknown) {
  const message = errorMessage(error);
  return /cannot read properties|is not a function|undefined|null|typeerror|referenceerror/i.test(message);
}

function defaultProject(): Project {
  const current = nowIso();
  return {
    id: "",
    projectName: "",
    siteUrl: "",
    brandName: "",
    shortDescription: "",
    longDescription: "",
    targetKeywords: [],
    anchorTexts: [],
    category: "",
    language: "en",
    contactEmail: "",
    authorName: "",
    logoUrl: "",
    socialLinks: [],
    createdAt: current,
    updatedAt: current
  };
}

function splitList(value: string) {
  return value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
}

function compactUnique(values: Array<string | undefined | null>) {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function outboundDomainsFromAnalysis(analysis: PageAnalysis) {
  return compactUnique((analysis.outboundLinks ?? []).map((link) => link.rootDomain))
    .filter((rootDomain) => rootDomain && rootDomain !== analysis.rootDomain);
}

async function recordDiscoveryTargetsFromAnalysis(analysis: PageAnalysis, outboundDomains: string[]) {
  const current = nowIso();
  const targets: DiscoveryTarget[] = outboundDomains.map((rootDomain) => ({
    id: uid("disc"),
    rootDomain,
    sourceRootDomain: analysis.rootDomain,
    sourcePageUrl: analysis.url,
    discoveredFrom: "page_outbound",
    provider: "none",
    status: "new",
    firstSeenAt: current,
    lastSeenAt: current,
    occurrenceCount: 1,
    discoveredOnPages: [analysis.url],
    seenSourceRootDomains: [analysis.rootDomain],
    whoisCheckedAt: "",
    seoCheckedAt: "",
    lastError: "",
    notes: `Discovered while analyzing outbound links on ${analysis.rootDomain}`
  }));
  if (targets.length) await upsertDiscoveryTargets(targets);
}

function firstValue(row: Record<string, string>, keys: string[]) {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [normalizeColumnName(key), value]));
  for (const key of keys) {
    if (row[key]) return row[key];
    const value = normalized.get(normalizeColumnName(key));
    if (value) return value;
  }
  return "";
}

function normalizeColumnName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function relFromRow(row: Record<string, string>): LinkRel {
  const rel = firstValue(row, ["rel", "Rel", "Link rel", "Link Rel"]);
  if (rel) return inferLinkRel(rel);
  if (truthy(firstValue(row, ["Sponsored", "sponsored"]))) return "sponsored";
  if (truthy(firstValue(row, ["Ugc", "UGC", "ugc"]))) return "ugc";
  if (truthy(firstValue(row, ["Nofollow", "NoFollow", "nofollow"]))) return "nofollow";
  return "dofollow";
}

function inferLinkRel(value: string): LinkRel {
  const clean = value.toLowerCase();
  if (clean.includes("sponsored")) return "sponsored";
  if (clean.includes("ugc")) return "ugc";
  if (clean.includes("nofollow")) return "nofollow";
  if (clean.includes("dofollow") || clean.includes("follow")) return "dofollow";
  return "unknown";
}

function truthy(value: string) {
  return /^(true|1|yes|y)$/i.test(value.trim());
}

function numberValue(value: string) {
  const parsed = Number(String(value).replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function metricValue(value: string) {
  const clean = String(value ?? "").trim().toLowerCase().replace(/,/g, "");
  if (!clean) return undefined;
  const match = clean.match(/(\d+(?:\.\d+)?)\s*([kmb])?/);
  if (!match) return undefined;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;
  const multiplier = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : match[2] === "b" ? 1_000_000_000 : 1;
  return Math.round(base * multiplier);
}

function priorityRank(priority: string) {
  return ({ A: 1, B: 2, C: 3, D: 4, X: 5 } as Record<string, number>)[priority] ?? 9;
}

function labelForType(type: BacklinkCategory) {
  return {
    product_submission: "产品提交",
    ugc_comment_profile: "UGC/Profile",
    developer_content: "内容托管",
    media_outreach: "媒体曝光",
    opportunity_strategy: "机会策略",
    unknown: "未知"
  }[type];
}

function backlinkOpportunity(source: BacklinkSource): { kind: OpportunityKind; label: string } {
  if (isSearchResultUrl(source.sourceUrl)) {
    return { kind: "skip", label: "搜索结果页" };
  }

  if (isCommunityOnlyDomain(source.rootDomain)) {
    return { kind: "skip", label: "社区不推广" };
  }

  if (source.status === "blacklisted" || source.status === "skipped" || source.hasCloudflare || source.hasCaptcha) {
    return { kind: "skip", label: "跳过" };
  }

  if (source.sourceType === "product_submission" || source.hasSubmitForm || source.hasProfileField) {
    return { kind: "direct", label: "可直接发" };
  }

  if (source.sourceType === "developer_content" || source.sourceType === "media_outreach") {
    return { kind: "review", label: "人工判断" };
  }

  if (source.sourceType === "ugc_comment_profile") {
    const isCommunityOnly = isCommunityOnlyDomain(source.rootDomain);
    if (source.hasProfileField) {
      return { kind: "direct", label: source.requiresLogin || source.requiresRegister ? "需账号可发" : "可直接发" };
    }
    if (source.hasCommentForm && !isCommunityOnly) {
      return { kind: "review", label: source.requiresLogin || source.requiresRegister ? "登录后判断" : "评论待判断" };
    }
    if (source.hasCommentForm && isCommunityOnly) {
      return { kind: "engage", label: "低价值互动" };
    }
    if (source.requiresLogin || source.requiresRegister) {
      return { kind: "review", label: "需账号验证" };
    }
    return { kind: "skip", label: "无发布入口" };
  }

  if (source.requiresPayment) {
    return { kind: "review", label: source.status === "usable" ? "付费已保留" : "付费待判断" };
  }

  if (source.detectedRel === "dofollow" && sourceEvidenceCount(source) >= 3) {
    return { kind: "review", label: "人工判断" };
  }

  return { kind: "review", label: "待分析" };
}

function opportunityFromAnalysis(analysis: PageAnalysis): OpportunityKind {
  if (analysis.pageUnavailable || analysis.captchaDetected || analysis.cloudflareDetected || analysis.noindex) return "skip";
  if (isCommunityOnlyDomain(analysis.rootDomain)) return "skip";
  const hasCommentField = analysis.formFields.some((field) => field.purpose === "comment");
  const blogCommentLike = hasCommentField || isBloggerCommentAnalysis(analysis) || isArticleCommentAnalysis(analysis) || isGenericBlogCommentAnalysis(analysis) || isBlogArticleUrl(analysis);
  const hasProfileField = analysis.formFields.some((field) => field.purpose === "bio" || (field.purpose === "website" && !blogCommentLike));
  if (analysis.paidPlacementDetected && !hasCommentField) return "review";
  const profileCandidate = !blogCommentLike && (analysis.profileCandidateDetected || isProfileCandidatePage(analysis));
  if (analysis.forumThreadDetected || analysis.forumReplyDetected) {
    return analysis.hasForm ? "review" : "skip";
  }
  if (analysis.directorySubmissionDetected) {
    if (analysis.loginRequired || analysis.registerRequired || analysis.submissionLinks.length > 0) return "review";
    if (analysis.hasForm && analysis.submitButtons.length > 0 && !hasCommentField) return "direct";
  }
  if (blogCommentLike) return "review";
  if (profileCandidate) {
    if (hasProfileField) return "direct";
    return "review";
  }
  if (hasProfileField || analysis.submitButtons.length > 0 && analysis.hasForm && !hasCommentField) return "direct";
  if (hasCommentField && isCommunityOnlyDomain(analysis.rootDomain)) return "engage";
  if (hasCommentField) return "review";
  if (analysis.commentHtmlAnchorLikely || (analysis.hasForm && analysis.pageType === "ugc_comment_profile")) return "review";
  if (isClosedTopicPage(analysis)) return "skip";
  if (isProfileCandidatePage(analysis)) return "review";
  return "skip";
}

function opportunityFromAnalysisForSource(analysis: PageAnalysis, source: BacklinkSource, allPages: BacklinkPage[]): OpportunityKind {
  const base = opportunityFromAnalysis(analysis);
  if (base !== "skip") return base;
  if (isHardSkipAnalysis(analysis)) return base;
  const sourcePages = pagesForSource(source, allPages);
  const resourceClass = executionResourceClass(source, sourcePages);
  const accountGate =
    analysis.loginRequired ||
    analysis.registerRequired ||
    analysis.profileCandidateDetected ||
    analysis.pageType === "ugc_comment_profile" ||
    isProfileCandidatePage(analysis);
  const sourceProfileCandidate =
    resourceClass === "profile" ||
    source.sourceType === "ugc_comment_profile" ||
    source.requiresLogin ||
    source.requiresRegister ||
    source.hasProfileField;
  if (sourceProfileCandidate && accountGate) return "review";
  return base;
}

function isHardSkipAnalysis(analysis: PageAnalysis) {
  return (
    analysis.pageUnavailable ||
    analysis.captchaDetected ||
    analysis.cloudflareDetected ||
    analysis.noindex ||
    isCommunityOnlyDomain(analysis.rootDomain)
  );
}

function skipScopeForAnalysis(analysis: PageAnalysis): "page" | "domain" | "none" {
  if (analysis.cloudflareDetected) return "domain";
  if (isCommunityOnlyDomain(analysis.rootDomain)) return "domain";
  if (isBrowserErrorAnalysis(analysis)) return "domain";
  if (opportunityFromAnalysis(analysis) === "skip") return "page";
  return "none";
}

function skipReasonForAnalysis(analysis: PageAnalysis) {
  if (isBrowserErrorAnalysis(analysis)) return "Browser security/network error";
  if (analysis.pageUnavailable) return "Page unavailable or not found";
  if (analysis.captchaDetected) return "Captcha detected";
  if (analysis.cloudflareDetected) return "Cloudflare or bot protection detected";
  if (analysis.noindex) return "Noindex page";
  if (isCommunityOnlyDomain(analysis.rootDomain)) return "Community domain not suitable for promotion";
  if (analysis.paidPlacementDetected) return "Paid placement or link farm detected";
  if (!analysis.hasForm) return "No publishable form detected";
  return "Skipped after page analysis";
}

function isBrowserErrorAnalysis(analysis: PageAnalysis) {
  const haystack = `${analysis.url} ${analysis.title}`.toLowerCase();
  return analysis.pageUnavailable && /(chrome-error:|privacy error|your connection is not private|隐私设置错误|您的连接不是私密连接|net::err_|err_cert_|err_ssl_|err_connection_|err_name_not_resolved|err_timed_out)/i.test(haystack);
}

function appendNote(existing: string, next: string) {
  const cleanExisting = existing.trim();
  return cleanExisting ? `${cleanExisting}\n${next}` : next;
}

function isClosedTopicPage(analysis: PageAnalysis) {
  const haystack = `${analysis.url} ${analysis.title}`.toLowerCase();
  return /(topic|thread|discuss|discussion|post)/.test(haystack) && !analysis.hasForm;
}

function isProfileCandidatePage(analysis: PageAnalysis) {
  if (analysis.profileCandidateDetected) return true;
  const haystack = `${analysis.url} ${analysis.title}`.toLowerCase();
  if (isGenericBlogCommentAnalysis(analysis) || isBloggerCommentAnalysis(analysis) || isArticleCommentAnalysis(analysis)) return false;
  return analysis.pageType === "ugc_comment_profile" &&
    /(forum|profile|user|member|account|settings|signature|register|login)/.test(haystack);
}

function sameUrl(a = "", b = "") {
  try {
    return normalizeUrl(a).replace(/\/$/, "") === normalizeUrl(b).replace(/\/$/, "");
  } catch {
    return a.replace(/\/$/, "") === b.replace(/\/$/, "");
  }
}

function pageSummaryLabel(source: BacklinkSource, pages: BacklinkPage[]) {
  return pageSummaryLabelFromPages(pagesForSource(source, pages));
}

function pageSummaryLabelFromPages(sourcePages: BacklinkPage[]) {
  if (!sourcePages.length) return "页面 0";
  const direct = sourcePages.filter((page) => page.opportunity === "direct").length;
  const review = sourcePages.filter((page) => page.opportunity === "review").length;
  const engage = sourcePages.filter((page) => page.opportunity === "engage").length;
  const skip = sourcePages.filter((page) => page.opportunity === "skip").length;
  const parts = [
    `页面 ${sourcePages.length}`,
    direct ? `可发 ${direct}` : "",
    review ? `判断 ${review}` : "",
    engage ? `互动 ${engage}` : "",
    skip ? `跳过 ${skip}` : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function buildResourcePoolModel(sources: BacklinkSource[], pages: BacklinkPage[]) {
  const sourcePagesById = buildSourcePagesById(sources, pages);
  const items = sources.map((source) => {
    const sourcePages = sourcePagesById.get(source.id) ?? [];
    const opportunity = sourceDisplayOpportunityFromPages(source, sourcePages);
    const summaryLabel = pageSummaryLabelFromPages(sourcePages);
    return {
      source,
      pages: sourcePages,
      opportunity,
      summaryLabel,
      queueRank: sourceQueueRankFromPages(source, opportunity.kind, sourcePages),
      searchText: `${source.sourceDomain} ${source.rootDomain} ${source.sourceUrl} ${source.sourceType} ${source.priorityLevel} ${opportunity.label} ${summaryLabel}`.toLowerCase()
    };
  }).sort((a, b) => a.queueRank - b.queueRank || a.source.rootDomain.localeCompare(b.source.rootDomain));

  const stats = {
    totalDomains: sources.length,
    activeDomains: 0,
    excludedDomains: 0,
    pendingDetection: 0,
    passedDetection: 0,
    secondReviewDomains: 0,
    repeatedDomains: 0,
    repeatedPages: 0
  };

  for (const item of items) {
    if (isExcludedResourceItem(item)) {
      stats.excludedDomains += 1;
      continue;
    }
    stats.activeDomains += 1;
    if (sourceNeedsDetectionFromPages(item.source, item.pages, item.opportunity)) stats.pendingDetection += 1;
    if (sourcePassedDetectionFromPages(item.source, item.pages, item.opportunity)) stats.passedDetection += 1;
    if (sourceEvidenceCount(item.source) > 1) stats.repeatedDomains += 1;
  }
  stats.secondReviewDomains = Math.max(stats.activeDomains - stats.pendingDetection - stats.passedDetection, 0);
  stats.repeatedPages = pages.filter((page) => pageEvidenceCount(page) > 1 && !isSearchResultUrl(page.pageUrl)).length;

  return { items, stats };
}

function isExcludedResourceItem(item: { source: BacklinkSource; pages: BacklinkPage[]; opportunity: { kind: OpportunityKind; label: string } }) {
  if (item.source.status === "skipped" || item.source.status === "blacklisted" || item.source.priorityLevel === "X") return true;
  if (item.opportunity.kind === "skip") return true;
  return item.pages.length > 0 && actionablePagesFromSortedPages(item.pages).length === 0 && item.pages.every((page) => page.status === "skipped" || page.opportunity === "skip");
}

function buildSourcePagesById(sources: BacklinkSource[], pages: BacklinkPage[]) {
  const bySourceId = new Map<string, BacklinkPage[]>();
  const byRootDomain = new Map<string, BacklinkPage[]>();

  for (const page of pages) {
    if (isSearchResultUrl(page.pageUrl)) continue;
    if (page.sourceId) {
      const rows = bySourceId.get(page.sourceId) ?? [];
      rows.push(page);
      bySourceId.set(page.sourceId, rows);
    }
    if (page.rootDomain) {
      const rows = byRootDomain.get(page.rootDomain) ?? [];
      rows.push(page);
      byRootDomain.set(page.rootDomain, rows);
    }
  }

  const result = new Map<string, BacklinkPage[]>();
  for (const source of sources) {
    const seen = new Set<string>();
    const sourcePages = [
      ...(bySourceId.get(source.id) ?? []),
      ...(byRootDomain.get(source.rootDomain) ?? [])
    ].filter((page) => {
      if (seen.has(page.id)) return false;
      seen.add(page.id);
      return true;
    }).sort((a, b) => opportunityRank(a.opportunity) - opportunityRank(b.opportunity) || b.lastSeenAt.localeCompare(a.lastSeenAt));
    result.set(source.id, sourcePages);
  }
  return result;
}

function resourcePoolStats(sources: BacklinkSource[], pages: BacklinkPage[]) {
  return {
    totalDomains: sources.length,
    pendingDetection: sources.filter((source) => sourceNeedsDetection(source, pages)).length,
    passedDetection: sources.filter((source) => sourcePassedDetection(source, pages)).length,
    repeatedDomains: sources.filter((source) => sourceEvidenceCount(source) > 1).length,
    repeatedPages: pages.filter((page) => pageEvidenceCount(page) > 1 && !isSearchResultUrl(page.pageUrl)).length
  };
}

function sourceEvidenceCount(source: BacklinkSource) {
  return Math.max(source.seenCompetitorDomains?.length || 0, source.competitorCount || 0, 1);
}

function pageEvidenceCount(page: BacklinkPage) {
  return Math.max(page.seenCompetitorDomains?.length || 0, page.competitorDomain ? 1 : 0, 1);
}

function sourceHasPrecheck(source: BacklinkSource, pages: BacklinkPage[]) {
  return sourceHasPrecheckFromPages(source, pagesForSource(source, pages));
}

function sourceHasPrecheckFromPages(source: BacklinkSource, sourcePages: BacklinkPage[]) {
  if (source.status === "analyzed" || source.status === "usable" || source.status === "skipped" || source.status === "blacklisted") return true;
  return sourcePages.some((page) =>
    Boolean(page.lastAnalyzedAt) ||
    page.status === "analyzed" ||
    page.status === "skipped"
  );
}

function sourceNeedsDetection(source: BacklinkSource, pages: BacklinkPage[]) {
  if (sourceDisplayOpportunity(source, pages).kind === "skip") return false;
  return !sourceHasPrecheck(source, pages);
}

function sourceNeedsDetectionFromPages(source: BacklinkSource, sourcePages: BacklinkPage[], opportunity: { kind: OpportunityKind }) {
  if (opportunity.kind === "skip") return false;
  return !sourceHasPrecheckFromPages(source, sourcePages);
}

function sourcePassedDetection(source: BacklinkSource, pages: BacklinkPage[]) {
  return sourceDisplayOpportunity(source, pages).kind !== "skip" && hasAnalyzedActionablePage(pagesForSource(source, pages));
}

function sourcePassedDetectionFromPages(_source: BacklinkSource, sourcePages: BacklinkPage[], opportunity: { kind: OpportunityKind }) {
  return opportunity.kind !== "skip" && hasAnalyzedActionablePage(sourcePages);
}

function hasAnalyzedActionablePage(sourcePages: BacklinkPage[]) {
  return sourcePages.some((page) =>
    Boolean(page.lastAnalyzedAt) &&
    page.status !== "skipped" &&
    page.opportunity !== "skip"
  );
}

function sourceDisplayOpportunity(source: BacklinkSource, pages: BacklinkPage[]): { kind: OpportunityKind; label: string } {
  return sourceDisplayOpportunityFromPages(source, pagesForSource(source, pages));
}

function sourceDisplayOpportunityFromPages(source: BacklinkSource, sourcePages: BacklinkPage[]): { kind: OpportunityKind; label: string } {
  if (isCommunityOnlyDomain(source.rootDomain)) {
    return { kind: "skip", label: "社区不推广" };
  }
  if (source.status === "blacklisted" || source.status === "skipped" || source.hasCloudflare || source.hasCaptcha) {
    return { kind: "skip", label: "跳过" };
  }
  if (source.status === "usable") {
    const actionable = actionablePagesFromSortedPages(sourcePages)[0];
    return actionable ? opportunityLabelForKind(actionable.opportunity) : { kind: "review", label: "已保留" };
  }
  if (source.requiresPayment) {
    return { kind: "review", label: "付费待判断" };
  }
  if (sourcePages.length) {
    const actionable = actionablePagesFromSortedPages(sourcePages)[0];
    if (!actionable) return { kind: "skip", label: "页面均跳过" };
    return opportunityLabelForKind(actionable.opportunity);
  }
  return backlinkOpportunity(source);
}

function opportunityLabelForKind(kind: OpportunityKind) {
  return {
    direct: { kind, label: "可直接发" },
    review: { kind, label: "人工判断" },
    engage: { kind, label: "低价值互动" },
    skip: { kind, label: "跳过" }
  }[kind];
}

function pagesForSource(source: BacklinkSource, pages: BacklinkPage[]) {
  return pages
    .filter((page) => (page.sourceId === source.id || page.rootDomain === source.rootDomain) && !isSearchResultUrl(page.pageUrl))
    .sort((a, b) => opportunityRank(a.opportunity) - opportunityRank(b.opportunity) || b.lastSeenAt.localeCompare(a.lastSeenAt));
}

function actionablePagesForSource(source: BacklinkSource, pages: BacklinkPage[]) {
  return actionablePagesFromSortedPages(pagesForSource(source, pages));
}

function actionablePagesFromSortedPages(sourcePages: BacklinkPage[]) {
  return sourcePages.filter((page) => page.opportunity !== "skip" && page.status !== "skipped");
}

function openBestPage(source: BacklinkSource, pages: BacklinkPage[]) {
  if (isSearchResultUrl(source.sourceUrl)) return;
  const best = bestPageUrl(source, pages);
  if (best) openUrl(best, true);
}

function openBestPageFromPages(source: BacklinkSource, sourcePages: BacklinkPage[]) {
  if (isSearchResultUrl(source.sourceUrl)) return;
  openUrl(bestPageUrlFromPages(source, sourcePages), true);
}

function openSeoForDomain(domain: string, provider: "ahrefs" | "semrush") {
  if (!domain) return;
  chrome.runtime.sendMessage({ type: provider === "ahrefs" ? "OPEN_AHREFS" : "OPEN_SEMRUSH", domain });
}

function bestPageUrl(source: BacklinkSource, pages: BacklinkPage[]) {
  return bestPageUrlFromPages(source, pagesForSource(source, pages));
}

function bestPageUrlFromPages(source: BacklinkSource, sourcePages: BacklinkPage[]) {
  return actionablePagesFromSortedPages(sourcePages)[0]?.pageUrl || source.sourceUrl;
}

function queueSourceItems(
  sources: BacklinkSource[],
  pages: BacklinkPage[],
  executedRoots = new Set<string>(),
  excludedUrls = new Set<string>(),
  options: { requireAnalyzed?: boolean } = {}
) {
  return sources
    .filter((source) => !isSearchResultUrl(source.sourceUrl))
    .map((source) => ({ source, opportunity: sourceDisplayOpportunity(source, pages), url: bestPageUrl(source, pages) }))
    .filter((item) =>
      item.opportunity.kind !== "skip" &&
      (!options.requireAnalyzed || sourceHasPrecheck(item.source, pages)) &&
      !executedRoots.has(item.source.rootDomain) &&
      !excludedUrls.has(queueUrlKey(item.url))
    )
    .sort((a, b) => sourceQueueRank(a.source, a.opportunity.kind, pages) - sourceQueueRank(b.source, b.opportunity.kind, pages));
}

function queueSourceItemsFromModel(
  resourcePool: ResourcePoolModel,
  executedRoots = new Set<string>(),
  excludedUrls = new Set<string>(),
  options: { requireAnalyzed?: boolean; requirePassedPrecheck?: boolean } = {}
) {
  return resourcePool.items
    .map((item) => ({ ...item, url: bestPageUrlFromPages(item.source, item.pages) }))
    .filter((item) =>
      item.opportunity.kind !== "skip" &&
      (!options.requirePassedPrecheck || sourcePassedDetectionFromPages(item.source, item.pages, item.opportunity)) &&
      (!options.requireAnalyzed || sourceHasPrecheckFromPages(item.source, item.pages)) &&
      !executedRoots.has(item.source.rootDomain) &&
      !excludedUrls.has(queueUrlKey(item.url))
    );
}

function candidatePageCount(items: Array<{ pages: BacklinkPage[] }>) {
  return items.reduce((sum, item) => sum + actionablePagesFromSortedPages(item.pages).length, 0);
}

function sourceQueueRank(source: BacklinkSource, opportunity: OpportunityKind, pages: BacklinkPage[]) {
  return sourceQueueRankFromPages(source, opportunity, pagesForSource(source, pages));
}

function sourceQueueRankFromPages(source: BacklinkSource, opportunity: OpportunityKind, sourcePages: BacklinkPage[]) {
  const skippedPages = sourcePages.filter((page) => page.opportunity === "skip" || page.status === "skipped").length;
  const analyzedPages = sourcePages.filter((page) => page.lastAnalyzedAt || page.status === "analyzed" || page.status === "skipped").length;
  const classScore = executionClassRank(source, sourcePages) * 10000;
  const directoryQualityScore = classifyDirectoryQuality(source, sourcePages).rank * 750;
  const opportunityScore = opportunityRank(opportunity) * 1000;
  const priorityScore = (({ A: 0, B: 1, C: 2, D: 3, X: 4 } as const)[source.priorityLevel] ?? 3) * 100;
  const discoveryScore = discoveryPriorityPenalty(source, sourcePages);
  const precheckPenalty = analyzedPages * 250 + skippedPages * 50;
  return classScore + directoryQualityScore + opportunityScore + priorityScore + discoveryScore + precheckPenalty;
}

function discoveryPriorityPenalty(source: BacklinkSource, sourcePages: BacklinkPage[]) {
  const haystack = `${source.discoveredFrom} ${source.notes} ${sourcePages.map((page) => `${page.discoveredFrom} ${page.notes}`).join(" ")}`.toLowerCase();
  const competitorBonus = Math.min(Math.max(source.competitorCount || source.seenCompetitorDomains?.length || 0, 0), 5) * 35;
  const metricBonus = Math.min((source.dr ?? 0) * 1.5, 90) + Math.min(Math.log10((source.traffic ?? 0) + 1) * 30, 120);
  if (/prepared type|link strategy|has url field|\.xlsx|\.xls/.test(haystack)) return -420 - competitorBonus - metricBonus;
  if (/ahrefs|semrush/.test(haystack)) return -260 - competitorBonus - metricBonus;
  if (source.discoveredOutboundDomains?.length) return -80 - Math.min(source.discoveredOutboundDomains.length * 15, 80);
  return -metricBonus;
}

type ExecutionFilter = "all" | Exclude<ExecutionResourceClass, "other"> | "manual_review";
type ExecutionQueueMode = "full_review" | "actionable_only";

function executionQueueOptions(mode: ExecutionQueueMode) {
  return mode === "actionable_only"
    ? { requirePassedPrecheck: true }
    : { requireAnalyzed: true };
}

function executionClassSummary(items: Array<{ source: BacklinkSource; pages: BacklinkPage[]; opportunity: { kind: OpportunityKind } }>) {
  const counts: Record<ExecutionResourceClass, number> = {
    directory: 0,
    developer_blog: 0,
    profile: 0,
    blog_comment: 0,
    shortlink: 0,
    other: 0
  };
  for (const item of items) {
    counts[executionResourceClass(item.source, item.pages)] += 1;
  }
  const labels: Record<Exclude<ExecutionResourceClass, "other">, string> = {
    directory: "目录/提交",
    developer_blog: "开发者博客",
    profile: "Profile",
    blog_comment: "博客评论",
    shortlink: "短链"
  };
  const classItems = (Object.keys(labels) as Array<Exclude<ExecutionResourceClass, "other">>)
    .filter((key) => counts[key] > 0)
    .map((key) => ({ filter: key as ExecutionFilter, label: labels[key], count: counts[key] }));
  return [
    { filter: "all" as ExecutionFilter, label: "默认优先级", count: items.length },
    ...classItems,
    ...(counts.other ? [{ filter: "manual_review" as ExecutionFilter, label: "待人工验证", count: counts.other }] : [])
  ];
}

function filterExecutionItems<T extends { source: BacklinkSource; pages: BacklinkPage[]; opportunity: { kind: OpportunityKind } }>(
  items: T[],
  filter: ExecutionFilter
) {
  if (filter === "all") return items;
  return items.filter((item) => matchesExecutionFilter(item, filter));
}

function matchesExecutionFilter(
  item: { source: BacklinkSource; pages: BacklinkPage[]; opportunity: { kind: OpportunityKind } },
  filter: ExecutionFilter
) {
  if (filter === "manual_review") return executionResourceClass(item.source, item.pages) === "other";
  return executionResourceClass(item.source, item.pages) === filter;
}

function executionFilterLabel(filter: ExecutionFilter) {
  return {
    all: "默认优先级",
    directory: "目录/提交",
    developer_blog: "开发者博客",
    profile: "Profile",
    blog_comment: "博客评论",
    shortlink: "短链",
    manual_review: "待人工验证"
  }[filter];
}

function queueUrlKey(url: string) {
  try {
    return normalizeUrl(url).replace(/\/$/, "");
  } catch {
    return url.replace(/\/$/, "");
  }
}

function checkLogResultLabel(log: CheckLog) {
  if (log.result === "candidate") return log.opportunity === "direct" ? "候选通过：可发布" : "候选通过：人工判断";
  if (log.result === "skip") return log.skipScope === "domain" ? "已跳过域名" : "已跳过页面";
  return "检测异常";
}

function formatTime(value: string) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function openUrl(url: string, rememberForExecution = false) {
  if (rememberForExecution) void rememberPendingExecutionUrl(url);
  void chrome.tabs.create({ url });
}

function openWorkbenchTab() {
  void chrome.tabs.create({ url: chrome.runtime.getURL("src/popup/index.html") });
}

async function openSidePanel() {
  await chrome.runtime.sendMessage({ type: "OPEN_SIDEPANEL" });
}

function waitForTabComplete(tabId: number, timeoutMs: number) {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    }).catch(finish);
    window.setTimeout(finish, timeoutMs);
  });
}

function rememberPendingExecutionUrl(url: string) {
  return chrome.storage.local.set({ pendingExecutionUrl: url });
}

async function getPendingExecutionUrl() {
  const result = await chrome.storage.local.get("pendingExecutionUrl");
  return typeof result.pendingExecutionUrl === "string" ? result.pendingExecutionUrl : "";
}

function clearPendingExecutionUrl() {
  return chrome.storage.local.remove("pendingExecutionUrl");
}

function pageLabel(page: BacklinkPage) {
  return truncate(page.pageTitle || page.pageUrl, 86);
}

function opportunityRank(kind: OpportunityKind) {
  return ({ direct: 1, review: 2, engage: 3, skip: 4 } as Record<OpportunityKind, number>)[kind];
}

const PROJECT_EXECUTED_STATUSES = new Set<SubmissionStatus>([
  "filled",
  "waiting_manual_submit",
  "submitted",
  "pending_review",
  "live_dofollow",
  "live_nofollow",
  "live_ugc",
  "live_sponsored"
]);

function projectExecutedRootDomains(submissions: BacklinkSubmission[], projectId?: string) {
  if (!projectId) return new Set<string>();
  return new Set(submissions
    .filter((submission) => submission.projectId === projectId && PROJECT_EXECUTED_STATUSES.has(submission.status) && isValidSubmissionTarget(submission))
    .map((submission) => rootDomainFromUrl(submission.submittedUrl || submission.targetUrl))
    .filter(Boolean));
}

function todayProjectProcessedRootDomains(submissions: BacklinkSubmission[]) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return new Set(submissions
    .filter((submission) =>
      PROJECT_EXECUTED_STATUSES.has(submission.status) &&
      isValidSubmissionTarget(submission) &&
      submissionHappenedInRange(submission, start.getTime(), end.getTime())
    )
    .map((submission) => rootDomainFromUrl(submission.submittedUrl || submission.targetUrl))
    .filter(Boolean));
}

function submissionHappenedInRange(submission: BacklinkSubmission, startMs: number, endMs: number) {
  return [submission.checkedAt, submission.submittedAt]
    .filter(Boolean)
    .some((value) => {
      const time = Date.parse(value);
      return Number.isFinite(time) && time >= startMs && time < endMs;
    });
}

function isValidSubmissionTarget(submission: BacklinkSubmission) {
  const url = submission.submittedUrl || submission.targetUrl;
  if (!isHttpUrl(url)) return false;
  const root = rootDomainFromUrl(url);
  return Boolean(root) && root !== "chromiumapp.org";
}

async function closeTabIfCurrent(tab: chrome.tabs.Tab | undefined) {
  if (!tab?.id || !isHttpUrl(tab.url ?? "")) return;
  await chrome.tabs.remove(tab.id).catch(() => undefined);
}

function isCommunityOnlyDomain(rootDomain: string) {
  return new Set([
    "scratch.mit.edu",
    "facebook.com",
    "instagram.com",
    "tiktok.com",
    "youtube.com"
  ]).has(rootDomain);
}

function isSearchResultUrl(url: string) {
  try {
    const parsed = new URL(normalizeUrl(url));
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return (
      host.includes("search.yahoo.") ||
      host.startsWith("www.google.") && path.startsWith("/search") ||
      host.startsWith("www.bing.") && path.startsWith("/search") ||
      host.startsWith("duckduckgo.com") ||
      host.startsWith("yandex.") && path.startsWith("/search")
    );
  } catch {
    return false;
  }
}

function projectLinkStatus(analysis: PageAnalysis, project?: Project) {
  if (!project?.siteUrl) return "未设置";
  return analysis.existingTargetLink ? `${analysis.targetLinkCount} 次 · ${analysis.existingLinkRel}` : "未出现";
}

function competitorLinkStatus(analysis: PageAnalysis) {
  if (!analysis.competitorDomain) return "未设置";
  return analysis.competitorLinkCount > 0
    ? `${analysis.competitorDomain} · ${analysis.competitorLinkCount} 次 · ${analysis.competitorLinkRel}`
    : `${analysis.competitorDomain} · 未出现`;
}

function competitorAnchorStatus(analysis: PageAnalysis) {
  if (!analysis.competitorDomain) return "未设置";
  if (!analysis.competitorAnchors.length) return "未出现";
  return truncate(analysis.competitorAnchors.join(" / "), 80);
}

function discoveredDomainsFromAnalysis(analysis: PageAnalysis) {
  return compactUnique((analysis.outboundLinks ?? []).map((link) => link.rootDomain))
    .filter((rootDomain) => rootDomain && rootDomain !== analysis.rootDomain);
}

function discoveredDomainsStatus(analysis: PageAnalysis) {
  const domains = discoveredDomainsFromAnalysis(analysis);
  if (!domains.length) return "未发现";
  return `${domains.length} 个 · ${truncate(domains.slice(0, 3).join(" / "), 64)}`;
}

function sourceForUrl(sources: BacklinkSource[], url: string) {
  const root = rootDomainFromUrl(url);
  return sources.find((source) => source.rootDomain === root);
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function flatten(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, String(value ?? "")]));
}

function downloadFile(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

createRoot(document.getElementById("root")!).render(<App />);
