import { classifySource, pageAnalysisToSourcePatch, priorityForSource } from "./shared/classifier";
import {
  allPages,
  allCheckLogs,
  allDiscoveryTargets,
  allSources,
  allSubmissions,
  bulkSavePages,
  findPageByUrl,
  findSourceByRootDomain,
  getSettings,
  nowIso,
  saveCheckLog,
  saveImportBatch,
  savePage,
  saveSettings,
  saveSource,
  saveDiscoveryTarget,
  uid,
  upsertDiscoveryTargets,
  upsertSourcesAndPages,
  upsertSourcesByRootDomain
} from "./shared/db";
import { syncLocalDataToGoogleSheets } from "./shared/googleSheets";
import { executionResourceClass } from "./shared/executionClassification";
import type { BacklinkPage, BacklinkSource, BacklinkSubmission, CheckLog, DiscoveryTarget, OpportunityKind, PageAnalysis, SubmissionStatus } from "./shared/types";
import { hostnameFromUrl, normalizeUrl, rootDomainFromUrl } from "./shared/url";

type RuntimeMessage =
  | { type: "OPEN_AHREFS"; domain: string }
  | { type: "OPEN_SEMRUSH"; domain: string }
  | { type: "SAVE_AHREFS_ROWS"; rows: unknown[]; label: string; competitorDomain: string }
  | { type: "CAPTURE_SEO_RESPONSE"; payload: CapturedSeoResponsePayload }
  | { type: "OPEN_SIDEPANEL" }
  | { type: "START_AUTO_SCREEN"; projectId?: string; limit?: number; continuous?: boolean; stopOnActionable?: boolean; precheckOnly?: boolean; screenMode?: AutoScreenMode }
  | { type: "STOP_AUTO_SCREEN" }
  | { type: "GET_AUTO_SCREEN_STATE" }
  | { type: "ENRICH_DISCOVERY_TARGETS"; limit?: number; sourceRootDomain?: string; sourcePageUrl?: string };

type AutoScreenMode = "all" | "unverified" | "second_review";

type AutoScreenState = {
  running: boolean;
  checked: number;
  skipped: number;
  stoppedOnUrl: string;
  message: string;
  startedAt: string;
  updatedAt: string;
};

const AUTO_SYNC_ALARM = "googleSheetsAutoSync";
const AUTO_SYNC_META_KEY = "googleSheetsAutoSyncMeta";

type AutoSyncMeta = {
  pendingChanges: number;
  syncing: boolean;
  lastAttemptAt: string;
  lastSuccessAt: string;
  lastError: string;
};

type SeoCaptureStatus = {
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
};

let autoScreenAbort = false;
let autoScreenRunning = false;
let discoveryEnrichRunning = false;
const capturedSeoResponseKeys = new Set<string>();

type CapturedSeoResponsePayload = {
  provider: "ahrefs" | "semrush" | "page";
  pageUrl: string;
  requestUrl: string;
  requestBody: string;
  responseText: string;
  capturedAt: string;
};

chrome.runtime.onInstalled.addListener(() => {
  void ensureAutoSyncAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureAutoSyncAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_SYNC_ALARM) void maybeAutoSyncGoogleSheets("timer");
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type === "OPEN_AHREFS") {
    const url = `https://ahrefs.com/backlink-checker/?input=${encodeURIComponent(message.domain)}&mode=subdomains`;
    chrome.tabs.create({ url });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "OPEN_SEMRUSH") {
    const url = `https://www.semrush.com/analytics/backlinks/overview/?q=${encodeURIComponent(message.domain)}&searchType=domain`;
    chrome.tabs.create({ url });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "SAVE_AHREFS_ROWS") {
    void importAhrefsRows(message.rows, message.label, message.competitorDomain).then((result) => sendResponse(result));
    return true;
  }

  if (message.type === "CAPTURE_SEO_RESPONSE") {
    void importCapturedSeoResponse(message.payload).then((result) => sendResponse(result));
    return true;
  }

  if (message.type === "OPEN_SIDEPANEL") {
    void openSidePanel().then((result) => sendResponse(result));
    return true;
  }

  if (message.type === "START_AUTO_SCREEN") {
    if (!autoScreenRunning) {
      autoScreenAbort = false;
      void runAutoScreen(message.projectId, message.limit ?? 10, {
        continuous: message.continuous ?? false,
        stopOnActionable: message.stopOnActionable ?? false,
        screenMode: message.screenMode ?? (message.precheckOnly ? "unverified" : "all")
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "STOP_AUTO_SCREEN") {
    autoScreenAbort = true;
    void updateAutoScreenState({ running: false, message: "已请求停止自动筛选" });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "GET_AUTO_SCREEN_STATE") {
    void getAutoScreenState().then((state) => sendResponse(state));
    return true;
  }

  if (message.type === "ENRICH_DISCOVERY_TARGETS") {
    if (discoveryEnrichRunning) {
      sendResponse({ ok: false, message: "发现队列正在补充域名年龄数据" });
      return true;
    }
    void enrichDiscoveryTargets(message.limit ?? 8, {
      sourceRootDomain: message.sourceRootDomain,
      sourcePageUrl: message.sourcePageUrl
    }).then((result) => sendResponse(result));
    return true;
  }

  return false;
});

async function openSidePanel() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const windowId = tab?.windowId;
  if (typeof chrome.sidePanel?.open === "function" && windowId) {
    await chrome.sidePanel.open({ windowId });
    return { ok: true };
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL("src/popup/index.html") });
  return { ok: true, fallback: "tab" };
}

