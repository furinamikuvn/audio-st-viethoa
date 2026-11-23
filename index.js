import { createTranslator, CJK_RE, TRANSLATABLE_ATTRS } from './translator.js';

const EXTENSION_KEY = 'st_iphonie_vi';
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  translateToasts: true,
  debugMissing: false,
});

// Parent-document containers & widgets owned by ST-iPhonie (never touch SillyTavern RP .mes_text prose)
const HOST_ROOT_SELECTOR = [
  '#sttts-panel',
  '#sttts-extension-entry',
  '#sttts-wand-entry',
  '#sttts-floating',
  '.sttts-call-island',
  '.sttts-msg-island',
  '.sttts-music-island',
  '.sttts-note-island',
  '.sttts-voice-island',
  '.sttts-vn',
  '.sttts-book',
  '.sttts-ask',
  '.sttts-save-choice',
  '.sttts-selection-draw',
  '.sttts-context-menu',
  '.sttts-viewer',
  '.sttts-game',
  '.sttts-lint',
  '.sttts-pic-bar',
  '.sttts-pic-note',
  '.sttts-pic-wait',
  '.sttts-pic-removed',
  '.sttts-pic-fold-mark',
  '.sttts-phone-note',
  '.sttts-tools-entry',
  '[data-sttts-owned]',
  '[data-sttts-action]',
].join(',');

const IFRAME_HOST_SELECTOR = '#sttts-panel iframe, .sttts-game iframe';

let settings = { ...DEFAULT_SETTINGS };
let translator = null;
let bodyObserver = null;
let toastrRestore = null;
const attachedDocs = new WeakMap(); // Document -> { observer, rafId, dirtyNodes, applying }
const observedHosts = new WeakMap(); // Element -> MutationObserver
const hookedFrames = new WeakSet();

function getContext() {
  return globalThis.SillyTavern?.getContext?.() || null;
}

function loadSettings() {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return { ...DEFAULT_SETTINGS };
  if (!ctx.extensionSettings[EXTENSION_KEY]) {
    ctx.extensionSettings[EXTENSION_KEY] = { ...DEFAULT_SETTINGS };
  }
  settings = { ...DEFAULT_SETTINGS, ...ctx.extensionSettings[EXTENSION_KEY] };
  return settings;
}

function saveSettings() {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  ctx.extensionSettings[EXTENSION_KEY] = { ...settings };
  ctx.saveSettingsDebounced?.();
}

function updateStatsUI() {
  const el = document.querySelector('#stvi-stats');
  if (!el || !translator) return;
  const s = translator.stats;
  el.innerHTML = '';
  const badge = document.createElement('span');
  badge.className = 'stvi-badge';
  badge.textContent = settings.enabled ? 'Đang bật' : 'Đã tắt';
  const text = document.createTextNode(
    ` · Từ điển: ${s.exactCount} cụm + ${s.patternCount} mẫu` +
      (settings.debugMissing ? ` · Chưa dịch: ${s.missingCount}` : ''),
  );
  el.append(badge, text);
}

const CSS_PATCH_ID = 'stvi-css-patch';
const CSS_PATCH_TEXT = `
.reading-art.folded .reading-art-image::after { content: "Xem tranh minh họa" !important; }
.chat-photo.missing:after { content: "Ảnh này đã bị xóa khỏi Thư viện ảnh" !important; }
`;

function syncCssPatch(doc, active) {
  if (!doc?.head) return;
  const existing = doc.getElementById(CSS_PATCH_ID);
  if (active) {
    if (!existing) {
      const style = doc.createElement('style');
      style.id = CSS_PATCH_ID;
      style.textContent = CSS_PATCH_TEXT;
      doc.head.appendChild(style);
    }
  } else {
    existing?.remove();
  }
}

