import type { BacklinkPage, BacklinkSource } from "./types";
import { normalizeUrl } from "./url";

export type ExecutionResourceClass = "directory" | "developer_blog" | "profile" | "blog_comment" | "shortlink" | "other";
export type DirectoryQualityLevel = "not_directory" | "strong_candidate" | "standard_candidate" | "review_paid" | "weak_or_spam" | "unknown";

export interface DirectoryQuality {
  level: DirectoryQualityLevel;
  label: string;
  reason: string;
  rank: number;
}

export function executionResourceClass(source: BacklinkSource, sourcePages: BacklinkPage[]): ExecutionResourceClass {
  const urls = [source.sourceUrl, ...sourcePages.map((page) => page.pageUrl)].join(" ").toLowerCase();
  if (isShortlinkResource(source, sourcePages)) return "shortlink";
  if (source.sourceType === "product_submission" || source.hasSubmitForm || sourcePages.some((page) => page.hasSubmitForm || page.pageType === "product_submission")) return "directory";
  if (source.sourceType === "developer_content" || isDeveloperBlogDomain(source.rootDomain)) return "developer_blog";
  if (
    source.hasProfileField ||
    sourcePages.some((page) => page.hasProfileField) ||
    /(\/usercp|\/ucp\.php|\/member\.php|\/profile|\/settings|\/account|op=info|action=profile|signature|pf_phpbb_website)/i.test(urls)
  ) return "profile";
  if (source.hasCommentForm || sourcePages.some((page) => page.hasCommentForm) || source.sourceType === "ugc_comment_profile") return "blog_comment";
  return "other";
}

export function executionClassRank(source: BacklinkSource, sourcePages: BacklinkPage[]) {
  const ranking: Record<ExecutionResourceClass, number> = {
    directory: 0,
    developer_blog: 1,
    profile: 2,
    blog_comment: 3,
    shortlink: 4,
    other: 5
  };
  return ranking[executionResourceClass(source, sourcePages)];
}

export function executionClassLabel(source: BacklinkSource, sourcePages: BacklinkPage[]) {
  return executionClassLabelFromClass(executionResourceClass(source, sourcePages));
}

export function executionClassLabelFromClass(resourceClass: ExecutionResourceClass) {
  return {
    directory: "目录/提交",
    developer_blog: "开发者博客",
    profile: "Profile",
    blog_comment: "普通博客评论",
    shortlink: "短链",
    other: "待人工验证"
  }[resourceClass];
}

export function actionablePagesFromSortedPages(sourcePages: BacklinkPage[]) {
  return sourcePages.filter((page) => page.opportunity !== "skip" && page.status !== "skipped" && !isSearchResultUrl(page.pageUrl));
}

export function sourcePassedPrecheck(source: BacklinkSource, sourcePages: BacklinkPage[]) {
  if (source.status === "blacklisted" || source.status === "skipped" || source.hasCloudflare || source.hasCaptcha) return false;
  return actionablePagesFromSortedPages(sourcePages).some((page) =>
    Boolean(page.lastAnalyzedAt) &&
    page.status !== "skipped" &&
    page.opportunity !== "skip"
  );
}

export function bestExecutionPageUrl(source: BacklinkSource, sourcePages: BacklinkPage[]) {
  return actionablePagesFromSortedPages(sourcePages)[0]?.pageUrl || source.sourceUrl;
}

