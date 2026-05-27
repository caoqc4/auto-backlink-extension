# Backlink Forge / Auto Backlink Extension

English | [中文](README.zh-CN.md)

> A Manifest V3 Chrome extension for backlink discovery, classification, screening, semi-automated execution, and workflow tracking.

Backlink Forge is a workflow-oriented Chrome extension for independent developers, SEO operators, and small teams. It is not a black-box "auto comment spammer". Instead, it turns backlink building into a semi-automated, reviewable process:

```text
Project profile -> Discovery -> Resource pool -> Screening -> Assisted execution -> Tracking -> Sync
```

The extension can analyze pages, detect forms, draft content, and help fill recognizable fields, while keeping the final submission under human control.

## Functional Blocks

### 1. Project Profiles

Maintain reusable project data for form filling and draft generation.

- Project name, brand name, and site URL
- Short description, long description, category, and language
- Target keywords and anchor texts
- Contact email, author name, logo URL, and social links

### 2. Backlink Discovery And Import

Collect potential backlink opportunities from multiple sources and normalize them into a local resource pool.

- Observe or import backlink data from Ahrefs / Semrush pages
- Import CSV, JSON, and XLSX files
- Extract outbound links, submission pages, comment pages, and candidate domains from the current page
- Track source URL, root domain, competitor source, occurrence count, and related metadata

### 3. Resource Pool And Classification

Organize collected opportunities and classify them with local rules.

- Product or project submission pages
- UGC, blog comments, profiles, and community pages
- Developer content platforms
- Media outreach or exposure opportunities
- Unknown resources that need manual review

Each resource keeps status, priority, failure reason, notes, candidate pages, and screening results.

### 4. Page Screening

The content script inspects target pages and detects execution signals.

- Login, registration, and payment requirements
- Captcha, Cloudflare, browser error, and unavailable pages
- Submission forms, comment forms, and profile fields
- Redirects, closed pages, and inaccessible pages
- Existing target links and link `rel` attributes

### 5. Assisted Execution

The execution panel helps process tasks by project and resource priority.

- Exclude already processed root domains per project
- Choose execution strategy by detected page type
- Handle product submissions, blog comments, forum replies, profiles, and similar surfaces
- Generate concise, low-key, page-relevant drafts
- Fill recognizable fields while leaving final submission to the user

### 6. AI Draft Generation

AI is used only for drafting comments, profile text, or submission copy.

- Supports OpenAI-compatible APIs, OpenRouter, DeepSeek, and Gemini
- BYOK by design; API keys are stored locally in the extension data
- Prompts favor short, natural, specific writing and avoid promotional or SEO-heavy language

### 7. Submission Tracking

Track execution state and backlink verification results over time.

- Candidate, opened, analyzed, filled, waiting for manual submission
- Submitted, pending review, live, failed, skipped
- dofollow, nofollow, ugc, sponsored, mixed, and unknown rel states
- Check logs, failure reasons, notes, and next check time

### 8. Google Sheets Sync

Local IndexedDB data can be synced to the user's own Google Sheets for backup, review, and cross-device workflows.

- Projects
- Sources
- Pages
- Submissions
- Imports
- Check logs
- Discovery targets

Data is synced only after the user configures and triggers Google Sheets sync.

## Google Sheets Restore Setup

Use this when you want to restore an existing synced spreadsheet into a fresh extension install.

### 1. Enable Google Sheets API

In Google Cloud Console, open your project and enable:

```text
Google Sheets API
```

### 2. Create Or Reuse An OAuth Client

Go to:

```text
Google Cloud Console -> API & Services -> Credentials -> OAuth 2.0 Client IDs
```

Create or reuse a **Web application** OAuth client.

Add the extension redirect URLs for your current unpacked extension ID:

```text
Authorized JavaScript origins:
https://<extension-id>.chromiumapp.org

Authorized redirect URIs:
https://<extension-id>.chromiumapp.org/
```

You can find the extension ID on `chrome://extensions`.

Example:

```text
https://lljkhioocjljemhdjcdfnfglgkhlppkg.chromiumapp.org
https://lljkhioocjljemhdjcdfnfglgkhlppkg.chromiumapp.org/
```

Save the OAuth client and copy its client ID:

```text
xxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com
```

### 3. Restore From The Spreadsheet

In the extension settings:

1. Paste the Google Sheets spreadsheet ID or full spreadsheet URL.
2. Paste the Google OAuth Client ID.
3. Click **Restore from Google Sheets**.

Do not click **Sync to Google Sheets** before restoring if the local extension data is empty, because that can overwrite the spreadsheet with empty local data.

## Privacy And Security

- Data is stored locally in the browser extension environment by default.
- AI API keys use a BYOK model and are not sent to a project-owned backend.
- Google OAuth tokens are used only for user-authorized spreadsheet sync.
- Do not commit browser cookies, captured authenticated requests, private spreadsheets, account data, or API keys.

## Development Setup

Requirements:

- Node.js 20 or newer
- npm
- Chrome or a Chromium-based browser

```bash
npm install
npm run build
```

Load the extension:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click "Load unpacked"
4. Select the generated `dist` directory

For popup UI development:

```bash
npm run dev
```

Vite is useful for frontend development, but full extension workflows require loading the built `dist` directory in Chrome.

## Browser Permissions

The extension currently requests broad permissions because it needs to inspect arbitrary backlink target pages and assist with form filling.

- `<all_urls>` for page analysis and form detection
- `activeTab`, `tabs`, and `scripting` for current-tab workflows and script injection
- `storage` for local state
- `webRequest` for observing SEO tool page requests
- `sidePanel` for the extension workspace
- `identity` for Google OAuth
- `alarms` for scheduled sync

Consider narrowing host permissions before publishing to the Chrome Web Store if your use case allows it.

## Repository Layout

```text
src/
  background.ts              Extension service worker and workflow orchestration
  content.ts                 Page analysis, form detection, and assisted filling
  seoBridge.ts               SEO tool page bridge
  popup/                     React popup / side-panel UI
  shared/                    IndexedDB, CSV, Google Sheets, URL, and classifier helpers
public/manifest.json         Production extension manifest copied into dist
docs/                        Product and design notes
```

## Scripts

```bash
npm run dev       # Start Vite dev server
npm run build     # Type-check and build extension into dist
npm run preview   # Preview the Vite app
```

## Open Source Hygiene

- Do not commit cookies, tokens, API keys, private spreadsheets, or account data
- Keep local research exports such as `doc_webcafe/` out of git
- Run `npm run build`
- Run a final secret scan:

```bash
rg -n "(cookie|authorization|bearer|secret|token|api[_-]?key|password)" -S . -g '!*node_modules*' -g '!package-lock.json'
```

## License

MIT