async function runAutoScreen(projectId = "", limit = 10, options: { continuous: boolean; stopOnActionable: boolean; screenMode: AutoScreenMode }) {
  autoScreenRunning = true;
  const startedAt = nowIso();
  const modeLabel = autoScreenModeLabel(options.screenMode);
  await setAutoScreenState({
    running: true,
    checked: 0,
    skipped: 0,
    stoppedOnUrl: "",
    message: options.continuous ? `${modeLabel}已开启，将持续检测到列表结束` : `${modeLabel}已启动`,
    startedAt,
    updatedAt: startedAt
  });
  const checkedUrls = new Set<string>();
  let checked = 0;
  let skipped = 0;
  let passed = 0;
  const maxChecks = options.continuous ? Number.POSITIVE_INFINITY : limit;

  try {
    for (let i = 0; i < maxChecks && !autoScreenAbort; i += 1) {
      const next = await nextQueueItem(projectId, checkedUrls, { screenMode: options.screenMode });
      if (!next) {
        await updateAutoScreenState({
          running: false,
          checked,
          skipped,
          message: checked
            ? options.continuous
              ? `自动检查完成，列表已结束；通过 ${passed} 条，跳过 ${skipped} 条`
              : `本轮完成，通过 ${passed} 条，跳过 ${skipped} 条`
            : "没有可自动筛选的资源"
        });
        return;
      }
      checkedUrls.add(queueUrlKey(next.url));
      checked += 1;
      await updateAutoScreenState({ checked, skipped, message: `正在检查 ${next.source.rootDomain} · ${next.url}` });
      const result = await inspectQueueItem(next, {
        keepActionableTab: options.stopOnActionable,
        projectId,
        taskType: options.stopOnActionable ? "execution_screen" : "resource_precheck"
      });
      const checkedLabel = result.finalRoot && result.finalRoot !== next.source.rootDomain
        ? `${next.source.rootDomain} → ${result.finalRoot}`
        : next.source.rootDomain;
      if (result.kind === "skip") {
        skipped += 1;
        await updateAutoScreenState({ checked, skipped, message: `已跳过 ${skipped} 条：${checkedLabel}，继续检查下一条` });
        await delay(500);
        continue;
      }
      passed += 1;
      if (!options.stopOnActionable) {
        await updateAutoScreenState({ checked, skipped, message: `候选通过 ${passed} 条：${checkedLabel}，继续检查下一条` });
        await delay(300);
        continue;
      }
      await updateAutoScreenState({
        running: false,
        checked,
        skipped,
        stoppedOnUrl: result.url,
        message: skipped ? `已跳过 ${skipped} 条，发现需要人工处理的页面` : "发现需要人工处理的页面"
      });
      return;
    }
    await updateAutoScreenState({ running: false, checked, skipped, message: autoScreenAbort ? "自动筛选已停止" : `本轮完成，通过 ${passed} 条，跳过 ${skipped} 条` });
  } finally {
    autoScreenRunning = false;
    autoScreenAbort = false;
  }
}

function autoScreenModeLabel(mode: AutoScreenMode) {
  if (mode === "unverified") return "资源预检测";
  if (mode === "second_review") return "资源二检";
  return "自动筛选";
}

async function nextQueueItem(projectId: string, excludedUrls: Set<string>, options: { screenMode?: AutoScreenMode } = {}) {
  const [sources, pages, submissions, logs] = await Promise.all([allSources(), allPages(), allSubmissions(), allCheckLogs()]);
  const executedRoots = projectExecutedRootDomains(submissions, projectId);
  const domainSkippedRoots = new Set(logs
    .filter((log) => log.result === "skip" && log.skipScope === "domain")
    .map((log) => log.finalRootDomain || log.sourceRootDomain));
  return queueSourceItems(sources, pages, executedRoots, excludedUrls, { ...options, excludedRoots: domainSkippedRoots })[0];
}

async function inspectQueueItem(
  next: { source: BacklinkSource; url: string },
  options: { keepActionableTab: boolean; projectId: string; taskType: CheckLog["taskType"] }
) {
  const pages = await allPages();
  const url = next.url || bestPageUrl(next.source, pages);
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await chrome.tabs.create({ url, active: true });
    if (!tab.id) {
      await saveAutoScreenLog(next, url, unavailableAnalysisFromUrl(url, "Tab could not be created"), {
        taskType: options.taskType,
        projectId: options.projectId,
        result: "error",
        reason: "Tab could not be created"
      });
      return { kind: "skip" as const, url, finalRoot: next.source.rootDomain };
    }
    const tabId = tab.id;
    await waitForTabComplete(tabId, 10000);
    tab = await chrome.tabs.get(tabId);
    const currentSource = sourceForUrl(await allSources(), tab.url ?? "") || next.source;
    const response = await sendTabMessage<PageAnalysis>(tabId, {
      type: "ANALYZE_PAGE",
      targetUrl: "",
      competitorUrl: currentSource.competitorDomain ?? ""
    });
    const allKnownPages = await allPages();
    const effectiveOpportunity = opportunityFromAnalysisForSource(response, currentSource, allKnownPages);
    await syncAnalyzedPage(response, effectiveOpportunity);
    if (shouldMarkPendingUrl(response, url)) {
      await syncAnalyzedPage(unavailableAnalysisFromUrl(url, "Original URL redirected or became unavailable"));
    }
    const opportunity = effectiveOpportunity;
    if (opportunity === "skip") {
      await saveAutoScreenLog(next, url, response, {
        taskType: options.taskType,
        projectId: options.projectId,
        result: "skip",
        reason: skipReasonForAnalysis(response)
      });
      await chrome.tabs.remove(tabId).catch(() => undefined);
      return { kind: "skip" as const, url, finalRoot: response.rootDomain };
    }
    await saveAutoScreenLog(next, url, response, {
      taskType: options.taskType,
      projectId: options.projectId,
      result: "candidate",
      reason: opportunity === "direct" ? "Candidate passed: direct opportunity" : "Candidate passed: needs manual review"
    });
    if (options.keepActionableTab) {
      await chrome.tabs.update(tabId, { active: true });
    } else {
      await chrome.tabs.remove(tabId).catch(() => undefined);
    }
    return { kind: "pass" as const, url: response.url, finalRoot: response.rootDomain };
  } catch {
    const fallback = unavailableAnalysisFromUrl(url, tab?.title || "Page unavailable");
    await syncAnalyzedPage(fallback);
    await saveAutoScreenLog(next, url, fallback, {
      taskType: options.taskType,
      projectId: options.projectId,
      result: "error",
      reason: "Page unavailable"
    });
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => undefined);
    return { kind: "skip" as const, url, finalRoot: rootDomainFromUrl(url) };
  }
}

async function saveAutoScreenLog(
  next: { source: BacklinkSource; url: string },
  queuedUrl: string,
  analysis: PageAnalysis,
  options: { taskType: CheckLog["taskType"]; projectId: string; result: CheckLog["result"]; reason: string }
) {
  const opportunity = opportunityFromAnalysis(analysis);
  const skipScope = skipScopeForAnalysis(analysis);
  const checkedAt = nowIso();
  await saveCheckLog({
    id: uid("log"),
    taskType: options.taskType,
    projectId: options.projectId,
    sourceId: next.source.id,
    sourceRootDomain: next.source.rootDomain,
    sourceUrl: next.source.sourceUrl,
    queuedUrl,
    finalUrl: analysis.url,
    finalRootDomain: analysis.rootDomain,
    result: options.result,
    opportunity,
    skipScope: skipScope === "none" ? "none" : skipScope,
    reason: options.reason,
    checkedAt,
    notes: [
      next.source.rootDomain !== analysis.rootDomain ? `Redirect/root mismatch: ${next.source.rootDomain} -> ${analysis.rootDomain}` : "",
      analysis.title
    ].filter(Boolean).join(" · ")
  });
  await recordAutoSyncChange();
}

