import { allCheckLogs, allDiscoveryTargets, allImports, allPages, allProjects, allSources, allSubmissions, replaceSyncedData, type SyncedLocalData } from "./db";
import {
  bestExecutionPageUrl,
  classifyDirectoryQuality,
  executionClassLabel,
  executionResourceClass,
  sourcePassedPrecheck,
  actionablePagesFromSortedPages
} from "./executionClassification";
import type { BacklinkPage, BacklinkSource, BacklinkSubmission, CheckLog, DiscoveryTarget, ImportBatch, Project } from "./types";

type SheetCell = string | number | boolean;

interface SheetTable {
  name: string;
  headers: string[];
  rows: Array<Record<string, unknown>>;
}

export interface GoogleSheetsSyncResult {
  spreadsheetId: string;
  tableCount: number;
  rowCount: number;
  syncedAt: string;
}

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const MAX_SHEET_CELL_LENGTH = 49000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

interface CachedGoogleToken {
  clientId: string;
  token: string;
  expiresAt: number;
}

export function extractSpreadsheetId(input: string) {
  const trimmed = input.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] ?? trimmed;
}

export async function syncLocalDataToGoogleSheets(
  spreadsheetIdOrUrl: string,
  googleOAuthClientId: string,
  onProgress: (message: string) => void = () => undefined,
  options: { interactiveAuth?: boolean } = {}
): Promise<GoogleSheetsSyncResult> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdOrUrl);
  if (!spreadsheetId) throw new Error("请先填写 Google Sheets ID 或表格链接。");
  if (!googleOAuthClientId.trim()) throw new Error("请先填写 Google OAuth Web Client ID。");

  onProgress("正在请求 Google 授权");
  const token = await getGoogleAccessToken(googleOAuthClientId.trim(), options.interactiveAuth ?? true);

  onProgress("正在读取本地数据");
  const [projects, sources, pages, submissions, imports, checkLogs, discoveryTargets] = await Promise.all([
    allProjects(),
    allSources(),
    allPages(),
    allSubmissions(),
    allImports(),
    allCheckLogs(),
    allDiscoveryTargets()
  ]);

  const syncedAt = new Date().toISOString();
  const tables = buildTables({ projects, sources, pages, submissions, imports, checkLogs, discoveryTargets, syncedAt });

  onProgress("正在准备工作表");
  await ensureSheets(spreadsheetId, token, tables.map((table) => table.name));

  let rowCount = 0;
  for (const table of tables) {
    onProgress(`正在同步 ${table.name}`);
    const values = [table.headers, ...table.rows.map((row) => table.headers.map((header) => cellValue(row[header])))];
    rowCount += table.rows.length;
    await clearValues(spreadsheetId, token, table.name);
    await updateValues(spreadsheetId, token, table.name, values);
  }

  return { spreadsheetId, tableCount: tables.length, rowCount, syncedAt };
}

export async function restoreLocalDataFromGoogleSheets(
  spreadsheetIdOrUrl: string,
  googleOAuthClientId: string,
  onProgress: (message: string) => void = () => undefined
): Promise<GoogleSheetsSyncResult> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdOrUrl);
  if (!spreadsheetId) throw new Error("请先填写 Google Sheets ID 或表格链接。");
  if (!googleOAuthClientId.trim()) throw new Error("请先填写 Google OAuth Web Client ID。");

  onProgress("正在请求 Google 授权");
  const token = await getGoogleAccessToken(googleOAuthClientId.trim(), true);

  onProgress("正在读取 Google Sheets");
  const data = await readSyncedTables(spreadsheetId, token);
  const rowCount =
    data.projects.length +
    data.sources.length +
    data.pages.length +
    data.submissions.length +
    data.imports.length +
    data.checkLogs.length +
    (data.discoveryTargets?.length ?? 0);

  onProgress("正在覆盖本地数据");
  await replaceSyncedData(data);

  return { spreadsheetId, tableCount: 7, rowCount, syncedAt: new Date().toISOString() };
}

