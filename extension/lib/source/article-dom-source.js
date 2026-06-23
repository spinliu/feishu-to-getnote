export async function readArticleFromTab({ tabId, url, sourceType = 'web-article' }) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractArticleFromPage,
    args: [sourceType],
  });
  const content = result?.result;
  if (!content?.ok) {
    throw new Error(content?.error || '未能从当前页面提取文章正文');
  }
  return {
    ...content,
    sourceType,
    sourceUrl: url || content.sourceUrl,
  };
}

function extractArticleFromPage(sourceType) {
  const bySelector = selector => document.querySelector(selector);
  const pickText = selector => (bySelector(selector)?.textContent || '').trim();
  const isWeChat = sourceType === 'wechat-article' || location.hostname === 'mp.weixin.qq.com';
  const sourceUrl = location.href;
  const siteName = meta('og:site_name') || location.hostname;
  const title =
    (isWeChat ? pickText('#activity-name') : '') ||
    meta('og:title') ||
    pickText('article h1') ||
    pickText('main h1') ||
    pickText('h1') ||
    document.title ||
    'Untitled';
  const author =
    (isWeChat ? pickText('#js_name') : '') ||
    meta('author') ||
    pickText('[rel=author]') ||
    pickText('.author') ||
    pickText('.byline') ||
    '';
  const publishedAt =
    (isWeChat ? pickText('#publish_time') : '') ||
    meta('article:published_time') ||
    bySelector('time')?.getAttribute('datetime') ||
    pickText('time') ||
    '';

  const root =
    (isWeChat ? bySelector('#js_content') : null) ||
    bySelector('article') ||
    bySelector('main') ||
    largestTextBlock() ||
    document.body;

  const markdown = normalizeMarkdown(nodeToMarkdown(root));
  const minLength = isWeChat ? 30 : 80;
  if (!markdown || markdown.length < minLength) {
    return { ok: false, error: '正文太短，可能不是文章页或被页面脚本保护' };
  }

  const images = Array.from(root.querySelectorAll('img'))
    .map(img => ({
      src: imageSrc(img),
      alt: img.alt || '',
      kind: 'inline',
    }))
    .filter(img => img.src)
    .filter((img, index, all) => all.findIndex(other => other.src === img.src) === index)
    .slice(0, 30);

  return {
    ok: true,
    title: clean(title),
    sourceUrl,
    author: clean(author),
    siteName: clean(siteName),
    publishedAt: clean(publishedAt),
    markdown: buildMarkdown({ title, author, publishedAt, markdown, sourceUrl, isWeChat }),
    images,
    metadata: { extraction: 'dom', extractor: isWeChat ? 'wechat-dom' : 'generic-dom' },
  };

  function meta(name) {
    const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
    return (el?.content || '').trim();
  }

  function largestTextBlock() {
    const candidates = Array.from(document.querySelectorAll('article, main, section, div'))
      .filter(el => !isHidden(el))
      .map(el => ({ el, len: (el.innerText || '').trim().length }))
      .filter(x => x.len > 200)
      .sort((a, b) => b.len - a.len);
    return candidates[0]?.el || null;
  }

  function nodeToMarkdown(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return clean(node.textContent || '');
    if (node.nodeType !== Node.ELEMENT_NODE || isHidden(node)) return '';

    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'nav', 'footer', 'header', 'aside', 'form', 'button'].includes(tag)) return '';

    const text = () => normalizeInline(Array.from(node.childNodes).map(nodeToMarkdown).join(''));

    if (/h[1-6]/.test(tag)) {
      const level = Number(tag[1]);
      return `\n\n${'#'.repeat(level)} ${clean(node.innerText)}\n\n`;
    }
    if (['p', 'div', 'section'].includes(tag)) return paragraph(text());
    if (tag === 'br') return '\n';
    if (tag === 'blockquote') return `\n\n> ${normalizeInline(node.innerText).replace(/\n/g, '\n> ')}\n\n`;
    if (tag === 'pre') return `\n\n\`\`\`\n${node.innerText.trim()}\n\`\`\`\n\n`;
    if (tag === 'code') return `\`${clean(node.innerText)}\``;
    if (tag === 'strong' || tag === 'b') return `**${text()}**`;
    if (tag === 'em' || tag === 'i') return `*${text()}*`;
    if (tag === 'a') {
      const label = text() || clean(node.href);
      return node.href ? `[${label}](${node.href})` : label;
    }
    if (tag === 'img') {
      const src = imageSrc(node);
      if (!src) return '';
      return `\n\n![${clean(node.alt || '')}](${src})\n\n`;
    }
    if (tag === 'li') return `\n- ${text()}`;
    if (tag === 'ul' || tag === 'ol') return `\n${text()}\n`;
    return Array.from(node.childNodes).map(nodeToMarkdown).join('');
  }

  function isHidden(el) {
    const style = window.getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden';
  }

  function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function paragraph(value) {
    const textValue = normalizeInline(value);
    if (!textValue || isNoiseParagraph(textValue)) return '';
    return `\n\n${textValue}\n\n`;
  }

  function normalizeInline(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalizeMarkdown(value) {
    return String(value || '')
      .split('\n')
      .map(line => line.replace(/[ \t]+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/([^\n])\n(#{1,6}\s+)/g, '$1\n\n$2')
      .trim();
  }

  function isNoiseParagraph(value) {
    return /^(?:[\s·•—_\-–|｜]+|阅读全文|继续滑动看下一个)$/i.test(value);
  }

  function imageSrc(img) {
    const raw = isWeChat
      ? (img.getAttribute('data-src') || img.currentSrc || img.src || '')
      : (img.currentSrc || img.src || img.getAttribute('data-src') || '');
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return '';
    try {
      return new URL(raw, location.href).toString();
    } catch {
      return '';
    }
  }

  function buildMarkdown(data) {
    const parts = [`# ${clean(data.title)}`];
    if (data.isWeChat) {
      const byline = [clean(data.author), clean(data.publishedAt)].filter(Boolean).join(' · ');
      if (byline) parts.push(`> ${byline}`);
    }
    parts.push(data.markdown);
    parts.push(`> 来源：${data.sourceUrl}`);
    return parts.filter(Boolean).join('\n\n');
  }
}