async function importAhrefsRows(rows: unknown[], label: string, competitorDomain: string) {
  const createdAt = nowIso();
  const sources: BacklinkSource[] = rows
    .map((row) => rowToImportedSource(row))
    .filter((item): item is { sourceUrl: string; dr?: number; traffic?: number; title: string; anchor: string } => Boolean(item?.sourceUrl))
    .map((item) => {
      const sourceUrl = item.sourceUrl;
      const rootDomain = rootDomainFromUrl(sourceUrl);
      const classification = classifySource(sourceUrl, item.title, item.anchor);
      const source: BacklinkSource = {
        id: uid("src"),
        sourceDomain: hostnameFromUrl(sourceUrl),
        sourceUrl,
        rootDomain,
        discoveredFrom: "ahrefs",
        competitorDomain,
        sourceType: classification.type,
        sourceTypeConfidence: classification.confidence,
        dr: item.dr,
        traffic: item.traffic,
        firstSeenAt: createdAt,
        lastSeenAt: createdAt,
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
        detectedRel: "unknown",
        isNoindex: null,
        priorityLevel: "D",
        status: "new",
        failureReason: "",
        notes: [
          item.title ? `Title: ${item.title}` : "",
          item.anchor ? `Anchor: ${item.anchor}` : ""
        ].filter(Boolean).join("\n")
      };
      source.priorityLevel = priorityForSource(source);
      return source;
    });

  const result = await upsertSourcesByRootDomain(sources);
  await saveImportBatch({
    id: uid("imp"),
    source: "ahrefs",
    label,
    importedAt: createdAt,
    rowCount: rows.length,
    createdCount: result.createdCount,
    updatedCount: result.updatedCount,
    notes: "Imported from Ahrefs helper"
  });
  await recordAutoSyncChange(Math.max(1, result.createdCount + result.updatedCount));
  return { ok: true, createdCount: result.createdCount, updatedCount: result.updatedCount };
}

async function importCapturedSeoResponse(payload: CapturedSeoResponsePayload) {
  if (!payload?.responseText || !payload.provider || payload.provider === "page") return { ok: false, reason: "empty" };
  const requestData = safeJsonParse(payload.requestBody);
  const competitorDomain = competitorDomainFromCapturedPayload(payload, requestData);
  const requestLabel = seoRequestLabel(payload.requestUrl);
  await setSeoCaptureStatus({
    status: "captured",
    provider: payload.provider,
    competitorDomain,
    rowCount: 0,
    createdCount: 0,
    updatedCount: 0,
    pageCreatedCount: 0,
    pageUpdatedCount: 0,
    requestLabel,
    message: `已收到 ${payload.provider} ${requestLabel} 数据，正在解析`,
    updatedAt: nowIso()
  });
  const fingerprint = seoPayloadFingerprint(payload);
  if (capturedSeoResponseKeys.has(fingerprint)) {
    await setSeoCaptureStatus({
      status: "duplicate",
      provider: payload.provider,
      competitorDomain,
      rowCount: 0,
      createdCount: 0,
      updatedCount: 0,
      pageCreatedCount: 0,
      pageUpdatedCount: 0,
      requestLabel,
      message: `已收到重复 ${requestLabel} 结果，本次未重复导入`,
      updatedAt: nowIso()
    });
    return { ok: true, duplicate: true };
  }
  capturedSeoResponseKeys.add(fingerprint);
  if (capturedSeoResponseKeys.size > 200) capturedSeoResponseKeys.clear();
  const provider = payload.provider as "ahrefs" | "semrush";

  const responseData = safeJsonParse(payload.responseText);
  if (!responseData) {
    await setSeoCaptureStatus({
      status: "failed",
      provider,
      competitorDomain: "",
      rowCount: 0,
      createdCount: 0,
      updatedCount: 0,
      pageCreatedCount: 0,
      pageUpdatedCount: 0,
      requestLabel,
      message: "已收到返回数据，但不是可解析的 JSON",
      updatedAt: nowIso()
    });
    return { ok: false, reason: "json_parse_failed" };
  }

  const responseKind = seoResponseKind(payload, responseData);
  if (responseKind !== "list") {
    const metrics = extractSeoMetrics(responseData);
    await updateDiscoveryTargetSeoMetrics(competitorDomain, provider, metrics);
    await setSeoCaptureStatus({
      status: "captured",
      provider,
      competitorDomain,
      rowCount: 0,
      createdCount: 0,
      updatedCount: 0,
      pageCreatedCount: 0,
      pageUpdatedCount: 0,
      requestLabel,
      message: `已收到 ${provider} ${requestLabel} 数据；等待外链列表结果`,
      updatedAt: nowIso()
    });
    return { ok: true, overview: true };
  }
  const backlinkRows = extractBacklinkRows(responseData, competitorDomain);
  const metrics = extractSeoMetrics(responseData);
  if (!backlinkRows.length) {
    await markDiscoveryTargetSeoImported(competitorDomain, provider, 0, metrics);
    await setSeoCaptureStatus({
      status: "failed",
      provider,
      competitorDomain,
      rowCount: 0,
      createdCount: 0,
      updatedCount: 0,
      pageCreatedCount: 0,
      pageUpdatedCount: 0,
      requestLabel,
      message: `已收到 ${provider} ${requestLabel} 数据，但没有识别到外链行`,
      updatedAt: nowIso()
    });
    return { ok: true, createdCount: 0, updatedCount: 0, pageCreatedCount: 0, pageUpdatedCount: 0 };
  }

  const current = nowIso();
  const items = backlinkRows
    .map((row) => capturedRowToSourceAndPage(row, provider, competitorDomain, current))
    .filter((item): item is { source: BacklinkSource; page: BacklinkPage } => Boolean(item));
  const result = await upsertSourcesAndPages(items);
  await saveImportBatch({
    id: uid("imp"),
    source: provider,
    label: competitorDomain || payload.pageUrl || payload.requestUrl,
    importedAt: current,
    rowCount: backlinkRows.length,
    createdCount: result.createdCount,
    updatedCount: result.updatedCount,
    notes: `Auto captured ${provider} ${requestLabel} result; pages added ${result.pageCreatedCount}, updated ${result.pageUpdatedCount}`
  });
  await markDiscoveryTargetSeoImported(
    competitorDomain,
    provider,
    result.createdCount + result.updatedCount + result.pageCreatedCount + result.pageUpdatedCount,
    metrics
  );
  await setSeoCaptureStatus({
    status: "imported",
    provider,
    competitorDomain,
    rowCount: backlinkRows.length,
    createdCount: result.createdCount,
    updatedCount: result.updatedCount,
    pageCreatedCount: result.pageCreatedCount,
    pageUpdatedCount: result.pageUpdatedCount,
    requestLabel,
    message: `已自动导入 ${backlinkRows.length} 条 ${provider} ${requestLabel} 外链结果`,
    updatedAt: nowIso()
  });
  const changedCount = Math.max(1, result.createdCount + result.updatedCount + result.pageCreatedCount + result.pageUpdatedCount);
  void recordAutoSyncChange(changedCount).catch((error) => {
    console.warn("Auto sync after SEO result import failed", error);
  });
  return { ok: true, ...result };
}