function buildTables(data: {
  projects: Awaited<ReturnType<typeof allProjects>>;
  sources: Awaited<ReturnType<typeof allSources>>;
  pages: Awaited<ReturnType<typeof allPages>>;
  submissions: Awaited<ReturnType<typeof allSubmissions>>;
  imports: Awaited<ReturnType<typeof allImports>>;
  checkLogs: Awaited<ReturnType<typeof allCheckLogs>>;
  discoveryTargets: Awaited<ReturnType<typeof allDiscoveryTargets>>;
  syncedAt: string;
}): SheetTable[] {
  const sourceById = new Map(data.sources.map((source) => [source.id, source]));
  const pageCountsBySource = countBy(data.pages, (page) => page.sourceId);
  const submissionCountsBySource = countBy(data.submissions, (submission) => submission.sourceId);
  const pagesBySource = buildPagesBySource(data.sources, data.pages);
  const summaryRows = executionSummaryRows(data.sources, pagesBySource);

  return [
    {
      name: "readme",
      headers: ["key", "value"],
      rows: [
        { key: "syncedAt", value: data.syncedAt },
        { key: "mode", value: "local_snapshot_overwrite" },
        { key: "sources", value: data.sources.length },
        { key: "pages", value: data.pages.length },
        { key: "discovery_targets", value: data.discoveryTargets.length },
        { key: "check_logs", value: data.checkLogs.length },
        { key: "submissions", value: data.submissions.length },
        { key: "execution_candidates", value: summaryRows.find((row) => row.executionClass === "all")?.candidateDomains ?? 0 },
        { key: "note", value: "当前版本由扩展本地 IndexedDB 单向覆盖同步到 Google Sheets。" }
      ]
    },
    {
      name: "execution_summary",
      headers: [
        "executionClass",
        "executionClassLabel",
        "candidateDomains",
        "candidatePages",
        "totalDomains",
        "totalPages"
      ],
      rows: summaryRows
    },
    {
      name: "sources",
      headers: [
        "id",
        "rootDomain",
        "sourceDomain",
        "sourceUrl",
        "sourceType",
        "sourceTypeConfidence",
        "priorityLevel",
        "status",
        "executionClass",
        "executionClassLabel",
        "isExecutionCandidate",
        "directoryQuality",
        "directoryQualityReason",
        "actionablePageCount",
        "bestExecutionUrl",
        "detectedRel",
        "dr",
        "traffic",
        "pageCount",
        "submissionCount",
        "occurrenceCount",
        "competitorCount",
        "requiresLogin",
        "requiresRegister",
        "requiresPayment",
        "hasCaptcha",
        "hasCloudflare",
        "hasSubmitForm",
        "hasCommentForm",
        "hasProfileField",
        "isNoindex",
        "failureReason",
        "notes",
        "discoveredFrom",
        "competitorDomain",
        "seenCompetitorDomains",
        "discoveredOutboundDomains",
        "seenOccurrenceKeys",
        "firstSeenAt",
        "lastSeenAt"
      ],
      rows: data.sources
        .sort((a, b) => a.rootDomain.localeCompare(b.rootDomain))
        .map((source) => {
          const sourcePages = pagesBySource.get(source.id) ?? [];
          return {
            ...source,
            pageCount: pageCountsBySource.get(source.id) ?? 0,
            submissionCount: submissionCountsBySource.get(source.id) ?? 0,
            executionClass: executionResourceClass(source, sourcePages),
            executionClassLabel: executionClassLabel(source, sourcePages),
            isExecutionCandidate: sourcePassedPrecheck(source, sourcePages),
            directoryQuality: classifyDirectoryQuality(source, sourcePages).label,
            directoryQualityReason: classifyDirectoryQuality(source, sourcePages).reason,
            actionablePageCount: actionablePagesFromSortedPages(sourcePages).length,
            bestExecutionUrl: bestExecutionPageUrl(source, sourcePages)
          };
        })
    },
    {
      name: "pages",
      headers: [
        "id",
        "sourceId",
        "rootDomain",
        "sourceUrl",
        "pageUrl",
        "pageTitle",
        "pageType",
        "executionClass",
        "executionClassLabel",
        "isActionablePage",
        "discoveredFrom",
        "opportunity",
        "status",
        "detectedRel",
        "competitorDomain",
        "competitorTargetUrl",
        "competitorAnchor",
        "competitorLinkCount",
        "occurrenceCount",
        "seenCompetitorDomains",
        "discoveredOutboundDomains",
        "seenOccurrenceKeys",
        "requiresLogin",
        "requiresRegister",
        "hasCaptcha",
        "hasCloudflare",
        "hasSubmitForm",
        "hasCommentForm",
        "hasProfileField",
        "failureReason",
        "notes",
        "firstSeenAt",
        "lastSeenAt",
        "lastAnalyzedAt"
      ],
      rows: data.pages
        .sort((a, b) => a.rootDomain.localeCompare(b.rootDomain) || a.pageUrl.localeCompare(b.pageUrl))
        .map((page) => {
          const source = sourceById.get(page.sourceId);
          const sourcePages = source ? pagesBySource.get(source.id) ?? [] : [];
          return {
            ...page,
            sourceUrl: source?.sourceUrl ?? "",
            executionClass: source ? executionResourceClass(source, sourcePages) : "",
            executionClassLabel: source ? executionClassLabel(source, sourcePages) : "",
            isActionablePage: page.opportunity !== "skip" && page.status !== "skipped"
          };
        })
    },
    {
      name: "check_logs",
      headers: [
        "id",
        "checkedAt",
        "taskType",
        "projectId",
        "result",
        "opportunity",
        "skipScope",
        "sourceId",
        "sourceRootDomain",
        "sourceUrl",
        "queuedUrl",
        "finalRootDomain",
        "finalUrl",
        "reason",
        "notes"
      ],
      rows: data.checkLogs
        .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
        .map((log) => ({ ...log }))
    },
    {
      name: "submissions",
      headers: [
        "id",
        "projectId",
        "sourceId",
        "targetDomain",
        "targetUrl",
        "submittedUrl",
        "backlinkType",
        "anchorText",
        "status",
        "rel",
        "isLive",
        "isIndexed",
        "submittedAt",
        "checkedAt",
        "nextCheckAt",
        "failureReason",
        "notes",
        "contentUsed",
        "accountUsed",
        "emailUsed"
      ],
      rows: data.submissions
        .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
        .map((submission) => ({ ...submission }))
    },
    {
      name: "projects",
      headers: [
        "id",
        "projectName",
        "siteUrl",
        "brandName",
        "category",
        "language",
        "targetKeywords",
        "anchorTexts",
        "contactEmail",
        "authorName",
        "logoUrl",
        "socialLinks",
        "shortDescription",
        "longDescription",
        "createdAt",
        "updatedAt"
      ],
      rows: data.projects
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((project) => ({ ...project }))
    },
    {
      name: "imports",
      headers: ["id", "source", "label", "importedAt", "rowCount", "createdCount", "updatedCount", "notes"],
      rows: data.imports
        .sort((a, b) => b.importedAt.localeCompare(a.importedAt))
        .map((batch) => ({ ...batch }))
    },
    {
      name: "discovery_targets",
      headers: [
        "id",
        "rootDomain",
        "status",
        "discoveredFrom",
        "provider",
        "sourceRootDomain",
        "sourcePageUrl",
        "occurrenceCount",
        "discoveredOnPages",
        "seenSourceRootDomains",
        "dr",
        "traffic",
        "refDomains",
        "backlinks",
        "domainCreatedAt",
        "domainAgeMonths",
        "whoisCheckedAt",
        "seoCheckedAt",
        "lastError",
        "notes",
        "firstSeenAt",
        "lastSeenAt"
      ],
      rows: data.discoveryTargets
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
        .map((target) => ({ ...target }))
    }
  ];
}

