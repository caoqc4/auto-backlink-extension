export type BacklinkCategory =
  | "product_submission"
  | "ugc_comment_profile"
  | "developer_content"
  | "media_outreach"
  | "opportunity_strategy"
  | "unknown";

export type PriorityLevel = "A" | "B" | "C" | "D" | "X";

export type SourceStatus =
  | "new"
  | "queued"
  | "opened"
  | "analyzed"
  | "usable"
  | "skipped"
  | "failed"
  | "blacklisted";

export type SubmissionStatus =
  | "candidate"
  | "queued"
  | "opened"
  | "analyzed"
  | "filled"
  | "waiting_manual_submit"
  | "submitted"
  | "pending_review"
  | "live_dofollow"
  | "live_nofollow"
  | "live_ugc"
  | "live_sponsored"
  | "rejected"
  | "failed"
  | "skipped"
  | "needs_manual";

export type LinkRel = "dofollow" | "nofollow" | "ugc" | "sponsored" | "mixed" | "unknown";
export type OpportunityKind = "direct" | "review" | "engage" | "skip";

export interface OutboundLinkSignal {
  href: string;
  rootDomain: string;
  anchor: string;
  rel: LinkRel;
}

export type DiscoveryTargetStatus =
  | "new"
  | "queued"
  | "enriched"
  | "seo_queued"
  | "imported"
  | "ignored"
  | "failed";

export interface DiscoveryTarget {
  id: string;
  rootDomain: string;
  sourceRootDomain: string;
  sourcePageUrl: string;
  discoveredFrom: "page_outbound" | "ahrefs" | "semrush" | "import" | "manual";
  provider: "none" | "ahrefs" | "semrush" | "whois";
  status: DiscoveryTargetStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  discoveredOnPages: string[];
  seenSourceRootDomains: string[];
  dr?: number;
  traffic?: number;
  refDomains?: number;
  backlinks?: number;
  domainCreatedAt?: string;
  domainAgeMonths?: number;
  whoisCheckedAt: string;
  seoCheckedAt: string;
  lastError: string;
  notes: string;
}

export interface Project {
  id: string;
  projectName: string;
  siteUrl: string;
  brandName: string;
  shortDescription: string;
  longDescription: string;
  targetKeywords: string[];
  anchorTexts: string[];
  category: string;
  language: string;
  contactEmail: string;
  authorName: string;
  logoUrl: string;
  socialLinks: string[];
  createdAt: string;
  updatedAt: string;
}

export interface BacklinkSource {
  id: string;
  sourceDomain: string;
  sourceUrl: string;
  rootDomain: string;
  discoveredFrom: string;
  competitorDomain: string;
  sourceType: BacklinkCategory;
  sourceTypeConfidence: number;
  dr?: number;
  traffic?: number;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  competitorCount: number;
  seenCompetitorDomains?: string[];
  seenOccurrenceKeys?: string[];
  discoveredOutboundDomains?: string[];
  requiresLogin: boolean | null;
  requiresRegister: boolean | null;
  requiresPayment: boolean | null;
  hasCaptcha: boolean | null;
  hasCloudflare: boolean | null;
  hasSubmitForm: boolean | null;
  hasCommentForm: boolean | null;
  hasProfileField: boolean | null;
  detectedRel: LinkRel;
  isNoindex: boolean | null;
  priorityLevel: PriorityLevel;
  status: SourceStatus;
  failureReason: string;
  notes: string;
}

export interface BacklinkPage {
  id: string;
  sourceId: string;
  rootDomain: string;
  pageUrl: string;
  pageTitle: string;
  pageType: BacklinkCategory;
  discoveredFrom: string;
  competitorDomain: string;
  competitorTargetUrl: string;
  competitorAnchor: string;
  competitorLinkCount: number;
  occurrenceCount: number;
  seenCompetitorDomains?: string[];
  seenOccurrenceKeys?: string[];
  discoveredOutboundDomains?: string[];
  detectedRel: LinkRel;
  requiresLogin: boolean | null;
  requiresRegister: boolean | null;
  hasCaptcha: boolean | null;
  hasCloudflare: boolean | null;
  hasSubmitForm: boolean | null;
  hasCommentForm: boolean | null;
  hasProfileField: boolean | null;
  opportunity: OpportunityKind;
  status: SourceStatus;
  failureReason: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastAnalyzedAt: string;
  notes: string;
}

