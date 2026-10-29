import { countWords } from '@ww/projector';

/** Tiny DOM helpers: enough structure to build the interface without a framework. */
export type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;
export type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'value' && el instanceof HTMLInputElement) {
      el.value = String(v);
      el.dataset['v'] = String(v); // what was rendered, so an edit in progress can be told apart
    }
    else if (k === 'text') el.textContent = String(v);
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export const clear = (el: Element): void => {
  while (el.firstChild) el.removeChild(el.firstChild);
};

export function replace(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

/** Wrap a section in the standard panel frame. */
export function panel(title: string, cls = ''): { root: HTMLElement; body: HTMLElement } {
  const body = h('div', { class: 'body' });
  const root = h('section', { class: `panel ${cls}`.trim() }, h('h2', { text: title }), body);
  return { root, body };
}

/** "3 minutes", "45 seconds" — for deadlines, in words a player reads at a glance. */
export function humanMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Words exactly as the engine counts them, so the limit a player sees is the limit applied. */
export const words = countWords;

/**
 * Rebuild a container without losing what the person is typing. Inputs carry a `data-k` key;
 * an input that was being edited (or had focus) gets its text, caret and focus back — unless the
 * server changed that field in the meantime, in which case the server's value wins.
 */
export function preserveEdits(container: HTMLElement, rebuild: () => void): void {
  const saved = new Map<string, { value: string; rendered: string | undefined; focused: boolean; start: number | null; end: number | null }>();
  for (const el of container.querySelectorAll<HTMLInputElement>('input[data-k]')) {
    const focused = document.activeElement === el;
    if (!focused && el.value === el.dataset['v']) continue;
    let start: number | null = null;
    let end: number | null = null;
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
    } catch {
      // number inputs have no selection
    }
    saved.set(el.dataset['k']!, { value: el.value, rendered: el.dataset['v'], focused, start, end });
  }
  rebuild();
  for (const [k, s] of saved) {
    const el = container.querySelector<HTMLInputElement>(`input[data-k="${k}"]`);
    if (!el || el.dataset['v'] !== s.rendered) continue;
    el.value = s.value;
    if (s.focused) {
      el.focus();
      try {
        if (s.start !== null && s.end !== null) el.setSelectionRange(s.start, s.end);
      } catch {
        // number inputs have no selection
      }
    }
  }
}
