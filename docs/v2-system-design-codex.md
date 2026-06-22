<title>feishu-to-getnote v2 系统设计：文章 / 微信文章一键进入飞书文档或 Get 笔记</title>

<callout emoji="✅">
**结论先行：**v2 不应该把插件改成“万能后端抓网页”的形态，而应该扩展为清晰的三层架构：Source Adapters 负责从当前浏览器页面取内容，Normalized Content Model 负责统一文章 / 飞书文档结构，Destination Adapters 负责写入 Get 笔记或飞书文档。
现有 Worker 继续保留“飞书 token 不出后端”的边界；Get API Key 继续留在 Chrome 本地；新增文章导入采用分层抽取策略：普通网页优先当前 Tab DOM 抽取；微信公众号、强反爬页面、需要图片转存的页面优先走后端抽取服务。Worker 只做认证转发、飞书 API 编排和必要路由，不把自身变成通用爬虫。
</callout>

# 1. 代码阅读结论

本次阅读基于 GitHub 仓库 `spinliu/feishu-to-getnote` 当前 main，提交 `e93b987`。核心结论如下：

| 模块 | 当前能力 | 对 v2 的含义 |
|-|-|-|
| Chrome popup | 只识别 `feishu.cn` / `larksuite.com` 页面；非飞书页面直接提示“当前页面不是飞书文档”。 | 文章 / 微信文章导入不是补几行判断，而是要新增 Source Adapter 和新的按钮状态。 |
| Chrome background | 单一链路：调 Worker `/api/doc` 拉飞书 blocks，转 Markdown，再直调 Get 笔记 OpenAPI。 | 适合升级为 orchestrator：根据 source 和 destination 组合调不同适配器。 |
| Chrome permissions | 当前只有 `storage`、`identity`、`activeTab`，没有 `scripting` 或 content script。 | 要从当前网页取正文，v2 需要新增 `scripting`，并在用户点击时向当前 Tab 注入抽取脚本。 |
| Worker | 只做飞书 OAuth、session KV、文档只读代理：`/oauth/start`、`/oauth/callback`、`/api/session`、`/api/doc`。 | 新增“写飞书文档”应放在 Worker，因为需要使用用户飞书 OAuth token，且不能把 app secret 放进插件。 |
| 本地 Markdown | 当前 main 没有实际本地文件保存路径：未发现 `chrome.downloads`、Blob 下载或文件系统写入。Markdown 只是内存中间格式。 | v2 应明确不恢复本地 Markdown 存储；Markdown 可以继续作为内部交换格式，但不作为用户可见目的地。 |

---

# 2. 需求重新定义

<callout emoji="📌">
v2 的产品目标不是“多一个网页抓取功能”，而是把插件从单一转换器升级为轻量内容路由器：用户在浏览器当前页面点击一次，内容就能进入合适的知识容器。
</callout>

## 2.1 新的用户任务

| 当前页面 | 可选动作 | 目标体验 |
|-|-|-|
| 飞书文档 / Wiki | 导入 Get 笔记 | 保持现有能力，但登录失效时在按钮点击流程里自动完成重新授权。 |
| 普通网络文章 | 存到飞书文档 / 存到 Get 笔记 / 两边都存 | 用户不需要复制粘贴标题、正文和来源链接。 |
| 微信公众号文章 | 存到飞书文档 / 存到 Get 笔记 / 两边都存 | 优先识别微信正文容器、标题、作者、发布时间、封面图和正文图片。 |

## 2.2 明确不做的事

- 不做本地 Markdown 文件存储。它既不是团队协作容器，也会引入权限、路径和重复文件问题。
- 不让 Cloudflare Worker 作为通用网页爬虫。服务器端抓文章会遇到登录态、反爬、CORS、微信限制和版权边界问题。
- 不把 Get API Key 交给 Worker。Get API Key 继续只存在用户 Chrome 本地，减少后端责任和泄露面。
- 不把 v2 做成双向同步。仍然是“导入 / 保存”，不是长期同步系统。

---

# 3. 推荐的 v2 架构

