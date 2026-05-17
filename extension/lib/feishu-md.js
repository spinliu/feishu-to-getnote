// feishu blocks → markdown
// 飞书 docx block_type 参考：
//   1 page, 2 text(paragraph), 3-11 heading1-9, 12 bullet, 13 ordered, 14 code,
//   15 quote, 17 todo, 19 callout, 22 divider, 27 image, 31 table, 32 table_cell
// 设计原则：P0 覆盖文字类，图片/嵌入式块用注释占位，不报错。

export function blocksToMarkdown(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return '';

  // 建索引 + parent→children 顺序
  const byId = new Map();
  for (const b of blocks) byId.set(b.block_id, b);
  const rootId = blocks[0].block_id; // page block 一定在最前

  const lines = [];
  walk(byId, rootId, lines, /*depth=*/ 0, /*orderedCounters=*/ []);
  // 折叠超过 2 个的空行
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function walk(byId, id, lines, depth, orderedCounters) {
  const b = byId.get(id);
  if (!b) return;
  const t = b.block_type;

  // 渲染当前块（page 本身不渲染，只递归 children）
  if (t !== 1) {
    const md = renderBlock(b, depth, orderedCounters);
    if (md !== null) {
      lines.push(md);
      // 块级元素后追加空行（除了相邻同类列表项之间，那个由列表内部不空行处理）
      if (!isListItem(t)) lines.push('');
    }
  }

  // 列表项的 children 需要缩进；其它块的 children 直接平铺
  const children = b.children || [];
  if (children.length === 0) return;

  // 有序列表在同一父级下要连续编号，所以传入计数器
  const childDepth = isListItem(t) ? depth + 1 : depth;
  let counter = 0;
  for (const cid of children) {
    const child = byId.get(cid);
    if (child?.block_type === 13) counter++;
    walk(byId, cid, lines, childDepth, child?.block_type === 13 ? [...orderedCounters, counter] : orderedCounters);
  }
}

function isListItem(t) {
  return t === 12 || t === 13 || t === 17;
}

function renderBlock(b, depth, _orderedCounters) {
  const t = b.block_type;
  const indent = '  '.repeat(depth);

  // 标题 3-11 = h1-h9
  if (t >= 3 && t <= 11) {
    const level = t - 2;
    return `${'#'.repeat(Math.min(level, 6))} ${textOf(b['heading' + level])}`;
  }

  switch (t) {
    case 2:  return `${indent}${textOf(b.text)}`;
    case 12: return `${indent}- ${textOf(b.bullet)}`;
    case 13: return `${indent}1. ${textOf(b.ordered)}`;
    case 17: {
      const done = b.todo?.style?.done ? 'x' : ' ';
      return `${indent}- [${done}] ${textOf(b.todo)}`;
    }
    case 14: {
      const lang = LANG_MAP[b.code?.style?.language] || '';
      const code = textOf(b.code, /*plain=*/ true);
      return `\n\`\`\`${lang}\n${code}\n\`\`\``;
    }
    case 15: return `> ${textOf(b.quote)}`;
    case 19: return `> ${textOf(b.callout) || '(callout)'}`;
    case 22: return `---`;
    case 27: return `<!-- image omitted (P0 不导图片) -->`;
    case 31: return renderTable(b);
    case 32: return null; // table cell 由 renderTable 处理
    case 34: return ''; // quote_container 用空字符串占位，children 自己渲染
    default: {
      const fallback = textOf(b[Object.keys(b).find(k => b[k]?.elements)] || {});
      return fallback ? `${indent}${fallback}` : `<!-- unsupported block_type=${t} -->`;
    }
  }
}

function renderTable(b) {
  const prop = b.table?.property;
  if (!prop) return '<!-- empty table -->';
  const cols = prop.column_size || 0;
  const cellIds = prop.merge_info ? null : null; // 暂不处理合并
  const cells = b.table?.cells || []; // children 是 cell block_id 列表
  if (!cols || cells.length === 0) return '<!-- empty table -->';
  // P0 简化：单元格文本由调用方在外层 walk 处理。
  // 这里只画一个空骨架；真正内容由 children walking 填——但 markdown 表格不能跨行写。
  // 因此 P0 直接降级：表格转成"列对齐的代码块"承载文本，保结构不丢内容。
  return `<!-- table ${cells.length} cells × ${cols} cols (P0 表格降级为占位，复杂表格手动处理) -->`;
}

// 飞书 code language 枚举 → markdown fence 语言
const LANG_MAP = {
  1: '', 2: 'abap', 3: 'ada', 4: 'apache', 5: 'apex', 6: 'asm', 7: 'bash', 8: 'csharp',
  9: 'cpp', 10: 'c', 11: 'cobol', 12: 'css', 13: 'cuda', 14: 'dart', 15: 'delphi',
  16: 'django', 17: 'dockerfile', 18: 'erlang', 19: 'fortran', 21: 'go', 22: 'groovy',
  23: 'html', 24: 'haskell', 25: 'json', 26: 'java', 27: 'javascript', 28: 'julia',
  29: 'kotlin', 30: 'latex', 31: 'lisp', 33: 'lua', 34: 'matlab', 35: 'makefile',
  36: 'markdown', 37: 'nginx', 38: 'objectivec', 39: 'openedge', 40: 'php', 41: 'perl',
  42: 'powershell', 43: 'prolog', 44: 'protobuf', 45: 'python', 46: 'r', 47: 'rpg',
  48: 'ruby', 49: 'rust', 50: 'sas', 51: 'scala', 52: 'scheme', 53: 'scratch', 54: 'shell',
  55: 'sql', 56: 'stata', 57: 'swift', 58: 'thrift', 59: 'typescript', 60: 'vbnet',
  61: 'vba', 62: 'xml', 63: 'yaml', 64: 'cmake', 65: 'diff', 66: 'gherkin', 67: 'graphql',
  68: 'opengl', 69: 'openqasm', 70: 'tcl', 71: 'verilog', 72: 'vhdl', 73: 'solidity',
};

// 把飞书 text 节点（带 elements: text_run[]）展平为 markdown 字符串
function textOf(node, plain = false) {
  if (!node) return '';
  const elements = node.elements || [];
  if (elements.length === 0) return '';
  return elements.map(el => renderElement(el, plain)).join('');
}

function renderElement(el, plain) {
  if (el.text_run) {
    const tr = el.text_run;
    let s = tr.content || '';
    if (plain) return s;
    const st = tr.text_element_style || {};
    if (st.inline_code) s = '`' + s + '`';
    if (st.bold) s = '**' + s + '**';
    if (st.italic) s = '*' + s + '*';
    if (st.strikethrough) s = '~~' + s + '~~';
    if (st.underline) s = '<u>' + s + '</u>';
    if (st.link?.url) s = `[${s}](${decodeURIComponent(st.link.url)})`;
    return s;
  }
  if (el.equation) return `$${el.equation.content || ''}$`;
  if (el.mention_user) return `@${el.mention_user.user_id || ''}`;
  if (el.mention_doc)  return `[${el.mention_doc.title || 'doc'}](${el.mention_doc.url || ''})`;
  return '';
}
