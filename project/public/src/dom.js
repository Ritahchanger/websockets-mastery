// Small DOM helpers. All user content goes through escapeHtml before it
// touches innerHTML — chat apps are XSS magnets.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** Tiny, safe markdown: escape first, then `code`, **bold**, _italic_, links. */
export function renderText(text) {
  let html = escapeHtml(text);
  const codes = [];
  html = html.replace(/```([\s\S]+?)```/g, (_, c) => `\u0000${codes.push(`<pre><code>${c.replace(/^\n/, '')}</code></pre>`) - 1}\u0000`);
  html = html.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(`<code>${c}</code>`) - 1}\u0000`);
  html = html
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<em>$2</em>')
    .replace(/\bhttps?:\/\/[^\s<]+[^\s<.,:;"')\]]/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    .replace(/\n/g, '<br>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
}

export const initials = (name) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('') || '?';

export function avatar(user, size = 36) {
  return `<span class="avatar" style="--c:${escapeHtml(user.color ?? '#7c5cff')};--s:${size}px">${escapeHtml(initials(user.name))}</span>`;
}

export function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

export function toast(message, kind = 'info', ms = 3500) {
  const root = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  root.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}