```text
Browser current tab
  |
  | user click
  v
Chrome Popup
  - detect source type
  - show destination actions
  |
  v
Background Orchestrator
  |
  +-- Source Adapter: feishuSource
  |     calls Worker /api/doc
  |
  +-- Source Adapter: articleSource
  |     injects extractor into active tab
  |
  v
Normalized Content Model
  - title
  - sourceUrl
  - author
  - publishedAt
  - markdown
  - images
  - metadata
  |
  +-- Destination Adapter: getnoteDestination
  |     Chrome local Get key -> Get OpenAPI
  |
  +-- Destination Adapter: feishuDestination
        session key -> Worker /api/feishu/doc/create -> Feishu Docx
```

## 3.1 三层职责

<grid>
<column width-ratio="0.333333">
### Source Adapters
只负责“从哪里取内容”。飞书文档走 Worker；普通文章走当前页面 DOM；公众号、强反爬和图片转存场景走后端抽取服务。
</column>
<column width-ratio="0.333333">
### Normalized Model
把不同来源统一成一份结构化内容，避免 Get 和飞书两边各写一套提取逻辑。
</column>
<column width-ratio="0.333333">
### Destination Adapters
只负责“写到哪里”。Get 直连；飞书写入通过 Worker 使用用户 OAuth session。
</column>
</grid>

## 3.2 标准内容模型

```typescript
type NormalizedContent = {
  sourceType: 'feishu-doc' | 'web-article' | 'wechat-article';
  title: string;
  sourceUrl: string;
  author?: string;
  siteName?: string;
  publishedAt?: string;
  markdown: string;
  images: Array<{
    src: string;
    alt?: string;
    caption?: string;
    kind?: 'cover' | 'inline';
  }>;
  metadata: Record<string, string>;
};
```

<callout emoji="❗">
Markdown 在 v2 中仍然有价值，但它应当只是内部交换格式，不再是用户侧存储产物。用户真正看到的是 Get 笔记或飞书文档。
</callout>

---

# 4. 关键流程设计

## 4.1 飞书文档 → Get 笔记

1. popup 识别当前 URL 是飞书文档或 Wiki。
2. background 调 `ensureFeishuSession({ interactive: true })`，先探活，失效则从当前点击流程发起 OAuth。
3. background 调 Worker `/api/doc` 拉取 blocks。
4. 前端转换为 Markdown。
5. background 使用本地 Get API Key 直调 Get OpenAPI。
6. popup 返回成功状态，最好展示标题和 note id。

## 4.2 普通网页 / 微信文章 → Get 笔记

1. popup 判断不是飞书页面，但是 http/https 页面，展示“存到 Get 笔记”。
2. background 通过 `chrome.scripting.executeScript` 注入 article extractor。
3. extractor 先尝试微信专用选择器，再 fallback 到 Readability 类算法。
4. 生成 `NormalizedContent`，其中正文转 Markdown，来源 URL 写入 metadata。
5. background 调 Get OpenAPI 写入，tags 建议包含 `from-web`、`from-wechat`。

## 4.3 普通网页 / 微信文章 → 飞书文档

1. 前半段同文章抽取流程。
2. background 调 `ensureFeishuSession({ interactive: true })`。
3. background 把 `NormalizedContent` 发给 Worker `/api/feishu/doc/create`。
4. Worker 使用 session 对应的用户 access token 创建 Docx，并将 Markdown / 结构化 blocks 写入文档。
5. Worker 返回文档 URL，popup 展示“打开飞书文档”。

## 4.4 两边都存

| 策略 | 建议 | 原因 |
|-|-|-|
| 并行写入 | 不推荐作为 P0 默认 | 任何一边失败都会带来复杂的部分成功状态。 |
| 先飞书后 Get | 推荐 | 飞书文档 URL 可作为 Get 笔记的来源链接和团队协作入口。 |
| 先 Get 后飞书 | 不推荐 | Get 返回值当前不稳定提供可分享 URL，难以反向挂接。 |

---

# 5. Chrome 插件改造

## 5.1 文件结构建议

