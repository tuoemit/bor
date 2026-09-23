// Omnibox suggestions: local (bookmarks + top sites + history) plus the two
// synthetic entries every address bar needs.
import { bookmarksList, historyList, topSites } from '../store.js';
import { normalizeInput } from './api.js';

const SEARCH_LABEL = 'Search the web for';

export function extractSuggestions(userId, rawQuery) {
  const query = String(rawQuery ?? '').trim();
  const needle = query.toLowerCase();
  const items = [];
  const seen = new Set();

  const push = (url, title, kind, score) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    items.push({ url, title: title || url, kind, score });
  };

  if (!query) {
    for (const site of topSites(userId, 8)) push(site.url, site.title, 'frequent', 1);
    for (const mark of bookmarksList(userId).slice(0, 8)) push(mark.url, mark.title, 'bookmark', 1);
    return items.slice(0, 10);
  }

  for (const mark of bookmarksList(userId)) {
    const haystack = `${mark.title ?? ''} ${mark.url}`.toLowerCase();
    if (haystack.includes(needle)) push(mark.url, mark.title, 'bookmark', 6);
  }

  for (const row of historyList(userId, { limit: 200, q: query })) {
    let score = 2;
    try {
      const host = new URL(row.url).hostname;
      if (host.startsWith(needle)) score += 4;
      if (host.includes(needle)) score += 2;
    } catch {
      /* ignore */
    }
    score += Math.min(3, (row.visit_count ?? 1) / 4);
    push(row.url, row.title, 'history', score);
  }

  const target = normalizeInput(query);
  if (target) {
    const isSearch = target.includes('?q=') || target.includes('&q=');
    push(target, isSearch ? `${SEARCH_LABEL} “${query}”` : target, isSearch ? 'search' : 'direct', isSearch ? 0.5 : 9);
  }

  return items.sort((a, b) => b.score - a.score).slice(0, 10);
}