function attachDocumentObserver(doc) {
  if (!doc?.body || attachedDocs.has(doc)) return;
  syncCssPatch(doc, settings.enabled);

  const state = {
    observer: null,
    rafId: 0,
    dirtyNodes: new Set(),
    applying: false,
  };

  const flush = () => {
    state.rafId = 0;
    if (!settings.enabled || !translator) {
      state.dirtyNodes.clear();
      return;
    }
    state.applying = true;
    try {
      const batch = [...state.dirtyNodes];
      state.dirtyNodes.clear();
      for (const node of batch) {
        if (!node.isConnected) continue;
        translator.translateTree(node);
      }
      // Also keep document title translated if CJK
      if (doc.title && CJK_RE.test(doc.title)) {
        const nextTitle = translator.translateString(doc.title);
        if (nextTitle !== doc.title) doc.title = nextTitle;
      }
    } finally {
      state.applying = false;
      updateStatsUI();
    }
  };

  const schedule = (node) => {
    if (!node) return;
    state.dirtyNodes.add(node);
    if (!state.rafId) {
      const win = doc.defaultView || globalThis;
      if (doc.hidden || typeof win.requestAnimationFrame !== 'function') {
        state.rafId = win.setTimeout(flush, 16);
      } else {
        state.rafId = win.requestAnimationFrame(flush);
      }
    }
  };

  const observer = new MutationObserver((records) => {
    if (state.applying || !settings.enabled) return;
    for (const r of records) {
      if (r.type === 'characterData') {
        if (r.target.nodeValue && CJK_RE.test(r.target.nodeValue)) schedule(r.target);
      } else if (r.type === 'attributes') {
        const val = r.target.getAttribute?.(r.attributeName);
        if (val && CJK_RE.test(val)) schedule(r.target);
      } else if (r.type === 'childList') {
        for (const n of r.addedNodes) {
          if (n.nodeType === 1 || n.nodeType === 3) schedule(n);
        }
      }
    }
  });

  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSLATABLE_ATTRS,
  });

  state.observer = observer;
  attachedDocs.set(doc, state);

  if (settings.enabled && translator) {
    state.applying = true;
    try {
      translator.translateTree(doc.body);
    } finally {
      state.applying = false;
    }
  }
}

function attachIframe(frame) {
  if (!frame || hookedFrames.has(frame)) return;
  hookedFrames.add(frame);

  const tryHookDoc = () => {
    try {
      const doc = frame.contentDocument;
      if (!doc) return;
      if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', () => attachDocumentObserver(doc), { once: true });
      } else {
        attachDocumentObserver(doc);
      }
    } catch {
      // Cross-origin guard
    }
  };

  frame.addEventListener('load', tryHookDoc);
  tryHookDoc();
}

function observeHostRoot(el) {
  if (!el || el.nodeType !== 1 || observedHosts.has(el)) return;

  let applying = false;
  let rafId = 0;
  const dirty = new Set();

  const flush = () => {
    rafId = 0;
    if (!settings.enabled || !translator) {
      dirty.clear();
      return;
    }
    applying = true;
    try {
      for (const n of dirty) {
        if (n.isConnected) translator.translateTree(n);
      }
      dirty.clear();
    } finally {
      applying = false;
    }
  };

  const schedule = (node) => {
    dirty.add(node);
    if (!rafId) rafId = requestAnimationFrame(flush);
  };

  const obs = new MutationObserver((records) => {
    if (applying || !settings.enabled) return;
    for (const r of records) {
      if (r.type === 'characterData') {
        if (r.target.nodeValue && CJK_RE.test(r.target.nodeValue)) schedule(r.target);
      } else if (r.type === 'attributes') {
        const val = r.target.getAttribute?.(r.attributeName);
        if (val && CJK_RE.test(val)) schedule(r.target);
      } else if (r.type === 'childList') {
        for (const n of r.addedNodes) {
          if (n.nodeType === 1) {
            if (n.matches?.(IFRAME_HOST_SELECTOR)) attachIframe(n);
            n.querySelectorAll?.(IFRAME_HOST_SELECTOR).forEach(attachIframe);
            schedule(n);
          } else if (n.nodeType === 3) {
            schedule(n);
          }
        }
      }
    }
  });

  obs.observe(el, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSLATABLE_ATTRS,
  });

  observedHosts.set(el, obs);

  if (el.matches(IFRAME_HOST_SELECTOR)) attachIframe(el);
  el.querySelectorAll?.(IFRAME_HOST_SELECTOR).forEach(attachIframe);

  if (settings.enabled && translator) {
    applying = true;
    try {
      translator.translateTree(el);
    } finally {
      applying = false;
    }
  }
}