```text
extension/
  background.js
  popup.js
  options.js
  lib/
    auth-manager.js
    source/
      feishu-source.js
      article-source.js
      article-extractor.js
      readability.js
    destination/
      getnote-destination.js
      feishu-destination.js
    normalize/
      markdown.js
      html-to-markdown.js
      feishu-md.js
```

## 5.2 manifest 权限

| 权限 | 是否需要 | 说明 |
|-|-|-|
| `storage` | 保留 | 保存 Worker URL、Get Key、Get client id、Feishu session。 |
| `identity` | 保留 | 继续使用 `chrome.identity.launchWebAuthFlow` 完成飞书 OAuth。 |
| `activeTab` | 保留 | 用户点击插件时临时读取当前页面，权限面小于长期 host permission。 |
| `scripting` | 新增 | 向当前 Tab 注入文章抽取脚本，这是文章 / 微信文章导入的核心。 |
| `downloads` | 不要新增 | 明确移除本地 Markdown 文件存储，不需要下载权限。 |
| `<all_urls>` | P0 不建议 | 优先靠 `activeTab` 覆盖用户主动点击页面，降低权限审批和安全风险。 |

## 5.3 popup 状态机

```text
detectCurrentTab()
  if feishu doc:
    show [导入 Get 笔记]
  else if http/https article page:
    show [存到飞书文档] [存到 Get 笔记] [两边都存]
  else:
    show unsupported state

on action click:
  disable buttons
  show running status
  send { type: 'save', source, destinations }
  render result with document url or note id
```

## 5.4 文章抽取策略

| 层级 | 抽取方式 | 说明 |
|-|-|-|
| 微信专用 | `#js_content`、`#activity-name`、`#js_name`、`#publish_time`、`meta[property="og:image"]` | 微信 DOM 结构相对稳定，优先专用规则。 |
| 通用文章 | Readability 类算法 | 提取主标题、正文、站点名、作者、时间，剔除导航和广告。 |
| 兜底 | `article`、`main`、最大文本密度节点 | 在结构不标准的网站上尽量给出可用内容。 |

<callout emoji="💡">
微信图片是风险点：正文图片常在 `data-src`，并可能有防盗链或临时参数。P0 建议先保证标题、正文和来源链接稳定；图片作为 P1 做“下载后上传飞书素材”或“可访问 URL 直插”的增强。
</callout>

---

# 6. 飞书认证优化

## 6.1 当前问题根因

当前插件只判断本地有没有 `feishuSession`。如果 session 已经在 Worker KV 失效，或者 refresh token 过期，用户第一次点击导入时会先失败，再被要求去设置页重新登录。这不是飞书 OAuth 本身的限制，而是前端流程没有在动作开始前做 session 探活和自动重登。

## 6.2 推荐实现

```javascript
async function ensureFeishuSession({ interactive }) {
  const cfg = await chrome.storage.local.get(['worker', 'feishuSession']);
  if (!cfg.worker) throw new Error('未配置 Worker URL');

  if (cfg.feishuSession) {
    const ok = await probeSession(cfg.worker, cfg.feishuSession);
    if (ok) return cfg.feishuSession;
    await chrome.storage.local.remove('feishuSession');
  }

  if (!interactive) throw new Error('未登录飞书');

  const redirect = chrome.identity.getRedirectURL();
  const startUrl = `${cfg.worker}/oauth/start?redirect=${encodeURIComponent(redirect)}`;
  const cbUrl = await chrome.identity.launchWebAuthFlow({
    url: startUrl,
    interactive: true,
  });
  const session = new URL(cbUrl).searchParams.get('session');
  if (!session) throw new Error('飞书登录回调缺 session');
  await chrome.storage.local.set({ feishuSession: session });
  return session;
}
```

## 6.3 Worker 也要修

当前 `/api/session` 只检查 KV 里有没有 session，不会调用 `ensureAccessToken`。这会导致一种假阳性：session 存在，但 refresh 已经不可用。v2 应改为：

