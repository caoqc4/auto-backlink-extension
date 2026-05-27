import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { AppSettings, BacklinkPage, BacklinkSource, BacklinkSubmission, CheckLog, DiscoveryTarget, ImportBatch, Project } from "./types";

export interface SyncedLocalData {
  projects: Project[];
  sources: BacklinkSource[];
  pages: BacklinkPage[];
  submissions: BacklinkSubmission[];
  imports: ImportBatch[];
  checkLogs: CheckLog[];
  discoveryTargets: DiscoveryTarget[];
}

interface BacklinkForgeDb extends DBSchema {
  projects: {
    key: string;
    value: Project;
    indexes: { "by-updated": string };
  };
  backlink_sources: {
    key: string;
    value: BacklinkSource;
    indexes: { "by-root-domain": string; "by-priority": string; "by-status": string; "by-type": string };
  };
  backlink_pages: {
    key: string;
    value: BacklinkPage;
    indexes: { "by-source": string; "by-root-domain": string; "by-page-url": string; "by-opportunity": string; "by-status": string };
  };
  backlink_submissions: {
    key: string;
    value: BacklinkSubmission;
    indexes: { "by-project": string; "by-source": string; "by-status": string };
  };
  imports: {
    key: string;
    value: ImportBatch;
    indexes: { "by-imported": string };
  };
  check_logs: {
    key: string;
    value: CheckLog;
    indexes: { "by-checked": string; "by-source-root": string; "by-result": string };
  };
  discovery_targets: {
    key: string;
    value: DiscoveryTarget;
    indexes: { "by-root-domain": string; "by-status": string; "by-last-seen": string };
  };
  settings: {
    key: string;
    value: AppSettings;
  };
}

let dbPromise: Promise<IDBPDatabase<BacklinkForgeDb>> | null = null;

export function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<BacklinkForgeDb>("backlink-forge", 4, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("projects")) {
          const projects = db.createObjectStore("projects", { keyPath: "id" });
          projects.createIndex("by-updated", "updatedAt");
        }

        if (!db.objectStoreNames.contains("backlink_sources")) {
          const sources = db.createObjectStore("backlink_sources", { keyPath: "id" });
          sources.createIndex("by-root-domain", "rootDomain");
          sources.createIndex("by-priority", "priorityLevel");
          sources.createIndex("by-status", "status");
          sources.createIndex("by-type", "sourceType");
        }

        if (!db.objectStoreNames.contains("backlink_pages")) {
          const pages = db.createObjectStore("backlink_pages", { keyPath: "id" });
          pages.createIndex("by-source", "sourceId");
          pages.createIndex("by-root-domain", "rootDomain");
          pages.createIndex("by-page-url", "pageUrl", { unique: true });
          pages.createIndex("by-opportunity", "opportunity");
          pages.createIndex("by-status", "status");
        }

        if (!db.objectStoreNames.contains("backlink_submissions")) {
          const submissions = db.createObjectStore("backlink_submissions", { keyPath: "id" });
          submissions.createIndex("by-project", "projectId");
          submissions.createIndex("by-source", "sourceId");
          submissions.createIndex("by-status", "status");
        }

        if (!db.objectStoreNames.contains("imports")) {
          const imports = db.createObjectStore("imports", { keyPath: "id" });
          imports.createIndex("by-imported", "importedAt");
        }

        if (!db.objectStoreNames.contains("check_logs")) {
          const logs = db.createObjectStore("check_logs", { keyPath: "id" });
          logs.createIndex("by-checked", "checkedAt");
          logs.createIndex("by-source-root", "sourceRootDomain");
          logs.createIndex("by-result", "result");
        }

        if (!db.objectStoreNames.contains("discovery_targets")) {
          const targets = db.createObjectStore("discovery_targets", { keyPath: "id" });
          targets.createIndex("by-root-domain", "rootDomain", { unique: true });
          targets.createIndex("by-status", "status");
          targets.createIndex("by-last-seen", "lastSeenAt");
        }

        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "id" });
        }
      }
    });
  }
  return dbPromise;
}

export const nowIso = () => new Date().toISOString();

export const uid = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