function scanExistingRoots() {
  document.querySelectorAll(HOST_ROOT_SELECTOR).forEach(observeHostRoot);
  document.querySelectorAll(IFRAME_HOST_SELECTOR).forEach(attachIframe);
}

function installToastrHook() {
  if (toastrRestore || !globalThis.toastr) return;
  const t = globalThis.toastr;
  const orig = {};
  for (const method of ['info', 'success', 'warning', 'error']) {
    if (typeof t[method] !== 'function') continue;
    orig[method] = t[method].bind(t);
    t[method] = function (message, title, options) {
      if (settings.enabled && settings.translateToasts && translator) {
        const looksLikeIphonie =
          (typeof title === 'string' && (title.includes('ST-iPhonie') || CJK_RE.test(title))) ||
          (typeof message === 'string' && CJK_RE.test(message));
        if (looksLikeIphonie) {
          if (typeof message === 'string' && CJK_RE.test(message)) {
            message = translator.translateString(message);
          }
          if (typeof title === 'string' && CJK_RE.test(title)) {
            title = translator.translateString(title);
          }
        }
      }
      return orig[method](message, title, options);
    };
  }
  toastrRestore = () => {
    for (const [method, fn] of Object.entries(orig)) {
      t[method] = fn;
    }
    toastrRestore = null;
  };
}

function applyAllNow() {
  if (!translator) return;
  scanExistingRoots();
  document.querySelectorAll(HOST_ROOT_SELECTOR).forEach((el) => translator.translateTree(el));
  document.querySelectorAll(IFRAME_HOST_SELECTOR).forEach((frame) => {
    try {
      if (frame.contentDocument?.body) {
        syncCssPatch(frame.contentDocument, true);
        translator.translateTree(frame.contentDocument.body);
      }
    } catch {
      // ignore
    }
  });
  updateStatsUI();
}

function restoreAllNow() {
  if (!translator) return;
  document.querySelectorAll(HOST_ROOT_SELECTOR).forEach((el) => translator.restoreTree(el));
  document.querySelectorAll(IFRAME_HOST_SELECTOR).forEach((frame) => {
    try {
      if (frame.contentDocument?.body) {
        syncCssPatch(frame.contentDocument, false);
        translator.restoreTree(frame.contentDocument.body);
      }
    } catch {
      // ignore
    }
  });
  updateStatsUI();
}