- `/api/session` 读取 bearer session。
- 调用 `ensureAccessToken(env, session)`。
- 如果能拿到 access token，返回 `{ ok: true }`。
- 如果不能，删除本地 stale session 或返回 `401 session_invalid_or_expired`。

<callout emoji="✅">
这样用户点击按钮时，可以在同一次点击链路中完成“探活 → 失效 → OAuth → 重试原动作”，不需要先失败一次，也不需要去 options 页手动登录。
</callout>

---

# 7. Worker / API 改造

## 7.1 保留现有 API

| API | 处理方式 | 原因 |
|-|-|-|
| `/oauth/start` | 保留 | 仍然是 Chrome identity 发起飞书 OAuth 的入口。 |
| `/oauth/callback` | 保留 | 继续把 access / refresh token 存在 KV，只回传 session key。 |
| `/api/doc` | 保留 | 继续服务“飞书文档 → Get 笔记”。 |
| `/api/session` | 修正 | 从“KV 存在检查”升级为“可 refresh 检查”。 |

## 7.2 新增 API

```text
POST /api/feishu/doc/create
Authorization: Bearer <session_key>
Content-Type: application/json

{
  "title": "文章标题",
  "sourceUrl": "https://example.com/article",
  "author": "作者",
  "publishedAt": "2026-06-21",
  "markdown": "# title ...",
  "images": []
}

Response:
{
  "ok": true,
  "title": "文章标题",
  "url": "https://xxx.feishu.cn/docx/...",
  "documentId": "..."
}
```

## 7.3 飞书写入权限

<callout emoji="❗">
实施前需要在飞书开放平台核准新增的 Docx 创建 / 编辑 scope 名称。当前代码只申请 `docx:document:readonly` 和 `wiki:wiki:readonly`，只能读，不能创建和写入文档。
</callout>

建议原则是最小权限：只增加创建 Docx 与写入 blocks 所需 scope，不一次性申请表格、多维表格、云盘全量权限。这样管理员审批负担较低，也更符合插件用途。

## 7.4 抽取位置：普通网页 DOM，公众号 / 强反爬后端服务

<grid>
<column width-ratio="0.500000">
### 不推荐：Worker 自己 fetch 文章 URL
- 拿不到用户浏览器登录态。
- 容易被微信和新闻站反爬。
- 需要处理大量站点差异。
- 会让 Worker 从飞书代理变成通用爬虫。
</column>
<column width-ratio="0.500000">
### 推荐：分层抽取
- 普通网页：用户主动点击后用当前 Tab DOM 抽取，权限边界最小。
- 微信公众号 / 强反爬：走后端抽取服务，复用 scrapling-article-fetch 或等价 HTTP 服务。
- 图片转存：由后端负责下载、归一化和上传飞书素材，前端只接收结构化结果。
- Worker：只做 session 校验、请求转发、飞书写入编排，不承载 Python 抽取运行时。
</column>
</grid>

---

# 8. Feishu CLI 的角色

`lark-cli docs +create --api-version v2` 已经证明了一个正确边界：给一段 Markdown / XML 内容，就能创建飞书文档并返回 URL。这对 v2 很有参考价值，但不应该让 Chrome 插件去调用本地 CLI。

| 使用场景 | 是否用 lark-cli | 原因 |
|-|-|-|
| 本地开发 smoke test | 可以 | 快速验证飞书创建文档和权限是否配置正确。 |
| 生产插件运行时 | 不要 | Chrome 扩展无法依赖用户本地装 CLI，也不该有本地 shell 权限。 |
| Worker 实现参考 | 可以参考 | Worker 应实现等价 OpenAPI 调用：创建文档、写入 blocks、返回 URL。 |

---

# 9. 实施路线图

## Phase 1：修认证和路由骨架

- [ ] 新增 `auth-manager.js`，把 options 页和按钮动作共用同一套 `ensureFeishuSession`。

- [ ] 修 Worker `/api/session`，让它调用 `ensureAccessToken`。

- [ ] 把 background 单函数拆成 source / destination / orchestrator 三层。

- [ ] popup 从单按钮改为按 source type 渲染动作按钮。

