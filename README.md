# Backlink Forge / Auto Backlink Extension

> 一个用于外链资源发现、分类、预检测、半自动执行和记录同步的 Manifest V3 Chrome 扩展。
>
> A Manifest V3 Chrome extension for backlink discovery, classification, screening, semi-automated execution, and workflow tracking.

## 中文说明

Backlink Forge 是一个面向独立开发者、SEO 站长和小团队的外链建设工作流工具。它不是“全自动发评论”的黑盒脚本，而是把外链建设拆成可记录、可筛选、可复盘的半自动流程：

```text
项目资料 -> 资源发现 -> 资源池分类 -> 页面预检测 -> 半自动执行 -> 结果记录 -> 表格同步
```

扩展可以分析页面、识别表单、生成草稿、辅助填写字段，但最终提交动作建议由人确认。

### 功能模块

#### 1. 项目资料管理

为每个推广项目维护一份基础资料，用于后续自动填写和内容生成。

- 项目名称、品牌名、站点 URL
- 简短介绍、长介绍、分类、语言
- 目标关键词和锚文本
- 联系邮箱、作者名、Logo、社交链接

#### 2. 外链资源发现与导入

支持从多个入口收集潜在外链资源，并统一写入本地资源池。

- 从 Ahrefs / Semrush 页面观察或导入外链数据
- 导入 CSV、JSON、XLSX 表格
- 从当前网页提取外链、提交入口、评论页和候选域名
- 记录来源域名、目标页面、竞品来源、出现次数等信息

#### 3. 资源池与分类

扩展会把收集到的资源组织成可筛选的资源池，并根据规则进行初步分类。

- 产品/项目提交类
- UGC、博客评论、Profile、社区页面
- 开发者内容平台
- 媒体投稿或曝光机会
- 需要人工复核的未知资源

每个资源会维护状态、优先级、失败原因、历史记录、页面候选和检测结果。

#### 4. 页面预检测

内容脚本会在目标页面中识别可执行信号，帮助判断这个资源是否值得继续处理。

- 是否需要登录、注册、付费
- 是否有验证码、Cloudflare 或浏览器错误页
- 是否存在提交表单、评论表单、Profile 字段
- 页面是否不可访问、跳转或已关闭
- 是否已有目标站链接，以及链接 rel 类型

#### 5. 半自动执行助手

执行面板会按项目和资源优先级推进任务，辅助打开候选页面并填写可识别字段。

- 按项目排除已处理域名
- 根据页面类型选择执行策略
- 识别产品提交、博客评论、论坛回复、Profile 等场景
- 生成简短、低调、相关的评论或简介草稿
- 模拟填写字段，但保留人工最终提交

#### 6. AI 草稿生成

AI 只用于生成评论、简介或提交文案草稿，不负责最终决策。

- 支持 OpenAI-compatible API、OpenRouter、DeepSeek、Gemini
- 使用 BYOK 模式，API Key 保存在本地扩展数据中
- 默认要求内容简短、自然、具体，避免广告腔和 SEO 痕迹

#### 7. 提交记录与结果追踪

扩展会记录每次执行和检测结果，方便后续复盘。

- 候选、已打开、已分析、已填写、等待人工提交
- 已提交、待审核、上线、失败、跳过
- dofollow、nofollow、ugc、sponsored 等 rel 状态
- 检测日志、失败原因、备注和下一次检查时间

#### 8. Google Sheets 同步

本地 IndexedDB 数据可以同步到用户自己的 Google Sheets，方便备份、审阅和跨设备处理。

- 项目表
- 资源表
- 页面表
- 提交记录表
- 导入记录表
- 检测日志表
- 发现队列表

数据只在用户主动配置并触发同步后写入指定表格。

### 隐私与安全

- 默认数据存储在浏览器扩展本地环境中。
- AI API Key 使用 BYOK 模式，不上传到项目维护者的服务器。
- Google OAuth token 用于用户授权的表格同步。
- 不要把浏览器 cookie、抓包文件、私有表格、账号信息或 API Key 提交到仓库。

### 开发安装

要求：

- Node.js 20 或更高版本
- npm
- Chrome 或 Chromium 系浏览器

```bash
npm install
npm run build
```

加载扩展：

1. 打开 `chrome://extensions`
2. 开启 Developer mode
3. 点击 "Load unpacked"
4. 选择生成的 `dist` 目录

开发弹窗 UI：

```bash
npm run dev
```

Vite 只能用于调试前端界面。完整扩展能力仍需要在 Chrome 中加载构建后的 `dist` 目录。

### 浏览器权限说明

扩展当前需要较宽的浏览器权限，因为它需要分析任意外链目标页面并辅助填写表单。

- `<all_urls>`：分析目标页面和检测表单
- `activeTab`、`tabs`、`scripting`：当前标签页工作流和脚本注入
- `storage`：保存本地设置和状态
- `webRequest`：观察 SEO 工具页面请求
- `sidePanel`：侧边栏工作台
- `identity`：Google OAuth
- `alarms`：定时同步

发布到 Chrome Web Store 前，可以根据实际使用范围进一步收窄 host permissions。

### 项目结构

