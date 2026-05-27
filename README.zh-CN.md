# Backlink Forge / Auto Backlink Extension

[English](README.md) | 中文

> 一个用于外链资源发现、分类、预检测、半自动执行和记录同步的 Manifest V3 Chrome 扩展。

Backlink Forge 是一个面向独立开发者、SEO 站长和小团队的外链建设工作流工具。它不是“全自动发评论”的黑盒脚本，而是把外链建设拆成可记录、可筛选、可复盘的半自动流程：

```text
项目资料 -> 资源发现 -> 资源池分类 -> 页面预检测 -> 半自动执行 -> 结果记录 -> 表格同步
```

扩展可以分析页面、识别表单、生成草稿、辅助填写字段，但最终提交动作建议由人确认。

## 功能模块

### 1. 项目资料管理

为每个推广项目维护一份基础资料，用于后续自动填写和内容生成。

- 项目名称、品牌名、站点 URL
- 简短介绍、长介绍、分类、语言
- 目标关键词和锚文本
- 联系邮箱、作者名、Logo、社交链接

### 2. 外链资源发现与导入

支持从多个入口收集潜在外链资源，并统一写入本地资源池。

- 从 Ahrefs / Semrush 页面观察或导入外链数据
- 导入 CSV、JSON、XLSX 表格
- 从当前网页提取外链、提交入口、评论页和候选域名
- 记录来源域名、目标页面、竞品来源、出现次数等信息

### 3. 资源池与分类

扩展会把收集到的资源组织成可筛选的资源池，并根据规则进行初步分类。

- 产品/项目提交类
- UGC、博客评论、Profile、社区页面
- 开发者内容平台
- 媒体投稿或曝光机会
- 需要人工复核的未知资源

每个资源会维护状态、优先级、失败原因、历史记录、页面候选和检测结果。

### 4. 页面预检测

内容脚本会在目标页面中识别可执行信号，帮助判断这个资源是否值得继续处理。

- 是否需要登录、注册、付费
- 是否有验证码、Cloudflare 或浏览器错误页
- 是否存在提交表单、评论表单、Profile 字段
- 页面是否不可访问、跳转或已关闭
- 是否已有目标站链接，以及链接 rel 类型

### 5. 半自动执行助手

执行面板会按项目和资源优先级推进任务，辅助打开候选页面并填写可识别字段。

- 按项目排除已处理域名
- 根据页面类型选择执行策略
- 识别产品提交、博客评论、论坛回复、Profile 等场景
- 生成简短、低调、相关的评论或简介草稿
- 模拟填写字段，但保留人工最终提交

### 6. AI 草稿生成

AI 只用于生成评论、简介或提交文案草稿，不负责最终决策。

- 支持 OpenAI-compatible API、OpenRouter、DeepSeek、Gemini
- 使用 BYOK 模式，API Key 保存在本地扩展数据中
- 默认要求内容简短、自然、具体，避免广告腔和 SEO 痕迹

### 7. 提交记录与结果追踪

扩展会记录每次执行和检测结果，方便后续复盘。

- 候选、已打开、已分析、已填写、等待人工提交
- 已提交、待审核、上线、失败、跳过
- dofollow、nofollow、ugc、sponsored 等 rel 状态
- 检测日志、失败原因、备注和下一次检查时间

### 8. Google Sheets 同步

本地 IndexedDB 数据可以同步到用户自己的 Google Sheets，方便备份、审阅和跨设备处理。

- 项目表
- 资源表
- 页面表
- 提交记录表
- 导入记录表
- 检测日志表
- 发现队列表

数据只在用户主动配置并触发同步后写入指定表格。

## Google Sheets 恢复配置

当你想把已经同步过的 Google Sheets 数据恢复到一个新的扩展安装时，按下面流程操作。

### 1. 启用 Google Sheets API

在 Google Cloud Console 里打开你的项目，并启用：

```text
Google Sheets API
```

### 2. 创建或复用 OAuth Client

进入：

```text
Google Cloud Console -> API 和服务 -> 凭据 -> OAuth 2.0 客户端 ID
```

创建或复用一个 **Web 应用** 类型的 OAuth 客户端。

给当前加载的扩展 ID 添加授权地址：

```text
已获授权的 JavaScript 来源:
https://<extension-id>.chromiumapp.org

已获授权的重定向 URI:
https://<extension-id>.chromiumapp.org/
```

扩展 ID 可以在 `chrome://extensions` 页面查看。

示例：

```text
https://lljkhioocjljemhdjcdfnfglgkhlppkg.chromiumapp.org
https://lljkhioocjljemhdjcdfnfglgkhlppkg.chromiumapp.org/
```

