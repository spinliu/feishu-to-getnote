# feishu-getnote

> **5 秒看懂**：浏览器里看任意飞书文档 → 点一下插件图标 → 文档 markdown 自动进你的 Get 笔记。
>
> - 📖 **团队成员看这里**：[安装使用指南](docs/install-guide.md)
> - 🔧 **想了解怎么造的**：[工程回顾](docs/engineering-retro.md)
> - 🚀 **部署 / 维护 Worker**：[DEPLOY.md](DEPLOY.md)

---

一键把飞书文档导入到 Get 笔记的 Chrome 插件。OAuth 走 Cloudflare Worker 代理藏 app_secret，blocks 在前端转 markdown 后直灌 Get 笔记 OpenAPI。

## 架构

```
Chrome 插件 (MV3)
   │  popup 「导入到 Get 笔记」按钮
   │  options 「飞书登录」+「Get 笔记 API Key」
   │
   ↓ (调代理拉飞书内容)
Cloudflare Worker (lark-doc-proxy)
   │  /oauth/start, /oauth/callback, /api/doc
   │  藏 LARK_APP_ID + LARK_APP_SECRET
   │  KV 存 session → tokens
   │
   ↓ (调飞书 API)
飞书 OpenAPI
   - wiki/v2/spaces/get_node      (wiki token → docx token)
   - docx/v1/documents/:id        (取标题)
   - docx/v1/documents/:id/blocks (分页拉 blocks)
```

插件拿到 blocks 后在前端用 `lib/feishu-md.js` 转 markdown，再调 Get 笔记 OpenAPI 直接灌入。

## 设计原则

- **代理只做飞书侧**，不沾下游笔记 API。未来 feishu-Obsidian 等插件可零修改复用同一个 Worker。
- **Token 不出 Worker**：session key 给前端，access/refresh token 全部在 KV 里，Worker 端自动 refresh。
- **P0 不做语法预处理**：Get 笔记的 Markdown 已实测渲染粒度够，直接灌。

## 目录

```
worker/             Cloudflare Worker
  wrangler.toml
  src/index.js
extension/          Chrome MV3 插件
  manifest.json
  popup.html / popup.js
  options.html / options.js
  background.js
  lib/feishu-md.js  blocks → markdown 转换
  icons/            插件图标
DEPLOY.md           部署 + 安装步骤
```

## 部署

见 `DEPLOY.md`。

## 已知边界

- 只导文字，不处理图片（第一版有意省略）
- Get 笔记限流 <2 QPS，<5000 req 总量
- Get 笔记单条笔记上限未知，超大文档可能需要后续分片
- Mermaid / LaTeX 渲染粒度依赖 Get 笔记客户端
