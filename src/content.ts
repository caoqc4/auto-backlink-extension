type BacklinkCategory =
  | "product_submission"
  | "ugc_comment_profile"
  | "developer_content"
  | "media_outreach"
  | "opportunity_strategy"
  | "unknown";

type LinkRel = "dofollow" | "nofollow" | "ugc" | "sponsored" | "mixed" | "unknown";

type FieldPurpose =
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

interface ProjectPayload {
  projectName: string;
  siteUrl: string;
  brandName: string;
  shortDescription: string;
  longDescription: string;
  targetKeywords: string[];
  anchorTexts: string[];
  category: string;
  contactEmail: string;
  authorName: string;
}

interface FillPayload {
  project: ProjectPayload;
  commentText?: string;
  descriptionText?: string;
  titleText?: string;
  commentLinkMode?: "auto_recommend" | "none" | "website_field" | "body_html_anchor" | "body_bbcode_link";
}

interface FormFieldSummary {
  selector: string;
  tagName: string;
  type: string;
  name: string;
  id: string;
  placeholder: string;
  label: string;
  purpose: FieldPurpose;
}

type NativeFillElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type FillableElement = NativeFillElement | HTMLElement;

interface PageAnalysis {
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

interface PageContext {
  title: string;
  url: string;
  rootDomain: string;
  language: string;
  visibleText: string;
  headings: string[];
  nearbyComments: string[];
}

interface LinkVerification {
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

interface OutboundLinkSignal {
  href: string;
  rootDomain: string;
  anchor: string;
  rel: LinkRel;
}

type ContentMessage =
  | { type: "ANALYZE_PAGE"; targetUrl?: string; competitorUrl?: string; outboundLimit?: number }
  | { type: "ANALYZE_PAGE_V2"; targetUrl?: string; competitorUrl?: string; outboundLimit?: number }
  | { type: "HUMAN_FILL"; payload: FillPayload }
  | { type: "HUMAN_FILL_V2"; payload: FillPayload }
  | { type: "SCRAPE_AHREFS_ROWS" }
  | { type: "EXTRACT_PAGE_CONTEXT" }
  | { type: "EXTRACT_PAGE_CONTEXT_V2" }
  | { type: "VERIFY_BACKLINK"; targetUrl: string; targetAnchors?: string[] }
  | { type: "VERIFY_BACKLINK_V2"; targetUrl: string; targetAnchors?: string[] };

var backlinkForgeContentWindow = window as Window & { __backlinkForgeContentListenerInstalled?: boolean };
if (!backlinkForgeContentWindow.__backlinkForgeContentListenerInstalled) {
  backlinkForgeContentWindow.__backlinkForgeContentListenerInstalled = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data as { source?: string; payload?: unknown };
    if (data?.source !== "backlink-forge-seo-result") return;
    chrome.runtime.sendMessage({ type: "CAPTURE_SEO_RESPONSE", payload: data.payload }).catch(() => undefined);
  });

  chrome.runtime.onMessage.addListener((message: ContentMessage, _sender, sendResponse) => {
    if (message.type === "ANALYZE_PAGE" || message.type === "ANALYZE_PAGE_V2") {
      sendResponse(analyzePage(message.targetUrl, message.competitorUrl, message.outboundLimit));
      return true;
    }

    if (message.type === "HUMAN_FILL" || message.type === "HUMAN_FILL_V2") {
      void fillPage(message.payload).then((result) => sendResponse(result));
      return true;
    }

    if (message.type === "SCRAPE_AHREFS_ROWS") {
      sendResponse({ rows: scrapeVisibleLinks() });
      return true;
    }

    if (message.type === "EXTRACT_PAGE_CONTEXT" || message.type === "EXTRACT_PAGE_CONTEXT_V2") {
      sendResponse(extractPageContext());
      return true;
    }

    if (message.type === "VERIFY_BACKLINK" || message.type === "VERIFY_BACKLINK_V2") {
      sendResponse(verifyBacklink(message.targetUrl, message.targetAnchors ?? []));
      return true;
    }

    return false;
  });
}

function analyzePage(targetUrl = "", competitorUrl = "", outboundLimit = 250): PageAnalysis {
  const text = document.body?.innerText ?? "";
  const title = document.title || "";
  const pageUnavailable = isUnavailablePage(title, text);
  const classification = classifySource(location.href, title, text.slice(0, 6000));
  const nativeFields = Array.from(document.querySelectorAll("input, textarea, select"))
    .filter((element) => isUsableField(element as NativeFillElement));
  const richEditors = getRichTextEditors();
  const fields = [...nativeFields, ...richEditors];
  const formFields = fields.map((element) => summarizeField(element as FillableElement));
  const submitButtons = Array.from(document.querySelectorAll("button, input[type='submit']"))
    .filter((button) => isVisibleElement(button as HTMLElement))
    .map((button) => ((button as HTMLButtonElement).innerText || (button as HTMLInputElement).value || "").trim())
    .filter(Boolean)
    .slice(0, 12);
  const publishableFieldCount = formFields.filter((field) => field.purpose !== "unknown" && !isSearchLikeField(field)).length;

  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
  const submissionLinks = collectActionLinks(links, "submission");
  const accountLinks = collectActionLinks(links, "account");
  const forumThreadDetected = isForumThreadComposerPage(text, title, location.href, formFields, submitButtons);
  const forumReplyDetected = isForumReplyPage(text, title, location.href, formFields, submitButtons);
  const bloggerCommentDetected = isBloggerCommentPage(text, title, location.href);
  const genericBlogCommentDetected = isGenericBlogCommentPage(text, title, location.href, formFields, submitButtons);
  const directorySubmissionDetected = isDirectorySubmissionPage(text, title, submissionLinks, formFields, submitButtons);
  const profileCandidateDetected = !bloggerCommentDetected && !genericBlogCommentDetected && !isBlogArticlePage(text, title, location.href) && !forumThreadDetected && !forumReplyDetected && isProfileCandidatePage(text, title, location.href, accountLinks, formFields);
  const commentHtmlAnchorLikely = canLikelyAcceptHtmlAnchorInComment();
  const targetPresence = inspectLinkPresence(links, targetUrl);
  const competitorPresence = inspectLinkPresence(links, competitorUrl);
  const outboundLinks = inspectOutboundLinks(links, targetUrl, outboundLimit);

  return {
    url: location.href,
    rootDomain: rootDomainFromUrl(location.href),
    title,
    language: document.documentElement.lang || navigator.language || "unknown",
    pageType: classification.type,
    hasForm: publishableFieldCount > 0 || bloggerCommentDetected || genericBlogCommentDetected || forumThreadDetected || forumReplyDetected,
    formFields,
    submitButtons,
    directorySubmissionDetected,
    profileCandidateDetected,
    forumThreadDetected,
    forumReplyDetected,
    commentHtmlAnchorLikely: commentHtmlAnchorLikely || bloggerCommentDetected || genericBlogCommentDetected,
    submissionLinks,
    accountLinks,
    loginRequired: /(log in|login|sign in|登录|登入)/i.test(text),
    registerRequired: /(register|sign up|join|create account|加入|注册|创建账户)/i.test(text),
    captchaDetected: /(captcha|hcaptcha|recaptcha|turnstile|人机|验证码)/i.test(text) || Boolean(document.querySelector("[class*='captcha'], iframe[src*='captcha'], iframe[src*='turnstile']")),
    cloudflareDetected: /(cloudflare|checking your browser|verify you are human)/i.test(text),
    existingTargetLink: targetPresence.count > 0,
    existingLinkRel: targetPresence.rel,
    targetLinkCount: targetPresence.count,
    competitorDomain: competitorPresence.domain,
    competitorLinkCount: competitorPresence.count,
    competitorLinkRel: competitorPresence.rel,
    competitorAnchors: competitorPresence.anchors,
    outboundLinks,
    paidPlacementDetected: isPaidPlacementPage(text, title),
    noindex: Boolean(document.querySelector("meta[name='robots'][content*='noindex' i]")),
    pageUnavailable,
    canonicalUrl: document.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href ?? ""
  };
}