function compactStrings(values: Array<string | undefined | null>) {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function sourceOccurrenceKey(source: Pick<BacklinkSource, "competitorDomain" | "discoveredFrom" | "sourceUrl">) {
  return source.competitorDomain || source.discoveredFrom || source.sourceUrl;
}

function pageOccurrenceKey(page: Pick<BacklinkPage, "competitorDomain" | "discoveredFrom" | "competitorTargetUrl" | "pageUrl">) {
  return page.competitorDomain || page.discoveredFrom || page.competitorTargetUrl || page.pageUrl;
}

function mergeNullableFlag<T>(existing: T | null, incoming: T | null) {
  return incoming ?? existing;
}

function mergeSourceStatus(existing: BacklinkSource["status"], incoming: BacklinkSource["status"]) {
  if (["blacklisted", "skipped", "failed"].includes(existing)) return existing;
  if (["analyzed", "usable"].includes(incoming)) return incoming;
  return existing || incoming;
}

function mergePageStatus(existing: BacklinkPage["status"], incoming: BacklinkPage["status"]) {
  if (["blacklisted", "skipped", "failed"].includes(existing)) return existing;
  if (["analyzed", "usable"].includes(incoming)) return incoming;
  return existing || incoming;
}

export async function allProjects() {
  return (await getDb()).getAll("projects");
}

export async function saveProject(project: Project) {
  return (await getDb()).put("projects", project);
}

export async function allSources() {
  return (await getDb()).getAll("backlink_sources");
}

export async function saveSource(source: BacklinkSource) {
  return (await getDb()).put("backlink_sources", source);
}

export async function clearResourcePool() {
  const db = await getDb();
  const tx = db.transaction(["backlink_sources", "backlink_pages", "imports", "check_logs", "discovery_targets"], "readwrite");
  await Promise.all([
    tx.objectStore("backlink_sources").clear(),
    tx.objectStore("backlink_pages").clear(),
    tx.objectStore("imports").clear(),
    tx.objectStore("check_logs").clear(),
    tx.objectStore("discovery_targets").clear()
  ]);
  await tx.done;
}

export async function bulkSaveSources(sources: BacklinkSource[]) {
  const db = await getDb();
  const tx = db.transaction("backlink_sources", "readwrite");
  await Promise.all(sources.map((source) => tx.store.put(source)));
  await tx.done;
}

export async function bulkSavePages(pages: BacklinkPage[]) {
  const db = await getDb();
  const tx = db.transaction("backlink_pages", "readwrite");
  await Promise.all(pages.map((page) => tx.store.put(page)));
  await tx.done;
}

export async function upsertSourcesByRootDomain(sources: BacklinkSource[]) {
  const db = await getDb();
  const tx = db.transaction("backlink_sources", "readwrite");
  let createdCount = 0;
  let updatedCount = 0;

  for (const source of sources) {
    const existing = await tx.store.index("by-root-domain").get(source.rootDomain);
    if (existing) {
      const competitorDomains = compactStrings([...(existing.seenCompetitorDomains ?? []), ...(existing.discoveredOutboundDomains ?? []), existing.competitorDomain, source.competitorDomain, ...(source.discoveredOutboundDomains ?? [])]);
      const occurrenceKeys = compactStrings([...(existing.seenOccurrenceKeys ?? []), sourceOccurrenceKey(existing), sourceOccurrenceKey(source)]);
      await tx.store.put({
        ...existing,
        sourceUrl: existing.sourceUrl || source.sourceUrl,
        sourceType: existing.sourceType === "unknown" ? source.sourceType : existing.sourceType,
        sourceTypeConfidence: Math.max(existing.sourceTypeConfidence, source.sourceTypeConfidence),
        dr: Math.max(existing.dr ?? 0, source.dr ?? 0) || existing.dr || source.dr,
        traffic: Math.max(existing.traffic ?? 0, source.traffic ?? 0) || existing.traffic || source.traffic,
        lastSeenAt: nowIso(),
        occurrenceCount: Math.max(occurrenceKeys.length, existing.occurrenceCount || 1),
        competitorCount: Math.max(existing.competitorCount, competitorDomains.length),
        seenCompetitorDomains: competitorDomains,
        discoveredOutboundDomains: compactStrings([...(existing.discoveredOutboundDomains ?? []), ...(source.discoveredOutboundDomains ?? [])]),
        seenOccurrenceKeys: occurrenceKeys,
        priorityLevel: source.priorityLevel,
        notes: [existing.notes, source.notes].filter(Boolean).join("\n")
      });
      updatedCount += 1;
    } else {
      const competitorDomains = compactStrings([source.competitorDomain, ...(source.discoveredOutboundDomains ?? [])]);
      const occurrenceKeys = compactStrings([sourceOccurrenceKey(source)]);
      await tx.store.put({
        ...source,
        occurrenceCount: Math.max(source.occurrenceCount || 1, occurrenceKeys.length || 1),
        competitorCount: Math.max(source.competitorCount || 0, competitorDomains.length),
        seenCompetitorDomains: competitorDomains,
        discoveredOutboundDomains: source.discoveredOutboundDomains ?? [],
        seenOccurrenceKeys: occurrenceKeys
      });
      createdCount += 1;
    }
  }

  await tx.done;
  return { createdCount, updatedCount };
}

export async function upsertSourcesAndPages(items: Array<{ source: BacklinkSource; page?: BacklinkPage }>) {
  const db = await getDb();
  const tx = db.transaction(["backlink_sources", "backlink_pages"], "readwrite");
  const sourceStore = tx.objectStore("backlink_sources");
  const pageStore = tx.objectStore("backlink_pages");
  let createdCount = 0;
  let updatedCount = 0;
  let pageCreatedCount = 0;
  let pageUpdatedCount = 0;

  for (const item of items) {
    const existing = await sourceStore.index("by-root-domain").get(item.source.rootDomain);
    const sourceId = existing?.id ?? item.source.id;
    if (existing) {
      const competitorDomains = compactStrings([...(existing.seenCompetitorDomains ?? []), ...(existing.discoveredOutboundDomains ?? []), existing.competitorDomain, item.source.competitorDomain, ...(item.source.discoveredOutboundDomains ?? [])]);
      const occurrenceKeys = compactStrings([...(existing.seenOccurrenceKeys ?? []), sourceOccurrenceKey(existing), sourceOccurrenceKey(item.source)]);
      await sourceStore.put({
        ...existing,
        sourceUrl: existing.sourceUrl || item.source.sourceUrl,
        sourceType: existing.sourceType === "unknown" ? item.source.sourceType : existing.sourceType,
        sourceTypeConfidence: Math.max(existing.sourceTypeConfidence, item.source.sourceTypeConfidence),
        dr: Math.max(existing.dr ?? 0, item.source.dr ?? 0) || existing.dr || item.source.dr,
        traffic: Math.max(existing.traffic ?? 0, item.source.traffic ?? 0) || existing.traffic || item.source.traffic,
        lastSeenAt: nowIso(),
        occurrenceCount: Math.max(occurrenceKeys.length, existing.occurrenceCount || 1),
        competitorCount: Math.max(existing.competitorCount, competitorDomains.length),
        seenCompetitorDomains: competitorDomains,
        discoveredOutboundDomains: compactStrings([...(existing.discoveredOutboundDomains ?? []), ...(item.source.discoveredOutboundDomains ?? [])]),
        seenOccurrenceKeys: occurrenceKeys,
        requiresLogin: mergeNullableFlag(existing.requiresLogin, item.source.requiresLogin),
        requiresRegister: mergeNullableFlag(existing.requiresRegister, item.source.requiresRegister),
        requiresPayment: mergeNullableFlag(existing.requiresPayment, item.source.requiresPayment),
        hasCaptcha: mergeNullableFlag(existing.hasCaptcha, item.source.hasCaptcha),
        hasCloudflare: mergeNullableFlag(existing.hasCloudflare, item.source.hasCloudflare),
        hasSubmitForm: mergeNullableFlag(existing.hasSubmitForm, item.source.hasSubmitForm),
        hasCommentForm: mergeNullableFlag(existing.hasCommentForm, item.source.hasCommentForm),
        hasProfileField: mergeNullableFlag(existing.hasProfileField, item.source.hasProfileField),
        detectedRel: existing.detectedRel === "unknown" ? item.source.detectedRel : existing.detectedRel,
        status: mergeSourceStatus(existing.status, item.source.status),
        failureReason: existing.failureReason || item.source.failureReason,
        priorityLevel: item.source.priorityLevel,
        notes: [existing.notes, item.source.notes].filter(Boolean).join("\n")
      });
      updatedCount += 1;
    } else {
      const competitorDomains = compactStrings([item.source.competitorDomain, ...(item.source.discoveredOutboundDomains ?? [])]);
      const occurrenceKeys = compactStrings([sourceOccurrenceKey(item.source)]);
      await sourceStore.put({
        ...item.source,
        occurrenceCount: Math.max(item.source.occurrenceCount || 1, occurrenceKeys.length || 1),
        competitorCount: Math.max(item.source.competitorCount || 0, competitorDomains.length),
        seenCompetitorDomains: competitorDomains,
        discoveredOutboundDomains: item.source.discoveredOutboundDomains ?? [],
        seenOccurrenceKeys: occurrenceKeys
      });
      createdCount += 1;
    }

    if (item.page) {
      const existingPage = await pageStore.index("by-page-url").get(item.page.pageUrl);
      if (existingPage) {
        const competitorDomains = compactStrings([...(existingPage.seenCompetitorDomains ?? []), ...(existingPage.discoveredOutboundDomains ?? []), existingPage.competitorDomain, item.page.competitorDomain, ...(item.page.discoveredOutboundDomains ?? [])]);
        const occurrenceKeys = compactStrings([...(existingPage.seenOccurrenceKeys ?? []), pageOccurrenceKey(existingPage), pageOccurrenceKey(item.page)]);
        await pageStore.put({
          ...existingPage,
          sourceId,
          pageTitle: existingPage.pageTitle || item.page.pageTitle,
          pageType: existingPage.pageType === "unknown" ? item.page.pageType : existingPage.pageType,
          competitorDomain: existingPage.competitorDomain || item.page.competitorDomain,
          competitorTargetUrl: existingPage.competitorTargetUrl || item.page.competitorTargetUrl,
          competitorAnchor: existingPage.competitorAnchor || item.page.competitorAnchor,
          competitorLinkCount: Math.max(existingPage.competitorLinkCount, item.page.competitorLinkCount),
          occurrenceCount: Math.max(occurrenceKeys.length, existingPage.occurrenceCount || 1),
          seenCompetitorDomains: competitorDomains,
          discoveredOutboundDomains: compactStrings([...(existingPage.discoveredOutboundDomains ?? []), ...(item.page.discoveredOutboundDomains ?? [])]),
          seenOccurrenceKeys: occurrenceKeys,
          detectedRel: existingPage.detectedRel === "unknown" ? item.page.detectedRel : existingPage.detectedRel,
          requiresLogin: mergeNullableFlag(existingPage.requiresLogin, item.page.requiresLogin),
          requiresRegister: mergeNullableFlag(existingPage.requiresRegister, item.page.requiresRegister),
          hasCaptcha: mergeNullableFlag(existingPage.hasCaptcha, item.page.hasCaptcha),
          hasCloudflare: mergeNullableFlag(existingPage.hasCloudflare, item.page.hasCloudflare),
          hasSubmitForm: mergeNullableFlag(existingPage.hasSubmitForm, item.page.hasSubmitForm),
          hasCommentForm: mergeNullableFlag(existingPage.hasCommentForm, item.page.hasCommentForm),
          hasProfileField: mergeNullableFlag(existingPage.hasProfileField, item.page.hasProfileField),
          opportunity: existingPage.opportunity === "skip" ? existingPage.opportunity : item.page.opportunity,
          status: mergePageStatus(existingPage.status, item.page.status),
          failureReason: existingPage.failureReason || item.page.failureReason,
          lastAnalyzedAt: item.page.lastAnalyzedAt || existingPage.lastAnalyzedAt,
          lastSeenAt: nowIso(),
          notes: [existingPage.notes, item.page.notes].filter(Boolean).join("\n")
        });
        pageUpdatedCount += 1;
      } else {
        const competitorDomains = compactStrings([item.page.competitorDomain, ...(item.page.discoveredOutboundDomains ?? [])]);
        const occurrenceKeys = compactStrings([pageOccurrenceKey(item.page)]);
        await pageStore.put({
          ...item.page,
          sourceId,
          occurrenceCount: Math.max(item.page.occurrenceCount || 1, occurrenceKeys.length || 1),
          seenCompetitorDomains: competitorDomains,
          discoveredOutboundDomains: item.page.discoveredOutboundDomains ?? [],
          seenOccurrenceKeys: occurrenceKeys
        });
        pageCreatedCount += 1;
      }
    }
  }

  await tx.done;
  return { createdCount, updatedCount, pageCreatedCount, pageUpdatedCount };
}

export async function allPages() {
  return (await getDb()).getAll("backlink_pages");
}

export async function savePage(page: BacklinkPage) {
  return (await getDb()).put("backlink_pages", page);
}

export async function findPageByUrl(pageUrl: string) {
  return (await getDb()).getFromIndex("backlink_pages", "by-page-url", pageUrl);
}

export async function findSourceByRootDomain(rootDomain: string) {
  return (await getDb()).getFromIndex("backlink_sources", "by-root-domain", rootDomain);
}

export async function allSubmissions() {
  return (await getDb()).getAll("backlink_submissions");
}

export async function saveSubmission(submission: BacklinkSubmission) {
  return (await getDb()).put("backlink_submissions", submission);
}

export async function allImports() {
  return (await getDb()).getAll("imports");
}

export async function saveImportBatch(batch: ImportBatch) {
  return (await getDb()).put("imports", batch);
}

export async function allCheckLogs() {
  return (await getDb()).getAll("check_logs");
}

export async function saveCheckLog(log: CheckLog) {
  const db = await getDb();
  await db.put("check_logs", log);
  const logs = await db.getAll("check_logs");
  const oldLogs = logs
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
    .slice(500);
  if (oldLogs.length) {
    const tx = db.transaction("check_logs", "readwrite");
    await Promise.all(oldLogs.map((item) => tx.store.delete(item.id)));
    await tx.done;
  }
}

export async function allDiscoveryTargets() {
  return (await getDb()).getAll("discovery_targets");
}

export async function saveDiscoveryTarget(target: DiscoveryTarget) {
  return (await getDb()).put("discovery_targets", target);
}

export async function upsertDiscoveryTargets(targets: DiscoveryTarget[]) {
  const db = await getDb();
  const tx = db.transaction("discovery_targets", "readwrite");
  let createdCount = 0;
  let updatedCount = 0;

  for (const target of targets) {
    const existing = await tx.store.index("by-root-domain").get(target.rootDomain);
    if (existing) {
      const discoveredOnPages = compactStrings([...(existing.discoveredOnPages ?? []), ...(target.discoveredOnPages ?? []), target.sourcePageUrl]);
      const seenSourceRootDomains = compactStrings([...(existing.seenSourceRootDomains ?? []), ...(target.seenSourceRootDomains ?? []), target.sourceRootDomain]);
      const existingEvidenceCount = Math.max(existing.discoveredOnPages?.length ?? 0, existing.seenSourceRootDomains?.length ?? 0, existing.occurrenceCount || 1);
      const nextEvidenceCount = Math.max(discoveredOnPages.length, seenSourceRootDomains.length, 1);
      await tx.store.put({
        ...existing,
        sourceRootDomain: existing.sourceRootDomain || target.sourceRootDomain,
        sourcePageUrl: existing.sourcePageUrl || target.sourcePageUrl,
        discoveredFrom: existing.discoveredFrom || target.discoveredFrom,
        provider: target.provider !== "none" ? target.provider : existing.provider,
        status: mergeDiscoveryStatus(existing.status, target.status),
        lastSeenAt: target.lastSeenAt,
        occurrenceCount: Math.max(existingEvidenceCount, nextEvidenceCount),
        discoveredOnPages,
        seenSourceRootDomains,
        dr: Math.max(existing.dr ?? 0, target.dr ?? 0) || existing.dr || target.dr,
        traffic: Math.max(existing.traffic ?? 0, target.traffic ?? 0) || existing.traffic || target.traffic,
        refDomains: Math.max(existing.refDomains ?? 0, target.refDomains ?? 0) || existing.refDomains || target.refDomains,
        backlinks: Math.max(existing.backlinks ?? 0, target.backlinks ?? 0) || existing.backlinks || target.backlinks,
        domainCreatedAt: existing.domainCreatedAt || target.domainCreatedAt,
        domainAgeMonths: existing.domainAgeMonths ?? target.domainAgeMonths,
        whoisCheckedAt: existing.whoisCheckedAt || target.whoisCheckedAt,
        seoCheckedAt: existing.seoCheckedAt || target.seoCheckedAt,
        lastError: target.lastError || existing.lastError,
        notes: [existing.notes, target.notes].filter(Boolean).join("\n")
      });
      updatedCount += 1;
    } else {
      await tx.store.put({
        ...target,
        discoveredOnPages: compactStrings([...(target.discoveredOnPages ?? []), target.sourcePageUrl]),
        seenSourceRootDomains: compactStrings([...(target.seenSourceRootDomains ?? []), target.sourceRootDomain])
      });
      createdCount += 1;
    }
  }

  await tx.done;
  return { createdCount, updatedCount };
}

function mergeDiscoveryStatus(existing: DiscoveryTarget["status"], incoming: DiscoveryTarget["status"]) {
  if (["ignored", "imported"].includes(existing)) return existing;
  if (["enriched", "seo_queued", "failed"].includes(incoming)) return incoming;
  if (existing === "new" && incoming === "queued") return incoming;
  return existing || incoming;
}

export async function replaceSyncedData(data: SyncedLocalData) {
  const db = await getDb();
  const tx = db.transaction([
    "projects",
    "backlink_sources",
    "backlink_pages",
    "backlink_submissions",
    "imports",
    "check_logs",
    "discovery_targets"
  ], "readwrite");
  const projects = tx.objectStore("projects");
  const sources = tx.objectStore("backlink_sources");
  const pages = tx.objectStore("backlink_pages");
  const submissions = tx.objectStore("backlink_submissions");
  const imports = tx.objectStore("imports");
  const logs = tx.objectStore("check_logs");
  const targets = tx.objectStore("discovery_targets");

  await Promise.all([
    projects.clear(),
    sources.clear(),
    pages.clear(),
    submissions.clear(),
    imports.clear(),
    logs.clear(),
    targets.clear()
  ]);

  await Promise.all([
    ...data.projects.map((item) => projects.put(item)),
    ...data.sources.map((item) => sources.put(item)),
    ...data.pages.map((item) => pages.put(item)),
    ...data.submissions.map((item) => submissions.put(item)),
    ...data.imports.map((item) => imports.put(item)),
    ...data.checkLogs.map((item) => logs.put(item)),
    ...(data.discoveryTargets ?? []).map((item) => targets.put(item))
  ]);
  await tx.done;
}

export async function getSettings(): Promise<AppSettings> {
  const db = await getDb();
  const existing = await db.get("settings", "settings");
  const defaults: AppSettings = {
    id: "settings",
    aiProvider: "none",
    aiApiKey: "",
    aiModel: "",
    googleSheetsId: "",
    googleOAuthClientId: "",
    googleSheetsAutoSyncEnabled: true,
    googleSheetsAutoSyncEveryChanges: 100,
    googleSheetsAutoSyncMinIntervalMinutes: 30,
    lastGoogleSheetsSyncAt: "",
    lastGoogleSheetsSyncDirection: "none",
    feishuBaseId: "",
    humanTypingMinDelayMs: 25,
    humanTypingMaxDelayMs: 85,
    submitMode: "manual"
  };
  if (existing) {
    const merged = { ...defaults, ...existing };
    await db.put("settings", merged);
    return merged;
  }
  await db.put("settings", defaults);
  return defaults;
}

export async function saveSettings(settings: AppSettings) {
  return (await getDb()).put("settings", settings);
}
