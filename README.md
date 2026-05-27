# Backlink Forge

Backlink Forge is a Manifest V3 Chrome extension for managing backlink building workflows. It helps collect backlink opportunities, classify pages, screen candidate resources, draft short comments or profile text with a user-provided AI API key, and keep local records in sync with Google Sheets.

The extension is designed as a semi-automated assistant: it can analyze pages and fill recognizable fields, but the final submission should stay under human control.

## Features

- Collect backlink sources from Ahrefs/Semrush pages, CSV/XLSX imports, and the current browser page.
- Classify opportunities into product submissions, UGC/profile/comment pages, developer content, media outreach, and other review queues.
- Maintain projects, sources, pages, submissions, imports, check logs, and discovery targets in local IndexedDB.
- Screen pages for login, captcha, Cloudflare, page availability, forms, rel attributes, and practical execution status.
- Generate concise draft comments through OpenAI-compatible providers, DeepSeek, OpenRouter, or Gemini using BYOK settings stored locally.
- Sync the local resource pool to Google Sheets for backup and review.

## Install For Development

Requirements:

- Node.js 20 or newer
- npm
- Chrome or a Chromium-based browser

```bash
npm install
npm run build
```

Then load the extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select the generated `dist` directory.

For popup UI development:

```bash
npm run dev
```

Vite serves the popup UI for development, but extension APIs still require loading a built extension in Chrome for full workflow testing.

## Configuration

All runtime settings are entered in the extension UI and stored locally in the browser extension storage or IndexedDB.

- AI API keys are BYOK and are not uploaded to a project-owned backend.
- Google Sheets sync requires a Google OAuth client ID and a target spreadsheet ID.
- Project data, resource pools, and submission records are local unless you explicitly sync them.

## Browser Permissions

The extension currently requests broad permissions because its workflow needs to inspect arbitrary backlink target pages and optionally interact with forms:

- `<all_urls>` host access for page analysis and field detection.
- `activeTab`, `tabs`, and `scripting` for current-tab workflows.
- `storage` for local state.
- `webRequest` for SEO tool request observation.
- `sidePanel` for the extension workspace.
- `identity` for Google OAuth.
- `alarms` for scheduled Google Sheets sync.

Before publishing to the Chrome Web Store, consider narrowing host permissions if your use case allows it.

## Repository Layout

```text
src/
  background.ts              Extension service worker and workflow orchestration
  content.ts                 Page analysis and form interaction content script
  seoBridge.ts               SEO tool page bridge
  popup/                     React popup/side-panel UI
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

Before making the repository public:

- Remove captured requests, cookies, exported private spreadsheets, and local account data.
- Keep local research exports such as `doc_webcafe/` out of git.
- Run `npm run build`.
- Run a final secret scan, for example `rg -n "(cookie|authorization|bearer|secret|token|api[_-]?key|password)"`.
- Decide whether `public/manifest.json` permissions should be narrowed.

## License

MIT