export function classifyDirectoryQuality(source: BacklinkSource, sourcePages: BacklinkPage[]): DirectoryQuality {
  if (executionResourceClass(source, sourcePages) !== "directory") {
    return { level: "not_directory", label: "非目录站", reason: "当前资源不是目录/提交站", rank: 0 };
  }

  const traffic = source.traffic;
  const dr = source.dr;
  const paidSignal = hasPaidDirectorySignal(source, sourcePages);
  const linkFarmSignal = hasLinkFarmSignal(source, sourcePages);
  const hasTraffic = typeof traffic === "number" && Number.isFinite(traffic);
  const hasDr = typeof dr === "number" && Number.isFinite(dr);
  const drText = hasDr ? `DR ${dr}` : "DR 未知";
  const trafficText = hasTraffic ? `traffic ${traffic}` : "traffic 未知";

  if (!hasTraffic) {
    return {
      level: paidSignal || linkFarmSignal ? "review_paid" : "unknown",
      label: paidSignal || linkFarmSignal ? "付费目录 · 数据不足" : "目录数据不足",
      reason: `${trafficText}，${drText}${paidSignal || linkFarmSignal ? "，存在付费/链接农场信号" : ""}`,
      rank: paidSignal || linkFarmSignal ? 4 : 3
    };
  }

  if (traffic <= 100 && (paidSignal || linkFarmSignal || (hasDr && dr >= 30))) {
    return {
      level: "weak_or_spam",
      label: "疑似链接工厂",
      reason: `${trafficText}，${drText}，${paidSignal || linkFarmSignal ? "存在付费/泛目录信号" : "DR 高但流量低"}`,
      rank: 6
    };
  }

  if (traffic <= 100) {
    return {
      level: "weak_or_spam",
      label: "低流量目录",
      reason: `${trafficText} 未超过 100，${drText}`,
      rank: 5
    };
  }

  if (paidSignal || linkFarmSignal) {
    return {
      level: "review_paid",
      label: "付费目录 · 人工判断",
      reason: `${trafficText} 已超过 100，${drText}，但存在付费/泛目录信号`,
      rank: 4
    };
  }

  if (hasDr && dr >= 20) {
    return {
      level: "strong_candidate",
      label: "目录高质量候选",
      reason: `${trafficText} 已超过 100，${drText}`,
      rank: 1
    };
  }

  return {
    level: "standard_candidate",
    label: "目录普通候选",
    reason: `${trafficText} 已超过 100，${drText}`,
    rank: 2
  };
}

export function isSearchResultUrl(url: string) {
  try {
    const parsed = new URL(normalizeUrl(url));
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return (
      host.includes("search.yahoo.") ||
      (host.startsWith("www.google.") && path.startsWith("/search")) ||
      (host.startsWith("www.bing.") && path.startsWith("/search")) ||
      host.startsWith("duckduckgo.com") ||
      (host.startsWith("yandex.") && path.startsWith("/search"))
    );
  } catch {
    return false;
  }
}

function isDeveloperBlogDomain(rootDomain: string) {
  return new Set(["dev.to", "medium.com", "hashnode.dev", "velog.io", "telegra.ph", "rentry.co"]).has(rootDomain);
}

function isShortlinkResource(source: BacklinkSource, sourcePages: BacklinkPage[]) {
  const roots = new Set([source.rootDomain, ...sourcePages.map((page) => page.rootDomain)]);
  const known = new Set(["bit.ly", "tinyurl.com", "t.co", "is.gd", "v.gd", "cutt.ly", "rebrand.ly", "shorturl.at", "s.id", "rb.gy"]);
  if (Array.from(roots).some((root) => known.has(root))) return true;
  const urls = [source.sourceUrl, ...sourcePages.map((page) => page.pageUrl)].join(" ").toLowerCase();
  return /(shorten|shortlink|short-url|url-shortener|\/go\/|\/r\/|\/l\/)/i.test(urls) && source.sourceType !== "product_submission";
}

function hasPaidDirectorySignal(source: BacklinkSource, sourcePages: BacklinkPage[]) {
  if (source.requiresPayment) return true;
  const haystack = directoryHaystack(source, sourcePages);
  return /(paid|payment|pricing|price|package|sponsored|guest\s*post|article\s*publish|high\s*(dr|da)|buy\s*(backlink|link)|link\s*building|add\s+\d+\s+articles?)/i.test(haystack);
}

function hasLinkFarmSignal(source: BacklinkSource, sourcePages: BacklinkPage[]) {
  const haystack = directoryHaystack(source, sourcePages);
  return /(link\s*directory|web\s*directory|submit\s*(url|site|article)|add\s*my\s*site|add\s*site|general\s*business|casino|forex|loan|essay|adult)/i.test(haystack);
}

function directoryHaystack(source: BacklinkSource, sourcePages: BacklinkPage[]) {
  return [
    source.sourceUrl,
    source.sourceDomain,
    source.rootDomain,
    source.failureReason,
    source.notes,
    ...sourcePages.flatMap((page) => [page.pageUrl, page.pageTitle, page.failureReason, page.notes])
  ].join(" ").toLowerCase();
}