function buildPagesBySource(sources: BacklinkSource[], pages: BacklinkPage[]) {
  const bySourceId = new Map<string, BacklinkPage[]>();
  const byRootDomain = new Map<string, BacklinkPage[]>();

  for (const page of pages) {
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
    }).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    result.set(source.id, sourcePages);
  }
  return result;
}

function executionSummaryRows(sources: BacklinkSource[], pagesBySource: Map<string, BacklinkPage[]>) {
  const labels = {
    directory: "目录/提交",
    developer_blog: "开发者博客",
    profile: "Profile",
    blog_comment: "普通博客评论",
    shortlink: "短链",
    other: "待人工验证"
  };
  const rows: Array<{
    executionClass: string;
    executionClassLabel: string;
    candidateDomains: number;
    candidatePages: number;
    totalDomains: number;
    totalPages: number;
  }> = Object.entries(labels).map(([executionClass, executionClassLabel]) => ({
    executionClass,
    executionClassLabel,
    candidateDomains: 0,
    candidatePages: 0,
    totalDomains: 0,
    totalPages: 0
  }));
  const rowByClass = new Map(rows.map((row) => [row.executionClass, row]));
  const allRow = {
    executionClass: "all",
    executionClassLabel: "全部可执行候选",
    candidateDomains: 0,
    candidatePages: 0,
    totalDomains: sources.length,
    totalPages: 0
  };

  for (const source of sources) {
    const sourcePages = pagesBySource.get(source.id) ?? [];
    const resourceClass = executionResourceClass(source, sourcePages);
    const classRow = rowByClass.get(resourceClass);
    const actionableCount = actionablePagesFromSortedPages(sourcePages).length;
    const isCandidate = sourcePassedPrecheck(source, sourcePages);
    if (classRow) {
      classRow.totalDomains += 1;
      classRow.totalPages += sourcePages.length;
      if (isCandidate) {
        classRow.candidateDomains += 1;
        classRow.candidatePages += actionableCount;
      }
    }
    allRow.totalPages += sourcePages.length;
    if (isCandidate) {
      allRow.candidateDomains += 1;
      allRow.candidatePages += actionableCount;
    }
  }

  return [allRow, ...rows];
}

