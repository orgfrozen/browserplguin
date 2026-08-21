import { elementSemanticText, isElementVisible, normalizeUiText } from './ui-semantics.js';

const PROMOTION_PATTERNS = [
  /在\s*chatgpt\s*应用中[，,\s]*体验更佳/i,
  /在\s*chatgpt\s*應用中[，,\s]*體驗更佳/i,
  /(?:download|下载|下載|ダウンロード).*(?:chatgpt\s*)?(?:desktop\s*)?(?:app|应用|應用|アプリ)/i,
  /(?:chatgpt\s*)?(?:desktop\s*)?(?:app|应用|應用|アプリ).*(?:download|下载|下載|ダウンロード)/i,
  /get more from chatgpt.*(?:desktop\s*)?app/i,
  /chatgpt.*(?:desktop\s*)?app.*(?:better|best|more)/i
];

const CLOSE_PATTERNS = [
  /^close$/i,
  /^dismiss$/i,
  /^关闭$/,
  /^關閉$/,
  /^关闭弹窗$/,
  /^關閉彈窗$/,
  /^閉じる$/,
  /modal[-_ ]?close/i,
  /dialog[-_ ]?close/i
];

function matchesAny(value, patterns) {
  return patterns.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function visibleDialogs(root) {
  const nodes = [
    ...(root?.querySelectorAll?.('[role="dialog"]') ?? []),
    ...(root?.querySelectorAll?.('dialog[open]') ?? [])
  ];
  return [...new Set(nodes)].filter(isElementVisible);
}

function isKnownPromotion(dialog) {
  return matchesAny(normalizeUiText(dialog?.textContent), PROMOTION_PATTERNS);
}

function findCloseControl(dialog) {
  const buttons = [...(dialog?.querySelectorAll?.('button, [role="button"]') ?? [])].filter(isElementVisible);
  const matches = buttons.filter(button => matchesAny(elementSemanticText(button), CLOSE_PATTERNS));
  return matches.length === 1 ? matches[0] : null;
}

export class BlockingUiGuard {
  constructor(root = document, { MutationObserverCtor = globalThis.MutationObserver } = {}) {
    this.root = root;
    this.MutationObserverCtor = MutationObserverCtor;
  }

  dismissKnownPromotions() {
    let dismissed = 0;
    let unresolved = 0;
    for (const dialog of visibleDialogs(this.root)) {
      if (!isKnownPromotion(dialog)) continue;
      const close = findCloseControl(dialog);
      if (!close) {
        unresolved += 1;
        continue;
      }
      close.click?.();
      dismissed += 1;
    }
    return { dismissed, unresolved };
  }

  observe() {
    this.dismissKnownPromotions();
    if (!this.MutationObserverCtor) return () => {};
    const target = this.root?.documentElement ?? this.root?.body ?? null;
    if (!target) return () => {};
    const observer = new this.MutationObserverCtor(() => {
      this.dismissKnownPromotions();
    });
    observer.observe(target, { childList: true, subtree: true, attributes: true });
    return () => observer.disconnect?.();
  }
}