function capturedRowToSourceAndPage(row: unknown, provider: "ahrefs" | "semrush", competitorDomain: string, current: string) {
  if (!row || typeof row !== "object") return null;
  const sourceUrl = sourceUrlFromCapturedRow(row, competitorDomain);
  if (!/^https?:\/\//i.test(sourceUrl)) return null;
  const rootDomain = rootDomainFromUrl(sourceUrl);
  if (!rootDomain) return null;
  const title = firstDeepString(row, ["title", "sourceTitle", "pageTitle", "referringPageTitle"]);
  const anchor = firstDeepString(row, ["anchor", "anchorText", "text", "linkText"]);
  const targetUrl = targetUrlFromCapturedRow(row, competitorDomain) || firstDeepString(row, ["targetUrl", "urlTo", "target", "destinationUrl", "target_url"]);
  const rowText = compactUnknown(row).slice(0, 240);
  const classification = classifySource(sourceUrl, title, `${anchor} ${rowText}`);
  const source: BacklinkSource = {
    id: uid("src"),
    sourceDomain: hostnameFromUrl(sourceUrl),
    sourceUrl,
    rootDomain,
    discoveredFrom: provider,
    competitorDomain,
    sourceType: classification.type,
    sourceTypeConfidence: classification.confidence,
    dr: metricValue(firstDeepString(row, ["dr", "domainRating", "domain_rating", "domainAuthority", "authorityScore", "as"])),
    traffic: metricValue(firstDeepString(row, ["traffic", "organicTraffic", "domainTraffic", "pageTraffic", "referringPageTraffic"])),
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
    detectedRel: relFromCapturedRow(row),
    isNoindex: null,
    priorityLevel: "D",
    status: "new",
    failureReason: "",
    notes: [
      `Captured from ${provider} result`,
      title ? `Title: ${title}` : "",
      anchor ? `Anchor: ${anchor}` : "",
      rowText ? `Row: ${rowText}` : ""
    ].filter(Boolean).join("\n")
  };
  source.priorityLevel = priorityForSource(source);
  const page: BacklinkPage = {
    id: uid("pg"),
    sourceId: source.id,
    rootDomain,
    pageUrl: sourceUrl,
    pageTitle: title || anchor,
    pageType: source.sourceType,
    discoveredFrom: provider,
    competitorDomain,
    competitorTargetUrl: targetUrl,
    competitorAnchor: anchor,
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
    notes: rowText ? `Captured row: ${rowText}` : ""
  };
  return { source, page };
}

function extractBacklinkRows(value: unknown, competitorDomain: string): unknown[] {
  const rows: unknown[] = [];
  const ahrefsTopBacklinks = ahrefsTopBacklinksRows(value);
  if (ahrefsTopBacklinks.length) return uniqueBacklinkRows(ahrefsTopBacklinks, competitorDomain);
  const visit = (node: unknown, depth: number) => {
    if (depth > 8 || !node) return;
    if (Array.isArray(node)) {
      if (node.some((item) => looksLikeBacklinkRow(item, competitorDomain))) {
        rows.push(...node.filter((item) => looksLikeBacklinkRow(item, competitorDomain)));
        return;
      }
      node.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof node === "object") {
      Object.entries(node as Record<string, unknown>).forEach(([key, child]) => {
        if (/backlinks?|referring|pages?/i.test(key) && Array.isArray(child) && child.some((item) => looksLikeBacklinkRow(item, competitorDomain))) {
          rows.push(...child.filter((item) => looksLikeBacklinkRow(item, competitorDomain)));
          return;
        }
        visit(child, depth + 1);
      });
    }
  };
  visit(value, 0);
  return uniqueBacklinkRows(rows, competitorDomain);
}

function uniqueBacklinkRows(rows: unknown[], competitorDomain: string) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const url = sourceUrlFromCapturedRow(row, competitorDomain);
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function ahrefsTopBacklinksRows(value: unknown): unknown[] {
  const found: unknown[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 8 || !node || found.length) return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof node !== "object") return;
    const topBacklinks = (node as Record<string, unknown>).topBacklinks;
    if (topBacklinks && typeof topBacklinks === "object") {
      const backlinks = (topBacklinks as Record<string, unknown>).backlinks;
      if (Array.isArray(backlinks)) {
        found.push(...backlinks);
        return;
      }
    }
    Object.values(node as Record<string, unknown>).forEach((child) => visit(child, depth + 1));
  };
  visit(value, 0);
  return found;
}

function seoResponseKind(payload: CapturedSeoResponsePayload, responseData: unknown): "list" | "overview" | "unknown" {
  const label = seoRequestLabel(payload.requestUrl);
  if (label === "list") return "list";
  if (label === "overview") return "overview";
  if (ahrefsTopBacklinksRows(responseData).length) return "list";
  return "unknown";
}

function seoRequestLabel(requestUrl: string) {
  if (/stGetFreeBacklinksList/i.test(requestUrl)) return "list";
  if (/stGetFreeBacklinksOverview/i.test(requestUrl)) return "overview";
  if (/backlinks/i.test(requestUrl)) return "backlinks";
  if (/refdomains/i.test(requestUrl)) return "refdomains";
  return "unknown";
}

function looksLikeBacklinkRow(value: unknown, competitorDomain = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (hasBacklinkRowArrayChild(value, competitorDomain)) return false;
  return /^https?:\/\//i.test(sourceUrlFromCapturedRow(value, competitorDomain));
}

function hasBacklinkRowArrayChild(value: unknown, competitorDomain: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).some((child) =>
    Array.isArray(child) && child.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      return /^https?:\/\//i.test(sourceUrlFromCapturedRow(item, competitorDomain));
    })
  );
}

function extractSeoMetrics(value: unknown) {
  return {
    dr: metricValue(firstDeepString(value, ["dr", "domainRating", "domain_rating", "domainAuthority", "authorityScore", "as"])),
    traffic: metricValue(firstDeepString(value, ["traffic", "organicTraffic", "domainTraffic"])),
    refDomains: metricValue(firstDeepString(value, ["refDomains", "referringDomains", "refdomains", "referring_domains"])),
    backlinks: metricValue(firstDeepString(value, ["backlinks", "backlinksCount", "totalBacklinks", "total"]))
  };
}