## Phase 2：文章 → Get 笔记

- [ ] manifest 增加 `scripting` 权限。

- [ ] 实现 `article-extractor.js`，优先覆盖微信文章和普通 `article` 页面。

- [ ] 实现 HTML 到 Markdown 的最小转换：标题、段落、链接、列表、引用、代码块、图片占位。

- [ ] 复用现有 Get 写入链路，补充 `from-web` / `from-wechat` tags。

## Phase 3：文章 → 飞书文档

- [ ] 确认飞书 Docx 创建 / 编辑 scope，并更新 Worker `SCOPES`。

- [ ] 新增 Worker `/api/feishu/doc/create`。

- [ ] 实现 Markdown / 结构化内容到飞书 blocks 的写入。

- [ ] popup 成功态返回飞书文档 URL，支持一键打开。

## Phase 4：质量增强

- [ ] 补单元测试：auth-manager、article extraction、html-to-markdown、feishu-md。

- [ ] 补 e2e 测试：飞书文档 → Get、微信文章 → Get、微信文章 → 飞书。

- [ ] 处理图片 P1：可访问图片直插飞书；不可访问图片走下载再上传或降级为来源链接。

- [ ] 新增 options 自检：Worker 可达、Feishu session 可用、Get key 可用。

---

# 10. 风险与取舍

| 风险 | 影响 | 处理建议 |
|-|-|-|
| 微信图片不可稳定外链 | 飞书文档里的图片可能缺失 | P0 先保证正文；P1 做图片上传链路。 |
| Readability 对中文内容页不总是准确 | 正文可能漏抓或多抓导航 | 先覆盖微信和常见文章页，再用样本集迭代选择器。 |
| 飞书新增写权限需要管理员审批 | 部署节奏可能被权限卡住 | 先完成 Get 目的地和认证修复；飞书写入作为独立发布点。 |
| 两边都存存在部分成功 | 用户可能不知道哪边成功 | 结果对象必须拆分返回 `{ feishu, getnote }`，UI 明确展示。 |
| Get 单条笔记体积上限不明 | 超长文章写入失败 | 保留字数检测；超过阈值时优先建议存飞书，Get 只存摘要和链接。 |

---

# 11. 从旧设计到新设计：变化与原因

| 旧设计 | 新设计 | 为什么要改 |
|-|-|-|
| 单一路径：飞书文档 → Get 笔记。 | 多源多目的地：飞书文档 / 网络文章 / 微信文章 → Get / 飞书文档。 | 新需求的核心是浏览器当前内容的一键路由，不再只是飞书导出。 |
| popup 只显示一个导入按钮，且非飞书页面直接拒绝。 | popup 根据当前页面类型显示不同动作。 | 文章页面必须有自己的入口，否则用户无法触发文章抽取。 |
| background 把所有逻辑写在 `handleImport` 里。 | background 变成 orchestrator，调用 source 和 destination adapters。 | 避免 v2 继续堆 if/else，后续接 Notion、Obsidian、更多网页源也能扩展。 |
| 飞书 session 只看本地有没有 key，失败后让用户去设置页。 | 按钮点击时自动探活、自动 OAuth、自动重试原动作。 | 这能解决“第一次点必报错再重新登录”的体验问题，而且 Chrome identity 已经具备这个能力。 |
| `/api/session` 只检查 KV 是否存在。 | `/api/session` 调 `ensureAccessToken` 验证 token 可刷新。 | KV 存在不等于 session 可用；必须消除假阳性。 |
| Worker 只读飞书文档。 | Worker 继续读飞书，同时新增创建飞书文档 API。 | 文章写入飞书需要用户 OAuth token 和 app secret 保护，应该在 Worker 完成。 |
| Markdown 是显性导出目标或历史遗留目标。 | Markdown 只保留为内部交换格式。 | 本地 Markdown 存储价值低、bug 面大；飞书文档和 Get 才是用户真正要的容器。 |
| 没有网页 DOM 抽取能力。 | 新增 `scripting` 权限和 article extractor。 | 普通网页当前页面 DOM 更轻；微信公众号和强反爬页面更适合后端抽取服务，不能一刀切。 |
| Get API Key 留在 Chrome 本地，Worker 不碰下游。 | 继续保持。 | 这是旧设计里正确的边界，v2 不应为了方便而扩大后端敏感数据面。 |
| lark-cli 只作为部署外部工具。 | lark-cli 作为本地验证和设计参照，运行时由 Worker 实现等价 OpenAPI。 | Chrome 插件不能依赖本地 CLI；但 CLI 的 create-doc 能证明 API 边界和内容格式是可行的。 |

