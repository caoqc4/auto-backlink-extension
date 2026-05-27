# 外链建设浏览器插件产品功能设计

日期：2026-04-26

## 1. 产品定位

这个产品不是单纯的“自动发评论插件”，而是一个外链建设工作流工具：

> 外链资源收集 -> 清洗分类 -> 资源池分级 -> 半自动发布 -> 发布后检测 -> 状态同步

插件承担两类角色：

1. **外链资源收集器**：从竞品域名、Ahrefs 页面、CSV 导入、当前网页中收集外链资源。
2. **浏览器执行器**：在目标外链页面中识别页面类型、生成内容、模拟真人填表，并把最终提交动作交给人确认。

第一版目标是服务独立开发者和 SEO 站长，让外链建设从散乱手工操作变成可记录、可复盘、可迭代的流程。

## 2. 本轮补充点评估

### 2.1 输入域名自动抓外链

结论：**合理，可以进入第一版，但建议做成“半自动抓取”。**

实现方式：

- 用户输入竞品域名。
- 插件打开 Ahrefs 免费 backlink checker 页面。
- 自动填入域名并触发查询。
- 插件拦截或读取返回结果，保存到资源池。

注意点：

- Ahrefs 可能有人机验证，第一版不强行绕过。
- 如果遇到 Cloudflare 或验证码，插件暂停并提示人工处理。
- 第一版只需要抓免费工具可返回的 Top backlinks，不追求全量。

### 2.2 Ahrefs 请求拦截

结论：**可以第一版就上，技术难度可控。**

推荐方案：

- Chrome Extension 使用 `chrome.webRequest` 或 DevTools panel 监听 Ahrefs 请求。
- 识别 `ahrefs.com/v4/` 下的 backlink API 响应。
- 解析 JSON 中的 backlink 数据。
- 写入本地 IndexedDB，并可同步到 Google Sheets / 飞书。

备选方案：

- 插件不直接拦截，先让用户导入 mitmproxy 保存的 JSON/CSV。
- 这适合作为 fallback，不作为主路径。

风险：

- Ahrefs 接口结构可能变化。
- 浏览器扩展对响应 body 的读取有 Manifest V3 限制，必要时可通过页面注入脚本或 DevTools 扩展实现。

### 2.3 AI 分类评分要做小

结论：**非常合理。第一版应以规则和表结构自动分级为主，AI 只做兜底。**

第一版不做复杂 AI 评分，而是用字段自动计算：

- 外链类型
- 出现次数
- DR
- 流量
- 是否 dofollow
- 是否需要注册
- 是否需要登录
- 是否需要付费
- 是否有提交表单
- 是否已有成功记录
- 是否被多个竞品验证

AI 只在以下场景使用：

- 页面类型无法通过规则判断。
- 需要根据页面内容生成评论/产品描述。
- 需要判断页面相关性。

### 2.4 三类外链需要分类好

结论：**合理。产品底层保留 5 大类，但第一版执行层聚焦 3 类。**

第一版重点支持这 3 类：

1. **产品/项目提交类**
   例如 AI 导航站、工具目录、游戏目录、SaaS 目录、产品发布平台。

2. **UGC/社区/Profile/博客评论类**
   例如 WordPress 评论、论坛 Profile、社区个人主页、昵称/Website 字段。

3. **内容托管/开发者生态类**
   例如 dev.to、Medium、Hashnode、Velog、GitHub、npm、Rentry、Telegra.ph。

另外 2 类先作为线索和任务记录：

4. **媒体/内容曝光类**
   HARO、记者问答、媒体投稿、Guest Post、赞助文章。

5. **机会型/杠杆型策略**
   好评换链接、图片追链、Best list 收录、死链替代、过期域名、死链复活、Ego bait。

### 2.5 半自动发布

结论：**必须这样做，第一版不建议全自动提交。**

执行规则：

- AI 必须在一条外链任务内把所有可识别字段填完。
- 填写过程要模拟真人行为，不能瞬间写入。
- 最终提交按钮由人点击。
- 未来可为低风险站点开启自动提交，但第一版不默认开启。

模拟真人行为要求：

- 分字段填写。
- 每个字段随机延迟。
- 文本逐字符输入，而不是直接 `value = xxx`。
- 填写完成后停顿 1-3 秒。
- 遇到验证码、登录、Cloudflare、邮箱验证时暂停。

## 3. 第一版功能范围

### 3.1 项目资料库

用户可以维护多个推广项目。

