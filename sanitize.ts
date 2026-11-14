/**
 * HTML sanitising for user-authored card content. Cards can come from imports or public decks, so they are
 * treated as hostile: scripts, event handlers, iframes, forms and javascript: URLs are all removed.
 */
import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'a', 'b', 'i', 'u', 'em', 'strong', 's', 'sub', 'sup', 'br', 'p', 'div', 'span', 'hr', 'ul', 'ol', 'li',
  'blockquote', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'img', 'audio', 'source', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'font', 'mark',
];
const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'class', 'id', 'controls', 'colspan', 'rowspan', 'style', 'target', 'rel', 'width', 'height', 'color'];

// Only these URL schemes survive in href/src. `media:` is Mnemora's internal reference to a stored attachment.
const SAFE_URI = /^(?:(?:https?|mailto|tel|media|blob):|data:image\/(?:png|jpe?g|gif|webp);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;

let hooked = false;
function ensureHooks() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    // Strip CSS that can load remote resources or break out of the card.
    const style = node.getAttribute?.('style');
    if (style && /url\s*\(|expression\s*\(|@import|position\s*:\s*(fixed|absolute)/i.test(style)) node.removeAttribute('style');
  });
}

export function sanitizeHtml(html: string): string {
  ensureHooks();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: SAFE_URI,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'svg', 'math'],
  }) as string;
}

/** Scope user CSS to a container and drop anything that can exfiltrate or escape. */
export function sanitizeCss(css: string, scope: string): string {
  const cleaned = css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\s*\([^)]*\)/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/behavior\s*:[^;}]*/gi, '')
    .replace(/-moz-binding\s*:[^;}]*/gi, '')
    .replace(/<\/?style[^>]*>/gi, '');
  // Prefix each selector with the scope; `.card` rules target the container itself.
  return cleaned.replace(/(^|\})\s*([^{}@]+)\{/g, (_m, close: string, sel: string) => {
    const scoped = sel
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s === '.card' ? scope : `${scope} ${s}`))
      .join(', ');
    return `${close} ${scoped} {`;
  });
}