<callout>
**建议落地顺序：**先修认证与架构拆分，再做“文章 → Get”，最后做“文章 → 飞书文档”。这样每一步都有可发布价值，也避免一开始就被飞书写权限审批和图片上传复杂度拖住。
</callout>

---

# 12. Claude 独立稿对照复核与本轮修订

<callout emoji="✅">
**本轮复核结论：**Claude 稿在源码证据、分支事实、认证失败根因、OpenAPI 写入路径、运行时验证项上更扎实；我原稿在抽象分层、权限边界、Get Key 不进 Worker、Feishu CLI 不进运行时、渐进落地路线这些方向上仍然成立。合并后的设计应采用“普通网页 DOM 抽取 + 公众号/强反爬后端抽取”的混合架构，而不是任何一边的一刀切。
</callout>

## 12.1 我这版仍然 OK，甚至更应该保留的部分

| 保留点 | 判断 | 原因 |
|-|-|-|
| Source / Normalize / Destination 三层架构 | 保留 | 它比“按功能堆流程”更适合后续增加 Get、飞书、Notion、Obsidian 或更多网页源。 |
| Get API Key 继续只留在 Chrome 本地 | 保留 | Worker 不接触下游 Get 凭证，职责和泄露面更小；这也是旧设计中正确的边界。 |
| Markdown 只作为内部交换格式 | 保留 | 用户真正需要的是飞书文档或 Get 笔记；本地 Markdown 文件不是团队协作容器。 |
| Feishu CLI 不进入插件运行时 | 保留 | CLI 适合本地 smoke test 和 API 边界验证，Chrome 扩展运行时不能依赖本机 shell。 |
| 普通网页优先当前 Tab DOM 抽取 | 修订后保留 | 用户已主动打开页面时，DOM 抽取权限最小，也能使用用户浏览器登录态；但不再扩展到所有公众号和强反爬场景。 |

## 12.2 采纳 Claude 稿并修订的部分

| 采纳点 | 我原稿的问题 | 修订后的设计 |
|-|-|-|
| 本地 Markdown 分支事实 | 我只验证了 main 没有本地文件保存路径，没追远端分支。 | 已验证远端 `origin/feat/local-markdown` 存在，commit `c2f72b3` 引入 `extension/lib/fs-vault.js`，依赖 File System Access API 与 IndexedDB handle。设计结论改为：main 不需移除，直接废弃该分支或确保不合入。 |
| silent refresh 事实 | 我把体验问题主要表述成“缺少前置探活”，没有强调 Worker 已经实现 refresh。 | 修正为：Worker `ensureAccessToken` 已在 `worker/src/index.js:187-212` 实现刷新，但缺少并发保护、提前刷新、重试与真实错误区分；扩展侧也缺少点击前 session 探活和自动重授。 |
| 点击即自动授权 | 我原伪代码直接 `interactive:true`，体验仍偏重。 | 改为用户点击后先 `launchWebAuthFlow({ interactive:false })` 静默尝试；失败后再降级 `interactive:true`。这样飞书已有登录态时不弹授权页。 |
| refresh-token 轮换与并发风险 | 我原稿只说 `/api/session` 需要调用 `ensureAccessToken`，没有展开 refresh 链路断裂风险。 | 新增 Worker 侧要求：提前 5 分钟刷新、同一 session 单飞刷新、失败重试 1 次、刷新成功立即回写新 refresh_token、401 分清真过期与临时网络错误。 |
| 公众号 / 强反爬抽取 | 我原稿把微信也放进 DOM 抽取，过于乐观。 | 改为混合策略：普通网页用当前 Tab DOM；公众号、强反爬、图片转存走后端抽取服务。可复用已安装的 `scrapling-article-fetch` 能力，但需包装成 HTTP 服务或由独立后端承载，Cloudflare Worker 只转发，不跑 Python。 |
| 飞书写入端点拆解 | 我只写了抽象的 `/api/feishu/doc/create`。 | 补充实现时需要覆盖：创建 Docx、批量插入 blocks、媒体上传、权限授予。具体 scope 名称仍需以飞书开放平台实测为准，不能只凭记忆写死。 |
| 运维与安全卫生 | 我原稿没有展开 Worker 运维面。 | 新增要求：`/health` 显示 KV/secret 绑定状态但不泄密；OAuth redirect 前缀应收紧到精确扩展 ID 的 `chromiumapp.org` 回调，而不是宽泛前缀。 |

