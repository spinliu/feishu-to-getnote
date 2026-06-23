# v2 Runtime Validation

Date: 2026-06-22 13:48 +08
Branch: `codex/v2-content-router`

## Summary

The v2 content router is validated for the core P0 flows:

- `普通网页 -> Get 笔记`
- `普通网页 -> 飞书文档`
- `普通网页 -> 飞书 + Get 都保存`

The Worker is deployed at `https://lark-doc-proxy.spin-liu.workers.dev`, Feishu OAuth is working against the intended app, and real browser validation returned both a Feishu Docx URL and a Get `note_id`.

## Environment

- Node.js: `v20.20.2`
- `wrangler@latest`: not usable because Wrangler 4 requires Node.js 22+
- Local Worker validation used temporary `npx wrangler@3.114.14`
- Local Worker URL: `http://localhost:8787`

## Checks Passed

Syntax/static checks:

```bash
node --check extension/background.js
node --check extension/popup.js
node --check extension/options.js
node --check worker/src/index.js
node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('manifest ok')"
```

Worker startup:

```bash
npx wrangler@3.114.14 dev worker/src/index.js --config worker/wrangler.toml --local --port 8787
```

Worker endpoint checks:

```bash
curl -i http://localhost:8787/health
curl -i http://localhost:8787/api/session
curl -i -X POST http://localhost:8787/api/extract \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/article"}'
curl -i -X POST http://localhost:8787/api/feishu/doc/create \
  -H 'content-type: application/json' \
  -d '{"title":"Test","markdown":"hello"}'
curl -i 'http://localhost:8787/oauth/start'
curl -i 'http://localhost:8787/oauth/start?redirect=http%3A%2F%2Fevil.test%2Fcb'
curl -i -X OPTIONS http://localhost:8787/api/doc
```

Observed results:

| Check | Result |
|---|---|
| `/health` | `200`, `ok: true`; local KV binding present; optional extractor/write APIs unset |
| `/api/session` without auth | `401 missing_session` |
| `/api/session` with fake valid KV session | `200 ok` |
| `/api/session` with fake missing KV session | `401 session_invalid` |
| `/api/extract` without `EXTRACTOR_API_URL` | `501 extractor_not_configured` |
| `/api/feishu/doc/create` without auth | `401 missing_session` |
| `/api/feishu/doc/create` with fake session but no write API URL | `501 feishu_write_not_configured` |
| `/api/feishu/doc/create` with empty markdown | `400 missing_markdown` |
| `/oauth/start` without redirect | `400 missing_redirect` |
| `/oauth/start` without OAuth secrets | `501 lark_app_id_not_configured` |
| `/oauth/start` with non-HTTPS/non-Chrome redirect | `403 bad_redirect` |
| `OPTIONS /api/doc` | `200 ok` |

Follow-up checks added in the 2026-06-22 continuation sessions:

```bash
curl -i 'http://localhost:8787/oauth/start'
curl -i 'http://localhost:8787/oauth/start?redirect=http%3A%2F%2Fevil.test%2Fcb'
curl -i 'http://localhost:8787/oauth/start?redirect=https%3A%2F%2Fabc.chromiumapp.org%2F'
```

Observed results with local secrets intentionally unset:

| Check | Result |
|---|---|
| `/oauth/start` without redirect | `400 missing_redirect` |
| `/oauth/start` with non-HTTPS/non-Chrome redirect | `403 bad_redirect` |
| `/oauth/start` with allowed Chrome redirect but missing OAuth secrets | `501 lark_app_id_not_configured` |

Implementation note: `/oauth/start` now validates the redirect input before checking OAuth secret configuration, so malformed caller input is not hidden by deployment configuration errors.

## Get Note Write Follow-up

2026-06-22 group validation found a narrower failure in the ordinary web page -> Get path:

- Get API Key / Client ID validation passed.
- DOM article extraction passed.
- The request reached the real Get API.
- Get rejected `plain_text` content containing third-party image URLs with an image parsing error.

Result classification: `PARTIAL PASS`. Authorization, extraction, and real API reachability are proven; the failure is content-format handling.

The extension now matches the `getnote-cli` behavior more closely:

- Non-Feishu web sources first save to Get as `note_type: "link"` with `link_url: content.sourceUrl`.
- If link save fails, the extension falls back to `note_type: "plain_text"` after stripping Markdown image syntax and bare image URLs.
- Feishu document sources continue to save as `plain_text`, also with image cleanup, because private Feishu URLs should not be handed to Get as public link notes.

Local mock validation passed for link save, link-to-plain-text fallback, and Feishu plain-text behavior:

```bash
node --check extension/lib/destination/getnote-destination.js
node --input-type=module <mock saveToGetnote checks>
```

## Feishu Document Write Follow-up

After Get write passed with a real `note_id`, the next P0 path is ordinary web page -> Feishu document.

Implementation update:

- Worker `/api/feishu/doc/create` now has a built-in path and no longer requires `FEISHU_DOC_CREATE_API_URL`.
- The built-in path calls `POST /open-apis/docs_ai/v1/documents` with `{ content, format: "markdown" }`.
- OAuth scope list now includes `docx:document:create` and `docs:document:import` in addition to the existing read scopes.
- Markdown image syntax is stripped before import for P0 stability; image preservation remains a later media-upload task.
- Extension Feishu destination now requires a returned document URL or `documentId` before showing success.

Local mock validation passed:

```bash
node --check worker/src/index.js
node --check extension/lib/destination/feishu-destination.js
node --input-type=module <mock /api/feishu/doc/create checks>
```

Real validation pending:

