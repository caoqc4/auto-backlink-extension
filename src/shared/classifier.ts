import type { BacklinkCategory, BacklinkSource, LinkRel, PageAnalysis, PriorityLevel } from "./types";
import { rootDomainFromUrl } from "./url";

const developerDomains = [
  "dev.to",
  "medium.com",
  "hashnode.dev",
  "github.com",
  "npmjs.com",
  "rentry.co",
  "telegra.ph",
  "velog.io",
  "gitlab.com",
  "sourceforge.net"
];

export function classifySource(url: string, title = "", body = ""): { type: BacklinkCategory; confidence: number } {
  const haystack = `${url} ${title} ${body}`.toLowerCase();
  const root = rootDomainFromUrl(url);

  if (developerDomains.includes(root)) return { type: "developer_content", confidence: 0.92 };

  if (/(submit your (site|website|url|link|tool|product|startup|game)|add my site|add url|add listing|submit listing|site submission|free submission|web directory|link directory|business directory|\b(submit|add[-_\s]?(site|tool|product|startup|game)|directory|launch|product)\b)/.test(haystack)) {
    return { type: "product_submission", confidence: 0.82 };
  }

  if (/(leave a reply|leave a comment|comment form|your email|your website|wp-comments-post|comment_post_ID)/.test(haystack)) {
    return { type: "ugc_comment_profile", confidence: 0.86 };
  }

  if (/(profile|account|bio|signature|website field|forum|phpbb|discuz|edit profile|user control panel|homepage|website url)/.test(haystack)) {
    return { type: "ugc_comment_profile", confidence: 0.68 };
  }

  if (/(write for us|guest post|editorial|press|journalist|media kit|contribute)/.test(haystack)) {
    return { type: "media_outreach", confidence: 0.74 };
  }

  if (/(best .*tools|top .*tools|alternatives|resources|dead link|broken link|testimonial|case stud)/.test(haystack)) {
    return { type: "opportunity_strategy", confidence: 0.66 };
  }

  return { type: "unknown", confidence: 0.25 };
}

export function inferRel(rel: string): LinkRel {
  const clean = rel.toLowerCase();
  if (!clean.trim()) return "dofollow";
  if (clean.includes("sponsored")) return "sponsored";
  if (clean.includes("ugc")) return "ugc";
  if (clean.includes("nofollow")) return "nofollow";
  return "dofollow";
}

export function priorityForSource(source: Partial<BacklinkSource>): PriorityLevel {
  if (source.status === "blacklisted" || source.status === "skipped" || source.requiresPayment === true || source.hasCloudflare === true) return "X";

  let score = 0;
  score += Math.min((source.occurrenceCount ?? 1) * 12, 36);
  score += Math.min((source.competitorCount ?? 1) * 10, 30);
  score += Math.min((source.dr ?? 0) / 2, 30);
  score += Math.min(Math.log10((source.traffic ?? 0) + 1) * 8, 28);
  score += source.detectedRel === "dofollow" ? 16 : 0;
  score += source.hasSubmitForm || source.hasCommentForm || source.hasProfileField ? 14 : 0;
  score -= source.requiresRegister ? 8 : 0;
  score -= source.requiresLogin ? 6 : 0;
  score -= source.hasCaptcha ? 10 : 0;
  score -= source.detectedRel === "nofollow" || source.detectedRel === "ugc" ? 6 : 0;

  if (score >= 74) return "A";
  if (score >= 48) return "B";
  if (score >= 24) return "C";
  return "D";
}

export function pageAnalysisToSourcePatch(analysis: PageAnalysis): Pick<
  BacklinkSource,
  | "sourceType"
  | "sourceTypeConfidence"
  | "requiresLogin"
  | "requiresRegister"
  | "requiresPayment"
  | "hasCaptcha"
  | "hasCloudflare"
  | "hasSubmitForm"
  | "hasCommentForm"
  | "hasProfileField"
  | "detectedRel"
  | "isNoindex"
> {
  const hasForumComposer = analysis.forumThreadDetected || analysis.forumReplyDetected;
  const hasCommentForm = analysis.formFields.some((field) => field.purpose === "comment") || hasForumComposer;
  const commentOpportunity = hasCommentForm || analysis.commentHtmlAnchorLikely;
  const hasProfileField = !commentOpportunity && analysis.formFields.some((field) => field.purpose === "bio" || field.purpose === "website");
  const sourceType = hasCommentForm || analysis.commentHtmlAnchorLikely
    ? "ugc_comment_profile"
    : analysis.directorySubmissionDetected
      ? "product_submission"
      : analysis.profileCandidateDetected
      ? "ugc_comment_profile"
      : analysis.pageType;
  return {
    sourceType,
    sourceTypeConfidence: analysis.directorySubmissionDetected || analysis.profileCandidateDetected || analysis.commentHtmlAnchorLikely || hasForumComposer ? 0.86 : 0.78,
    requiresLogin: analysis.loginRequired,
    requiresRegister: analysis.registerRequired,
    requiresPayment: analysis.paidPlacementDetected,
    hasCaptcha: analysis.captchaDetected,
    hasCloudflare: analysis.cloudflareDetected,
    hasSubmitForm: analysis.directorySubmissionDetected && analysis.hasForm && analysis.submitButtons.length > 0,
    hasCommentForm,
    hasProfileField: commentOpportunity ? false : hasProfileField || analysis.profileCandidateDetected,
    detectedRel: analysis.existingLinkRel,
    isNoindex: analysis.noindex
  };
}