function mountSettingsPanel() {
  if (document.querySelector('#stvi-extension-entry')) return;
  const container =
    document.querySelector('#extensions_settings2') ||
    document.querySelector('#extensions_settings');
  if (!container) return;

  const root = document.createElement('div');
  root.id = 'stvi-extension-entry';
  root.className = 'stvi-skip';
  root.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header" tabindex="0">
        <b>ST-iPhonie Việt Hóa</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="stvi-row">
          <label><input type="checkbox" id="stvi-opt-enabled"> Bật Việt hóa giao diện ST-iPhonie</label>
        </div>
        <div class="stvi-row">
          <label><input type="checkbox" id="stvi-opt-toasts"> Dịch thông báo nổi (Toastr)</label>
        </div>
        <div class="stvi-row">
          <label><input type="checkbox" id="stvi-opt-debug"> Ghi nhận chuỗi chưa dịch (Debug)</label>
        </div>
        <div class="stvi-actions">
          <button type="button" id="stvi-btn-reapply" class="menu_button">Dịch lại ngay</button>
          <button type="button" id="stvi-btn-restore" class="menu_button">Khôi phục gốc</button>
          <button type="button" id="stvi-btn-copy-missing" class="menu_button" style="display:none">Copy chuỗi sót</button>
        </div>
        <div id="stvi-stats" class="stvi-stats">Đang nạp từ điển…</div>
      </div>
    </div>
  `;

  const enabledEl = root.querySelector('#stvi-opt-enabled');
  const toastsEl = root.querySelector('#stvi-opt-toasts');
  const debugEl = root.querySelector('#stvi-opt-debug');
  const copyMissingBtn = root.querySelector('#stvi-btn-copy-missing');

  enabledEl.checked = settings.enabled;
  toastsEl.checked = settings.translateToasts;
  debugEl.checked = settings.debugMissing;
  copyMissingBtn.style.display = settings.debugMissing ? '' : 'none';

  enabledEl.addEventListener('change', () => {
    settings.enabled = enabledEl.checked;
    saveSettings();
    if (settings.enabled) applyAllNow();
    else restoreAllNow();
  });

  toastsEl.addEventListener('change', () => {
    settings.translateToasts = toastsEl.checked;
    saveSettings();
  });

  debugEl.addEventListener('change', () => {
    settings.debugMissing = debugEl.checked;
    copyMissingBtn.style.display = settings.debugMissing ? '' : 'none';
    saveSettings();
    updateStatsUI();
  });

  root.querySelector('#stvi-btn-reapply').addEventListener('click', () => {
    if (!settings.enabled) {
      settings.enabled = true;
      enabledEl.checked = true;
      saveSettings();
    }
    applyAllNow();
    globalThis.toastr?.success?.('Đã quét và dịch lại giao diện ST-iPhonie.', 'ST-iPhonie Việt Hóa');
  });

  root.querySelector('#stvi-btn-restore').addEventListener('click', () => {
    settings.enabled = false;
    enabledEl.checked = false;
    saveSettings();
    restoreAllNow();
    globalThis.toastr?.info?.('Đã tạm khôi phục chữ gốc tiếng Trung.', 'ST-iPhonie Việt Hóa');
  });

  copyMissingBtn.addEventListener('click', async () => {
    const samples = translator?.stats?.missingSamples || [];
    if (!samples.length) {
      globalThis.toastr?.info?.('Chưa ghi nhận chuỗi UI nào bị sót.', 'ST-iPhonie Việt Hóa');
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(samples, null, 2));
      globalThis.toastr?.success?.(`Đã copy ${samples.length} chuỗi chưa dịch vào clipboard.`, 'ST-iPhonie Việt Hóa');
    } catch {
      console.info('[ST-iPhonie-VI] Missing strings:', samples);
      globalThis.toastr?.info?.('Không copy được, đã in danh sách ra Console (F12).', 'ST-iPhonie Việt Hóa');
    }
  });

  container.append(root);
  updateStatsUI();
}

let initialized = false;

export async function enable() {
  if (initialized) {
    settings.enabled = true;
    saveSettings();
    applyAllNow();
    return;
  }
  await init();
}

export function disable() {
  if (!initialized) return;
  bodyObserver?.disconnect();
  bodyObserver = null;
  toastrRestore?.();
  restoreAllNow();
  document.querySelector('#stvi-extension-entry')?.remove();
  initialized = false;
}

export const dispose = disable;

async function init() {
  if (initialized) return;
  initialized = true;
  loadSettings();

  const dictUrl = new URL('./dict.json', import.meta.url);
  const dict = await fetch(dictUrl, { cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error(`Không tải được dict.json (${r.status})`);
    return r.json();
  });

  translator = createTranslator({
    exact: dict.exact || {},
    patterns: dict.patterns || {},
    onMissing: (str) => {
      if (settings.debugMissing) {
        console.debug('[ST-iPhonie-VI][Missing]', str);
      }
    },
  });

  installToastrHook();
  mountSettingsPanel();
  scanExistingRoots();

  bodyObserver = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches?.(HOST_ROOT_SELECTOR)) observeHostRoot(n);
        n.querySelectorAll?.(HOST_ROOT_SELECTOR).forEach(observeHostRoot);
        if (n.matches?.(IFRAME_HOST_SELECTOR)) attachIframe(n);
        n.querySelectorAll?.(IFRAME_HOST_SELECTOR).forEach(attachIframe);
        if (n.id === 'extensions_settings' || n.id === 'extensions_settings2') {
          mountSettingsPanel();
        }
      }
    }
  });

  if (document.body) {
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  if (settings.enabled) {
    applyAllNow();
  }

  globalThis._stIphonieViCleanup = () => {
    bodyObserver?.disconnect();
    bodyObserver = null;
    toastrRestore?.();
    restoreAllNow();
    document.querySelector('#stvi-extension-entry')?.remove();
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => init().catch((e) => console.error('[ST-iPhonie-VI]', e)), { once: true });
} else {
  init().catch((e) => console.error('[ST-iPhonie-VI]', e));
}