export interface BacklinkSubmission {
  id: string;
  projectId: string;
  sourceId: string;
  targetDomain: string;
  targetUrl: string;
  submittedUrl: string;
  backlinkType: BacklinkCategory;
  anchorText: string;
  contentUsed: string;
  accountUsed: string;
  emailUsed: string;
  status: SubmissionStatus;
  rel: LinkRel;
  isLive: boolean | null;
  isIndexed: boolean | null;
  submittedAt: string;
  checkedAt: string;
  nextCheckAt: string;
  failureReason: string;
  notes: string;
}

export interface ImportBatch {
  id: string;
  source: "ahrefs" | "semrush" | "json" | "csv" | "xlsx" | "page" | "manual";
  label: string;
  importedAt: string;
  rowCount: number;
  createdCount: number;
  updatedCount: number;
  notes: string;
}

export interface CheckLog {
  id: string;
  taskType: "resource_precheck" | "execution_screen";
  projectId: string;
  sourceId: string;
  sourceRootDomain: string;
  sourceUrl: string;
  queuedUrl: string;
  finalUrl: string;
  finalRootDomain: string;
  result: "candidate" | "skip" | "error";
  opportunity: OpportunityKind;
  skipScope: "none" | "page" | "domain";
  reason: string;
  checkedAt: string;
  notes: string;
}

export interface AppSettings {
  id: "settings";
  uiLanguage: "zh-CN" | "en";
  aiProvider: "none" | "openai" | "gemini" | "openrouter" | "deepseek";
  aiApiKey: string;
  aiModel: string;
  googleSheetsId: string;
  googleOAuthClientId: string;
  googleSheetsAutoSyncEnabled: boolean;
  googleSheetsAutoSyncEveryChanges: number;
  googleSheetsAutoSyncMinIntervalMinutes: number;
  lastGoogleSheetsSyncAt: string;
  lastGoogleSheetsSyncDirection: "none" | "push" | "pull";
  feishuBaseId: string;
  humanTypingMinDelayMs: number;
  humanTypingMaxDelayMs: number;
  submitMode: "manual" | "confirm_each" | "auto_low_risk";
}

export interface PageAnalysis {
  url: string;
  rootDomain: string;
  title: string;
  language: string;
  pageType: BacklinkCategory;
  hasForm: boolean;
  formFields: FormFieldSummary[];
  submitButtons: string[];
  directorySubmissionDetected: boolean;
  profileCandidateDetected: boolean;
  forumThreadDetected: boolean;
  forumReplyDetected: boolean;
  commentHtmlAnchorLikely: boolean;
  submissionLinks: string[];
  accountLinks: string[];
  loginRequired: boolean;
  registerRequired: boolean;
  captchaDetected: boolean;
  cloudflareDetected: boolean;
  existingTargetLink: boolean;
  existingLinkRel: LinkRel;
  targetLinkCount: number;
  competitorDomain: string;
  competitorLinkCount: number;
  competitorLinkRel: LinkRel;
  competitorAnchors: string[];
  outboundLinks?: OutboundLinkSignal[];
  paidPlacementDetected: boolean;
  noindex: boolean;
  pageUnavailable: boolean;
  canonicalUrl: string;
}

export interface LinkVerification {
  targetUrl: string;
  targetDomain: string;
  found: boolean;
  count: number;
  rel: LinkRel;
  relCounts?: Partial<Record<LinkRel, number>>;
  anchors: string[];
  hrefs: string[];
  links?: Array<{
    href: string;
    anchor: string;
    rel: LinkRel;
    rawRel: string;
  }>;
  suspectedLinks?: Array<{
    href: string;
    anchor: string;
    rel: LinkRel;
    rawRel: string;
  }>;
  textMentionFound?: boolean;
  textMentions?: string[];
  checkedUrl: string;
  checkedTitle: string;
  isPrivateArea?: boolean;
  privateAreaReason?: string;
}

export interface FormFieldSummary {
  selector: string;
  tagName: string;
  type: string;
  name: string;
  id: string;
  placeholder: string;
  label: string;
  purpose: FieldPurpose;
}

export type FieldPurpose =
  | "name"
  | "email"
  | "website"
  | "comment"
  | "product_name"
  | "product_url"
  | "description"
  | "category"
  | "tags"
  | "bio"
  | "title"
  | "unknown";

export interface FillPayload {
  project: Project;
  commentText?: string;
  descriptionText?: string;
  titleText?: string;
  commentLinkMode?: "auto_recommend" | "none" | "website_field" | "body_html_anchor" | "body_bbcode_link";
}
