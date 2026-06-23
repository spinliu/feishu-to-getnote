# feishu-getnote v2

> **5 秒看懂**：浏览器里看飞书文档或网页文章 → 点一下插件 → 保存到 Get 笔记、飞书文档，或两边都保存。
>
> - 📖 **团队成员看这里**：[安装使用指南](docs/install-guide.md)
> - 🔧 **想了解怎么造的**：[工程回顾](docs/engineering-retro.md)
> - 🚀 **部署 / 维护 Worker**：[DEPLOY.md](DEPLOY.md)

---

一键把飞书文档 / 普通网页文章导入到 Get 笔记或飞书文档的 Chrome 插件。OAuth 走 Cloudflare Worker 代理藏 app_secret，网页文章在插件侧抽取正文，飞书文档通过 Worker 代拉 blocks。

## 架构

```
Chrome 插件 (MV3)
   │  popup 「保存到 Get 笔记」/「保存为飞书文档」/「飞书 + Get 都保存」
   │  options 「Worker URL」+「飞书登录」+「Get 笔记 API Key」
   │
   ├─ Get 笔记 OpenAPI
   │    - web link 优先，失败后清图片正文兜底
   │
   ↓ (飞书读写代理)
Cloudflare Worker (lark-doc-proxy)
   │  /oauth/start, /oauth/callback, /api/doc, /api/feishu/doc/create
   │  藏 LARK_APP_ID + LARK_APP_SECRET
   │  KV 存 session → tokens
   │
   ↓ (调飞书 API)
飞书 OpenAPI
   - wiki/v2/spaces/get_node      (wiki token → docx token)
   - docx/v1/documents/:id        (取标题)
   - docx/v1/documents/:id/blocks (分页拉 blocks)
   - docs_ai/v1/documents         (Markdown 导入为飞书文档)
```

插件拿到内容后统一为 Markdown：写 Get 时会清理第三方图片并处理限流；写飞书时由 Worker 调飞书导入接口创建 Docx，并把文章图片追加为飞书原生图片块。

## P1 体验

- 重复保存去重：同一 URL 同一目标 30 天内会提示已保存过，可手动再次保存；飞书文档历史链接若已删除或不可读，会自动清掉记录并重新保存。
- 批量保存：弹窗可把当前窗口里的普通网页 / 公众号页面批量保存为 Get 链接笔记。
- 失败日志：设置页展示最近保存记录，便于排查 Get 限流、飞书权限、抽取失败等问题。
- 微信公众号正文：优先从当前页面 DOM 抽取正文并保存为飞书文档，页面限制导致失败时再尝试 `/api/extract` 后端兜底。
- 公众号 / 网页图片转存：保存为飞书文档时会提取正文图片，最多 20 张按正文位置插入为飞书原生图片块，并在弹窗显示插入数量。

## 设计原则

- **代理只做飞书侧**，Get API Key 仍只存在用户本机浏览器里。
- **Token 不出 Worker**：session key 给前端，access/refresh token 全部在 KV 里，Worker 端自动 refresh。
- **先跑通正文闭环，再补媒体**：Get 仍优先避开第三方图片外链；飞书文档路径已进入图片转存 P1。

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
  lib/source/       飞书文档 / 网页文章 / 后端抽取 source adapters
  lib/destination/  Get 笔记 / 飞书文档 destination adapters
  lib/feishu-md.js  blocks → markdown 转换
  icons/            插件图标
DEPLOY.md           部署 + 安装步骤
```

## 部署

见 `DEPLOY.md`。

## 已知边界

- Get 笔记路径仍会清理第三方图片；飞书文档路径会尝试把最多 20 张文章图片转为原生图片块，并优先插入到原文对应位置
- Get 笔记限流 <2 QPS，<5000 req 总量；插件已做基础节流和重试
- Get 笔记单条笔记上限未知，超大文档可能需要后续分片
- Mermaid / LaTeX 渲染粒度依赖 Get 笔记客户端
- 若第三方图片站点反盗链，飞书侧图片导入可能失败；弹窗会显示失败数量
- 微信公众号后端抽取 `/api/extract` 仍是外部服务边界，当前仅作为 DOM 抽取失败后的兜底
- 批量保存当前只走 Get 链接笔记，不做批量正文抽取