function competitorDomainFromCapturedPayload(payload: CapturedSeoResponsePayload, requestData: unknown) {
  const fromRequest = firstDeepString(requestData, ["url", "input", "target", "domain", "q"]);
  if (fromRequest) return rootDomainFromUrl(fromRequest);
  try {
    const parsed = new URL(payload.pageUrl || payload.requestUrl);
    const candidate = parsed.searchParams.get("input") || parsed.searchParams.get("q") || parsed.searchParams.get("target") || parsed.searchParams.get("domain") || "";
    return candidate ? rootDomainFromUrl(candidate) : "";
  } catch {
    return "";
  }
}

async function markDiscoveryTargetSeoImported(rootDomain: string, provider: "ahrefs" | "semrush", importedRecords: number, metrics: { dr?: number; traffic?: number; refDomains?: number; backlinks?: number }) {
  const cleanRoot = rootDomainFromUrl(rootDomain);
  if (!cleanRoot) return;
  const target = (await allDiscoveryTargets()).find((item) => item.rootDomain === cleanRoot);
  if (!target) return;
  await saveDiscoveryTarget({
    ...target,
    provider,
    status: "imported",
    dr: metrics.dr ?? target.dr,
    traffic: metrics.traffic ?? target.traffic,
    refDomains: metrics.refDomains ?? target.refDomains,
    backlinks: metrics.backlinks ?? target.backlinks,
    seoCheckedAt: nowIso(),
    lastSeenAt: nowIso(),
    notes: appendNote(target.notes, `Imported ${importedRecords} SEO records from ${provider}`)
  });
}

async function updateDiscoveryTargetSeoMetrics(rootDomain: string, provider: "ahrefs" | "semrush", metrics: { dr?: number; traffic?: number; refDomains?: number; backlinks?: number }) {
  const cleanRoot = rootDomainFromUrl(rootDomain);
  if (!cleanRoot) return;
  const target = (await allDiscoveryTargets()).find((item) => item.rootDomain === cleanRoot);
  if (!target) return;
  const hasMetrics = [metrics.dr, metrics.traffic, metrics.refDomains, metrics.backlinks].some((value) => value !== undefined);
  await saveDiscoveryTarget({
    ...target,
    provider,
    status: hasMetrics && target.status === "seo_queued" ? "enriched" : target.status,
    dr: metrics.dr ?? target.dr,
    traffic: metrics.traffic ?? target.traffic,
    refDomains: metrics.refDomains ?? target.refDomains,
    backlinks: metrics.backlinks ?? target.backlinks,
    seoCheckedAt: hasMetrics ? nowIso() : target.seoCheckedAt,
    lastSeenAt: nowIso(),
    lastError: hasMetrics ? "" : target.lastError,
    notes: appendNote(target.notes, hasMetrics ? `Captured ${provider} overview metrics` : `Captured ${provider} overview response without metrics`)
  });
}

function relFromCapturedRow(row: unknown) {
  const rel = firstDeepString(row, ["rel", "linkRel", "linkType", "type"]);
  const nofollow = firstDeepString(row, ["nofollow", "isNofollow", "noFollow"]);
  if (/true|1|yes/i.test(nofollow)) return "nofollow" as const;
  if (/ugc/i.test(rel)) return "ugc" as const;
  if (/sponsored/i.test(rel)) return "sponsored" as const;
  if (/nofollow/i.test(rel)) return "nofollow" as const;
  return rel ? "unknown" as const : "unknown" as const;
}

function sourceUrlFromCapturedRow(row: unknown, competitorDomain: string) {
  const explicit = firstDeepString(row, [
    "sourceUrl",
    "source_url",
    "referringPage",
    "referring_page",
    "referringPageUrl",
    "referringUrl",
    "urlFrom",
    "url_from",
    "fromUrl",
    "from_url",
    "backlinkUrl",
    "backlink_url"
  ]);
  if (isExternalSourceUrl(explicit, competitorDomain)) return explicit;

  const urls = allUrlsFromUnknown(row);
  const external = urls.find((url) => isExternalSourceUrl(url, competitorDomain));
  return external || "";
}

function targetUrlFromCapturedRow(row: unknown, competitorDomain: string) {
  const explicit = firstDeepString(row, ["targetUrl", "urlTo", "url_to", "toUrl", "to_url", "target", "destinationUrl", "target_url"]);
  if (explicit && (!competitorDomain || rootDomainFromUrl(explicit) === competitorDomain)) return explicit;
  return allUrlsFromUnknown(row).find((url) => rootDomainFromUrl(url) === competitorDomain) || "";
}

function isExternalSourceUrl(url: string, competitorDomain: string) {
  if (!/^https?:\/\//i.test(url)) return false;
  const root = rootDomainFromUrl(url);
  if (!root) return false;
  if (competitorDomain && root === competitorDomain) return false;
  if (root === "ahrefs.com" || root === "semrush.com") return false;
  return true;
}

function allUrlsFromUnknown(value: unknown) {
  const urls: string[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 8 || node === null || node === undefined) return;
    if (typeof node === "string") {
      const matches = node.match(/https?:\/\/[^\s"'<>\\)]+/gi);
      if (matches) urls.push(...matches.map((url) => url.replace(/[.,;:]+$/, "")));
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, depth + 1));
      return;
    }
    Object.values(node as Record<string, unknown>).forEach((item) => visit(item, depth + 1));
  };
  visit(value, 0);
  return [...new Set(urls)];
}

function firstDeepString(value: unknown, keys: string[]) {
  const wanted = new Set(keys.map(normalizeColumnName));
  const visit = (node: unknown, depth: number): string => {
    if (depth > 6 || node === null || node === undefined) return "";
    if (typeof node !== "object") return "";
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return "";
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (wanted.has(normalizeColumnName(key)) && child !== null && child !== undefined && typeof child !== "object") {
        const text = String(child).trim();
        if (text) return text;
      }
    }
    for (const child of Object.values(node as Record<string, unknown>)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return "";
  };
  return visit(value, 0);
}