function countBy<T>(items: T[], keyFn: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

async function readSyncedTables(spreadsheetId: string, token: string): Promise<SyncedLocalData> {
  const [projectRows, sourceRows, pageRows, submissionRows, importRows, checkLogRows, discoveryTargetRows] = await Promise.all([
    readSheetRows(spreadsheetId, token, "projects"),
    readSheetRows(spreadsheetId, token, "sources"),
    readSheetRows(spreadsheetId, token, "pages"),
    readSheetRows(spreadsheetId, token, "submissions"),
    readSheetRows(spreadsheetId, token, "imports"),
    readSheetRows(spreadsheetId, token, "check_logs"),
    readSheetRows(spreadsheetId, token, "discovery_targets")
  ]);

  return {
    projects: projectRows.map(projectFromRow),
    sources: sourceRows.map(sourceFromRow),
    pages: pageRows.map(pageFromRow),
    submissions: submissionRows.map(submissionFromRow),
    imports: importRows.map(importFromRow),
    checkLogs: checkLogRows.map(checkLogFromRow),
    discoveryTargets: discoveryTargetRows.map(discoveryTargetFromRow)
  };
}

async function readSheetRows(spreadsheetId: string, token: string, sheetName: string) {
  const result = await sheetsFetch<{ values?: unknown[][] }>(
    `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(`${sheetName}!A:ZZ`)}?valueRenderOption=UNFORMATTED_VALUE`,
    token
  ).catch((error) => {
    if (error instanceof Error && error.message.includes("Unable to parse range")) return { values: [] };
    throw error;
  });
  const values = result.values ?? [];
  const headers = (values[0] ?? []).map((header) => String(header));
  return values.slice(1).map((row) => {
    const record: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      record[header] = row[index] ?? "";
    });
    return record;
  }).filter((row) => Object.values(row).some((value) => String(value).trim()));
}

function projectFromRow(row: Record<string, unknown>): Project {
  return {
    id: text(row.id),
    projectName: text(row.projectName),
    siteUrl: text(row.siteUrl),
    brandName: text(row.brandName),
    shortDescription: text(row.shortDescription),
    longDescription: text(row.longDescription),
    targetKeywords: list(row.targetKeywords),
    anchorTexts: list(row.anchorTexts),
    category: text(row.category),
    language: text(row.language),
    contactEmail: text(row.contactEmail),
    authorName: text(row.authorName),
    logoUrl: text(row.logoUrl),
    socialLinks: list(row.socialLinks),
    createdAt: text(row.createdAt),
    updatedAt: text(row.updatedAt)
  };
}