## 12.3 新的合并架构

```text
Chrome Extension
  popup: detect source + choose destination
  auth-manager: /api/session probe -> silent auth -> interactive fallback
  source adapters:
    feishuSource -> Worker /api/doc
    articleDomSource -> chrome.scripting on active tab
    extractServiceSource -> Worker /api/extract -> backend extractor
  destination adapters:
    getnoteDestination -> Get OpenAPI from Chrome local key
    feishuDestination -> Worker /api/feishu/doc/create

Cloudflare Worker
  OAuth/session proxy:
    /oauth/start, /oauth/callback, /api/session
  Feishu API proxy:
    /api/doc, /api/feishu/doc/create
  Router only for extraction:
    /api/extract -> Zylos/scrapling HTTP service or equivalent backend
  Not responsible for:
    Get API key, Python scraping runtime, local Markdown file storage
```

## 12.4 不采纳或需要改写 Claude 稿的部分

| Claude 稿观点 | 我的处理 | 理由 |
|-|-|-|
| 公众号 / 网页抽取整体不在浏览器内做 | 改写为分层策略 | 公众号和强反爬走后端是对的，但普通网页、已登录内网页、用户当前可见页面仍适合 DOM 抽取，权限更小、路径更短。 |
| Worker 升级为 `lark-content-proxy` | 暂不作为必需项 | 命名可以后续改，但不应阻塞实现；更重要的是先明确 Worker 不承载 Python 抽取运行时。 |
| 写飞书 scope 直接写 `docx:document`、`drive:drive` | 作为候选，不写死 | scope 名称和审批项必须在飞书开放平台或实际 API 错误中确认。设计文档应标成“候选/待验证”。 |

## 12.5 进入编码前必须确认的开放问题

- [ ] 用 `wrangler tail` 或等价日志抓一次真实 401，确认是 refresh_token 轮换断链、access token 过期、scope 失效，还是网络临时错误。

- [ ] 确认 `origin/feat/local-markdown` 是否在团队加载或发布过；如果没有，只需明确废弃分支，不需要在 main 删除不存在的功能。

- [ ] 确认后端抽取服务形态：复用 Zylos 本地 `scrapling-article-fetch` 包装 HTTP，还是另建可部署的 extraction service。

- [ ] 验证微信公众号正文和图片转存：正文是否可稳定提取，图片能否下载并通过飞书 media API 上传。

- [ ] 确认飞书 Docx 创建、插入 blocks、上传 media、授权用户所需的准确 OpenAPI 和 scope。

- [ ] 确认 Get 笔记是否有 note_id 到可打开 URL 的映射；没有则成功态只展示 note_id 和标题。

- [ ] 等 Spin 确认本章采纳/修订后，再开始新版本本地项目搭建。项目位置按要求放在 iCloud 目录下的 `codex/` 新项目文件夹，不直接改 main。

<callout>
**更新后的实施原则：**先修认证链路和架构拆分；再做普通网页 → Get / 飞书；随后接公众号后端抽取和图片转存；最后再考虑创建新分支、版本号和稳定运行后 merge。未经确认前不进入编码阶段。
</callout>