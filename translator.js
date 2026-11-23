/**
 * Core DOM & String Translation Engine for ST-iPhonie Việt Hóa.
 * Pure, framework-agnostic so it runs both in browser and Node unit tests.
 */

export const CJK_RE = /[\u4e00-\u9fff]/;

// Selectors inside the phone iframe / ST-iPhonie overlays that hold RP text or user input.
export const SKIP_CONTENT_SELECTOR = [
  'script',
  'style',
  'noscript',
  'code',
  'pre',
  'textarea',
  'input',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '.m-body',
  '.m-quote',
  '.moment-text',
  '.moment-comment',
  '.floor-text',
  '.forum-text',
  '.forum-title',
  '.reading-content',
  '.reading-page',
  '.vn-cast-text > strong',
  '.log-row',
  '.stvi-skip',
].join(',');

export const TRANSLATABLE_ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-label', 'data-tip'];

const COMPOSITE_SEPARATORS = [
  { sep: ' · ', out: ' · ' },
  { sep: '·', out: ' · ' },
  { sep: '｜', out: ' | ' },
  { sep: ' | ', out: ' | ' },
  { sep: ' / ', out: ' / ' },
  { sep: '，', out: ', ' },
  { sep: '、', out: ', ' },
  { sep: '：', out: ': ' },
  { sep: ': ', out: ': ' },
  { sep: ' — ', out: ' — ' },
];
const TRAILING_PUNCT_RE = /^([\s\S]+?)([：:…？?！!。]+)$/;
const LEADING_PUNCT_RE = /^([·•\-:\s]+)([\s\S]+)$/;
const ZH_WEEKDAY = { '一': 'Thứ Hai', '二': 'Thứ Ba', '三': 'Thứ Tư', '四': 'Thứ Năm', '五': 'Thứ Sáu', '六': 'Thứ Bảy', '日': 'Chủ Nhật', '天': 'Chủ Nhật' };
const ZH_DATE_WEEKDAY_RE = /^(\d{1,2})月(\d{1,2})日\s*星期([一二三四五六日天])$/;
const ZH_FULL_DATE_RE = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/;

/**
 * Compile `{0}`, `{1}` template patterns into safe RegExp matchers.
 * Patterns with more literal characters are prioritized first.
 */
export function compilePatterns(patternEntries) {
  const compiled = [];
  for (const [rawPat, viTpl] of Object.entries(patternEntries || {})) {
    if (!rawPat || !viTpl) continue;
    // Escape regex special chars except {0}, {1}...
    const placeholders = [];
    const tokenized = rawPat.replace(/\{(\d+)\}/g, (_, idx) => {
      placeholders.push(Number(idx));
      return `\u0000PH${placeholders.length - 1}\u0000`;
    });
    const escaped = tokenized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regexStr = escaped.replace(/\u0000PH(\d+)\u0000/g, '([\\s\\S]+?)');
    try {
      const regex = new RegExp(`^${regexStr}$`);
      const literalWeight = rawPat.replace(/\{\d+\}/g, '').length;
      compiled.push({ rawPat, viTpl, regex, placeholders, literalWeight });
    } catch {
      // Skip malformed pattern defensively
    }
  }
  compiled.sort((a, b) => b.literalWeight - a.literalWeight || b.rawPat.length - a.rawPat.length);
  return compiled;
}

