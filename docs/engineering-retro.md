# feishu-getnote 插件工程回顾 · 从需求到实现

> 完整记录：怎么想清楚的、怎么做的、踩了什么坑、重做能更好的地方。给团队和未来的自己看。

## 0. TL;DR

- **需求**：把飞书文档一键导入 Get 笔记
- **方案**：Chrome 插件 + Cloudflare Worker 代理 + 自写 blocks→markdown 转换
- **总耗时**：调研 + 设计 + 实现 + 部署，约 2 小时
- **代码量**：约 500 行（Worker 180 + 转换器 120 + 插件 200）
- **关键设计**：代理只做飞书侧，下游笔记 API 由插件直调——为未来 `feishu-Obsidian`、`feishu-Notion` 等插件零修改复用

## 1. 需求起点

Spin 提出原始需求时给了三个明确约束：

1. **团队 5-30 人可用**——排除"一个人自用 demo"的设计姿势
2. **最简单、轻量、稳定**——排除引入复杂打包链路、自建数据库等
3. **走 markdown 中间格式**——明确了文档抽象层

后续在调研中逐步收紧：

- **不需要图片**（纯文字）→ 砍掉一整块图床转存的脏活，工期减半
- **团队内分发**（非公开商店）→ 可以走"开发者模式加载已解压扩展"，省商店审核
- **粘贴 Get 笔记 API Key 登录**→ Get 笔记侧不走 OAuth，简化 50%

## 2. 调研阶段

并行起 2 个 agent，各调研一端 API，约 2 分钟出报告。

### 2.1 飞书侧关键结论

| 接口 | 用途 | 适合度 |
|---|---|---|
| `GET /docx/v1/documents/:id/raw_content` | 取纯文本 | ❌ 丢结构、无法转 markdown |
| `GET /docx/v1/documents/:id/blocks` | 取结构化 blocks | ✅ **推荐**，分页 500/页 |
| `POST /drive/v1/export_tasks` | 异步导出 | ❌ 不支持 markdown 目标格式 |

- wiki 链接需要先 `GET /wiki/v2/spaces/get_node` 换 docx token
- **Chrome 插件无后端做不到合规 OAuth**——app_secret 不能放前端，必须有一个最小代理
- npm 包 `feishu-docx` 已经做了 blocks→markdown，但需要打包

### 2.2 Get 笔记侧关键结论

- 有官方 OpenAPI：`POST openapi.biji.com/open/api/v1/resource/note/save`
- API Key 模式（无 OAuth），需 Get 会员
- `content` 字段直接支持 markdown
- 限流 **< 2 QPS、< 5000 req 总量**
- 飞书↔Get 笔记**没有官方打通**——确认这个插件有做的价值
- 单笔记体积上限、markdown 渲染粒度未公开 → 需要实测

### 2.3 实测 Get 笔记 markdown 渲染粒度

调研完，写了一个 Python 脚本通过 OpenAPI 发了一篇覆盖全语法的测试笔记（heading 1-6、加粗/斜体/删除线、嵌套列表、任务列表、引用、代码块、表格、LaTeX、Mermaid、链接、分隔线），让 Spin 在 Get 笔记客户端验收。

**反馈**：基本没塌 → **P0 决定不做任何 markdown 预处理**，直接灌。省一大块工程量。

## 3. 关键设计决策（5 个）

### 决策 1：要不要后端？

**选项**：
- A. 纯插件，用户自粘 user_access_token（2 小时过期）
- B. 插件 + 小代理藏 app_secret（标准 OAuth + refresh）

**选了 B**。理由：5-30 人团队 A 方案体验差到没人用（每 2 小时手动续）。

### 决策 2：代理职责怎么划？

**选项**：
- A. 代理一站式：插件传 url，代理返回 markdown（甚至直接写 Get 笔记）
- B. 代理只做飞书侧：返回 raw blocks，前端自己转 markdown + 调下游笔记 API

**选了 B**。理由：
- 未来做 `feishu-Obsidian`、`feishu-Notion` 等插件可以零修改复用同一个代理
- 转换逻辑前端化，调整不需要重新部署 Worker
- Worker 职责单一 = 长期稳定
- 命名也对应：代理叫 `lark-doc-proxy` 而非 `feishu-getnote-proxy`（能力命名，不是用途命名）

### 决策 3：token 存哪？

**选项**：
- A. 代理把 access_token + refresh_token 通过 URL 回传给插件
- B. 代理保管所有 token，给插件一个 session_key

**选了 B**。理由：
- token 永不出代理 = 浏览器历史 / 插件 storage 都不留敏感数据
- refresh 在代理端自动做，前端无感
- 唯一缺点：每次拉文档过代理（但 Cloudflare 免费档 100k req/day 够 30 人团队随便用）

### 决策 4：用 npm 包还是自写转换器？

**选项**：
- A. 引 `feishu-docx` npm 包（需要 esbuild 打包）
- B. 自写最简转换器，覆盖 P0 块类型