function sourceFromRow(row: Record<string, unknown>): BacklinkSource {
  return {
    id: text(row.id),
    sourceDomain: text(row.sourceDomain),
    sourceUrl: text(row.sourceUrl),
    rootDomain: text(row.rootDomain),
    discoveredFrom: text(row.discoveredFrom),
    competitorDomain: text(row.competitorDomain),
    sourceType: text(row.sourceType, "unknown") as BacklinkSource["sourceType"],
    sourceTypeConfidence: numberValue(row.sourceTypeConfidence),
    dr: optionalNumber(row.dr),
    traffic: optionalNumber(row.traffic),
    firstSeenAt: text(row.firstSeenAt),
    lastSeenAt: text(row.lastSeenAt),
    occurrenceCount: numberValue(row.occurrenceCount, 1),
    competitorCount: numberValue(row.competitorCount),
    seenCompetitorDomains: list(row.seenCompetitorDomains),
    discoveredOutboundDomains: list(row.discoveredOutboundDomains),
    seenOccurrenceKeys: list(row.seenOccurrenceKeys),
    requiresLogin: nullableBool(row.requiresLogin),
    requiresRegister: nullableBool(row.requiresRegister),
    requiresPayment: nullableBool(row.requiresPayment),
    hasCaptcha: nullableBool(row.hasCaptcha),
    hasCloudflare: nullableBool(row.hasCloudflare),
    hasSubmitForm: nullableBool(row.hasSubmitForm),
    hasCommentForm: nullableBool(row.hasCommentForm),
    hasProfileField: nullableBool(row.hasProfileField),
    detectedRel: text(row.detectedRel, "unknown") as BacklinkSource["detectedRel"],
    isNoindex: nullableBool(row.isNoindex),
    priorityLevel: text(row.priorityLevel, "D") as BacklinkSource["priorityLevel"],
    status: text(row.status, "new") as BacklinkSource["status"],
    failureReason: text(row.failureReason),
    notes: text(row.notes)
  };
}

function pageFromRow(row: Record<string, unknown>): BacklinkPage {
  return {
    id: text(row.id),
    sourceId: text(row.sourceId),
    rootDomain: text(row.rootDomain),
    pageUrl: text(row.pageUrl),
    pageTitle: text(row.pageTitle),
    pageType: text(row.pageType, "unknown") as BacklinkPage["pageType"],
    discoveredFrom: text(row.discoveredFrom),
    competitorDomain: text(row.competitorDomain),
    competitorTargetUrl: text(row.competitorTargetUrl),
    competitorAnchor: text(row.competitorAnchor),
    competitorLinkCount: numberValue(row.competitorLinkCount),
    occurrenceCount: numberValue(row.occurrenceCount, 1),
    seenCompetitorDomains: list(row.seenCompetitorDomains),
    discoveredOutboundDomains: list(row.discoveredOutboundDomains),
    seenOccurrenceKeys: list(row.seenOccurrenceKeys),
    detectedRel: text(row.detectedRel, "unknown") as BacklinkPage["detectedRel"],
    requiresLogin: nullableBool(row.requiresLogin),
    requiresRegister: nullableBool(row.requiresRegister),
    hasCaptcha: nullableBool(row.hasCaptcha),
    hasCloudflare: nullableBool(row.hasCloudflare),
    hasSubmitForm: nullableBool(row.hasSubmitForm),
    hasCommentForm: nullableBool(row.hasCommentForm),
    hasProfileField: nullableBool(row.hasProfileField),
    opportunity: text(row.opportunity, "review") as BacklinkPage["opportunity"],
    status: text(row.status, "new") as BacklinkPage["status"],
    failureReason: text(row.failureReason),
    firstSeenAt: text(row.firstSeenAt),
    lastSeenAt: text(row.lastSeenAt),
    lastAnalyzedAt: text(row.lastAnalyzedAt),
    notes: text(row.notes)
  };
}