保存后复制客户端 ID：

```text
xxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com
```

### 3. 从表格恢复

在扩展设置页：

1. 填入 Google Sheets 表格 ID 或完整表格 URL。
2. 填入 Google OAuth Client ID。
3. 点击 **从 Google Sheets 恢复**。

如果当前扩展本地数据是空的，恢复前不要点击 **同步到 Google Sheets**，否则可能用空本地数据覆盖表格。

## 隐私与安全

- 默认数据存储在浏览器扩展本地环境中。
- AI API Key 使用 BYOK 模式，不上传到项目维护者的服务器。
- Google OAuth token 用于用户授权的表格同步。
- 不要把浏览器 cookie、抓包文件、私有表格、账号信息或 API Key 提交到仓库。

## 开发安装

要求：

- Node.js 20 或更高版本
- npm
- Chrome 或 Chromium 系浏览器

```bash
npm install
npm run build
```

开发弹窗 UI：

```bash
npm run dev
```

Vite 只能用于调试前端界面。完整扩展能力依赖 Chrome extension API，具体加载方式见下面的 **本地使用**。

## 本地使用

### 安装本地构建版本

```bash
npm install
npm run build
```

然后在 Chrome 中加载扩展：

1. 打开 `chrome://extensions`
2. 开启 **开发者模式**
3. 点击 **加载未打包的扩展程序**
4. 选择生成的 `dist` 目录

加载后，可以从 Chrome 扩展工具栏打开弹窗或侧边栏。

### 更新本地构建版本

修改代码后执行：

```bash
npm run build
```

然后回到 `chrome://extensions`，点击 Backlink Forge 扩展卡片上的刷新按钮。

### 打包 Zip

生成生产构建并打包成 zip：

```bash
npm run package
```

会生成：

```text
auto-backlink-extension.zip
```

这个 zip 包包含 `dist/` 里的内容，可用于手动分享、审核或准备上传 Chrome Web Store。本地开发时优先使用 `dist` 目录通过 **加载未打包的扩展程序** 运行。

### 本地数据说明

Chrome 按扩展 ID 存储扩展数据，而不是按项目文件夹存储。如果你在 `chrome://extensions` 里移除扩展，Chrome 可能会删除这个扩展 ID 对应的 IndexedDB 和 `chrome.storage` 数据。

推荐流程：

- 移除或重新安装扩展前，先同步到 Google Sheets。
- 加载新构建后，用 **从 Google Sheets 恢复** 把数据恢复回来。
- 如果本地数据为空，不要先点 **同步到 Google Sheets**，除非你明确想用空本地数据覆盖表格。

## 浏览器权限说明

扩展当前需要较宽的浏览器权限，因为它需要分析任意外链目标页面并辅助填写表单。

- `<all_urls>`：分析目标页面和检测表单
- `activeTab`、`tabs`、`scripting`：当前标签页工作流和脚本注入
- `storage`：保存本地设置和状态
- `webRequest`：观察 SEO 工具页面请求
- `sidePanel`：侧边栏工作台
- `identity`：Google OAuth
- `alarms`：定时同步

发布到 Chrome Web Store 前，可以根据实际使用范围进一步收窄 host permissions。

## 项目结构

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

## 常用脚本

```bash
npm run dev       # 启动 Vite 开发服务器
npm run build     # 类型检查并构建扩展
npm run package   # 构建并生成 auto-backlink-extension.zip
npm run preview   # 预览 Vite 应用
```

## 常见问题

- **扩展能打开，但数据为空**：本地数据可能属于旧扩展 ID，或者旧扩展被移除时数据被 Chrome 删除了。如果之前同步过，请从 Google Sheets 恢复。
- **Google OAuth 报 redirect_uri mismatch**：在 OAuth Client 中添加 `https://<extension-id>.chromiumapp.org/` 到授权重定向 URI，保存后等待几分钟再试。
- **Vite 开发页面和真实扩展表现不一样**：这是正常的。完整功能依赖 Chrome extension API，需要加载 `dist` 目录测试。
- **构建后看不到新改动**：回到 `chrome://extensions`，点击扩展卡片上的刷新按钮。

## 开源前检查

- 确认没有提交 cookie、token、API Key、私有表格或账号信息
- 保持本地研究导出目录，例如 `doc_webcafe/`，不进入 git
- 运行 `npm run build`
- 运行敏感信息扫描：

```bash
rg -n "(cookie|authorization|bearer|secret|token|api[_-]?key|password)" -S . -g '!*node_modules*' -g '!package-lock.json'
```

## License

MIT