字段建议：

```text
project_id
project_name
site_url
brand_name
short_description
long_description
target_keywords
anchor_texts
category
language
contact_email
author_name
logo_url
social_links
created_at
updated_at
```

用途：

- 自动填产品提交表单。
- 生成博客评论。
- 生成 Profile bio。
- 生成开发者平台文章。
- 检测目标页面是否已出现当前项目域名。

### 3.2 外链资源收集

支持 4 种收集入口：

1. **输入竞品域名抓取 Ahrefs 外链**
   插件打开 Ahrefs 免费工具并抓取返回数据。

2. **Ahrefs 请求拦截**
   用户手动查域名时，插件自动保存返回 JSON。

3. **CSV/JSON 导入**
   支持 Ahrefs、Semrush、手工整理表格、mitmproxy JSON。

4. **当前页面提取**
   从当前网页提取外链、评论区网站、目录列表中的提交入口。

### 3.3 外链资源池

资源池保存所有候选外链资源。

核心字段：

```text
source_id
source_domain
source_url
root_domain
discovered_from
competitor_domain
source_type
source_type_confidence
dr
traffic
first_seen_at
last_seen_at
occurrence_count
competitor_count
requires_login
requires_register
requires_payment
has_captcha
has_cloudflare
has_submit_form
has_comment_form
has_profile_field
detected_rel
is_noindex
priority_level
status
failure_reason
notes
```

### 3.4 自动分类

第一版用规则分类，AI 只做辅助。

分类结果：

```text
product_submission
ugc_comment_profile
developer_content
media_outreach
opportunity_strategy
unknown
```

规则示例：

- URL 或页面包含 `submit`, `add your tool`, `add product`, `directory`：产品提交类。
- 页面包含 `leave a reply`, `comment`, `website`, `email`：UGC/博客评论类。
- 域名是 `dev.to`, `hashnode`, `medium`, `github`, `npmjs`, `rentry`, `telegra.ph`：内容托管/开发者生态类。
- 页面标题含 `best`, `top`, `alternatives`, `tools`：机会型线索。
- 页面有 `write for us`, `guest post`, `editorial`, `press`：媒体/投稿类。

### 3.5 规则化分级

第一版用规则自动生成优先级。

建议等级：

```text
A: 优先处理
B: 可处理
C: 低优先级
D: 暂不处理
X: 黑名单/跳过
```

分级规则示例：

```text
A:
- 被 >= 3 个竞品验证
- DR 或 traffic 较高
- 免费
- 不需要复杂注册
- 有明确提交入口
- 过往成功率高

B:
- 被 1-2 个竞品验证
- 需要注册但不复杂
- 页面可提交

C:
- 需要人工较多
- 可能需要审核
- nofollow 但相关性强

D:
- 需要付费
- 需要复杂沟通
- 不确定是否可提交

X:
- 付费墙不可接受
- Cloudflare 硬封
- 死站
- 明显 spam/PBN
- 已多次失败
```

### 3.6 当前页面分析

用户打开候选页面后，插件分析：

```text
page_title
page_language
page_type
has_form
form_fields
submit_buttons
login_required
register_required
captcha_detected
cloudflare_detected
existing_target_link
existing_link_rel
noindex
canonical_url
```

页面分析完成后写回资源池。

### 3.7 半自动填表发布

支持三类首发场景：

1. **产品/项目提交类**
   自动填：
   - 产品名
   - URL
   - 描述
   - 分类
   - 标签
   - Logo
   - 联系邮箱

2. **UGC/博客评论/Profile 类**
   自动填：
   - 姓名
   - 邮箱
   - Website
   - 评论正文
   - Profile bio
   - 社交链接

3. **内容托管/开发者生态类**
   自动生成：
   - 标题
   - 简介
   - Markdown 正文
   - 标签
   - 项目链接

发布策略：

- 插件填好所有字段。
- 插件提示“已填完，请人工检查并点击提交”。
- 用户点击提交。
- 插件在提交后检测结果并同步状态。

### 3.8 提交记录

每个项目的每次外链提交都要单独记录。

字段建议：

```text
submission_id
project_id
source_id
target_domain
target_url
submitted_url
backlink_type
anchor_text
content_used
account_used
email_used
status
rel
is_live
is_indexed
submitted_at
checked_at
next_check_at
failure_reason
notes
```

状态建议：

```text
candidate
queued
opened
analyzed
filled
waiting_manual_submit
submitted
pending_review
live_dofollow
live_nofollow
live_ugc
live_sponsored
rejected
failed
skipped
needs_manual
```