export function createTranslator({ exact = {}, patterns = {}, onMissing = null } = {}) {
  const exactMap = new Map(Object.entries(exact));
  const compiledPatterns = compilePatterns(patterns);
  const originalTextMap = new WeakMap();
  const originalAttrMap = new WeakMap();
  const missingSet = new Set();

  function recordMissing(str) {
    if (!onMissing || !str || str.length > 180 || missingSet.has(str)) return;
    if (missingSet.size < 500) {
      missingSet.add(str);
      onMissing(str);
    }
  }

  function translateCore(core, depth = 0) {
    if (!core || !CJK_RE.test(core)) return core;

    const dw = ZH_DATE_WEEKDAY_RE.exec(core);
    if (dw) {
      return `${ZH_WEEKDAY[dw[3]] || dw[3]}, ${dw[2]} tháng ${dw[1]}`;
    }
    const fd = ZH_FULL_DATE_RE.exec(core);
    if (fd) {
      return `${fd[3]}/${fd[2]}/${fd[1]}`;
    }

    const exactHit = exactMap.get(core);
    if (exactHit !== undefined) return exactHit;

    // Try pattern matching
    for (const pat of compiledPatterns) {
      const m = pat.regex.exec(core);
      if (!m) continue;
      let out = pat.viTpl;
      // Map capture group i+1 to placeholder {placeholders[i]}
      const capturedByIdx = new Map();
      for (let i = 0; i < pat.placeholders.length; i++) {
        const val = m[i + 1] ?? '';
        const translatedVal = depth < 2 && CJK_RE.test(val) ? translateCore(val.trim(), depth + 1) : val;
        capturedByIdx.set(pat.placeholders[i], translatedVal);
      }
      out = out.replace(/\{(\d+)\}/g, (_, idx) => capturedByIdx.get(Number(idx)) ?? '');
      return out;
    }

    // Try stripping leading/trailing punctuation (e.g., "音色：" -> "Giọng đọc:", "· 缓存" -> "· Bộ nhớ đệm")
    if (depth < 2) {
      const lm = LEADING_PUNCT_RE.exec(core);
      if (lm) {
        const rest = lm[2].trim();
        const restHit = exactMap.get(rest);
        if (restHit !== undefined) return `${lm[1]}${restHit}`;
      }
      const pm = TRAILING_PUNCT_RE.exec(core);
      if (pm) {
        const inner = pm[1].trim();
        const punct = pm[2] === '：' ? ':' : pm[2] === '？' ? '?' : pm[2] === '！' ? '!' : pm[2] === '。' ? '.' : pm[2];
        const innerHit = exactMap.get(inner);
        if (innerHit !== undefined) return `${innerHit}${punct}`;
      }
    }

    // Try splitting composite UI strings (e.g., "豆包语音 · 未连接", "GPT 生图，点一下抽到最前面")
    if (depth < 2) {
      for (const { sep, out } of COMPOSITE_SEPARATORS) {
        if (!core.includes(sep)) continue;
        const parts = core.split(sep);
        let changed = false;
        const outParts = parts.map((p) => {
          const trimmed = p.trim();
          if (!trimmed || !CJK_RE.test(trimmed)) return p.trim();
          const tr = translateCore(trimmed, depth + 1);
          if (tr !== trimmed) changed = true;
          return tr;
        });
        if (changed) {
          return outParts.join(out).replace(/\s+([,.:;!?])/g, '$1').trim();
        }
      }
    }

    recordMissing(core);
    return core;
  }

  function translateString(raw) {
    if (typeof raw !== 'string' || !raw || !CJK_RE.test(raw)) return raw;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
    if (!m) return raw;
    const [, lead, core, trail] = m;
    if (!core || !CJK_RE.test(core)) return raw;
    const translated = translateCore(core, 0);
    if (translated === core) return raw;
    return `${lead}${translated}${trail}`;
  }

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return true;
    return !!el.closest?.(SKIP_CONTENT_SELECTOR);
  }

  function translateTextNode(node) {
    if (!node || node.nodeType !== 3) return false;
    const val = node.nodeValue;
    if (!val || !CJK_RE.test(val)) return false;
    if (shouldSkipElement(node.parentElement)) return false;

    const parent = node.parentElement;
    if (parent && parent.tagName === 'OPTION' && !parent.hasAttribute('value')) {
      parent.value = parent.textContent;
    }

    const next = translateString(val);
    if (next !== val) {
      if (!originalTextMap.has(node)) originalTextMap.set(node, val);
      node.nodeValue = next;
      return true;
    }
    return false;
  }

  function translateAttributes(el) {
    if (!el || el.nodeType !== 1) return 0;
    if (el.closest?.('script,style,code,pre,.stvi-skip')) return 0;
    let count = 0;
    for (const attr of TRANSLATABLE_ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      const val = el.getAttribute(attr);
      if (!val || !CJK_RE.test(val)) continue;
      const next = translateString(val);
      if (next !== val) {
        let saved = originalAttrMap.get(el);
        if (!saved) {
          saved = new Map();
          originalAttrMap.set(el, saved);
        }
        if (!saved.has(attr)) saved.set(attr, val);
        el.setAttribute(attr, next);
        count++;
      }
    }
    return count;
  }

  function translateTree(root) {
    if (!root) return 0;
    const doc = root.ownerDocument || (root.nodeType === 9 ? root : document);
    let changes = 0;

    if (root.nodeType === 3) {
      return translateTextNode(root) ? 1 : 0;
    }

    if (root.nodeType === 1) {
      changes += translateAttributes(root);
    }

    const walker = doc.createTreeWalker(root, 5 /* SHOW_ELEMENT | SHOW_TEXT */);
    let current = walker.nextNode();
    while (current) {
      if (current.nodeType === 3) {
        if (translateTextNode(current)) changes++;
      } else if (current.nodeType === 1) {
        changes += translateAttributes(current);
      }
      current = walker.nextNode();
    }
    return changes;
  }

  function restoreTree(root) {
    if (!root) return 0;
    const doc = root.ownerDocument || (root.nodeType === 9 ? root : document);
    let restored = 0;

    const restoreEl = (el) => {
      const saved = originalAttrMap.get(el);
      if (saved) {
        for (const [attr, orig] of saved.entries()) {
          if (el.getAttribute(attr) !== orig) {
            el.setAttribute(attr, orig);
            restored++;
          }
        }
      }
    };

    if (root.nodeType === 3 && originalTextMap.has(root)) {
      const orig = originalTextMap.get(root);
      if (root.nodeValue !== orig) {
        root.nodeValue = orig;
        return 1;
      }
      return 0;
    }

    if (root.nodeType === 1) restoreEl(root);
    const walker = doc.createTreeWalker(root, 5);
    let current = walker.nextNode();
    while (current) {
      if (current.nodeType === 3 && originalTextMap.has(current)) {
        const orig = originalTextMap.get(current);
        if (current.nodeValue !== orig) {
          current.nodeValue = orig;
          restored++;
        }
      } else if (current.nodeType === 1) {
        restoreEl(current);
      }
      current = walker.nextNode();
    }
    return restored;
  }

  return {
    translateString,
    translateTextNode,
    translateAttributes,
    translateTree,
    restoreTree,
    get stats() {
      return {
        exactCount: exactMap.size,
        patternCount: compiledPatterns.length,
        missingCount: missingSet.size,
        missingSamples: [...missingSet],
      };
    },
  };
}