```text
src/
  background.ts              扩展 Service Worker 和工作流调度
  content.ts                 页面分析、表单识别和辅助填写脚本
  seoBridge.ts               SEO 工具页面桥接脚本
  popup/                     React 弹窗/侧边栏 UI
  shared/                    IndexedDB、CSV、Google Sheets、URL、分类等共享逻辑
public/manifest.json         构建时复制到 dist 的扩展 manifest
docs/                        产品设计和补充文档
```

### 常用脚本

```bash
npm run dev       # 启动 Vite 开发服务器
npm run build     # 类型检查并构建扩展
npm run preview   # 预览 Vite 应用
```

### 开源前检查

- 确认没有提交 cookie、token、API Key、私有表格或账号信息
- 保持本地研究导出目录，例如 `doc_webcafe/`，不进入 git
- 运行 `npm run build`
- 运行敏感信息扫描：

```bash
rg -n "(cookie|authorization|bearer|secret|token|api[_-]?key|password)" -S . -g '!*node_modules*' -g '!package-lock.json'
```

## English

Backlink Forge is a workflow-oriented Chrome extension for independent developers, SEO operators, and small teams. It is not a black-box "auto comment spammer". Instead, it turns backlink building into a semi-automated, reviewable process:

```text
Project profile -> Discovery -> Resource pool -> Screening -> Assisted execution -> Tracking -> Sync
```

The extension can analyze pages, detect forms, draft content, and help fill recognizable fields, while keeping the final submission under human control.

### Functional Blocks

#### 1. Project Profiles

Maintain reusable project data for form filling and draft generation.

- Project name, brand name, and site URL
- Short description, long description, category, and language
- Target keywords and anchor texts
- Contact email, author name, logo URL, and social links

#### 2. Backlink Discovery And Import

Collect potential backlink opportunities from multiple sources and normalize them into a local resource pool.

- Observe or import backlink data from Ahrefs / Semrush pages
- Import CSV, JSON, and XLSX files
- Extract outbound links, submission pages, comment pages, and candidate domains from the current page
- Track source URL, root domain, competitor source, occurrence count, and related metadata

#### 3. Resource Pool And Classification

Organize collected opportunities and classify them with local rules.

- Product or project submission pages
- UGC, blog comments, profiles, and community pages
- Developer content platforms
- Media outreach or exposure opportunities
- Unknown resources that need manual review

Each resource keeps status, priority, failure reason, notes, candidate pages, and screening results.

#### 4. Page Screening

The content script inspects target pages and detects execution signals.

- Login, registration, and payment requirements
- Captcha, Cloudflare, browser error, and unavailable pages
- Submission forms, comment forms, and profile fields
- Redirects, closed pages, and inaccessible pages
- Existing target links and link `rel` attributes

#### 5. Assisted Execution

The execution panel helps process tasks by project and resource priority.

- Exclude already processed root domains per project
- Choose execution strategy by detected page type
- Handle product submissions, blog comments, forum replies, profiles, and similar surfaces
- Generate concise, low-key, page-relevant drafts
- Fill recognizable fields while leaving final submission to the user

#### 6. AI Draft Generation

AI is used only for drafting comments, profile text, or submission copy.

- Supports OpenAI-compatible APIs, OpenRouter, DeepSeek, and Gemini
- BYOK by design; API keys are stored locally in the extension data
- Prompts favor short, natural, specific writing and avoid promotional or SEO-heavy language

#### 7. Submission Tracking

Track execution state and backlink verification results over time.

- Candidate, opened, analyzed, filled, waiting for manual submission
- Submitted, pending review, live, failed, skipped
- dofollow, nofollow, ugc, sponsored, mixed, and unknown rel states
- Check logs, failure reasons, notes, and next check time

#### 8. Google Sheets Sync

Local IndexedDB data can be synced to the user's own Google Sheets for backup, review, and cross-device workflows.

- Projects
- Sources
- Pages
- Submissions
- Imports
- Check logs
- Discovery targets

Data is synced only after the user configures and triggers Google Sheets sync.

### Privacy And Security

- Data is stored locally in the browser extension environment by default.
- AI API keys use a BYOK model and are not sent to a project-owned backend.
- Google OAuth tokens are used only for user-authorized spreadsheet sync.
- Do not commit browser cookies, captured authenticated requests, private spreadsheets, account data, or API keys.

### Development Setup

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

### Browser Permissions

The extension currently requests broad permissions because it needs to inspect arbitrary backlink target pages and assist with form filling.

- `<all_urls>` for page analysis and form detection
- `activeTab`, `tabs`, and `scripting` for current-tab workflows and script injection
- `storage` for local state
- `webRequest` for observing SEO tool page requests
- `sidePanel` for the extension workspace
- `identity` for Google OAuth
- `alarms` for scheduled sync

Consider narrowing host permissions before publishing to the Chrome Web Store if your use case allows it.

### Repository Layout

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

### Scripts

```bash
npm run dev       # Start Vite dev server
npm run build     # Type-check and build extension into dist
npm run preview   # Preview the Vite app
```

### Open Source Hygiene

- Do not commit cookies, tokens, API keys, private spreadsheets, or account data
- Keep local research exports such as `doc_webcafe/` out of git
- Run `npm run build`
- Run a final secret scan:

```bash
rg -n "(cookie|authorization|bearer|secret|token|api[_-]?key|password)" -S . -g '!*node_modules*' -g '!package-lock.json'
```

## License

MIT