function submissionFromRow(row: Record<string, unknown>): BacklinkSubmission {
  return {
    id: text(row.id),
    projectId: text(row.projectId),
    sourceId: text(row.sourceId),
    targetDomain: text(row.targetDomain),
    targetUrl: text(row.targetUrl),
    submittedUrl: text(row.submittedUrl),
    backlinkType: text(row.backlinkType, "unknown") as BacklinkSubmission["backlinkType"],
    anchorText: text(row.anchorText),
    contentUsed: text(row.contentUsed),
    accountUsed: text(row.accountUsed),
    emailUsed: text(row.emailUsed),
    status: text(row.status, "candidate") as BacklinkSubmission["status"],
    rel: text(row.rel, "unknown") as BacklinkSubmission["rel"],
    isLive: nullableBool(row.isLive),
    isIndexed: nullableBool(row.isIndexed),
    submittedAt: text(row.submittedAt),
    checkedAt: text(row.checkedAt),
    nextCheckAt: text(row.nextCheckAt),
    failureReason: text(row.failureReason),
    notes: text(row.notes)
  };
}

function importFromRow(row: Record<string, unknown>): ImportBatch {
  return {
    id: text(row.id),
    source: text(row.source, "csv") as ImportBatch["source"],
    label: text(row.label),
    importedAt: text(row.importedAt),
    rowCount: numberValue(row.rowCount),
    createdCount: numberValue(row.createdCount),
    updatedCount: numberValue(row.updatedCount),
    notes: text(row.notes)
  };
}

function discoveryTargetFromRow(row: Record<string, unknown>): DiscoveryTarget {
  return {
    id: text(row.id),
    rootDomain: text(row.rootDomain),
    sourceRootDomain: text(row.sourceRootDomain),
    sourcePageUrl: text(row.sourcePageUrl),
    discoveredFrom: text(row.discoveredFrom, "page_outbound") as DiscoveryTarget["discoveredFrom"],
    provider: text(row.provider, "none") as DiscoveryTarget["provider"],
    status: text(row.status, "new") as DiscoveryTarget["status"],
    firstSeenAt: text(row.firstSeenAt),
    lastSeenAt: text(row.lastSeenAt),
    occurrenceCount: numberValue(row.occurrenceCount, 1),
    discoveredOnPages: list(row.discoveredOnPages),
    seenSourceRootDomains: list(row.seenSourceRootDomains),
    dr: optionalNumber(row.dr),
    traffic: optionalNumber(row.traffic),
    refDomains: optionalNumber(row.refDomains),
    backlinks: optionalNumber(row.backlinks),
    domainCreatedAt: text(row.domainCreatedAt),
    domainAgeMonths: optionalNumber(row.domainAgeMonths),
    whoisCheckedAt: text(row.whoisCheckedAt),
    seoCheckedAt: text(row.seoCheckedAt),
    lastError: text(row.lastError),
    notes: text(row.notes)
  };
}

function checkLogFromRow(row: Record<string, unknown>): CheckLog {
  return {
    id: text(row.id),
    taskType: text(row.taskType, "resource_precheck") as CheckLog["taskType"],
    projectId: text(row.projectId),
    sourceId: text(row.sourceId),
    sourceRootDomain: text(row.sourceRootDomain),
    sourceUrl: text(row.sourceUrl),
    queuedUrl: text(row.queuedUrl),
    finalUrl: text(row.finalUrl),
    finalRootDomain: text(row.finalRootDomain),
    result: text(row.result, "error") as CheckLog["result"],
    opportunity: text(row.opportunity, "skip") as CheckLog["opportunity"],
    skipScope: text(row.skipScope, "none") as CheckLog["skipScope"],
    reason: text(row.reason),
    checkedAt: text(row.checkedAt),
    notes: text(row.notes)
  };
}

function text(value: unknown, fallback = "") {
  const clean = String(value ?? "").trim();
  return clean || fallback;
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value: unknown) {
  const clean = String(value ?? "").trim();
  if (!clean) return undefined;
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nullableBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const clean = String(value ?? "").trim().toLowerCase();
  if (!clean || clean === "null") return null;
  if (clean === "true" || clean === "yes" || clean === "1") return true;
  if (clean === "false" || clean === "no" || clean === "0") return false;
  return null;
}

function list(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? "")
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

function cellValue(value: unknown): SheetCell {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return truncateSheetCell(value);
  if (Array.isArray(value)) return truncateSheetCell(value.map((item) => String(item)).join(" | "));
  return truncateSheetCell(JSON.stringify(value));
}