function safeJsonParse(value: unknown): unknown {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function seoPayloadFingerprint(payload: CapturedSeoResponsePayload) {
  return `${payload.provider}:${payload.requestUrl}:${simpleHash(`${payload.requestBody}\n${payload.responseText.slice(0, 8000)}`)}`;
}

function simpleHash(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function compactUnknown(value: unknown) {
  try {
    return JSON.stringify(value).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function rowToImportedSource(row: unknown): { sourceUrl: string; dr?: number; traffic?: number; title: string; anchor: string } | null {
  if (!row || typeof row !== "object") return null;
  const data = row as Record<string, unknown>;
  const sourceUrl = firstObjectValue(data, ["url", "sourceUrl", "source_url", "referringPage", "referring_page", "referringPageUrl", "page", "backlink"]);
  if (!sourceUrl.startsWith("http")) return null;
  return {
    sourceUrl,
    dr: metricValue(firstObjectValue(data, ["dr", "DR", "domainRating", "domain_rating", "Domain Rating", "authorityScore", "Authority Score", "as"])),
    traffic: metricValue(firstObjectValue(data, ["traffic", "Traffic", "organicTraffic", "Organic traffic", "domainTraffic", "Domain traffic", "referringPageTraffic", "Referring page traffic", "pageTraffic", "Page traffic"])),
    title: firstObjectValue(data, ["title", "Title", "sourceTitle", "Source title"]),
    anchor: firstObjectValue(data, ["anchor", "Anchor", "anchorText", "Anchor text"])
  };
}

function firstObjectValue(row: Record<string, unknown>, keys: string[]) {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [normalizeColumnName(key), String(value ?? "").trim()]));
  for (const key of keys) {
    const direct = row[key];
    if (direct !== undefined && direct !== null && String(direct).trim()) return String(direct).trim();
    const value = normalized.get(normalizeColumnName(key));
    if (value) return value;
  }
  return "";
}

function normalizeColumnName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
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
        notes: [existing.notes, `Background analyzed: ${analysis.url} · ${current} · ${analysis.title}`].filter(Boolean).join("\n")
      }
    : {
        id: uid("src"),
        sourceDomain: hostnameFromUrl(analysis.url),
        sourceUrl: analysis.url,
        rootDomain: analysis.rootDomain,
        discoveredFrom: "background_analysis",
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
        notes: `Background analyzed: ${current} · ${analysis.title}`
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
        discoveredFrom: "background_analysis",
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
        notes: `Background analyzed page: ${analysis.title}`
      };
  await savePage(page);
  await recordDiscoveryTargetsFromAnalysis(analysis, outboundDomains);
  if (outboundDomains.length && !discoveryEnrichRunning) {
    void enrichDiscoveryTargets(Math.min(outboundDomains.length, 6), {
      sourceRootDomain: analysis.rootDomain,
      sourcePageUrl: analysis.url
    }).catch(() => undefined);
  }

  if (shouldSkipSource) {
    const rootPages = await allPages();
    await bulkSavePages(rootPages
      .filter((item) => item.rootDomain === analysis.rootDomain && item.id !== page.id)
      .map((item) => ({
        ...item,
        opportunity: "skip",
        status: "skipped",
        failureReason: failureReason || item.failureReason || "Skipped after background analysis",
        lastAnalyzedAt: current
      })));
  }
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
  if (targets.length) {
    await upsertDiscoveryTargets(targets);
    await recordAutoSyncChange(targets.length);
  }
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

function opportunityFromAnalysis(analysis: PageAnalysis) {
  if (analysis.pageUnavailable || analysis.captchaDetected || analysis.cloudflareDetected || analysis.noindex) return "skip";
  if (isCommunityOnlyDomain(analysis.rootDomain)) return "skip";
  const hasCommentField = analysis.formFields.some((field) => field.purpose === "comment");
  const blogCommentLike = hasCommentField || isGenericBlogCommentAnalysis(analysis);
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
  if (isClosedTopicPage(analysis)) return "skip";
  if (isProfileCandidatePage(analysis)) return "review";
  return "skip";
}

function opportunityFromAnalysisForSource(analysis: PageAnalysis, source: BacklinkSource, allKnownPages: BacklinkPage[]): OpportunityKind {
  const base = opportunityFromAnalysis(analysis);
  if (base !== "skip") return base;
  if (isHardSkipAnalysis(analysis)) return base;
  const sourcePages = pagesForSource(source, allKnownPages);
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

function isClosedTopicPage(analysis: PageAnalysis) {
  const haystack = `${analysis.url} ${analysis.title}`.toLowerCase();
  return /(topic|thread|discuss|discussion|post)/.test(haystack) && !analysis.hasForm;
}

function isProfileCandidatePage(analysis: PageAnalysis) {
  if (analysis.profileCandidateDetected) return true;
  if (isGenericBlogCommentAnalysis(analysis)) return false;
  const haystack = `${analysis.url} ${analysis.title}`.toLowerCase();
  return analysis.pageType === "ugc_comment_profile" &&
    /(forum|profile|user|member|account|settings|signature|register|login)/.test(haystack);
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

function sourceDisplayOpportunity(source: BacklinkSource, pages: BacklinkPage[]): { kind: OpportunityKind } {
  if (isSearchResultUrl(source.sourceUrl)) return { kind: "skip" };
  if (isCommunityOnlyDomain(source.rootDomain)) return { kind: "skip" };
  if (source.status === "blacklisted" || source.status === "skipped" || source.hasCloudflare || source.hasCaptcha) return { kind: "skip" };
  if (source.requiresPayment) return { kind: "review" };
  const sourcePages = pagesForSource(source, pages);
  if (sourcePages.length) {
    const actionable = actionablePagesForSource(source, pages)[0];
    return { kind: actionable?.opportunity ?? "skip" };
  }
  if (source.sourceType === "product_submission" || source.hasSubmitForm || source.hasProfileField) return { kind: "direct" };
  if (source.sourceType === "developer_content" || source.sourceType === "media_outreach") return { kind: "review" };
  if (source.sourceType === "ugc_comment_profile") {
    if (source.hasProfileField) return { kind: "direct" };
    if (source.hasCommentForm) return { kind: "review" };
    if (source.requiresLogin || source.requiresRegister) return { kind: "review" };
    return { kind: "skip" };
  }
  return { kind: "review" };
}

function pagesForSource(source: BacklinkSource, pages: BacklinkPage[]) {
  return pages
    .filter((page) => (page.sourceId === source.id || page.rootDomain === source.rootDomain) && !isSearchResultUrl(page.pageUrl))
    .sort((a, b) => opportunityRank(a.opportunity) - opportunityRank(b.opportunity) || b.lastSeenAt.localeCompare(a.lastSeenAt));
}

function actionablePagesForSource(source: BacklinkSource, pages: BacklinkPage[]) {
  return pagesForSource(source, pages)
    .filter((page) => page.opportunity !== "skip" && page.status !== "skipped");
}

function bestPageUrl(source: BacklinkSource, pages: BacklinkPage[]) {
  return actionablePagesForSource(source, pages)[0]?.pageUrl || source.sourceUrl;
}

function queueSourceItems(
  sources: BacklinkSource[],
  pages: BacklinkPage[],
  executedRoots = new Set<string>(),
  excludedUrls = new Set<string>(),
  options: { screenMode?: AutoScreenMode; excludedRoots?: Set<string> } = {}
) {
  return sources
    .filter((source) => !isSearchResultUrl(source.sourceUrl))
    .map((source) => ({ source, opportunity: sourceDisplayOpportunity(source, pages), url: bestPageUrl(source, pages) }))
    .filter((item) =>
      item.opportunity.kind !== "skip" &&
      sourceMatchesAutoScreenMode(item.source, pages, options.screenMode ?? "all") &&
      !executedRoots.has(item.source.rootDomain) &&
      !options.excludedRoots?.has(item.source.rootDomain) &&
      !excludedUrls.has(queueUrlKey(item.url))
    )
    .sort((a, b) => sourceQueueRank(a.source, a.opportunity.kind, pages) - sourceQueueRank(b.source, b.opportunity.kind, pages));
}

function sourceMatchesAutoScreenMode(source: BacklinkSource, pages: BacklinkPage[], mode: AutoScreenMode) {
  if (mode === "all") return true;
  const hasPrecheck = sourceHasPrecheck(source, pages);
  if (mode === "unverified") return !hasPrecheck;
  return hasPrecheck && !sourcePassedDetection(source, pages);
}

function sourceHasPrecheck(source: BacklinkSource, pages: BacklinkPage[]) {
  if (source.status === "analyzed" || source.status === "usable" || source.status === "skipped" || source.status === "blacklisted") return true;
  return pagesForSource(source, pages).some((page) =>
    Boolean(page.lastAnalyzedAt) ||
    page.status === "analyzed" ||
    page.status === "skipped"
  );
}

function sourcePassedDetection(source: BacklinkSource, pages: BacklinkPage[]) {
  return pagesForSource(source, pages).some((page) =>
    Boolean(page.lastAnalyzedAt) &&
    page.status !== "skipped" &&
    page.opportunity !== "skip"
  );
}

function sourceQueueRank(source: BacklinkSource, opportunity: OpportunityKind, pages: BacklinkPage[]) {
  const sourcePages = pagesForSource(source, pages);
  const skippedPages = sourcePages.filter((page) => page.opportunity === "skip" || page.status === "skipped").length;
  const analyzedPages = sourcePages.filter((page) => page.lastAnalyzedAt || page.status === "analyzed" || page.status === "skipped").length;
  const opportunityScore = opportunityRank(opportunity) * 1000;
  const priorityScore = (({ A: 0, B: 1, C: 2, D: 3, X: 4 } as const)[source.priorityLevel] ?? 3) * 100;
  const discoveryScore = discoveryPriorityPenalty(source, sourcePages);
  const precheckPenalty = analyzedPages * 250 + skippedPages * 50;
  return opportunityScore + priorityScore + discoveryScore + precheckPenalty;
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

function queueUrlKey(url: string) {
  try {
    return normalizeUrl(url).replace(/\/$/, "");
  } catch {
    return url.replace(/\/$/, "");
  }
}

function sourceForUrl(sources: BacklinkSource[], url: string) {
  const root = rootDomainFromUrl(url);
  return sources.find((source) => source.rootDomain === root);
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

function projectExecutedRootDomains(submissions: BacklinkSubmission[], projectId: string) {
  if (!projectId) return new Set<string>();
  return new Set(submissions
    .filter((submission) => submission.projectId === projectId && PROJECT_EXECUTED_STATUSES.has(submission.status))
    .map((submission) => rootDomainFromUrl(submission.submittedUrl || submission.targetUrl))
    .filter(Boolean));
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
    setTimeout(finish, timeoutMs);
  });
}

async function sendTabMessage<T>(tabId: number, message: unknown): Promise<T> {
  try {
    return await chrome.tabs.sendMessage(tabId, message) as T;
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["assets/content.js"] });
    await delay(80);
    return await chrome.tabs.sendMessage(tabId, message) as T;
  }
}

function shouldMarkPendingUrl(analysis: PageAnalysis, pendingUrl: string) {
  if (sameUrl(analysis.url, pendingUrl)) return false;
  return analysis.pageUnavailable || rootDomainFromUrl(analysis.url) !== rootDomainFromUrl(pendingUrl);
}

function sameUrl(a = "", b = "") {
  try {
    return normalizeUrl(a).replace(/\/$/, "") === normalizeUrl(b).replace(/\/$/, "");
  } catch {
    return a.replace(/\/$/, "") === b.replace(/\/$/, "");
  }
}

function isCommunityOnlyDomain(rootDomain: string) {
  return new Set(["scratch.mit.edu", "facebook.com", "instagram.com", "tiktok.com", "youtube.com"]).has(rootDomain);
}

function isSearchResultUrl(url: string) {
  try {
    const parsed = new URL(normalizeUrl(url));
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return (
      host.includes("search.yahoo.") ||
      host.includes("google.") && path.includes("/search") ||
      host.includes("bing.com") && path.includes("/search") ||
      host.includes("duckduckgo.com") ||
      host.includes("yandex.") && path.includes("/search")
    );
  } catch {
    return false;
  }
}

function opportunityRank(kind: "direct" | "review" | "engage" | "skip") {
  return ({ direct: 1, review: 2, engage: 3, skip: 4 } as const)[kind];
}

async function getAutoScreenState(): Promise<AutoScreenState> {
  const result = await chrome.storage.local.get("autoScreenState");
  return result.autoScreenState ?? {
    running: false,
    checked: 0,
    skipped: 0,
    stoppedOnUrl: "",
    message: "",
    startedAt: "",
    updatedAt: ""
  };
}

function setAutoScreenState(state: AutoScreenState) {
  return chrome.storage.local.set({ autoScreenState: state });
}

async function updateAutoScreenState(patch: Partial<AutoScreenState>) {
  const existing = await getAutoScreenState();
  await setAutoScreenState({ ...existing, ...patch, updatedAt: nowIso() });
}

function compactUnique(values: Array<string | undefined | null>) {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function outboundDomainsFromAnalysis(analysis: PageAnalysis) {
  return compactUnique((analysis.outboundLinks ?? []).map((link) => link.rootDomain))
    .filter((rootDomain) => rootDomain && rootDomain !== analysis.rootDomain);
}

const WHOIS_SUPPORTED_SUFFIXES = new Set([
  "com", "box", "net", "org", "me", "xyz", "im", "info", "io", "co", "ai", "biz", "us", "app", "sg",
  "cafe", "now", "shop", "life", "cn", "uk", "chat", "design", "fun", "website", "link", "site",
  "online", "cards", "fr", "sk", "it", "new", "video", "cc", "world", "de", "nl", "se", "jp",
  "ca", "au", "in", "es", "pl", "one", "dev", "games", "cloud", "studio", "art", "media"
]);

async function enrichDiscoveryTargets(limit: number, options: { sourceRootDomain?: string; sourcePageUrl?: string } = {}) {
  discoveryEnrichRunning = true;
  let checked = 0;
  let updated = 0;
  let failed = 0;
  try {
    const targets = (await allDiscoveryTargets())
      .filter((target) => target.status !== "ignored" && target.status !== "imported")
      .filter((target) => !target.whoisCheckedAt || Date.now() - Date.parse(target.whoisCheckedAt) > 30 * 24 * 60 * 60 * 1000)
      .filter((target) =>
        !options.sourceRootDomain && !options.sourcePageUrl
          ? true
          : target.sourceRootDomain === options.sourceRootDomain ||
            target.discoveredOnPages?.includes(options.sourcePageUrl ?? "")
      )
      .sort((a, b) => scoreDiscoveryTargetForWhois(b) - scoreDiscoveryTargetForWhois(a))
      .slice(0, Math.max(1, Math.min(limit, 50)));
    for (const target of targets) {
      checked += 1;
      await delay(1200);
      const result = await queryDomainCreatedAt(target.rootDomain);
      const current = nowIso();
      if (result.createdAt) {
        await saveDiscoveryTarget({
          ...target,
          status: target.status === "new" || target.status === "queued" ? "enriched" : target.status,
          provider: "whois",
          domainCreatedAt: result.createdAt,
          domainAgeMonths: domainAgeMonths(result.createdAt),
          whoisCheckedAt: current,
          lastSeenAt: current,
          lastError: "",
          notes: appendNote(target.notes, `WHOIS creation date: ${result.createdAt}`)
        });
        updated += 1;
      } else {
        await saveDiscoveryTarget({
          ...target,
          status: target.status === "new" ? "failed" : target.status,
          provider: "whois",
          whoisCheckedAt: current,
          lastSeenAt: current,
          lastError: result.error || "WHOIS creation date unavailable"
        });
        failed += 1;
      }
    }
    if (checked) await recordAutoSyncChange(checked);
    return { ok: true, checked, updated, failed };
  } finally {
    discoveryEnrichRunning = false;
  }
}

function scoreDiscoveryTargetForWhois(target: DiscoveryTarget) {
  return (target.occurrenceCount || 1) * 10 + Math.min((target.seenSourceRootDomains?.length ?? 0) * 20, 100);
}

async function queryDomainCreatedAt(rootDomain: string): Promise<{ createdAt: string; error: string }> {
  const parsed = parseWhoisDomain(rootDomain);
  if (!parsed) return { createdAt: "", error: "Unsupported or invalid suffix" };
  try {
    const url = `https://whois.freeaiapi.xyz/?name=${encodeURIComponent(parsed.name)}&suffix=${encodeURIComponent(parsed.suffix)}&c=1`;
    const response = await fetch(url);
    if (!response.ok) return { createdAt: "", error: `WHOIS HTTP ${response.status}` };
    const data = await response.json() as { status?: string; creation_datetime?: string };
    if (data?.status === "ok" && data.creation_datetime) {
      const date = new Date(data.creation_datetime.trim());
      if (Number.isFinite(date.getTime())) return { createdAt: date.toISOString(), error: "" };
    }
    return { createdAt: "", error: "WHOIS response has no creation date" };
  } catch (error) {
    return { createdAt: "", error: error instanceof Error ? error.message : "WHOIS query failed" };
  }
}

function parseWhoisDomain(rootDomain: string) {
  const parts = rootDomain.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const suffix = parts[parts.length - 1];
  if (!WHOIS_SUPPORTED_SUFFIXES.has(suffix)) return null;
  return { name: parts[parts.length - 2], suffix };
}

function domainAgeMonths(createdAt: string) {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return undefined;
  return Math.max(0, Math.floor((Date.now() - created) / (30.4375 * 24 * 60 * 60 * 1000)));
}

function appendNote(existing: string, next: string) {
  return existing ? `${existing}\n${next}` : next;
}

async function setSeoCaptureStatus(status: SeoCaptureStatus) {
  await chrome.storage.local.set({ seoCaptureStatus: status });
}

async function ensureAutoSyncAlarm() {
  await chrome.alarms.create(AUTO_SYNC_ALARM, { periodInMinutes: 10 });
}

async function recordAutoSyncChange(count = 1) {
  const meta = await getAutoSyncMeta();
  await setAutoSyncMeta({ ...meta, pendingChanges: meta.pendingChanges + count });
  await maybeAutoSyncGoogleSheets("change");
}

async function maybeAutoSyncGoogleSheets(trigger: "change" | "timer") {
  const settings = await getSettings();
  if (!settings.googleSheetsAutoSyncEnabled || !settings.googleSheetsId || !settings.googleOAuthClientId) return;

  const meta = await getAutoSyncMeta();
  if (meta.syncing || meta.pendingChanges <= 0) return;

  const threshold = Math.max(1, settings.googleSheetsAutoSyncEveryChanges || 25);
  const minIntervalMs = Math.max(1, settings.googleSheetsAutoSyncMinIntervalMinutes || 10) * 60 * 1000;
  const lastSuccessAt = meta.lastSuccessAt ? Date.parse(meta.lastSuccessAt) : 0;
  const intervalReached = !lastSuccessAt || Date.now() - lastSuccessAt >= minIntervalMs;
  const shouldSync = trigger === "timer" ? intervalReached : meta.pendingChanges >= threshold;
  if (!shouldSync) return;

  const attemptAt = nowIso();
  await setAutoSyncMeta({ ...meta, syncing: true, lastAttemptAt: attemptAt, lastError: "" });
  try {
    const result = await syncLocalDataToGoogleSheets(
      settings.googleSheetsId,
      settings.googleOAuthClientId,
      () => undefined,
      { interactiveAuth: false }
    );
    await saveSettings({
      ...settings,
      lastGoogleSheetsSyncAt: result.syncedAt,
      lastGoogleSheetsSyncDirection: "push"
    });
    await setAutoSyncMeta({
      pendingChanges: 0,
      syncing: false,
      lastAttemptAt: attemptAt,
      lastSuccessAt: result.syncedAt,
      lastError: ""
    });
  } catch (error) {
    await setAutoSyncMeta({
      ...meta,
      syncing: false,
      lastAttemptAt: attemptAt,
      lastError: error instanceof Error ? error.message : "Google Sheets 自动同步失败"
    });
  }
}

async function getAutoSyncMeta(): Promise<AutoSyncMeta> {
  const result = await chrome.storage.local.get(AUTO_SYNC_META_KEY);
  return {
    pendingChanges: 0,
    syncing: false,
    lastAttemptAt: "",
    lastSuccessAt: "",
    lastError: "",
    ...(result[AUTO_SYNC_META_KEY] ?? {})
  };
}

function setAutoSyncMeta(meta: AutoSyncMeta) {
  return chrome.storage.local.set({ [AUTO_SYNC_META_KEY]: meta });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
