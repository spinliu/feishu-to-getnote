export async function readArticleFromTab({ tabId, url }) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractArticleFromPage,
  });
  const content = result?.result;
  if (!content?.ok) {
    throw new Error(content?.error || '未能从当前页面提取文章正文');
  }
  return {
    ...content,
    sourceType: 'web-article',
    sourceUrl: url || content.sourceUrl,
  };
}

function extractArticleFromPage() {
  const bySelector = selector => document.querySelector(selector);
  const pickText = selector => (bySelector(selector)?.textContent || '').trim();
  const sourceUrl = location.href;
  const siteName = meta('og:site_name') || location.hostname;
  const title =
    meta('og:title') ||
    pickText('article h1') ||
    pickText('main h1') ||
    pickText('h1') ||
    document.title ||
    'Untitled';
  const author =
    meta('author') ||
    pickText('[rel=author]') ||
    pickText('.author') ||
    pickText('.byline') ||
    '';
  const publishedAt =
    meta('article:published_time') ||
    bySelector('time')?.getAttribute('datetime') ||
    pickText('time') ||
    '';

  const root =
    bySelector('article') ||
    bySelector('main') ||
    largestTextBlock() ||
    document.body;

  const markdown = nodeToMarkdown(root).replace(/\n{3,}/g, '\n\n').trim();
  if (!markdown || markdown.length < 80) {
    return { ok: false, error: '正文太短，可能不是文章页或被页面脚本保护' };
  }

  const images = Array.from(root.querySelectorAll('img'))
    .map(img => ({
      src: img.currentSrc || img.src || img.getAttribute('data-src') || '',
      alt: img.alt || '',
      kind: 'inline',
    }))
    .filter(img => img.src)
    .slice(0, 30);

  return {
    ok: true,
    title: clean(title),
    sourceUrl,
    author: clean(author),
    siteName: clean(siteName),
    publishedAt: clean(publishedAt),
    markdown: `# ${clean(title)}\n\n${markdown}\n\n> 来源：${sourceUrl}`,
    images,
    metadata: { extraction: 'dom' },
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

    const text = () => Array.from(node.childNodes).map(nodeToMarkdown).join('').trim();

    if (/h[1-6]/.test(tag)) {
      const level = Number(tag[1]);
      return `\n\n${'#'.repeat(level)} ${clean(node.innerText)}\n\n`;
    }
    if (tag === 'p') return `\n\n${text()}\n\n`;
    if (tag === 'br') return '\n';
    if (tag === 'blockquote') return `\n\n> ${clean(node.innerText).replace(/\n/g, '\n> ')}\n\n`;
    if (tag === 'pre') return `\n\n\`\`\`\n${node.innerText.trim()}\n\`\`\`\n\n`;
    if (tag === 'code') return `\`${clean(node.innerText)}\``;
    if (tag === 'strong' || tag === 'b') return `**${text()}**`;
    if (tag === 'em' || tag === 'i') return `*${text()}*`;
    if (tag === 'a') {
      const label = text() || clean(node.href);
      return node.href ? `[${label}](${node.href})` : label;
    }
    if (tag === 'img') {
      const src = node.currentSrc || node.src || node.getAttribute('data-src') || '';
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
}
