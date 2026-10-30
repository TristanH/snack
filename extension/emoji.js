// Emoji lookup, rendering and search: Slack's standard shortcodes plus the
// workspace's custom emoji (from emoji.list, via the backend).

import { EMOJI_DATA } from './lib/emoji-data.js';

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const standard = new Map(); // shortcode -> character
const aliasesOf = new Map(); // primary shortcode -> all its shortcodes
for (const [names, char] of EMOJI_DATA) {
  for (const n of names) standard.set(n, char);
  aliasesOf.set(names[0], names);
}

let custom = new Map(); // name -> image URL, or "std:<shortcode>" for aliases of standard emoji

export function setCustomEmoji(map) {
  custom = new Map(Object.entries(map || {}));
}

// "thumbsup::skin-tone-3" -> base name + skin tone modifier.
const SKIN_TONES = { 2: '\u{1F3FB}', 3: '\u{1F3FC}', 4: '\u{1F3FD}', 5: '\u{1F3FE}', 6: '\u{1F3FF}' };
function parse(name) {
  const m = String(name).match(/^(.*?)(?:::skin-tone-(\d))?$/);
  return { base: m[1], tone: SKIN_TONES[m[2]] || '' };
}

export function emojiChar(name) {
  const { base, tone } = parse(name);
  const c = custom.get(base);
  const char = c?.startsWith('std:') ? standard.get(c.slice(4)) : standard.get(base);
  return char ? char + tone : null;
}

// HTML for an emoji (character, or <img> for custom ones), or null if unknown.
export function emojiHtml(name) {
  const char = emojiChar(name);
  if (char) return escapeHtml(char);
  const url = custom.get(parse(name).base);
  if (url && !url.startsWith('std:')) return `<img class="custom-emoji" src="${escapeHtml(url)}" alt=":${escapeHtml(name)}:" />`;
  return null;
}

// Picker search: prefix matches first, then substring matches; custom emoji included.
export function searchEmoji(query, limit = 96) {
  const q = query.toLowerCase().replace(/:/g, '').trim();
  const all = [
    ...EMOJI_DATA.map(([names]) => names[0]),
    ...[...custom.keys()].filter((n) => !custom.get(n).startsWith('std:')),
  ];
  if (!q) return all.slice(0, limit);
  const prefix = [];
  const contains = [];
  for (const n of all) {
    const aliases = aliasesOf.get(n) || [n];
    if (aliases.some((a) => a.startsWith(q))) prefix.push(n);
    else if (aliases.some((a) => a.includes(q))) contains.push(n);
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...contains].slice(0, limit);
}
