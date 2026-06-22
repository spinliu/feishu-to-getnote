# 部署 + 安装指南

按顺序走：先飞书应用，再 Worker，最后插件。每一步都标注了**谁来做**。

---

## A. 创建飞书自建应用（管理员，10 分钟）

1. 打开 [飞书开放平台](https://open.feishu.cn/app)，登录后右上角「创建企业自建应用」。
2. 填名称（如 `lark-doc-proxy`）、描述、上传 logo。
3. 进入应用 → **权限管理**，搜索并勾选权限：
   - `docx:document:readonly`（读 docx 文档）
   - `wiki:wiki:readonly`（读 wiki 节点）
   - `docx:document:create`（创建新版文档）
   - `docs:document:import`（把 Markdown 导入为飞书文档）
4. 进入 **安全设置** → **重定向 URL**，先填一个临时占位 `https://example.com/`（等 Worker 部署后再回来改）。
5. 进入 **应用发布** → 创建版本 → 提交审核（企业管理员审批通过后才能用）。
6. 在应用首页拿到 **App ID** 和 **App Secret**，下一步要用。

---

## B. 部署 Cloudflare Worker（你来做，5 分钟）

前置：装 `wrangler`，登录。
```bash
npm install -g wrangler
wrangler login
```

进项目目录：
```bash
cd "/Users/spin/Library/Mobile Documents/com~apple~CloudDocs/Codex/feishu-to-getnote-v2-codex"
```

### B1. 创建 KV namespace
```bash
npx --yes wrangler@3.114.14 kv namespace create SESSIONS
```
输出会有一行像：
```
binding = "SESSIONS", id = "abc123..."
```
**把这个 `id` 复制，替换 `wrangler.toml` 里的 `REPLACE_WITH_YOUR_KV_ID`。**

### B2. 写入 secrets
```bash
npx --yes wrangler@3.114.14 secret put LARK_APP_ID --config worker/wrangler.toml
# 提示输入时粘飞书 App ID

npx --yes wrangler@3.114.14 secret put LARK_APP_SECRET --config worker/wrangler.toml
# 提示输入时粘飞书 App Secret
```

### B3. 部署
```bash
npx --yes wrangler@3.114.14 deploy worker/src/index.js --config worker/wrangler.toml
```
输出会给出 Worker URL，形如：
```
https://lark-doc-proxy.<your-subdomain>.workers.dev
```
**把这个 URL 记下来**——下一步要填回飞书后台 + 插件设置。

### B4. 回飞书后台改重定向 URL
回 A 步的「重定向 URL」，把占位 `https://example.com/` 改成：
```
https://lark-doc-proxy.<your-subdomain>.workers.dev/oauth/callback
```
保存。

---

## C. 安装 Chrome 插件（每个用户，2 分钟）

### C1. 加载插件
1. 打开 Chrome，地址栏访问 `chrome://extensions`。
2. 右上角打开「开发者模式」。
3. 点「加载已解压的扩展程序」，选 `/Users/spin/Library/Mobile Documents/com~apple~CloudDocs/Codex/feishu-to-getnote-v2-codex/extension/` 目录。
4. 插件出现在工具栏（蓝色方块图标，因为还没换 logo）。

### C2. 配置
1. 点插件图标 → 「设置」，或右键 → 选项。
2. 填 **Worker URL**（B3 部署得到的），点「保存」。
3. 点「登录飞书」，弹出飞书授权页 → 同意 → 自动回跳，状态变 "已登录"。
4. 填 **Get 笔记 API Key** + **Client ID**（在 [Get 笔记开放平台](https://www.biji.com/openapi) 创建应用获取），点「保存」。

### C3. 使用
1. 浏览器打开任意飞书文档（`https://xxx.feishu.cn/docx/...` 或 `/wiki/...`）或普通网页文章。
2. 点工具栏插件图标。
3. 选择「保存到 Get 笔记」「保存为飞书文档」或「飞书 + Get 都保存」。
4. 成功后弹窗会显示飞书文档链接或 Get `note_id`。

---

## D. 团队分发

代码同步给团队成员，每人重复 C 步即可（Worker + 飞书应用是团队共享的，每人只走自己的 OAuth 授权 + 自己的 Get 笔记 API Key）。

未来打包成 .crx 上架内部商店可以省 C1，但 P0 用「加载已解压」就够了。

---

## E. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 登录飞书后没回跳 | Worker 部署有问题 / 重定向 URL 没改 | 看 `wrangler tail` 实时日志 |
| 「session 失效，请重新登录」 | refresh_token 也过期了（30天） | 重新点「登录飞书」 |
| 「飞书拉取失败：state_expired_or_invalid」 | OAuth state 10 分钟过期 | 重新点「登录飞书」 |
| 「Get 笔记写入失败」 | API Key 错 / 超过限流 | 检查 Key；如果是限流（<2 QPS）等一分钟再试 |
| 「飞书文档写入失败：权限不足」 | 飞书应用未开创建/导入权限，或用户未重新授权 | 在飞书开放平台添加 `docx:document:create`、`docs:document:import`，发布后重新点「登录飞书」 |
| 表格 / 复杂块导入后是占位注释 | P0 有意省略 | 在 `lib/feishu-md.js` 扩 `renderTable` |
| 图片没有 | P0 不导图片 | 已知边界，第二版再说 |

实时看 Worker 日志：
```bash
cd "/Users/spin/Library/Mobile Documents/com~apple~CloudDocs/Codex/feishu-to-getnote-v2-codex"
npx --yes wrangler@3.114.14 tail --config worker/wrangler.toml
```