1. Deploy the Worker update.
2. Add the new scopes in the Feishu developer console and publish/approve the app version.
3. Re-login from the extension so the user session receives the new scopes.
4. Test `普通网页 -> 飞书文档` and then `飞书 + Get 都保存`.

Deployment attempt:

- `npx --yes wrangler@3.114.14 --version` passed.
- `wrangler login` was completed by the user, and `wrangler whoami` confirmed OAuth access for `spin.liu@gmail.com`.
- The first `wrangler deploy` after login failed while fetching account memberships.
- Added the confirmed Cloudflare `account_id` to `worker/wrangler.toml`, then redeployed successfully.
- Worker URL: `https://lark-doc-proxy.spin-liu.workers.dev`
- Version ID: `c2e51446-f0d2-437f-85c1-148f22ab5a9f`
- Local `wrangler dev --local --port 8788` started successfully.
- Local `/health` returned `200`.
- Local `/api/feishu/doc/create` without auth returned `401 missing_session`, confirming the endpoint is active and no longer returns the old `501 feishu_write_not_configured` placeholder.
- Online `/health` returned `200` after deployment.
- Online `/api/feishu/doc/create` without auth returned `401 missing_session`, confirming the deployed endpoint is active and no longer returns the old `501 feishu_write_not_configured` placeholder.
- OAuth validation initially exposed a Cloudflare secret mismatch: the deployed Worker was still using `client_id=cli_aa837f4bb9badcc5`.
- Updated online Worker secrets `LARK_APP_ID` and `LARK_APP_SECRET` to match the intended Feishu app.
- Rechecked `/oauth/start`; it now redirects with `client_id=cli_aaa7b842c7385cdc` and the expected write scopes.
- User re-authenticated successfully from the extension after fixing App ID and redirect URL configuration.
- Real `普通网页 -> 飞书文档` validation passed. The popup returned a Feishu Docx URL for the Sina article.
- Get write later hit the documented rate limit (`请求频率超限，请稍后重试`). The extension now throttles Get write calls and retries rate-limit responses before surfacing an error.

## Chrome Validation Status

Attempted to initialize the Codex Chrome backend from this session. It returned:

```text
Browser is not available: extension
```

Per Chrome troubleshooting guidance, a retry after 2 seconds returned the same result.

Read-only local checks:

| Check | Result |
|---|---|
| Chrome installed | yes, Google Chrome `149.0.7827.115` |
| Chrome running | yes |
| Codex Chrome Extension | installed and enabled in selected `Default` profile |
| Native host manifest | exists and allows the expected extension origin |

Conclusion: the machine-level Chrome setup appears healthy, but this C4/Codex session is not bound to the Chrome extension backend. Real extension load/click validation must run in a browser-capable Codex session, or after the user opens a Chrome window for the selected profile and explicitly asks to retry.

## Final P0 Regression

Run on 2026-06-22 after real browser validation:

```bash
find extension worker/src -name '*.js' -print0 | xargs -0 -n1 node --check
node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('manifest ok')"
curl -s https://lark-doc-proxy.spin-liu.workers.dev/health
curl -s -i -X POST https://lark-doc-proxy.spin-liu.workers.dev/api/feishu/doc/create \
  -H 'content-type: application/json' \
  -d '{"title":"Test","markdown":"# Test\n\nhello"}'
node --input-type=module <mock getnote rate-limit retry>
node --input-type=module <mock getnote link fallback>
node --input-type=module <mock feishu doc create>
```

Results:

| Check | Result |
|---|---|
| JS syntax checks | pass |
| `extension/manifest.json` parse | pass |
| Online `/health` | `200 ok` |
| Online `/api/feishu/doc/create` without auth | `401 missing_session`, expected auth boundary |
| Get rate-limit retry mock | pass |
| Get link-to-plain-text fallback mock | pass |
| Feishu Docx create mock | pass |
| Real `普通网页 -> Get` | pass, returned real `note_id` |
| Real `普通网页 -> 飞书文档` | pass, returned Feishu Docx URL |
| Real `普通网页 -> 飞书 + Get 都保存` | pass, returned Feishu Docx URL and real Get `note_id` |

## Remaining P1 Work

Implemented after opening draft PR #1:

- Repeated save de-duplication for the same URL + destination, with a manual force-save button.
- Batch save for ordinary web / WeChat tabs in the current Chrome window to Get link notes.
- Local recent save/failure log in the settings page.
- WeChat article single-save now uses current-tab DOM extraction first, with `/api/extract` only as a fallback. This makes `微信公众号 -> 飞书文档` independent from a configured extractor service when the article is already visible in Chrome.
- WeChat DOM formatting now treats `section` / `div` / `p` nodes as Markdown paragraphs and normalizes blank lines so imported Feishu docs are easier to read.
- Feishu duplicate detection now checks whether the historical Docx URL/token is still readable. If it has been deleted or is no longer readable, the local history entry is removed and the document is saved again.

Validation:

```bash
find extension worker/src -name '*.js' -print0 | xargs -0 -n1 node --check
node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('manifest ok')"
node --input-type=module <mock save-state checks>
node --input-type=module <static WeChat route checks>
node --input-type=module <static WeChat formatting checks>
node --input-type=module <static Feishu stale duplicate checks>
```

Remaining:

1. Test and harden `飞书文档 -> Get` after the v2 routing refactor.
2. Decide whether `/api/extract` remains an external service boundary or gets a concrete trusted extractor service URL for DOM extraction failures.
3. Add image preservation via upload/transfer instead of P0 image stripping.
4. Add configurable Feishu destination folder.
5. Add success action buttons for opening the created Feishu document and locating Get notes where supported.