**选了 B**。理由：
- 省一整条打包链路（esbuild/rollup/webpack）
- P0 只覆盖文字类（heading、bullet、ordered、code、quote、divider、todo），约 120 行
- 复杂的（table、image）降级为占位注释，留 P1

### 决策 5：P0 砍什么？

| 功能 | 决策 | 理由 |
|---|---|---|
| 图片导入 | 砍 | 飞书图床是签名 URL，Get 笔记拉不到，必须本地下载再上传，工程复杂度翻倍 |
| 复杂表格 | 降级占位 | 飞书 table cell 是独立 block，markdown 表格扁平，二维拼接需要专门逻辑 |
| 超大文档分片 | 不做 | Get 笔记单笔记体积上限未知，等踩到再说 |
| 双向同步 | 不做 | 明确是"导入"不是"同步"，每次都新建笔记 |
| 批量导入 | 不做 | 第一版一次一篇 |

## 4. 最终架构

```
Chrome 插件 (MV3)
   │  popup.html/js       「导入到 Get 笔记」按钮
   │  options.html/js     「Worker URL」+「飞书登录」+「Get 笔记 API Key」
   │  background.js       service worker：拉 → 转 → 写
   │  lib/feishu-md.js    blocks → markdown，120 行
   │
   ↓ Authorization: Bearer <session_key>
Cloudflare Worker (lark-doc-proxy)
   │  /oauth/start         发起飞书授权
   │  /oauth/callback      接飞书回调，换 token，存 KV
   │  /api/doc             代拉 blocks
   │  KV: SESSIONS         session_key → {access, refresh, expires}
   │  Secrets: LARK_APP_ID, LARK_APP_SECRET
   │
   ↓ Authorization: Bearer <user_access_token>
飞书 OpenAPI
   - wiki/v2/spaces/get_node       (wiki token → docx token)
   - docx/v1/documents/:id         (取标题)
   - docx/v1/documents/:id/blocks  (分页拉 blocks)
```

下游写入 Get 笔记由插件 background.js 直调，**不经过代理**。

## 5. 实施步骤

1. 调研两端 API（并行 2 个 agent，2 分钟）
2. 实测 Get 笔记 markdown 渲染粒度（curl 发测试笔记）
3. 确认 Spin 要走 OAuth + Worker 代理路径（拍板设计）
4. 写代码（500 行，一气呵成）
5. 部署 Worker（npm install wrangler → login → kv create → secret put × 2 → deploy）
6. 飞书后台配重定向 URL
7. 加载插件 + 端到端测试

## 6. 踩坑清单

### 坑 1：Cloudflare workers.dev 子域要单独注册

首次 `wrangler deploy` 报错，输出里给的 onboarding URL 是 404（Cloudflare UI 改过）。手动去 Dashboard → Workers & Pages → Settings → Subdomain 注册一个全局唯一名称（如 `spin-liu`），再 redeploy 就行。

**重做改进**：DEPLOY.md 里明确写"初次需注册子域"，且不要给具体 URL（容易过期），写"进 Dashboard 找 Workers & Pages → Subdomain"。

### 坑 2：wrangler 命令在非交互上下文中默认走 fallback

`wrangler secret put XXX` 必须用 stdin 喂值（`echo 'xxx' | wrangler secret put XXX`），不然报 "non-interactive context"。Claude Code 通过 Bash 跑命令时是非交互的。

**重做改进**：DEPLOY.md 里给可直接 copy-paste 的 stdin 喂值版本，不照搬官方文档"提示输入时粘贴"那种交互范式。

### 坑 3：飞书 OAuth 授权用 v1 端点 + token 交换用 v2 端点

- 授权页：`https://accounts.feishu.cn/open-apis/authen/v1/authorize`
- token 交换：`https://open.feishu.cn/open-apis/authen/v2/oauth/token`

文档分散在不同地方，混用是飞书目前的实际设计现状。代码里走对了，但容易踩。

**重做改进**：代码里加注释说明这个 v1+v2 混用是有意为之，不是 bug。

### 坑 4：API Key 在对话里裸贴

测试阶段 Spin 直接把 Get 笔记 API Key 贴在对话框里给 Claude 测试用。这条凭证因此落到了对话历史 + claude-mem 上下文中。

**重做改进**：测试值用环境变量传，对话里只说"我把 key 放到 GETNOTE_KEY 环境变量了"。或者直接让 Claude 用占位 placeholder，自己粘到 ~/.bashrc。

### 坑 5：测试笔记 API 响应不带笔记 URL

Get 笔记 OpenAPI 返回的是 `{note_id, created_at}`，没有可点击的 URL。意味着插件成功后没法给"查看笔记"按钮，用户得自己打开 Get 笔记客户端找。

**重做改进**：第二版调研 Get 笔记是否有"按 ID 跳转"的 URL 格式（类似 `https://www.biji.com/note/<id>`），有的话拼出来。

