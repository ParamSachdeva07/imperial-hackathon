// Fixed observation code, never supplied by the model or by page content.
export const PAGE_STATE = `async () => {
  const roots = [document];
  const elements = [];
  for (let r = 0; r < roots.length; r++) {
    for (const e of roots[r].querySelectorAll('*')) {
      elements.push(e);
      if (e.shadowRoot) roots.push(e.shadowRoot);
    }
  }
  const visible = e => !!(e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  const fields = elements.filter(e => visible(e) && e.matches('input:not([type=password]):not([type=file]),textarea,[contenteditable=true]'))
    .slice(0, 60).map(e => ({ name: e.getAttribute('aria-label') || e.getAttribute('placeholder') || (e.labels && e.labels[0]?.innerText) || e.name || '',
      value: e.isContentEditable ? e.innerText : e.value, focused: e === active }));
  const media = elements.filter(e => visible(e) && e.matches('video,audio')).slice(0, 12);
  const times = media.map(e => e.currentTime);
  if (media.some(e => !e.paused && !e.ended)) await new Promise(resolve => setTimeout(resolve, 300));
  // A SPA may update its URL before replacing the previous page's main content.
  // Exclude surrounding navigation/search fields when a main landmark exists.
  const main = elements.filter(e => visible(e) && e.matches('main,[role=main]'));
  const contentRoots = main.length ? main : [document.body];
  const content = contentRoots.map(e => (e?.innerText || '') + ' ' +
    Array.from(e?.querySelectorAll('a[href]') || []).filter(visible).map(a => a.href).join(' ')).join(' ').slice(0, 60000);
  let contentHash = 2166136261;
  for (let i = 0; i < content.length; i++) contentHash = Math.imul(contentHash ^ content.charCodeAt(i), 16777619);
  return { url: location.href, title: document.title, documentId: String(performance.timeOrigin), readyState: document.readyState,
    contentKey: String(contentHash >>> 0),
    text: document.body?.innerText?.slice(0, 6000) || '',
    busy: elements.some(e => visible(e) && e.getAttribute('aria-busy') === 'true'),
    fields, activeHtml: active?.outerHTML?.slice(0, 20000) || '',
    media: media.map((e, i) => ({ kind: e.tagName.toLowerCase(), source: e.currentSrc, paused: e.paused, ended: e.ended,
      time: e.currentTime, advancing: !e.paused && !e.ended && e.currentTime > times[i] })) };
}`;

export const PAGE_IDENTITY = `() => ({url:location.href,documentId:String(performance.timeOrigin)})`;

export const ACTIVE_HTML = `() => {
  let e = document.activeElement;
  while (e?.shadowRoot?.activeElement) e = e.shadowRoot.activeElement;
  return e?.outerHTML || '';
}`;

export function evaluation(data: any): any {
  return data?.result ?? data;
}