function truncateSheetCell(value: string) {
  if (value.length <= MAX_SHEET_CELL_LENGTH) return value;
  return `${value.slice(0, MAX_SHEET_CELL_LENGTH)}\n...[truncated ${value.length - MAX_SHEET_CELL_LENGTH} chars for Google Sheets cell limit]`;
}

async function ensureSheets(spreadsheetId: string, token: string, sheetNames: string[]) {
  const metadata = await sheetsFetch<{ sheets?: Array<{ properties?: { title?: string } }> }>(
    `${SHEETS_API}/${spreadsheetId}?fields=sheets.properties.title`,
    token
  );
  const existing = new Set(metadata.sheets?.map((sheet) => sheet.properties?.title).filter(Boolean) as string[]);
  const missing = sheetNames.filter((name) => !existing.has(name));
  if (!missing.length) return;

  await sheetsFetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, token, {
    method: "POST",
    body: JSON.stringify({
      requests: missing.map((title) => ({ addSheet: { properties: { title } } }))
    })
  });
}

async function clearValues(spreadsheetId: string, token: string, sheetName: string) {
  await sheetsFetch(`${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(`${sheetName}!A:ZZ`)}:clear`, token, {
    method: "POST",
    body: JSON.stringify({})
  });
}

async function updateValues(spreadsheetId: string, token: string, sheetName: string, values: SheetCell[][]) {
  await sheetsFetch(
    `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(`${sheetName}!A1`)}?valueInputOption=RAW`,
    token,
    {
      method: "PUT",
      body: JSON.stringify({ values })
    }
  );
}

async function sheetsFetch<T = unknown>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Google Sheets API ${response.status}: ${detail || response.statusText}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function getGoogleAccessToken(clientId: string, interactiveFallback: boolean): Promise<string> {
  const cached = await getCachedGoogleToken(clientId);
  if (cached) return cached;

  const silentToken = await requestGoogleAccessToken(clientId, false).catch(() => null);
  if (silentToken) return silentToken;

  if (!interactiveFallback) throw new Error("没有可用的静默 Google 授权，请先手动同步一次。");
  return requestGoogleAccessToken(clientId, true);
}

function requestGoogleAccessToken(clientId: string, interactive: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!chrome.identity?.launchWebAuthFlow) {
      reject(new Error("当前扩展没有 identity 权限，无法进行 Google 授权。"));
      return;
    }

    const redirectUri = chrome.identity.getRedirectURL();
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "token",
      redirect_uri: redirectUri,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      include_granted_scopes: "true"
    });
    if (!interactive) params.set("prompt", "none");

    chrome.identity.launchWebAuthFlow({
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      interactive
    }, (responseUrl) => {
      const error = chrome.runtime.lastError;
      if (error || !responseUrl) {
        reject(new Error(error?.message || "Google 授权失败。"));
        return;
      }
      const fragment = new URL(responseUrl).hash.slice(1);
      const result = new URLSearchParams(fragment);
      const authError = result.get("error");
      if (authError) {
        reject(new Error(authError));
        return;
      }
      const token = result.get("access_token");
      if (!token) {
        reject(new Error("Google 授权返回中没有 access_token。"));
        return;
      }
      const expiresInSeconds = Number(result.get("expires_in") || "3600");
      void cacheGoogleToken({
        clientId,
        token,
        expiresAt: Date.now() + Math.max(60, expiresInSeconds) * 1000
      });
      resolve(token);
    });
  });
}

async function getCachedGoogleToken(clientId: string) {
  const key = googleTokenCacheKey(clientId);
  const item = await chrome.storage.local.get(key);
  const cached = item[key] as CachedGoogleToken | undefined;
  if (!cached || cached.clientId !== clientId || !cached.token) return "";
  if (cached.expiresAt - TOKEN_REFRESH_SKEW_MS <= Date.now()) return "";
  return cached.token;
}

async function cacheGoogleToken(token: CachedGoogleToken) {
  await chrome.storage.local.set({ [googleTokenCacheKey(token.clientId)]: token });
}

function googleTokenCacheKey(clientId: string) {
  return `google_oauth_token:${clientId}`;
}