function verifyBacklink(targetUrl: string, targetAnchors: string[] = []): LinkVerification {
  const targetDomain = rootDomainFromUrl(targetUrl);
  const privateArea = privateProfileAreaReason();
  const allLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
  const links = allLinks.filter((link) => hrefMatchesTarget(link.href, targetUrl, targetDomain));
  const textMentions = visibleTargetMentions(targetUrl, targetAnchors);
  const suspectedLinks = allLinks
    .filter((link) => !hrefMatchesTarget(link.href, targetUrl, targetDomain))
    .filter((link) => anchorLooksLikeTarget(link, targetDomain, targetAnchors))
    .map((link) => ({
      href: link.href,
      anchor: compactText(link.textContent || link.getAttribute("aria-label") || link.href),
      rel: inferRel(link.rel),
      rawRel: link.rel || ""
    }))
    .slice(0, 10);
  const linkDetails = links.map((link) => ({
    href: link.href,
    anchor: compactText(link.textContent || link.getAttribute("aria-label") || link.href),
    rel: inferRel(link.rel),
    rawRel: link.rel || ""
  }));
  const rels = new Set(linkDetails.map((link) => link.rel));
  const relCounts = linkDetails.reduce<Partial<Record<LinkRel, number>>>((counts, link) => {
    counts[link.rel] = (counts[link.rel] ?? 0) + 1;
    return counts;
  }, {});
  const anchors = Array.from(new Set(links
    .map((link) => compactText(link.textContent || link.getAttribute("aria-label") || link.href))
    .filter(Boolean))).slice(0, 10);
  const hrefs = Array.from(new Set(links.map((link) => link.href))).slice(0, 10);
  return {
    targetUrl,
    targetDomain,
    found: links.length > 0,
    count: links.length,
    rel: links.length ? (rels.size > 1 ? "mixed" : rels.values().next().value ?? "unknown") : "unknown",
    relCounts,
    anchors,
    hrefs,
    links: linkDetails.slice(0, 20),
    suspectedLinks,
    textMentionFound: textMentions.length > 0,
    textMentions,
    checkedUrl: location.href,
    checkedTitle: document.title || "",
    isPrivateArea: Boolean(privateArea),
    privateAreaReason: privateArea
  };
}

function anchorLooksLikeTarget(link: HTMLAnchorElement, targetDomain: string, targetAnchors: string[]) {
  const anchor = compactText(link.textContent || link.getAttribute("aria-label") || "").toLowerCase();
  if (!anchor) return false;
  const candidates = Array.from(new Set([
    targetDomain,
    targetDomain.replace(/\.[a-z.]+$/i, ""),
    ...targetAnchors
  ].map((item) => compactText(item).toLowerCase()).filter((item) => item.length >= 4)));
  return candidates.some((candidate) => anchor === candidate || anchor.includes(candidate));
}