### 3.9 发布后检测

提交后检测：

- 页面是否出现目标域名。
- 链接是否可点击。
- `rel` 是否为 dofollow/nofollow/ugc/sponsored。
- 页面是否 noindex。
- 是否进入审核队列。
- 是否需要登录才能看到链接。

检测方式：

- 当前 DOM 检测。
- 提交返回 URL 检测。
- 定时复查目标 URL。

### 3.10 同步

第一版建议支持：

- 本地 IndexedDB
- CSV 导入导出
- Google Sheets 同步

飞书多维表格可作为第二同步目标。

## 4. 核心用户流程

### 4.1 收集竞品外链

```text
输入竞品域名
-> 插件打开 Ahrefs
-> 自动填入域名并查询
-> 拦截/读取外链结果
-> 写入资源池
-> 按 root domain 聚合
-> 自动分类
-> 自动分级
```

### 4.2 导入外链数据

```text
上传 CSV/JSON
-> 字段映射
-> 去重
-> root domain 聚合
-> 统计出现次数
-> 自动分类
-> 自动分级
-> 进入资源池
```

### 4.3 执行外链提交

```text
选择项目
-> 选择资源池中的候选
-> 打开目标页面
-> 插件分析页面
-> AI 生成内容
-> 插件模拟真人填表
-> 状态变为 waiting_manual_submit
-> 用户人工检查并点击提交
-> 插件检测结果
-> 写入 submission 记录
-> 同步到表格
```

### 4.4 复查外链状态

```text
读取待复查 submission
-> 打开 submitted_url
-> 检查目标链接
-> 检查 rel / noindex / 可见性
-> 更新状态
-> 记录失败原因或成功结果
```

## 5. 第一版不做或弱化的功能

第一版不建议做：

- 默认全自动提交。
- 自动绕过验证码。
- 大规模并发发布。
- 复杂 AI 评分模型。
- 过期域名交易与 301 自动化。
- HARO 全自动 pitch。
- Guest Post 邮件群发。

第一版可以弱化：

- 域名 5 年内新建判断。
  可以预留字段 `domain_created_at` 和 `is_recent_domain`，但不阻塞主流程。后续接 RDAP/WHOIS API。

## 6. 风险控制

### 6.1 账号和登录态

- 不主动收集用户账号密码。
- 尽量复用浏览器已有登录态。
- 邮箱验证、Google 登录、验证码交给人工。

### 6.2 行为速度

- 禁止瞬间填表。
- 默认逐字符输入。
- 字段间随机等待。
- 提交前必须暂停。

### 6.3 数据安全

- API Key 本地保存。
- 同步到 Google Sheets/飞书必须由用户授权。
- 不经过第三方中转。

### 6.4 外链风险

- 记录 nofollow/ugc/sponsored。
- 记录 forum/comment 占比。
- 避免单一外链类型过高。
- 对 spam/PBN/零流量资源降级或拉黑。

## 7. 推荐第一版交付清单

第一版最小可用版本：

1. 项目资料库。
2. Ahrefs 域名查询辅助和结果抓取。
3. CSV/JSON 导入资源池。
4. 资源池去重、聚合、分类、分级。
5. 当前页面分析。
6. 三类页面半自动填表。
7. AI 生成评论/描述/简介。
8. 人工最终提交。
9. 发布后链接和 rel 检测。
10. 提交记录。
11. CSV 导出和 Google Sheets 同步。

## 8. 后续演进

第二版：

- 飞书多维表格同步。
- 域名年龄/RDAP 查询。
- Google index 状态复查。
- 账号池和邮箱池。
- 多项目批量任务队列。
- 外链类型占比风险看板。

第三版：

- 低风险站点全自动提交。
- 多浏览器 Profile 隔离。
- 代理配置。
- 失败模式知识库。
- Skill/Prompt 知识库。
- 团队协作和任务分配。

## 9. 总结

这个产品的第一版应该重点解决两个问题：

1. **外链资源怎么来、怎么整理、怎么判断优先级。**
2. **打开一个可发页面后，如何快速、稳定、可记录地完成半自动提交。**

最关键的产品原则：

- 先收集和管理，再发布。
- 先半自动，后全自动。
- 先规则分级，后 AI 评分。
- 先支持产品提交、UGC/Profile、内容托管三类高频场景。
- 每次发布必须留下状态和复查记录。