## 7. 重做时能更好的 7 个地方

### 7.1 调研顺序应该倒过来

**当时**：先调研飞书（上游）再调研 Get 笔记（下游）。

**更好**：**先验证下游**——确认 Get 笔记有可用 OpenAPI 是整个方案能否成立的前提。如果 Get 笔记没 API，方案要改成"下载 md 文件让用户手动导入"，架构完全不同。先验证下游再细化上游。

### 7.2 P0 应该有 "无飞书登录" 的纯文本兜底入口

**当前**：必须先飞书登录才能用插件。

**更好**：popup 加一个「粘贴飞书 URL + 直接粘 markdown」的手动入口，让没配置 Worker / 没登录飞书的人也能用 Get 笔记写入这条能力。30 行代码，分发友好度大幅提升。

### 7.3 Worker 应该早就有 /health 端点

**当前**：只有 `/` 根端点返回 ok。

**更好**：明确的 `/health` 端点 + 显示 KV 是否绑了 + secret 是否设了（不返回值，只 true/false）+ 上次部署时间。debug 时一眼看出环境是否齐全。

### 7.4 转换器应该有单元测试

**当前**：靠真实文档导入验证。出错才知道。

**更好**：写 10 个最小 block 样本（heading、list、code、quote、todo …）作为 fixture，节约调试时间。第二版加表格时这套测试也是回归保护。

### 7.5 options 页应该有连通性自检按钮

**当前**：填完 Worker URL 后只能"实际试用"才知道对不对。

**更好**：加「测试 Worker」按钮，调 `/` 验证可达；加「测试 Get 笔记」按钮验证 API Key 有效。降低 0→1 体验门槛。

### 7.6 飞书 scope 是否一次到位有取舍

**当前**：只申请 docx + wiki 读权限（最小集）。

**更好的一面**：可以一次申请文档、wiki、表格、多维表格全部读权限，避免做下个插件（feishu-Obsidian）时还要让管理员重新审批。

**反对的一面**：scope 越少审批越快通过；动态加 scope 飞书也支持。

**结论**：两难，按团队节奏选。如果飞书管理员审批快，最小集更好。

### 7.7 README 应该有架构图

**当前**：是 ASCII 文字图。

**更好**：mermaid 流程图，飞书后台、GitHub 都能渲染，可读性高一档。

## 8. 复用展望

代理叫 `lark-doc-proxy` 是有意命名能力而非用途。基于现在的架构，下一步可以做：

### feishu-Obsidian 插件

- 完全复用 Cloudflare Worker（零修改）
- 复用 `lib/feishu-md.js` 转换器
- 只需要写：插件骨架（manifest + popup + options）+ Obsidian 写入逻辑（最简单是写本地 vault 文件夹下的 .md 文件）
- **估计 1 小时**

### feishu-Notion 插件

- 复用 Worker
- 复用 markdown 转换
- 增加 Notion API 调用（Notion 自己的 OAuth 又一遍）
- **估计 2-3 小时**

### 飞书全文检索 CLI

- 复用 Worker `/api/doc`
- 把多篇文档的 markdown 灌到本地 sqlite + FTS
- **估计 1 小时**

### 飞书 → 任意 Markdown 笔记 工作流

把代理 + 转换器封装成一个 CLI 命令：`feishu-export <url>` 输出 markdown。可以接到任何工作流（cron、Raycast script、Alfred workflow）。

## 9. 元观察：AI 协作模式

记录一下这次 Claude Code 替我做的和我必须自己做的，供下次参考。

### AI 替我做了什么

- 两端 API 调研（agent 并行，2 分钟出报告，否则人工至少半天）
- 代码骨架（500 行一气呵成，符合规范）
- 部署命令编排（wrangler 各种交互范式我不熟）
- 文档撰写（README、DEPLOY、本回顾、安装指南都是 Claude 草拟）

### 我必须自己做的

- 拍板设计决策（OAuth vs 粘 token、代理职责、P0 砍什么）
- 提供凭证（API Key、App ID、App Secret）
- 浏览器交互动作（OAuth 授权、Cloudflare login、加载插件）
- 验收（Get 笔记 markdown 渲染、端到端测试）

### 不可替代的人类判断

- "团队 5-30 人用" → 决定 OAuth+代理 而非 PoC
- "纯文字就好" → 决定砍图片
- "可复用未来插件" → 决定代理职责划法
- "API Key 用户自己粘" → 决定 Get 笔记侧不走 OAuth

### Anthropic 创业者手册的对照

「AI 让构建变快，但容易做错东西。」这次没踩到，因为前置需求边界清晰（团队规模、不要图片、能复用）。如果换一个边界不清的需求，比如"做一个让飞书更好用的工具"，AI 很可能给我搭出一个 10x 复杂度但用户不要的东西。**需求边界是节流阀**，不是限制。

---

*回顾完成 · 2026-05-17 · Spin + Claude Opus 4.7*