function visibleTargetMentions(targetUrl: string, targetAnchors: string[]) {
  const visibleText = compactText(document.body?.innerText ?? "").toLowerCase();
  const domain = rootDomainFromUrl(targetUrl);
  const candidates = Array.from(new Set([
    domain,
    normalizeUrl(targetUrl).replace(/^https?:\/\//i, "").replace(/\/$/, ""),
    ...targetAnchors
  ].map((item) => compactText(item).toLowerCase()).filter((item) => item.length >= 4)));
  return candidates.filter((candidate) => visibleText.includes(candidate)).slice(0, 8);
}

function hrefMatchesTarget(href: string, targetUrl: string, targetDomain: string) {
  if (rootDomainFromUrl(href) === targetDomain) return true;
  const normalizedTarget = normalizeUrl(targetUrl).replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase();
  const candidates = decodedHrefCandidates(href);
  return candidates.some((candidate) => {
    const clean = candidate.toLowerCase();
    return rootDomainFromUrl(clean) === targetDomain ||
      clean.includes(targetDomain) ||
      Boolean(normalizedTarget && clean.includes(normalizedTarget));
  });
}

function decodedHrefCandidates(href: string) {
  const candidates = new Set<string>([href]);
  try {
    const parsed = new URL(href);
    parsed.searchParams.forEach((value) => candidates.add(value));
  } catch {
    // Keep the raw href when the browser reports a non-standard URL.
  }
  let previous = href;
  for (let i = 0; i < 3; i += 1) {
    try {
      const decoded = decodeURIComponent(previous);
      if (decoded === previous) break;
      candidates.add(decoded);
      previous = decoded;
    } catch {
      break;
    }
  }
  return [...candidates];
}

function privateProfileAreaReason() {
  const url = location.href.toLowerCase();
  const title = (document.title || "").toLowerCase();
  const text = compactText(document.body?.innerText ?? "").slice(0, 2500).toLowerCase();
  if (/(\/account(\/|$)|\/settings(\/|$)|\/preferences(\/|$)|\/usercp|\/ucp\.php|\/profile\/edit|\/account\/signature|\/account-details|\/signature|\/profile_layout)/i.test(url)) {
    return "当前是账号/资料设置页，不是公开可收录页面";
  }
  const publicProfileUrl = /(\/people\/[^/?#]+\/?(?:[?#].*)?$|\/users?\/[^/?#]+\/?(?:[?#].*)?$|\/members?\/[^/?#]+\/?(?:[?#].*)?$|\/(?:forums\/)?profile\/[^/?#]+\/?(?:[?#].*)?$)/i.test(url);
  const publicProfileContent = /(about me|activity|viewing profile|reputation|followers|posts|joined|last visited|contact methods)/i.test(`${title}\n${text}`);
  const editFormSignal = Boolean(document.querySelector(
    "form[action*='account' i], form[action*='settings' i], form[action*='profile' i], input[name*='signature' i], textarea[name*='signature' i], input[name*='bio' i], textarea[name*='bio' i]"
  ));
  if (publicProfileUrl && (publicProfileContent || !editFormSignal)) return "";
  const textEditSignal = /(edit signature|account details|your account|profile layout|edit profile|signature settings|user control panel)/i.test(`${title}\n${text}`);
  const accountSettingsOnly = /account settings/i.test(`${title}\n${text}`);
  if (textEditSignal || (accountSettingsOnly && editFormSignal && !publicProfileUrl)) {
    return "当前是账号/资料编辑页，不是公开可收录页面";
  }
  return "";
}

function isPaidPlacementPage(text: string, title: string) {
  const haystack = `${title}\n${text.slice(0, 7000)}`.toLowerCase();
  const url = location.href.toLowerCase();
  const blogArticleSignal = /(^https?:\/\/blog\.|\.blogspot\.|\/\d{4}\/\d{2}\/.*\.html(?:[?#]|$)|\.html(?:[?#]|$))/i.test(url);
  const commentSignal = /(leave a reply|leave a comment|post comment|comment \*|your email address will not be published|wp-comments-post|comment_post_id|comment as:|enter comment|publish|post comments \(atom\))/i.test(haystack);
  const strongPaidSignal = /(sponsored post|paid post|guest post package|publish on high dr|buy backlinks|buy backlink|lifetime backlink|article publish on high dr)/i.test(haystack);
  if (blogArticleSignal || commentSignal) {
    return strongPaidSignal;
  }
  return (
    /(buy backlinks|buy backlink|buy lifetime backlink|lifetime backlink|submit\s*(&|and)\s*pay|advertising spot is vacant|one[-\s]?time payment|add funds now|wallet balance|product purchases|buy from my websites|buy now|pricing|package|premium package|sponsored post|paid post|guest post package|publish on high dr|article publish on high dr|add 30 article|write for us \/ guest post)/i.test(haystack) ||
    /(\$\s?\d+|usd|eur|gbp).{0,120}(backlink|guest post|article|post|site|package|advertising spot)/i.test(haystack) ||
    /(backlink|guest post|article|advertising spot).{0,120}(\$\s?\d+|usd|eur|gbp|payment|pay)/i.test(haystack)
  );
}

function collectActionLinks(links: HTMLAnchorElement[], kind: "submission" | "account") {
  const pattern = kind === "submission"
    ? /(submit|add|list|suggest|publish|post|guest post|write for us|add my site|submit your (site|website|url|link|tool|product|startup|game)|提交|发布|投稿|收录|添加)/i
    : /(login|log in|sign in|register|sign up|join|account|profile|dashboard|settings|member|user|signature|登录|注册|账户|个人资料|设置)/i;
  return Array.from(new Set(links
    .filter((link) => isVisibleElement(link))
    .map((link) => `${compactText(link.textContent || link.getAttribute("aria-label") || "")} ${link.href}`)
    .filter((signature) => pattern.test(signature))
    .slice(0, 8)));
}

function isDirectorySubmissionPage(
  text: string,
  title: string,
  links: string[],
  fields: FormFieldSummary[],
  submitButtons: string[]
) {
  const haystack = `${location.href} ${title}\n${text.slice(0, 6000)}`.toLowerCase();
  if (/(usercp\.php|\/usercp|action=profile|edit profile|your profile|user control panel)/i.test(haystack)) return false;
  const hasDirectoryWords = /(submit your (site|website|url|link|tool|product|startup|game)|add my site|add url|add listing|submit listing|site submission|free submission|web directory|link directory|business directory|product hunt|launch your|submit startup|submit tool|guest post \/ add my site|submit your website)/i.test(haystack);
  const hasDirectoryFields =
    hasFieldPurpose(fields, ["product_name", "product_url", "description", "category", "title"]) &&
    hasFieldPurpose(fields, ["website", "product_url"]);
  const hasSubmitIntent = links.length > 0 || submitButtons.some((button) => /(submit|add|publish|send|post|提交|发布|添加)/i.test(button));
  return hasDirectoryWords || (hasDirectoryFields && hasSubmitIntent);
}

function isBloggerCommentPage(text: string, title: string, url: string) {
  const compact = text.length > 16000 ? `${text.slice(0, 8000)}\n${text.slice(-8000)}` : text;
  const haystack = `${url} ${title}\n${compact}`.toLowerCase();
  const bloggerPlatformSignal = /(blogger|blogspot|powered by blogger|post comments \(atom\))/i.test(haystack) ||
    Boolean(document.querySelector("a[href*='blogger.com' i], iframe[src*='blogger.com' i], .blogger, [class*='blogger' i]"));
  const googleCommentSignal = /(google-tilillä|google account|google-konto|google-tili|recaptcha|privacy policy|terms of service)/i.test(haystack);
  const articleUrlSignal = /\.html(?:[?#]|$)/i.test(url);
  const commentSignal = /(comment as:|enter comment|post comments \(atom\)|publish|reply|kirjoita kommentti|kommentti nimellä|julkaise|vasta|kommentti|nimetön|esikatselu|lähetä)/i.test(haystack);
  return commentSignal && (bloggerPlatformSignal || articleUrlSignal || googleCommentSignal);
}

function isBlogArticlePage(text: string, title: string, url: string) {
  const compact = text.length > 16000 ? `${text.slice(0, 8000)}\n${text.slice(-8000)}` : text;
  const haystack = `${url} ${title}\n${compact}`.toLowerCase();
  if (/(usercp|\/profile|\/account|\/settings|action=profile|edit profile|signature)/i.test(url)) return false;
  const articleUrlSignal = /(^https?:\/\/blog\.|\.blogspot\.|\/\d{4}\/\d{2}\/.*\.html(?:[?#]|$)|\.html(?:[?#]|$))/i.test(url);
  const articleContentSignal = /(posted by|author|comments?|comment as:|enter comment|publish|reply|newer post|older post|post comments \(atom\)|subscribe to: post comments)/i.test(haystack);
  return articleUrlSignal && articleContentSignal;
}

function isGenericBlogCommentPage(
  text: string,
  title: string,
  url: string,
  fields: FormFieldSummary[],
  submitButtons: string[]
) {
  if (/(usercp|\/profile|\/account|\/settings|action=profile|edit profile|signature|\/wp-admin)/i.test(url)) return false;
  const compact = text.length > 16000 ? `${text.slice(0, 8000)}\n${text.slice(-8000)}` : text;
  const fieldText = fields.map((field) => `${field.label} ${field.placeholder} ${field.name} ${field.id} ${field.purpose}`).join(" ");
  const buttonText = submitButtons.join(" ");
  const haystack = `${url} ${title}\n${compact}\n${fieldText}\n${buttonText}`.toLowerCase();
  const commentCopySignal = /(leave a comment|leave a reply|post comment|submit comment|your email address will not be published|required fields are marked|type here|comment \*|comments? on|thoughts on)/i.test(haystack);
  const wordpressSignal = /(commentform|wp-comments-post|comment_post_id|respond|comment-author|comment-email|comment-url)/i.test(haystack);
  const hasCommentField = fields.some((field) => field.purpose === "comment" || /comment|reply|message|type here/i.test(`${field.label} ${field.placeholder} ${field.name} ${field.id}`));
  const hasIdentityFields = fields.some((field) => field.purpose === "name") && fields.some((field) => field.purpose === "email");
  const hasWebsiteField = fields.some((field) => field.purpose === "website");
  const hasPostCommentButton = submitButtons.some((button) => /(post|submit|publish|send).{0,20}comment|comment.{0,20}(post|submit|publish|send)/i.test(button));
  const articleSurface = /(\/blog\/|\/20\d{2}\/|\/[^/?#]+\/?$|\.html(?:[?#]|$)|comments?)/i.test(url) || /(blog|article|post|comments?)/i.test(haystack);
  return (commentCopySignal || wordpressSignal || hasPostCommentButton) &&
    articleSurface &&
    (hasCommentField || (hasIdentityFields && hasWebsiteField));
}

function isProfileCandidatePage(
  text: string,
  title: string,
  url: string,
  links: string[],
  fields: FormFieldSummary[]
) {
  const haystack = `${url} ${title}\n${detectionText(text, 5000)}`.toLowerCase();
  if (/(leave a comment|leave a reply|post comment|submit comment|your email address will not be published|required fields are marked|commentform|wp-comments-post|comment_post_id)/i.test(haystack)) {
    return false;
  }
  const hasProfileWords = /(edit profile|my profile|member profile|user profile|account settings|profile settings|signature|homepage|website url|about me|bio|user control panel|usercp|ucp\.php|forum profile|pf_phpbb_website|discuz|个人资料|签名|主页|账户设置)/i.test(haystack);
  const hasProfileField = fields.some((field) => field.purpose === "bio" || isProfileWebsiteField(field));
  const hasAccountPath = /(\/usercp|\/ucp\.php|\/member\.php|\/profile|\/settings|\/account|op=info|action=profile)/i.test(url);
  return hasProfileWords || hasProfileField || (hasAccountPath && links.length > 0);
}

function isProfileWebsiteField(field: FormFieldSummary) {
  const signature = `${field.label} ${field.placeholder} ${field.name} ${field.id}`.toLowerCase();
  return field.purpose === "website" && /(homepage|website url|profile url|personal site|pf_phpbb_website|主页|个人网站)/i.test(signature);
}

function isForumThreadComposerPage(
  text: string,
  title: string,
  url: string,
  fields: FormFieldSummary[],
  submitButtons: string[]
) {
  const haystack = `${url} ${title}\n${detectionText(text, 9000)}`.toLowerCase();
  const hasThreadUrl = /(\/new(?:[/?#]|$)|\/post-thread|\/new-thread|\/create-thread|\/threads\/add|\/forums\/[^/]+\/post|\/post\?forum|\/newtopic|\/postarticle|[?&]action=post\b|[?&]boardid=)/i.test(url);
  const hasThreadWords = /(create post|new post title|post title|post article|post thread|post new topic|create thread|start new thread|thread title|topic title|your message|new topic|new thread|project status|project version|i have read the rules for posting)/i.test(haystack);
  const hasTitleField = fields.some((field) => field.purpose === "title");
  const hasBodyEditor =
    fields.some((field) => field.purpose === "comment" || field.purpose === "description") ||
    /(fr-element|fr-box|message body|write your message|compose your post|editor)/i.test(haystack);
  const hasSubmitIntent =
    submitButtons.some((button) => /(post article|post thread|create thread|submit thread|publish|post|submit)/i.test(button)) ||
    /(post article|post thread|post new topic|create thread|submit thread|topic title)/i.test(haystack);
  return (hasThreadUrl || hasThreadWords) && (hasTitleField || hasBodyEditor || hasSubmitIntent);
}

function isForumReplyPage(
  text: string,
  title: string,
  url: string,
  fields: FormFieldSummary[],
  submitButtons: string[]
) {
  if (isForumThreadComposerPage(text, title, url, fields, submitButtons)) return false;
  const haystack = `${url} ${title}\n${detectionText(text, 9000)}`.toLowerCase();
  const looksForum = /(\/threads?\/|\/showthread\.php|\/forums?\/|\/topics?\/|xenforo|phpbb|discuz|mybb|invision|forum index|thread starter|formatting cheatsheet)/i.test(haystack);
  const hasReplyWords = /(new reply|post reply|write your reply|reply to thread|quick reply|\+ quote|@mention|\breply\b)/i.test(haystack);
  const hasReplySubmit = submitButtons.some((button) => /(post reply|reply|submit reply)/i.test(button));
  const hasCommentField = fields.some((field) => field.purpose === "comment");
  const hasReplyEditor = fields.some((field) =>
    /(reply|message|post|body|editor|write|click here and begin writing)/i.test(`${field.label} ${field.placeholder} ${field.name} ${field.id} ${field.type}`)
  );
  return looksForum && (hasReplyWords || hasReplySubmit || hasCommentField || hasReplyEditor);
}

function detectionText(text: string, maxChunk = 7000) {
  if (text.length <= maxChunk * 2) return text;
  return `${text.slice(0, maxChunk)}\n${text.slice(-maxChunk)}`;
}

function hasFieldPurpose(fields: FormFieldSummary[], purposes: FieldPurpose[]) {
  return fields.some((field) => purposes.includes(field.purpose));
}

function isUnavailablePage(title: string, text: string) {
  const haystack = `${title}\n${text.slice(0, 1200)}`.toLowerCase();
  return (
    /\b(404|410)\b/.test(haystack) ||
    haystack.includes("page not found") ||
    haystack.includes("that page can't be found") ||
    haystack.includes("that page cannot be found") ||
    haystack.includes("nothing was found at this location") ||
    haystack.includes("not found at this location") ||
    haystack.includes("account suspended") ||
    haystack.includes("this account has been suspended") ||
    haystack.includes("domain suspended") ||
    haystack.includes("website suspended")
  );
}

function extractPageContext(): PageContext {
  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .map((item) => compactText(item.textContent ?? ""))
    .filter(Boolean)
    .slice(0, 8);
  const nearbyComments = Array.from(document.querySelectorAll("[class*='comment'], [id*='comment'], article, li"))
    .map((item) => compactText(item.textContent ?? ""))
    .filter((text) => text.length > 12 && text.length < 260)
    .slice(0, 8);

  return {
    title: document.title || "",
    url: location.href,
    rootDomain: rootDomainFromUrl(location.href),
    language: document.documentElement.lang || navigator.language || "unknown",
    visibleText: compactText(document.body?.innerText ?? "").slice(0, 2200),
    headings,
    nearbyComments
  };
}

function compactText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function inspectLinkPresence(links: HTMLAnchorElement[], targetUrl = "") {
  const domain = targetUrl ? rootDomainFromUrl(targetUrl) : "";
  const matchingLinks = domain
    ? links.filter((link) => rootDomainFromUrl(link.href) === domain)
    : [];
  const rels = new Set(matchingLinks.map((link) => inferRel(link.rel)));
  const anchors = Array.from(new Set(
    matchingLinks
      .map((link) => (link.textContent || link.getAttribute("aria-label") || link.href).trim().replace(/\s+/g, " "))
      .filter(Boolean)
  )).slice(0, 4);
  return {
    domain,
    count: matchingLinks.length,
    rel: rels.size > 1 ? "mixed" as LinkRel : rels.values().next().value ?? "unknown",
    anchors
  };
}

function inspectOutboundLinks(links: HTMLAnchorElement[], targetUrl = "", limit = 250): OutboundLinkSignal[] {
  const currentRoot = rootDomainFromUrl(location.href);
  const targetRoot = targetUrl ? rootDomainFromUrl(targetUrl) : "";
  const ignoredRoots = new Set([
    currentRoot,
    targetRoot,
    "google.com",
    "facebook.com",
    "twitter.com",
    "x.com",
    "instagram.com",
    "youtube.com",
    "linkedin.com",
    "pinterest.com",
    "wordpress.org",
    "blogger.com"
  ].filter(Boolean));
  const byDomain = new Map<string, OutboundLinkSignal>();
  for (const link of links) {
    const href = link.href;
    if (!/^https?:\/\//i.test(href)) continue;
    const rootDomain = rootDomainFromUrl(href);
    if (!rootDomain || ignoredRoots.has(rootDomain)) continue;
    const anchor = compactText(link.textContent || link.getAttribute("aria-label") || href);
    if (!byDomain.has(rootDomain)) {
      byDomain.set(rootDomain, {
        href,
        rootDomain,
        anchor,
        rel: inferRel(link.rel)
      });
    }
  }
  return Array.from(byDomain.values()).slice(0, Math.max(1, Math.min(limit, 1000)));
}

function isUsableField(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  if (!isVisibleElement(element)) return false;
  if (element.disabled) return false;
  if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.readOnly) return false;
  if (element instanceof HTMLInputElement) {
    return !["hidden", "submit", "button", "reset", "image", "file", "checkbox", "radio"].includes(element.type);
  }
  return true;
}

function getRichTextEditors() {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>([
    ".fr-element[contenteditable='true']",
    ".fr-view[contenteditable='true']",
    ".ProseMirror[contenteditable='true']",
    ".ql-editor[contenteditable='true']",
    "[role='textbox'][contenteditable='true']",
    "[contenteditable='true']"
  ].join(", ")));

  const editors = candidates
    .filter((element): element is HTMLElement => Boolean(element))
    .filter((element) => isUsableRichEditor(element));

  return dedupeNestedEditors(editors);
}

function isUsableRichEditor(element: HTMLElement) {
  if (!isVisibleElement(element)) return false;
  if (element.getAttribute("contenteditable") === "false") return false;
  if (element.closest("[aria-hidden='true'], [hidden]")) return false;
  const signature = `${compactText(element.id)} ${compactText(element.className)} ${compactText(element.getAttribute("role"))} ${compactText(element.getAttribute("aria-label"))} ${compactText(element.closest("form, .fr-box, .tox-tinymce, .ql-container, [data-xf-init], [class*='editor']")?.textContent).slice(0, 900)}`.toLowerCase();
  if (isSearchLikeFormContext(signature) || isSubscriptionLikeFormContext(signature)) return false;
  return /(fr-element|fr-view|prosemirror|ql-editor|tox-edit-area|message|reply|comment|post|thread|editor|write|compose|body|正文|回复|评论)/i.test(signature) ||
    element.matches(".fr-element, .fr-view, .ProseMirror, .ql-editor, [role='textbox']");
}

function dedupeNestedEditors(editors: HTMLElement[]) {
  return editors.filter((editor, index) => {
    if (editors.find((other, otherIndex) => otherIndex !== index && other.contains(editor))) return false;
    return editors.findIndex((other) => other === editor) === index;
  });
}

function isVisibleElement(element: Element | null | undefined) {
  if (!element || !(element instanceof Element)) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function classifySource(url: string, title = "", body = ""): { type: BacklinkCategory; confidence: number } {
  const haystack = `${url} ${title} ${body}`.toLowerCase();
  const root = rootDomainFromUrl(url);
  const developerDomains = new Set([
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
  ]);

  if (developerDomains.has(root)) return { type: "developer_content", confidence: 0.92 };
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

function inferRel(rel: string): LinkRel {
  const clean = compactText(rel).toLowerCase();
  if (!clean.trim()) return "dofollow";
  if (clean.includes("sponsored")) return "sponsored";
  if (clean.includes("ugc")) return "ugc";
  if (clean.includes("nofollow")) return "nofollow";
  return "dofollow";
}

function normalizeUrl(value: string): string {
  const trimmed = compactText(value);
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function rootDomainFromUrl(value: string): string {
  try {
    const hostname = new URL(normalizeUrl(value)).hostname.toLowerCase();
    const clean = hostname.replace(/^www\./, "");
    const parts = clean.split(".");
    if (parts.length <= 2) return clean;
    const secondLevelTlds = new Set(["co.uk", "com.au", "com.cn", "co.jp", "com.br"]);
    const lastTwo = parts.slice(-2).join(".");
    if (secondLevelTlds.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join(".");
    return lastTwo;
  } catch {
    return compactText(value).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  }
}

function summarizeField(element: FillableElement): FormFieldSummary {
  const label = getLabel(element);
  const placeholder = "placeholder" in element ? compactText(element.placeholder) : "";
  const type = element instanceof HTMLSelectElement
    ? "select"
    : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.type
      : richEditorType(element);
  const name = compactText(element.getAttribute("name"));
  const id = compactText(element.id);
  const role = compactText(element.getAttribute("role"));
  const ariaLabel = compactText(element.getAttribute("aria-label"));
  const className = compactText(element.className);
  const signature = `${label} ${placeholder} ${name} ${id} ${type} ${role} ${ariaLabel} ${className}`.toLowerCase();
  const form = element.closest("form");
  const editorShell = element.closest(".fr-box, .tox-tinymce, .ql-container, .ProseMirror, [data-xf-init], [class*='editor'], [class*='message']") as HTMLElement | null;
  const formSignature = form
    ? `${compactText(form.id)} ${compactText(form.className)} ${compactText(form.getAttribute("action"))} ${compactText(form.getAttribute("aria-label"))} ${compactText(form.textContent).slice(0, 700)}`.toLowerCase()
    : `${compactText(editorShell?.id)} ${compactText(editorShell?.className)} ${compactText(editorShell?.getAttribute("aria-label"))} ${compactText(editorShell?.textContent).slice(0, 700)}`.toLowerCase();

  return {
    selector: selectorFor(element),
    tagName: element.tagName.toLowerCase(),
    type,
    name,
    id,
    placeholder,
    label,
    purpose: inferPurpose(signature, element.tagName.toLowerCase(), formSignature)
  };
}

function richEditorType(element: Element) {
  if (element.matches(".fr-element, .fr-view")) return "froala_contenteditable";
  if (element.matches(".ProseMirror")) return "prosemirror_contenteditable";
  if (element.matches(".ql-editor")) return "quill_contenteditable";
  if (element.matches("[contenteditable='true' i]")) return "contenteditable";
  return "rich_text";
}

function inferPurpose(signature: string, tagName: string, formSignature = ""): FieldPurpose {
  const context = `${signature} ${formSignature}`;
  if (isSearchLikeSignature(signature) || isSearchLikeFormContext(context)) return "unknown";
  if (isSubscriptionLikeFormContext(context)) return "unknown";
  if (/(your name|name|author|昵称|姓名)/.test(signature)) return "name";
  if (/(email|e-mail|邮箱|mail)/.test(signature)) return "email";
  if (/(product url|tool url|app url|startup url|listing url|project url|submit url|target url|link url)/.test(signature)) return "product_url";
  if (/(product name|tool name|app name|startup name|project name|listing title|项目名|产品名)/.test(signature)) return "product_name";
  if (/(description|summary|short description|about|介绍|描述)/.test(signature)) return "description";
  if (/(bio|profile|about me|signature|签名|简介)/.test(signature)) return "bio";
  if (/(website|website url|profile url|personal site|url|site|homepage|domain|pf_phpbb_website|网址|网站|主页)/.test(signature)) return "website";
  if (/(comment|reply|评论|留言)/.test(signature) && isLikelyCommentField(tagName, context)) return "comment";
  if (tagName === "textarea" && isCommentFormContext(context)) return "comment";
  if (/(message|reply|post|body|editor|write|click here and begin writing|正文)/.test(signature) && isCommentFormContext(context)) return "comment";
  if (/(category|type|分类)/.test(signature)) return "category";
  if (/(tag|keyword|标签|关键词)/.test(signature)) return "tags";
  if (/(title|headline|标题)/.test(signature)) return "title";
  return "unknown";
}

function isCommentFormContext(context: string) {
  if (isSearchLikeFormContext(context) || isSubscriptionLikeFormContext(context)) return false;
  return /(commentform|wp-comments-post|comment_post_id|respond|leave a reply|leave a comment|your email address will not be published|required fields are marked|type here|new reply|post reply|quick reply|post comment|submit comment|reply to|discussion|thread|topic|formatting cheatsheet|@mention|评论|留言|回复)/.test(context);
}

function isLikelyCommentField(tagName: string, context: string) {
  if (isSearchLikeFormContext(context) || isSubscriptionLikeFormContext(context)) return false;
  return tagName === "textarea" ||
    /(commentform|wp-comments-post|comment_post_id|respond|leave a reply|leave a comment|your email address will not be published|required fields are marked|type here|new reply|post reply|quick reply|post comment|submit comment|reply to|discussion|thread|topic|formatting cheatsheet|@mention|评论|留言|回复)/.test(context);
}

function isSearchLikeSignature(signature: string) {
  return /(search|query|keyword search|buscar|cerca|recherche|suche|搜索|查找|\bq\b|\bs\b)/.test(signature);
}

function isSearchLikeFormContext(context: string) {
  return /\b(searchform|search-form|site-search|wp-block-search|search-submit|search-field|search-query|search results|search posts|search comments)\b/.test(context) ||
    /(type=\"search\"|role=\"search\"|placeholder=\"search|aria-label=\"search|站内搜索|搜索文章|搜索评论|查找内容)/.test(context);
}

function isSubscriptionLikeFormContext(context: string) {
  return /(newsletter|subscribe|subscription|mailchimp|mc-embedded-subscribe|email updates|join our list|订阅|邮件列表)/.test(context);
}

function isSearchLikeField(field: FormFieldSummary) {
  const signature = `${field.label} ${field.placeholder} ${field.name} ${field.id} ${field.type}`.toLowerCase();
  return isSearchLikeSignature(signature);
}

function getLabel(element: Element): string {
  const id = element.getAttribute("id");
  if (id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (explicit?.textContent) return explicit.textContent.trim();
  }
  const parentLabel = element.closest("label");
  if (parentLabel?.textContent) return parentLabel.textContent.trim();
  return "";
}

function selectorFor(element: Element): string {
  const id = element.getAttribute("id");
  if (id) return `#${CSS.escape(id)}`;
  const name = element.getAttribute("name");
  if (name) return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
  const fields = Array.from(document.querySelectorAll(element.tagName.toLowerCase()));
  const index = fields.indexOf(element);
  return `${element.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
}

async function fillPage(payload: FillPayload) {
  const nativeFields = Array.from(document.querySelectorAll("input, textarea, select"))
    .filter((field) => isUsableField(field as NativeFillElement));
  const fields = [...nativeFields, ...getRichTextEditors()]
    .map((field) => summarizeField(field as FillableElement))
    .filter((field) => isPublishablePurpose(field.purpose));

  if (!fields.length) {
    return {
      ok: false,
      filled: 0,
      message: "当前页没有找到可填写的发布表单。请先点击页面里的回复/引用/发布入口，出现编辑框后再点模拟填表。"
    };
  }

  const values: Record<FieldPurpose, string> = {
    name: payload.project.authorName || payload.project.brandName,
    email: payload.project.contactEmail,
    website: shouldFillWebsiteField(payload) ? payload.project.siteUrl : "",
    comment: commentValue(payload),
    product_name: payload.project.brandName || payload.project.projectName,
    product_url: payload.project.siteUrl,
    description: payload.descriptionText || payload.project.shortDescription,
    category: payload.project.category,
    tags: payload.project.targetKeywords.join(", "),
    bio: profileBioValue(payload),
    title: payload.titleText || payload.project.anchorTexts[0] || payload.project.brandName,
    unknown: ""
  };

  let filled = 0;
  for (const field of fields) {
    const value = values[field.purpose];
    if (!value) continue;
    const element = document.querySelector<FillableElement>(field.selector);
    if (!element || isHidden(element)) continue;
    await humanType(element, value);
    filled += 1;
    await wait(randomBetween(150, 420));
  }

  if (!filled) {
    return {
      ok: false,
      filled,
      message: "没有实际填入任何字段。请先打开回复/提交表单，或重新分析当前页。"
    };
  }

  return { ok: true, filled, message: `已填写 ${filled} 个字段。请人工检查内容后手动提交。` };
}

function commentValue(payload: FillPayload) {
  const base = payload.commentText || makeComment(payload);
  if (payload.commentLinkMode === "body_bbcode_link") return ensureBbcodeLink(base, payload.project);
  if (!shouldAddAnchorInCommentBody(payload)) return stripDofollowBypassFromNonBodyAnchor(base);
  const anchorText = payload.project.anchorTexts[0] || payload.project.brandName || payload.project.projectName || rootDomainFromUrl(payload.project.siteUrl);
  if (/<a\b/i.test(base) || base.includes(payload.project.siteUrl)) return ensureDofollowBypassAnchor(base, payload.project.siteUrl, anchorText);
  return `${base}\n<a href="${payload.project.siteUrl}\n">${anchorText}</a>`;
}

function profileBioValue(payload: FillPayload) {
  const base = payload.commentText || payload.project.longDescription || payload.project.shortDescription || makeComment(payload);
  if (payload.commentLinkMode === "body_html_anchor") {
    const anchorText = payload.project.anchorTexts[0] || payload.project.brandName || payload.project.projectName || rootDomainFromUrl(payload.project.siteUrl);
    return ensureDofollowBypassAnchor(base, payload.project.siteUrl, anchorText);
  }
  if (payload.commentLinkMode === "body_bbcode_link") return ensureBbcodeLink(base, payload.project);
  if (payload.commentLinkMode === "none" || !payload.project.siteUrl) return stripDofollowBypassFromNonBodyAnchor(base);
  return ensurePlainUrl(base, payload.project);
}

function ensurePlainUrl(value: string, project: FillPayload["project"]) {
  const normalizedUrl = normalizeUrl(project.siteUrl);
  if (!normalizedUrl) return value;
  const withoutHtml = stripDofollowBypassFromNonBodyAnchor(value).replace(/https?:\/\/[^\s"'<>]+/gi, "").replace(/\s+/g, " ").trim();
  return `${withoutHtml.replace(/[.!?]$/, "")}: ${normalizedUrl}`;
}

function ensureBbcodeLink(value: string, project: FillPayload["project"]) {
  const normalizedUrl = normalizeUrl(project.siteUrl);
  if (!normalizedUrl) return value;
  const anchorText = project.anchorTexts[0] || project.brandName || project.projectName || rootDomainFromUrl(project.siteUrl);
  const stripped = stripDofollowBypassFromNonBodyAnchor(value)
    .replace(/\[url=[^\]]+\]([\s\S]*?)\[\/url\]/gi, "$1")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${stripped.replace(/[.!?]$/, "")}: [url=${normalizedUrl}]${anchorText}[/url]`;
}

function ensureDofollowBypassAnchor(value: string, siteUrl: string, fallbackAnchor: string) {
  const normalizedUrl = normalizeUrl(siteUrl);
  if (!normalizedUrl) return value;
  if (!/<a\b/i.test(value) && !value.includes(normalizedUrl)) {
    return `${stripDofollowBypassFromNonBodyAnchor(value).replace(/[.!?]$/, "")}: <a href="${normalizedUrl}\n">${fallbackAnchor}</a>`;
  }
  return value.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (match, href: string, text: string) => {
    if (rootDomainFromUrl(href) !== rootDomainFromUrl(normalizedUrl)) return match;
    return `<a href="${normalizedUrl}\n">${text || fallbackAnchor}</a>`;
  });
}

function stripDofollowBypassFromNonBodyAnchor(value: string) {
  return value.replace(/<a\b[^>]*>(.*?)<\/a>/gi, "$1");
}

function shouldFillWebsiteField(payload: FillPayload) {
  return Boolean(payload.project.siteUrl && payload.commentLinkMode !== "none");
}

function shouldAddAnchorInCommentBody(payload: FillPayload) {
  if (!payload.project.siteUrl) return false;
  if (payload.commentLinkMode === "body_html_anchor") return true;
  if (payload.commentLinkMode === "body_bbcode_link") return false;
  if (payload.commentLinkMode !== "auto_recommend") return false;
  return canLikelyAcceptHtmlAnchorInComment() || hasCommentFieldWithoutWebsiteField();
}

function hasCommentFieldWithoutWebsiteField() {
  const nativeFields = Array.from(document.querySelectorAll("input, textarea, select"))
    .filter((field) => isUsableField(field as NativeFillElement));
  const fields = [...nativeFields, ...getRichTextEditors()]
    .map((field) => summarizeField(field as FillableElement));
  const hasComment = fields.some((field) => field.purpose === "comment");
  const hasWebsite = fields.some((field) => field.purpose === "website");
  return hasComment && !hasWebsite;
}

function canLikelyAcceptHtmlAnchorInComment() {
  const text = `${document.body?.innerText ?? ""} ${document.body?.innerHTML ?? ""}`.toLowerCase();
  const commentField = Array.from(document.querySelectorAll<HTMLTextAreaElement>(
    "textarea[name='comment'], textarea#comment, form[action*='wp-comments-post'] textarea, textarea[id*='comment'], textarea[name*='comment'], textarea"
  )).find((field) => isLikelyCommentTextarea(field));
  if (!commentField || !isVisibleElement(commentField)) return false;
  const form = commentField.closest("form");
  const formSignature = `${form?.id ?? ""} ${form?.className ?? ""} ${form?.getAttribute("action") ?? ""}`.toLowerCase();
  return (
    formSignature.includes("wp-comments-post") ||
    formSignature.includes("commentform") ||
    text.includes("comment_post_id") ||
    text.includes("wp-comments-post") ||
    /allowed html|you may use these html tags|<a href|href=/.test(text)
  );
}

function isLikelyCommentTextarea(field: HTMLTextAreaElement) {
  if (!isVisibleElement(field)) return false;
  const label = getLabel(field);
  const signature = `${label} ${field.placeholder} ${field.name} ${field.id} ${field.type}`.toLowerCase();
  const form = field.closest("form");
  const formSignature = form
    ? `${compactText(form.id)} ${compactText(form.className)} ${compactText(form.getAttribute("action"))} ${compactText(form.getAttribute("aria-label"))} ${compactText(form.textContent).slice(0, 700)}`.toLowerCase()
    : "";
  return isLikelyCommentField("textarea", `${signature} ${formSignature}`);
}

function isPublishablePurpose(purpose: FieldPurpose) {
  return new Set<FieldPurpose>([
    "name",
    "email",
    "website",
    "comment",
    "product_name",
    "product_url",
    "description",
    "category",
    "tags",
    "bio",
    "title"
  ]).has(purpose);
}

function makeComment(payload: FillPayload) {
  const title = cleanTitle(document.title || "this project");
  const haystack = `${title} ${document.body?.innerText?.slice(0, 1200) ?? ""}`.toLowerCase();
  const templates = haystack.includes("pokemon")
    ? [
        `Nice project. The Pokemon theme is fun, and the idea is easy to understand right away.`,
        `Cool Pokemon build. I like how simple the project is to jump into.`,
        `This is a fun Pokemon project. The visuals make it clear what is happening quickly.`,
        `Nice work on this. Pokemon projects are always fun to explore, and this one has a clear idea.`,
        `Cool project. I like the Pokemon style and the way it gets straight to the point.`
      ]
    : [
        `Nice project. The idea is easy to understand and fun to try.`,
        `Cool build. I like how quickly the project communicates what it is about.`,
        `Nice work on this project. The presentation is clear and easy to follow.`,
        `This is a fun project. I like the way the main idea comes through right away.`,
        `Cool project. It feels simple to get started with, which is nice.`
      ];

  const selected = templates[Math.floor(Math.random() * templates.length)];
  return title && title !== "this project" ? `${selected} The title caught my eye: ${title}.` : selected;
}

function cleanTitle(value: string) {
  return value
    .replace(/\s*[-|–]\s*on Scratch\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70);
}

async function humanType(element: FillableElement, value: string) {
  element.focus();
  if (element instanceof HTMLSelectElement) {
    const option = Array.from(element.options).find((item) => item.text.toLowerCase().includes(value.toLowerCase()));
    if (option) element.value = option.value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    setNativeControlValue(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(randomBetween(80, 180));
    return;
  }
  if (isRichTextEditable(element)) {
    await fillRichTextEditor(element, value);
  }
}

function setNativeControlValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) {
    setter.call(element, value);
  } else {
    element.value = value;
  }
}

function isRichTextEditable(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && (
    element.isContentEditable ||
    element.matches(".fr-element, .fr-view, .ProseMirror, .ql-editor, [role='textbox']")
  );
}

async function fillRichTextEditor(element: HTMLElement, value: string) {
  element.focus();
  clearRichTextEditor(element);
  await wait(randomBetween(120, 260));

  const normalized = value.replace(/\r\n?/g, "\n");
  const richHtml = richTextHtmlFromValue(normalized);
  const inserted = richHtml
    ? insertHtmlWithEditorApis(element, richHtml)
    : insertTextWithEditorApis(element, normalized);
  if (!inserted) {
    if (richHtml) {
      writeHtmlToEditable(element, richHtml);
    } else {
      writePlainTextToEditable(element, normalized);
    }
  }

  dispatchEditorEvents(element);
  await wait(randomBetween(180, 360));
}

function clearRichTextEditor(element: HTMLElement) {
  const selection = element.ownerDocument.getSelection();
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);
  if (!element.ownerDocument.execCommand?.("delete")) {
    element.textContent = "";
  }
  selection?.removeAllRanges();
}

function insertTextWithEditorApis(element: HTMLElement, value: string) {
  const doc = element.ownerDocument;
  element.focus();
  try {
    if (doc.execCommand?.("insertText", false, value)) return true;
  } catch {
    // Some editors disable execCommand; fall back to direct DOM updates below.
  }
  return false;
}

function insertHtmlWithEditorApis(element: HTMLElement, html: string) {
  const doc = element.ownerDocument;
  element.focus();
  try {
    if (doc.execCommand?.("insertHTML", false, html)) return true;
  } catch {
    // Some editors disable execCommand; fall back to direct DOM updates below.
  }
  return false;
}

function richTextHtmlFromValue(value: string) {
  if (!/(<a\b|\[url=)/i.test(value)) return "";
  const paragraphs = value.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const html = paragraphs.map((part) => `<p>${renderInlineRichText(part).replace(/\n/g, "<br>")}</p>`).join("");
  return /<a\b/i.test(html) ? html : "";
}

function renderInlineRichText(value: string) {
  const linkPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>|\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi;
  let html = "";
  let lastIndex = 0;
  for (const match of value.matchAll(linkPattern)) {
    html += escapeHtml(value.slice(lastIndex, match.index));
    const rawHref = match[1] || match[3] || "";
    const rawAnchor = match[2] || match[4] || "";
    const href = normalizeUrl(rawHref.replace(/\s+/g, ""));
    const anchor = compactText(stripMarkup(rawAnchor));
    if (/^https?:\/\//i.test(href) && anchor) {
      html += `<a href="${escapeAttribute(href)}" target="_blank" rel="external nofollow noopener">${escapeHtml(anchor)}</a>`;
    } else {
      html += escapeHtml(match[0]);
    }
    lastIndex = (match.index ?? 0) + match[0].length;
  }
  html += escapeHtml(value.slice(lastIndex));
  return html;
}

function stripMarkup(value: string) {
  return value.replace(/<[^>]+>/g, "").replace(/\[\/?url[^\]]*\]/gi, "");
}

function writeHtmlToEditable(element: HTMLElement, html: string) {
  element.innerHTML = html;
}

function writePlainTextToEditable(element: HTMLElement, value: string) {
  const paragraphs = value.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length > 1 && element.matches(".fr-element, .fr-view, .ProseMirror, .ql-editor")) {
    element.innerHTML = paragraphs.map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br>")}</p>`).join("");
  } else {
    element.textContent = value;
  }
}

function dispatchEditorEvents(element: HTMLElement) {
  element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: " " }));
  element.closest("form")?.dispatchEvent(new Event("input", { bubbles: true }));
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function isHidden(element: Element | null | undefined) {
  if (!element || !(element instanceof Element)) return true;
  const style = getComputedStyle(element);
  const htmlElement = element instanceof HTMLElement ? element : null;
  return style.display === "none" || style.visibility === "hidden" || htmlElement?.offsetParent === null;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function scrapeVisibleLinks() {
  return Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map((link) => {
    const rowText = compactText(link.closest("tr, [role='row'], li, article, .ReactVirtualized__Table__row, [class*='row']")?.textContent);
    return {
      url: link.href,
      text: compactText(link.innerText || link.textContent || link.getAttribute("aria-label")),
      rel: link.rel,
      rowText,
      dr: metricNearLabel(rowText, ["dr", "domain rating", "authority score", "as"]),
      traffic: metricNearLabel(rowText, ["traffic", "organic traffic", "visits"]),
      targetUrl: urlNearLabel(rowText, ["target", "linked page", "landing page"])
    };
  });
}

function metricNearLabel(rowText: string, labels: string[]) {
  const lower = rowText.toLowerCase();
  for (const label of labels) {
    const pattern = new RegExp(`${label.replace(/\s+/g, "\\s+")}\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?\\s*[kmb]?)`, "i");
    const match = lower.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

function urlNearLabel(rowText: string, labels: string[]) {
  const urls = rowText.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  if (!urls.length) return "";
  const lower = rowText.toLowerCase();
  for (const label of labels) {
    const index = lower.indexOf(label);
    if (index >= 0) {
      const after = rowText.slice(index);
      const match = after.match(/https?:\/\/[^\s"'<>]+/i);
      if (match?.[0]) return match[0];
    }
  }
  return urls[1] ?? "";
}
