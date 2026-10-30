// Snack frontend: an inbox for Slack (threads, DMs and @-mentions), plus
// passive channel unreads.

import * as backend from './backend.js';
import { emojiChar, emojiHtml, searchEmoji, setCustomEmoji } from './emoji.js';
import { attachAutocomplete } from './autocomplete.js';
import { messageTexts } from './lib/threads.js';

const DEFAULT_RECENT_EMOJI = ['+1', 'eyes', 'white_check_mark', 'heart', 'joy', 'tada', 'pray', 'raised_hands', 'fire', '100'];

const REFRESH_MS = 60_000;

const state = {
  auth: null,
  threads: [],
  users: {},
  channels: {},
  bots: {},
  meta: {},
  view: 'inbox', // 'inbox' | 'channels'
  inboxItems: [], // threads, DMs and mentions, merged (see lib/inbox.js)
  inboxLoaded: false,
  filter: 'all',
  channelItems: [],
  mentionItems: [],
  channelCounts: {},
  channelsLoaded: false,
  channelsLoading: false,
  sections: [],
  backTo: null, // { key, scrollTop } while viewing a thread opened from a conversation
  detail: null, // { channel, messages: Map<ts, message> } for the open conversation
  recentEmoji: DEFAULT_RECENT_EMOJI,
  mentionables: { users: [], channels: [], usergroups: [] }, // for composer autocomplete
  renderToken: 0, // guards against slow loads overwriting a newer conversation
  query: '',
  archived: {}, // inbox item key -> its lastTs when archived
  undo: null,
  selectedKey: null,
  openKey: null,
  loading: false,
};

const $ = (sel) => document.querySelector(sel);
const EMPTY_DETAIL = $('#detail').innerHTML;

// ---------------------------------------------------------------------------
// Formatting helpers

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const decodeEntities = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');


function mergeDirectory(data) {
  Object.assign(state.users, data.users);
  Object.assign(state.channels, data.channels);
  Object.assign(state.bots, data.bots);
}

function userName(id) {
  return state.users[id]?.name || id;
}

function channelLabel(id) {
  const c = state.channels[id];
  if (!c) return id;
  if (c.kind === 'im') return `@${userName(c.user)}`;
  if (c.kind === 'mpim') {
    const names = c.name.replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--');
    return names.join(', ');
  }
  if (c.kind === 'private') return `🔒 ${c.name}`;
  return `#${c.name}`;
}

// Links to Slack messages read better as "message in #channel".
function slackLinkLabel(url) {
  const m = url.match(/^https:\/\/[\w-]+\.slack\.com\/archives\/([A-Z0-9]+)(\/p\d+)?/);
  if (!m) return null;
  return m[2] ? `message in ${channelLabel(m[1])}` : channelLabel(m[1]);
}

// <!date^1791405746^{date_short_pretty} {time}|fallback>, shown in local time.
function slackDate(special, fallback) {
  const [, ts, format = '{date_short_pretty} {time}'] = special.split('^');
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return fallback || '';
  const day = (opts) => d.toLocaleDateString([], opts);
  const pretty = (plainDate) => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    if (d.toDateString() === today.toDateString()) return 'today';
    if (d.toDateString() === yesterday.toDateString()) return 'yesterday';
    if (d.toDateString() === tomorrow.toDateString()) return 'tomorrow';
    return plainDate;
  };
  const parts = {
    date_num: d.toISOString().slice(0, 10),
    date: day({ month: 'long', day: 'numeric', year: 'numeric' }),
    date_short: day({ month: 'short', day: 'numeric', year: 'numeric' }),
    date_long: day({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    time_secs: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }),
    ago: relativeTime(ts),
  };
  parts.date_pretty = pretty(parts.date);
  parts.date_short_pretty = pretty(parts.date_short);
  parts.date_long_pretty = pretty(parts.date_long);
  return format.replace(/\{(\w+)\}/g, (m, k) => parts[k] ?? m);
}

function renderToken(inner) {
  const [target, label] = inner.split('|');
  if (target.startsWith('@')) return `<span class="mention">@${escapeHtml(label || userName(target.slice(1)))}</span>`;
  if (target.startsWith('#')) {
    const name = label ? `#${label}` : channelLabel(target.slice(1));
    return `<span class="mention">${escapeHtml(name)}</span>`;
  }
  if (target.startsWith('!')) {
    const special = target.slice(1);
    if (['here', 'channel', 'everyone'].includes(special)) return `<span class="mention">@${special}</span>`;
    if (special.startsWith('subteam^')) return `<span class="mention">${escapeHtml(label || '@group')}</span>`;
    if (special.startsWith('date^')) return escapeHtml(slackDate(special, label));
    return escapeHtml(label || special);
  }
  if (/^(https?:|mailto:)/.test(target)) {
    const text = label || slackLinkLabel(target) || target.replace(/^mailto:/, '');
    return `<a href="${escapeHtml(target)}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>`;
  }
  return escapeHtml(label || target);
}

// Slack "mrkdwn" → HTML. Links/mentions and code are swapped for placeholders
// first so formatting rules never touch them.
function mrkdwn(text) {
  const tokens = [];
  const stash = (html) => `\u0000${tokens.push(html) - 1}\u0000`;

  let s = String(text || '').replace(/<([^<>]+)>/g, (_, inner) => stash(renderToken(inner)));
  s = escapeHtml(decodeEntities(s));
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => stash(`<pre>${code.replace(/^\n/, '')}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code>${code}</code>`));

  const edge = '(^|[\\s(\\u0000])';
  const end = '(?=$|[\\s).,!?:;\\u0000])';
  s = s.replace(new RegExp(`${edge}\\*([^*\\n]+)\\*${end}`, 'g'), '$1<b>$2</b>');
  s = s.replace(new RegExp(`${edge}_([^_\\n]+)_${end}`, 'g'), '$1<i>$2</i>');
  s = s.replace(new RegExp(`${edge}~([^~\\n]+)~${end}`, 'g'), '$1<s>$2</s>');
  s = s.replace(/:([a-z0-9_+'-]+(?:::skin-tone-\d)?):/g, (m, name) => emojiHtml(name) || m);
  s = s
    .split('\n')
    .map((line) => (line.startsWith('&gt;') ? `<blockquote>${line.slice(4).replace(/^ /, '')}</blockquote>` : line))
    .join('\n')
    .replace(/<\/blockquote>\n/g, '</blockquote>')
    .replace(/\n/g, '<br>');

  // Placeholders can nest (a link inside a code block), so restore until stable.
  while (s.includes('\u0000')) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[i]);
  return s;
}

// Plain-text preview for the list (no HTML).
function plain(text) {
  return decodeEntities(
    String(text || '').replace(/<([^<>]+)>/g, (_, inner) => {
      const [target, label] = inner.split('|');
      if (target.startsWith('@')) return `@${label || userName(target.slice(1))}`;
      if (target.startsWith('#')) return label ? `#${label}` : channelLabel(target.slice(1));
      if (target.startsWith('!date^')) return slackDate(target.slice(1), label);
      if (target.startsWith('!')) return label || `@${target.slice(1)}`;
      return label || slackLinkLabel(target) || target;
    }),
  )
    .replace(/:([a-z0-9_+'-]+(?:::skin-tone-\d)?):/g, (m, name) => emojiChar(name) || m)
    .replace(/[*_~`]/g, '')
    .replace(/^>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function messagePreview(m) {
  if (!m) return '';
  const blockText = m.blocks?.flatMap((b) => [b.text, ...(b.fields || [])]).filter(Boolean).join('\n');
  const text = plain(blockText) || plain(m.text) || plain(m.attachments?.[0]?.title) || plain(m.attachments?.[0]?.text);
  if (text) return text;
  if (m.files?.length) return `${m.files.every((f) => f.mimetype?.startsWith('image/')) ? '🖼' : '📎'} ${m.files.map((f) => f.name).join(', ')}`;
  return '';
}

function authorOf(m) {
  if (m.user && state.users[m.user]) return state.users[m.user].name;
  return m.botName || state.bots[m.botId]?.name || (m.user ? userName(m.user) : 'Unknown');
}

function avatarOf(m) {
  return (m.user && state.users[m.user]?.avatar) || m.botIcon || state.bots[m.botId]?.avatar || '';
}

const tsDate = (ts) => new Date(Number(ts) * 1000);

function relativeTime(ts) {
  const d = tsDate(ts);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (diff < 6 * 86400) return d.toLocaleDateString([], { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function fullTime(ts) {
  return tsDate(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function permalink(channel, ts, threadTs) {
  const base = state.auth?.url || 'https://app.slack.com/';
  const p = `${base}archives/${channel}/p${ts.replace('.', '')}`;
  return threadTs && threadTs !== ts ? `${p}?thread_ts=${threadTs}&cid=${channel}` : p;
}

// ---------------------------------------------------------------------------
// Inbox: threads you're in, DMs and @-mentions, as one list.

// An archived item stays out of the inbox until something newer than what
// you archived arrives, then it's back. (Mentions never change, so archiving
// one is permanent.)
function isArchived(item) {
  const ts = state.archived[item.key];
  return Boolean(ts) && Number(item.lastTs) <= Number(ts);
}

const needsReply = (m) => !m.replied && !m.fromBot;

function inboxHaystack(item) {
  const msgs = { thread: [item.root, item.last], dm: [item.last], channel: [item.last], mention: [item.message] }[item.type] || [];
  return [channelLabel(item.channel), ...msgs.filter(Boolean).flatMap((m) => [...messageTexts(m).map(plain), authorOf(m)])].join(' ').toLowerCase();
}

function visibleInbox() {
  const q = state.query.trim().toLowerCase();
  return state.inboxItems.filter((item) => {
    if (state.filter === 'archived' ? !isArchived(item) : isArchived(item)) return false;
    if (state.filter === 'unread' && !item.unread) return false;
    return !q || inboxHaystack(item).includes(q);
  });
}

// Rows are keyed and reused rather than rebuilt, so the list can update while
// pages stream in without eating clicks or hover state.
const rowCache = new Map(); // item key -> { el, html }

const TYPE_LABELS = { thread: 'Thread', dm: 'DM', channel: 'Channel', mention: 'Mention' };

function rowTop(item, label) {
  return `
    <span class="dot"></span>
    <div class="row">
      <span class="type-pill ${item.type}">${TYPE_LABELS[item.type]}</span>
      <span class="channel">${escapeHtml(label)}</span>
      ${item.mentioned ? '<span class="type-pill mention" title="You were @-mentioned">@ you</span>' : ''}
      <span class="time" title="${escapeHtml(fullTime(item.lastTs))}">${escapeHtml(relativeTime(item.lastTs))}</span>
    </div>`;
}

function rowEnd(item) {
  return `<span class="row-end">
      ${item.unreadCount && item.unread ? `<span class="badge">${item.unreadCount}</span>` : ''}
      <button class="row-action" data-action="archive" data-shortcut="archive" data-tip="${archiveLabel(item)}">${archiveLabel(item)}</button>
    </span>`;
}

const previewLine = (m, cls = 'root') =>
  m ? `<div class="row ${cls}"><span><b>${escapeHtml(authorOf(m))}:</b> ${escapeHtml(messagePreview(m))}</span></div>` : '';

function threadRowHtml(t) {
  const participants = t.replyUsers.slice(0, 3).map(userName).join(', ');
  return `${rowTop(t, channelLabel(t.channel))}
    ${previewLine(t.root)}
    ${t.last ? `<div class="row latest"><b>${escapeHtml(authorOf(t.last))}:</b>&nbsp;${escapeHtml(messagePreview(t.last))}</div>` : ''}
    <div class="row meta">
      <span>${t.replyCount} ${t.replyCount === 1 ? 'reply' : 'replies'}${participants ? ` · ${escapeHtml(participants)}` : ''}</span>
      ${rowEnd(t)}
    </div>`;
}

// A DM or an every-message channel: one row per conversation.
function conversationRowHtml(d) {
  return `${rowTop(d, channelLabel(d.channel))}
    ${previewLine(d.last)}
    <div class="row meta"><span></span>${rowEnd(d)}</div>`;
}

function mentionRowHtml(m) {
  const tag = m.replied ? '<span class="tag replied">Replied</span>' : '<span class="tag todo">Needs reply</span>';
  return `${rowTop(m, `${channelLabel(m.channel)}${m.threadTs ? ' · thread' : ''}`)}
    ${previewLine(m.message)}
    <div class="row meta">${isArchived(m) ? '<span></span>' : tag}${rowEnd(m)}</div>`;
}

const inboxRowHtml = (item) =>
  ({ thread: threadRowHtml, dm: conversationRowHtml, channel: conversationRowHtml, mention: mentionRowHtml })[item.type](item);

const visibleItems = () => (state.view === 'inbox' ? visibleInbox() : visibleChannels());

function renderList() {
  const list = $('#thread-list');
  const isInbox = state.view === 'inbox';
  const items = visibleItems();
  const entries = isInbox ? items : withSectionHeaders(items);
  const els = entries.map((item) => {
    let row = rowCache.get(item.key);
    if (!row) {
      row = { el: document.createElement('li'), html: null };
      row.el.dataset.key = item.key;
      rowCache.set(item.key, row);
    }
    const html = item.header ? sectionHeaderHtml(item) : isInbox ? inboxRowHtml(item) : channelRowHtml(item);
    if (row.html !== html) {
      row.el.innerHTML = html;
      row.html = html;
    }
    const unread = isInbox ? item.unread : !item.read;
    const className = item.header
      ? 'section-header'
      : ['thread-item', unread && 'unread', item.key === state.selectedKey && 'selected'].filter(Boolean).join('\n');
    if (row.el.className !== className) row.el.className = className;
    return row.el;
  });
  els.forEach((el, i) => {
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
  });
  while (list.children.length > els.length) list.lastElementChild.remove();

  const loaded = isInbox ? state.inboxLoaded : state.channelsLoaded;
  if (!items.length && loaded) {
    const empty = isInbox
      ? { all: 'Inbox zero 🎉', unread: 'Nothing unread.', archived: 'Nothing archived.' }[state.filter]
      : 'All caught up 🎉';
    list.insertAdjacentHTML('beforeend', `<li class="list-empty muted">${state.query ? 'Nothing matches.' : empty}</li>`);
  } else if (!items.length) {
    list.insertAdjacentHTML('beforeend', `<li class="list-empty muted">Loading…</li>`);
  }

  const unread = state.inboxItems.filter((i) => i.unread && !isArchived(i)).length;
  $('#unread-count').textContent = unread ? `(${unread})` : '';
  $('#inbox-count').textContent = unread ? `(${unread})` : '';
  const { unread: unreadChannels, ignored } = state.channelCounts;
  $('#channels-count').textContent = unreadChannels ? `(${unreadChannels})` : '';

  const footer = $('#list-footer');
  if (!isInbox) {
    footer.textContent = `${items.length} ${items.length === 1 ? 'conversation' : 'conversations'}${
      ignored ? ` · ${ignored} muted or ignored not shown` : ''
    }`;
    return;
  }
  // No "load older": an old thread that gets a new reply comes back on its own.
  footer.textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;
}

function applyInbox(data) {
  mergeDirectory(data);
  state.inboxItems = data.items;
  // The thread/mention views below look items up by type.
  state.threads = data.items.filter((i) => i.type === 'thread');
  state.mentionItems = data.items.filter((i) => i.type === 'mention');
  state.meta = data.meta || {};
  state.inboxLoaded = true;
  renderList();
}

async function loadInbox({ full = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  $('#refresh').classList.add('spinning');
  if (full || !state.inboxItems.length) $('#status').textContent = 'Loading…';
  try {
    const data = await backend.getInbox({
      full,
      onUpdate: (update) => {
        applyInbox(update);
        if (!update.progress.done) $('#status').textContent = 'Syncing threads…';
      },
    });
    applyInbox(data);
    $('#status').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  } catch (err) {
    if (err instanceof backend.AuthError) return showConnect(err.message);
    $('#status').textContent = `Error: ${err.message}`;
    console.error(err);
  } finally {
    state.loading = false;
    $('#refresh').classList.remove('spinning');
  }
}

function select(key, { scroll = true } = {}) {
  state.selectedKey = key;
  document.querySelectorAll('.thread-item.selected').forEach((el) => el.classList.remove('selected'));
  const el = document.querySelector(`.thread-item[data-key="${CSS.escape(key)}"]`);
  el?.classList.add('selected');
  if (scroll) el?.scrollIntoView({ block: 'nearest' });
}

function moveSelection(delta) {
  const items = visibleItems();
  if (!items.length) return;
  const idx = items.findIndex((t) => t.key === state.selectedKey);
  const next = items[Math.max(0, Math.min(items.length - 1, idx === -1 ? 0 : idx + delta))];
  // While reading, j/k go straight to the next conversation.
  if (state.openKey && next.key !== state.openKey) openItem(next.key);
  else select(next.key);
}

function openItem(key) {
  if (state.view === 'channels') return openChannel(key);
  const item = state.inboxItems.find((i) => i.key === key);
  ({ thread: openThread, dm: openConversation, channel: openConversation, mention: openMention })[item?.type]?.(key);
}

// `e`: archive an inbox item, or mark a channel done.
function doneItem(key) {
  if (state.view === 'channels') dismissChannel(key);
  else toggleArchive(key);
}

// Shows the mention in context, and marks it seen (in Slack, only up to the mention).
async function openMention(key) {
  const m = state.mentionItems.find((x) => x.key === key);
  if (!m) return;
  const token = ++state.renderToken;
  select(key, { scroll: false });
  state.openKey = key;
  state.backTo = null;
  document.querySelector('.app').classList.add('show-detail');

  const label = channelLabel(m.channel);
  const detail = $('#detail');
  detail.innerHTML = `
    <div class="detail-header">
      <button class="icon-btn back" data-shortcut="close" data-tip="Back">←</button>
      <h2>Mention in ${escapeHtml(label)}${m.threadTs ? ' thread' : ''}</h2>
      <span class="spacer"></span>
      <button class="text-btn archive-btn" data-shortcut="archive" data-tip="${archiveLabel(m)}">${archiveLabel(m)}</button>
      <a class="open-slack" href="${escapeHtml(permalink(m.channel, m.ts, m.threadTs))}" target="_blank" rel="noreferrer" data-shortcut="slack">Open in Slack ↗</a>
    </div>
    <div class="messages"><p class="muted" style="padding: 0 20px">Loading…</p></div>
    ${composerHtml('Reply in thread…')}`;
  detail.querySelector('.back').addEventListener('click', closeThread);
  detail.querySelector('.archive-btn').addEventListener('click', () => toggleArchive(key));
  bindComposer(detail, m.channel, m.threadTs || m.ts, async () => {
    m.replied = true;
    renderList();
    await openMention(key);
  });

  try {
    const data = await backend.getMentionContext(m.channel, m.ts, m.threadTs);
    if (token !== state.renderToken) return;
    mergeDirectory(data);
    setDetail(m.channel, data.messages);
    const box = detail.querySelector('.messages');
    box.innerHTML = data.messages.map((msg) => renderMessage(msg, { channel: m.channel, showReplies: !m.threadTs })).join('');
    const target = box.querySelector(`.message[data-ts="${CSS.escape(m.ts)}"]`);
    target?.classList.add('highlight');
    target?.scrollIntoView({ block: 'center' });
    if (m.unread) {
      m.seen = true;
      m.unread = false;
      renderList();
      backend.markMentionSeen(m.channel, m.ts, m.threadTs).catch((err) => console.warn('Could not mark seen:', err.message));
    }
    box.addEventListener('click', (e) => {
      const link = e.target.closest('.thread-link');
      if (link) openThreadFromChannel(key, m.channel, link.dataset.ts, box.scrollTop);
    });
  } catch (err) {
    detail.querySelector('.messages').innerHTML = `<p class="error" style="padding: 0 20px">Couldn't load: ${escapeHtml(err.message)}</p>`;
  }
}

// A DM or every-message channel: recent messages with a "New" divider;
// opening reads it, as in Slack.
async function openConversation(key) {
  const d = state.inboxItems.find((x) => x.key === key);
  if (!d) return;
  const token = ++state.renderToken;
  select(key, { scroll: false });
  state.openKey = key;
  state.backTo = null;
  document.querySelector('.app').classList.add('show-detail');

  const label = channelLabel(d.channel);
  const detail = $('#detail');
  detail.innerHTML = `
    <div class="detail-header">
      <button class="icon-btn back" data-shortcut="close" data-tip="Back">←</button>
      <h2>${escapeHtml(label)}</h2>
      <span class="spacer"></span>
      <button class="text-btn archive-btn" data-shortcut="archive" data-tip="${archiveLabel(d)}">${archiveLabel(d)}</button>
      <a class="open-slack" href="${escapeHtml(permalink(d.channel, d.lastTs))}" target="_blank" rel="noreferrer" data-shortcut="slack">Open in Slack ↗</a>
    </div>
    <div class="messages"><p class="muted" style="padding: 0 20px">Loading…</p></div>
    ${composerHtml(`Message ${label}…`)}`;
  detail.querySelector('.back').addEventListener('click', closeThread);
  detail.querySelector('.archive-btn').addEventListener('click', () => toggleArchive(key));
  bindComposer(detail, d.channel, null, async () => {
    await loadInbox();
    await openConversation(key);
  });

  try {
    const data = await backend.getConversation(d.channel, d.lastRead);
    if (token !== state.renderToken) return;
    mergeDirectory(data);
    setDetail(d.channel, data.messages);
    const box = detail.querySelector('.messages');
    box.innerHTML = data.messages
      .map((m) => (m.ts === data.firstUnreadTs ? '<div class="new-divider">New</div>' : '') + renderMessage(m, { channel: d.channel, showReplies: true }))
      .join('');
    const divider = box.querySelector('.new-divider');
    if (divider) box.scrollTop = divider.offsetTop - box.offsetTop - 60;
    else box.scrollTop = box.scrollHeight;
    box.addEventListener('click', (e) => {
      const link = e.target.closest('.thread-link');
      if (link) openThreadFromChannel(key, d.channel, link.dataset.ts, box.scrollTop);
    });

    const latest = data.messages[data.messages.length - 1];
    if (d.unread && latest) {
      backend
        .markChannelRead(d.channel, latest.ts)
        .then(() => {
          d.unread = false;
          d.lastRead = latest.ts;
          renderList();
        })
        .catch((err) => console.warn('Could not mark read:', err.message));
    }
  } catch (err) {
    detail.querySelector('.messages').innerHTML = `<p class="error" style="padding: 0 20px">Couldn't load messages: ${escapeHtml(err.message)}</p>`;
  }
}

// Move the selection to a neighbour of an item that's about to leave the list.
function selectNeighbour(key) {
  const visible = visibleItems();
  const idx = visible.findIndex((x) => x.key === key);
  const next = visible[idx + 1] || visible[idx - 1];
  state.selectedKey = next && next.key !== key ? next.key : null;
}

// ---------------------------------------------------------------------------
// Channel list: unread messages in channels and DMs

function visibleChannels() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.channelItems;
  return state.channelItems.filter((c) => {
    const m = c.preview?.latest;
    return [channelLabel(c.id), ...messageTexts(m).map(plain), m && authorOf(m)].join(' ').toLowerCase().includes(q);
  });
}

// Items arrive grouped by sidebar section; insert a header before each group.
function withSectionHeaders(items) {
  const names = new Map(state.sections.map((s) => [s.id, s.name]));
  const out = [];
  let current;
  for (const c of items) {
    if (c.section !== current || !out.length) {
      current = c.section;
      const count = items.filter((x) => x.section === current && !x.read).length;
      out.push({ key: `sec:${current}`, header: names.get(current) || 'Other', count });
    }
    out.push(c);
  }
  return out;
}

const sectionHeaderHtml = (h) => `<span>${escapeHtml(h.header)}</span>${h.count ? `<span class="count">${h.count}</span>` : ''}`;

function channelRowHtml(c) {
  const p = c.preview;
  const status = c.read ? 'Read' : p ? `${p.count}${p.hasMore ? '+' : ''} new` : '…';
  return `
    <span class="dot"></span>
    <div class="row">
      <span class="channel">${escapeHtml(channelLabel(c.id))}</span>
      <span class="time" title="${escapeHtml(fullTime(c.latest))}">${escapeHtml(relativeTime(c.latest))}</span>
    </div>
    ${p?.latest ? `<div class="row root"><span><b>${escapeHtml(authorOf(p.latest))}:</b> ${escapeHtml(messagePreview(p.latest))}</span></div>` : ''}
    <div class="row meta">
      <span>${status}</span>
      <span class="row-end">
        ${c.mentionCount ? `<span class="badge mention-badge">@${c.mentionCount}</span>` : ''}
        <button class="row-action" data-action="archive" data-shortcut="archive" data-tip="Mark read and remove">Done</button>
      </span>
    </div>`;
}

async function loadChannels() {
  if (state.channelsLoading) return;
  state.channelsLoading = true;
  try {
    const data = await backend.getChannels();
    mergeDirectory(data);
    state.channelCounts = data.counts;
    state.sections = data.sections || [];
    state.channelItems = data.items;
    state.channelsLoaded = true;
    renderList();
  } catch (err) {
    if (err instanceof backend.AuthError) return showConnect(err.message);
    $('#status').textContent = `Error: ${err.message}`;
    console.error(err);
  } finally {
    state.channelsLoading = false;
  }
}

function adjustChannelCount() {
  state.channelCounts.unread = Math.max(0, (state.channelCounts.unread || 0) - 1);
}

// restoreScroll: coming back from a thread, return to where you were.
async function openChannel(key, { restoreScroll = null } = {}) {
  const c = state.channelItems.find((x) => x.key === key);
  if (!c) return;
  const token = ++state.renderToken;
  select(key, { scroll: false });
  state.openKey = key;
  state.backTo = null;
  document.querySelector('.app').classList.add('show-detail');

  const label = channelLabel(c.id);
  const detail = $('#detail');
  detail.innerHTML = `
    <div class="detail-header">
      <button class="icon-btn back" data-shortcut="close" data-tip="Back">←</button>
      <h2>${escapeHtml(label)}</h2>
      <span class="spacer"></span>
      <button class="text-btn archive-btn" data-shortcut="archive" data-tip="Mark read and remove">Done</button>
      <a class="open-slack" href="${escapeHtml(permalink(c.id, c.latest))}" target="_blank" rel="noreferrer" data-shortcut="slack">Open in Slack ↗</a>
    </div>
    <div class="messages"><p class="muted" style="padding: 0 20px">Loading…</p></div>
    ${composerHtml(`Message ${label}…`)}`;
  detail.querySelector('.back').addEventListener('click', closeThread);
  detail.querySelector('.archive-btn').addEventListener('click', () => dismissChannel(key));
  bindComposer(detail, c.id, null, () => openChannel(key));

  try {
    const data = await backend.getChannelMessages(c.id);
    if (token !== state.renderToken) return;
    mergeDirectory(data);
    setDetail(c.id, data.messages);
    const box = detail.querySelector('.messages');
    box.innerHTML =
      (data.hasMoreUnread ? `<div class="list-note">Showing the latest 200 new messages.</div>` : '') +
      data.messages
        .map(
          (m) =>
            (m.ts === data.firstUnreadTs ? '<div class="new-divider">New</div>' : '') +
            renderMessage(m, { channel: c.id, showReplies: true }),
        )
        .join('');
    const divider = box.querySelector('.new-divider');
    if (restoreScroll !== null) box.scrollTop = restoreScroll;
    else if (divider) box.scrollTop = divider.offsetTop - box.offsetTop - 60;
    else box.scrollTop = box.scrollHeight;
    box.addEventListener('click', (e) => {
      const link = e.target.closest('.thread-link');
      if (link) openThreadFromChannel(key, c.id, link.dataset.ts, box.scrollTop);
    });

    // Opening a conversation reads it, as in Slack.
    const latest = data.messages[data.messages.length - 1];
    if (!c.read && latest) {
      backend
        .markChannelRead(c.id, latest.ts)
        .then(() => {
          c.read = true;
          c.mentionCount = 0;
          adjustChannelCount();
          renderList();
        })
        .catch((err) => console.warn('Could not mark channel read:', err.message));
    }
  } catch (err) {
    detail.querySelector('.messages').innerHTML = `<p class="error" style="padding: 0 20px">Couldn't load messages: ${escapeHtml(err.message)}</p>`;
  }
}

// Mark read (if needed) and drop it from the list.
function dismissChannel(key) {
  const c = state.channelItems.find((x) => x.key === key);
  if (!c) return;
  if (!c.read) {
    adjustChannelCount();
    backend.markChannelRead(c.id, c.latest).catch((err) => toast(`Couldn’t mark read: ${escapeHtml(err.message)}`));
  }
  const wasOpen = state.openKey === key;
  backend.dismissChannel(c.id);
  selectNeighbour(key);
  state.channelItems = state.channelItems.filter((x) => x.key !== key);
  renderList();
  advanceAfterRemoving(key, wasOpen);
}

// After archiving/dismissing: keep reading if a conversation was open.
function advanceAfterRemoving(key, wasOpen) {
  if (wasOpen && state.selectedKey) openItem(state.selectedKey);
  else if (wasOpen || state.openKey === null) closeThread();
}

// ---------------------------------------------------------------------------
// Views

function setView(view) {
  if (state.view === view) return;
  state.view = view;
  state.selectedKey = null;
  closeThread();
  document.querySelectorAll('.views button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.filters').forEach((f) => (f.hidden = f.dataset.view !== view));
  $('#search').placeholder = `Filter ${view}`;
  $('.list-pane').scrollTop = 0;
  renderList();
  if (view === 'channels') loadChannels();
}

function refreshView() {
  if (state.view === 'inbox') loadInbox({ full: true });
  else loadChannels();
}

// ---------------------------------------------------------------------------
// Thread detail

function reactionsHtml(m) {
  return m.reactions
    .map((r) => {
      const mine = r.users.includes(state.auth?.user_id);
      return `<button class="reaction${mine ? ' mine' : ''}" data-name="${escapeHtml(r.name)}" data-tip="${escapeHtml(reactionTip(r))}">${
        emojiHtml(r.name) || `:${escapeHtml(r.name)}:`
      } ${r.count}</button>`;
    })
    .join('');
}

// "Alice, Bob and 3 others reacted with :eyes:", like Slack's hover card.
function reactionTip(r) {
  const names = r.users.map((id) => (id === state.auth?.user_id ? 'You' : userName(id)));
  const others = r.count - names.length; // Slack caps the user list on big reactions.
  if (others > 0) names.push(`${others} ${others === 1 ? 'other' : 'others'}`);
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || 'Someone';
  return `${who} reacted with :${r.name}:`;
}

const link = (url, html) => `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${html}</a>`;

function blocksHtml(blocks) {
  return blocks
    .map((b) => {
      if (b.kind === 'text') return `<div class="block">${mrkdwn(b.text)}</div>`;
      if (b.kind === 'header') return `<div class="block block-header">${mrkdwn(b.text)}</div>`;
      if (b.kind === 'context') return `<div class="block block-context">${mrkdwn(b.text)}</div>`;
      if (b.kind === 'divider') return '<hr class="block-divider" />';
      if (b.kind === 'fields') return `<div class="block block-fields">${b.fields.map((f) => `<div>${mrkdwn(f)}</div>`).join('')}</div>`;
      if (b.kind === 'image' && /^https:/.test(b.url)) return `<div class="block">${mediaHtml({ src: b.url, w: b.w, h: b.h, alt: b.alt })}</div>`;
      if (b.kind === 'buttons') return `<div class="block block-buttons">${b.buttons.map((x) => link(x.url, mrkdwn(x.text))).join('')}</div>`;
      return '';
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Media: images, video and PDF thumbnails inline (as in Slack); click an image
// to see it full size.

const MEDIA_MAX_W = 360;
const MEDIA_MAX_H = 260;

// The box is sized up front from the known dimensions, so scroll positions
// (e.g. jumping to "New") don't shift as images arrive.
function mediaBox(w, h, maxW = MEDIA_MAX_W, maxH = MEDIA_MAX_H) {
  if (!w || !h) return `width:${maxW}px;aspect-ratio:4/3`;
  const scale = Math.min(1, maxW / w, maxH / h);
  return `width:${Math.max(40, Math.round(w * scale))}px;aspect-ratio:${w}/${h}`;
}

// src: a public image URL. slack: a files.slack.com URL, which needs your
// session and so loads through the extension (see hydrateMedia).
// full: shown when clicked; href: opened instead (videos, PDFs).
function mediaHtml({ src, slack, w, h, full, href, play = false, alt = '' }) {
  const img = slack
    ? `<img data-slack-src="${escapeHtml(slack)}" alt="${escapeHtml(alt)}" />`
    : `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" />`;
  const inner = `${img}${play ? '<span class="play">▶</span>' : ''}`;
  const attrs = `class="media" style="${mediaBox(w, h)}"${alt ? ` data-tip="${escapeHtml(alt)}"` : ''}`;
  if (href) return `<a ${attrs} href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${inner}</a>`;
  const target = full || slack || src;
  return `<button type="button" ${attrs} data-full="${escapeHtml(target)}"${/^https:\/\/files\.slack\.com\//.test(target) ? ' data-full-slack' : ''}>${inner}</button>`;
}

const fileChip = (f) => `<a class="file" href="${escapeHtml(f.url)}" target="_blank" rel="noreferrer">📎 ${escapeHtml(f.name)}</a>`;

function filesHtml(files) {
  const media = [];
  const chips = [];
  for (const f of files) {
    const kind = f.mimetype?.split('/')[0];
    if (!f.thumb || !(kind === 'image' || kind === 'video' || f.mimetype === 'application/pdf')) {
      chips.push(fileChip(f));
      continue;
    }
    // Thumbnails are stills, so small GIFs load the original to animate.
    const animated = f.mimetype === 'image/gif' && f.size < 5e6;
    media.push(
      mediaHtml({
        slack: animated ? f.full : f.thumb.url,
        w: f.w || f.thumb.w,
        h: f.h || f.thumb.h,
        full: kind === 'image' ? f.full : null,
        href: kind === 'image' ? null : f.url,
        play: kind === 'video',
        alt: f.name,
      }),
    );
  }
  return (
    (media.length ? `<div class="media-row">${media.join('')}</div>` : '') +
    (chips.length ? `<div class="files">${chips.join('')}</div>` : '')
  );
}

const iconImg = (url) => (/^https:/.test(url || '') ? `<img class="att-icon" src="${escapeHtml(url)}" alt="" loading="lazy" />` : '');
const maybeLink = (url, html) => (/^https?:/.test(url || '') ? link(url, html) : html);

// Link previews, quoted Slack messages and app attachments.
function attachmentHtml(a) {
  let head = '';
  if (a.isMessage) {
    if (a.author) head = `<div class="att-head">${iconImg(a.authorIcon)}<b>${maybeLink(a.authorUrl, escapeHtml(a.author))}</b></div>`;
  } else if (a.service) {
    head = `<div class="att-head muted">${iconImg(a.serviceIcon)}${escapeHtml(a.service)}${a.author ? ` · ${maybeLink(a.authorUrl, escapeHtml(a.author))}` : ''}</div>`;
  } else if (a.author) {
    head = `<div class="att-head">${iconImg(a.authorIcon)}${maybeLink(a.authorUrl, escapeHtml(a.author))}</div>`;
  }
  const title = a.title ? `<div class="title">${maybeLink(a.url, escapeHtml(a.title))}</div>` : '';
  const body = a.blocks ? blocksHtml(a.blocks) : a.text ? `<div class="att-text">${mrkdwn(a.text)}</div>` : '';
  const fields = a.fields?.length
    ? `<div class="att-fields">${a.fields
        .map((f) => `<div class="${f.short ? 'short' : ''}">${f.title ? `<div class="att-field-title">${escapeHtml(f.title)}</div>` : ''}<div>${mrkdwn(f.value)}</div></div>`)
        .join('')}</div>`
    : '';
  let big = '';
  if (a.image) big = mediaHtml({ src: a.image.url, w: a.image.w, h: a.image.h, alt: a.title });
  else if (a.thumb && a.isVideo) big = mediaHtml({ src: a.thumb.url, w: a.thumb.w, h: a.thumb.h, href: a.url, play: true, alt: a.title });
  const side = !big && a.thumb ? `<img class="att-thumb" src="${escapeHtml(a.thumb.url)}" alt="" loading="lazy" />` : '';
  const footerParts = [a.footer && mrkdwn(a.footer), a.ts && escapeHtml(fullTime(a.ts))].filter(Boolean);
  const footer = footerParts.length ? `<div class="att-footer">${footerParts.join(' · ')}</div>` : '';
  return `${a.pretext ? `<div class="msg-body">${mrkdwn(a.pretext)}</div>` : ''}
    <div class="attachment${a.isMessage ? ' quoted' : ''}"${a.color ? ` style="--bar:${escapeHtml(a.color)}"` : ''}>
      <div class="att-main">${head}${title}${body}${fields}${big ? `<div class="att-media">${big}</div>` : ''}${footer}</div>${side}
    </div>`;
}

// Slack-hosted images load through the extension once they're near the viewport.
const mediaObserver = new IntersectionObserver(
  (entries) => {
    for (const { isIntersecting, target: img } of entries) {
      if (!isIntersecting) continue;
      mediaObserver.unobserve(img);
      backend
        .slackFileUrl(img.dataset.slackSrc)
        .then((url) => {
          img.src = url;
        })
        .catch((err) => {
          img.closest('.media')?.classList.add('failed');
          console.warn('Could not load image:', err.message);
        });
    }
  },
  { rootMargin: '800px' },
);

function hydrateMedia(root) {
  root.querySelectorAll('img[data-slack-src]:not([data-watched])').forEach((img) => {
    img.dataset.watched = '1';
    mediaObserver.observe(img);
  });
}

function openLightbox(button) {
  const box = $('#lightbox');
  const img = box.querySelector('img');
  img.src = button.querySelector('img')?.src || ''; // The thumbnail while the original loads.
  box.hidden = false;
  if (!('fullSlack' in button.dataset)) {
    img.src = button.dataset.full;
    return;
  }
  const want = button.dataset.full;
  box.dataset.want = want;
  backend
    .slackFileUrl(want)
    .then((url) => {
      if (box.dataset.want === want) img.src = url;
    })
    .catch((err) => toast(`Couldn’t load image: ${escapeHtml(err.message)}`));
}

function closeLightbox() {
  const box = $('#lightbox');
  box.hidden = true;
  box.dataset.want = '';
  box.querySelector('img').removeAttribute('src');
}

function bindMedia() {
  new MutationObserver(() => hydrateMedia($('#detail'))).observe($('#detail'), { childList: true, subtree: true });
  $('#detail').addEventListener('click', (e) => {
    const button = e.target.closest('button.media');
    if (button) openLightbox(button);
  });
  $('#lightbox').addEventListener('click', closeLightbox);
}

function renderMessage(m, { isRoot = false, channel = null, showReplies = false } = {}) {
  const avatar = avatarOf(m);
  const author = authorOf(m);
  const avatarHtml = avatar
    ? `<img class="avatar" src="${escapeHtml(avatar)}" alt="" loading="lazy" />`
    : `<div class="avatar placeholder">${escapeHtml(author[0] || '?')}</div>`;
  const attachments = m.attachments.map(attachmentHtml).join('');
  const files = filesHtml(m.files);
  const reactions = `<div class="reactions" data-ts="${escapeHtml(m.ts)}">${reactionsHtml(m)}</div>`;
  return `
    <article class="message${isRoot ? ' root' : ''}" data-ts="${escapeHtml(m.ts)}">
      <button class="msg-react" data-react="${escapeHtml(m.ts)}" data-shortcut="react" data-tip="Add reaction">☺+</button>
      ${avatarHtml}
      <div>
        <div class="msg-head">
          <span class="author">${escapeHtml(author)}</span>
          <span class="ts" title="${escapeHtml(fullTime(m.ts))}">${escapeHtml(relativeTime(m.ts))}${m.edited ? ' (edited)' : ''}</span>
        </div>
        <div class="msg-body">${m.blocks ? blocksHtml(m.blocks) : mrkdwn(m.text)}</div>
        ${attachments}${files}${reactions}
        ${showReplies && m.replyCount ? `<button class="thread-link" data-ts="${escapeHtml(m.ts)}">${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}${m.latestReply ? `<span class="muted"> · last ${escapeHtml(relativeTime(m.latestReply))}</span>` : ''}</button>` : ''}
      </div>
    </article>`;
}

// A thread opened from a channel's "N replies", shown in place; back returns
// to the channel where you left off.
function openThreadFromChannel(channelKey, channel, ts, scrollTop) {
  const key = `${channel}:${ts}`;
  const thread = state.threads.find((x) => x.key === key) || { key, channel, threadTs: ts, lastTs: ts, isUnread: false };
  openThread(key, { thread, backTo: { key: channelKey, scrollTop } });
}

async function openThread(key, { thread = null, backTo = null } = {}) {
  const t = thread || state.threads.find((x) => x.key === key);
  if (!t) return;
  const token = ++state.renderToken;
  const listed = state.threads.includes(t); // Part of the thread inbox (vs. opened from a channel).
  if (!backTo) {
    select(key, { scroll: false });
    state.openKey = key;
  }
  state.backTo = backTo;
  document.querySelector('.app').classList.add('show-detail');

  const detail = $('#detail');
  detail.innerHTML = `
    <div class="detail-header">
      <button class="icon-btn back${backTo ? ' always' : ''}" data-shortcut="close" data-tip="${backTo ? `Back to ${escapeHtml(channelLabel(t.channel))}` : 'Back'}">←</button>
      <h2>${backTo ? 'Thread in ' : ''}${escapeHtml(channelLabel(t.channel))}</h2>
      <span class="spacer"></span>
      ${listed ? `<button class="text-btn archive-btn" data-shortcut="archive" data-tip="${archiveLabel(t)}">${archiveLabel(t)}</button>` : ''}
      <a class="open-slack" href="${escapeHtml(permalink(t.channel, t.threadTs))}" target="_blank" rel="noreferrer" data-shortcut="slack">Open in Slack ↗</a>
    </div>
    <div class="messages"><p class="muted" style="padding: 0 20px">Loading…</p></div>
    ${composerHtml('Reply in thread…')}`;
  detail.querySelector('.back').addEventListener('click', () => (backTo ? goBack() : closeThread()));
  detail.querySelector('.archive-btn')?.addEventListener('click', () => toggleArchive(key));
  bindComposer(detail, t.channel, t.threadTs, async () => {
    if (listed) await loadInbox();
    await openThread(t.key, { thread: listed ? null : t, backTo });
  });

  try {
    const data = await backend.getThread(t.channel, t.threadTs);
    if (token !== state.renderToken) return;
    mergeDirectory(data);
    setDetail(t.channel, data.messages);
    const [root, ...replies] = data.messages;
    const box = detail.querySelector('.messages');
    box.innerHTML =
      renderMessage(root, { isRoot: true }) +
      (replies.length ? `<div class="replies-divider">${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}</div>` : '') +
      replies.map((m) => renderMessage(m)).join('');
    box.scrollTop = box.scrollHeight;

    if (!listed) return;

    // The list may be a minute behind; catch the row up with what we loaded.
    const latest = data.messages[data.messages.length - 1];
    const hasNewer = Number(latest.ts) > Number(t.lastTs);
    if (hasNewer) {
      t.lastTs = latest.ts;
      t.last = replies.length ? latest : null;
      t.replyCount = replies.length;
      renderList();
      loadInbox(); // Pull the rest of the list up to date too.
    }

    // Opening a thread reads it, as in Slack.
    if (t.isUnread || hasNewer) {
      backend
        .markRead(t.channel, t.threadTs, latest.ts)
        .then(() => {
          t.isUnread = false;
          t.unread = false;
          t.unreadCount = 0;
          renderList();
        })
        .catch((err) => console.warn('Could not mark thread read:', err.message));
    }
  } catch (err) {
    detail.querySelector('.messages').innerHTML = `<p class="error" style="padding: 0 20px">Couldn't load thread: ${escapeHtml(err.message)}</p>`;
  }
}

const archiveLabel = (t) => (isArchived(t) ? 'Move to inbox' : 'Archive');

let toastTimer = null;
function toast(html) {
  const el = $('#toast');
  el.innerHTML = html;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

function setArchived(key, ts) {
  if (ts) state.archived[key] = ts;
  else delete state.archived[key];
  backend.updateArchived({ [key]: ts || null }).catch((err) => console.warn('Could not save archive:', err.message));
}

// Archive (or, in the Archived view, restore) an inbox item and move the
// selection to its neighbour, like an email inbox.
function toggleArchive(key) {
  const t = state.inboxItems.find((x) => x.key === key);
  if (!t) return;
  const wasArchived = isArchived(t);
  const wasOpen = state.openKey === key;

  selectNeighbour(key);
  state.undo = { key, prev: state.archived[key] };
  setArchived(key, wasArchived ? null : t.lastTs);
  renderList();
  advanceAfterRemoving(key, wasOpen);
  toast(`${wasArchived ? 'Moved to inbox' : 'Archived'} · <button id="undo">Undo</button> <kbd>z</kbd>`);
  $('#undo').addEventListener('click', undoArchive);
}

function undoArchive() {
  if (!state.undo) return;
  if (state.view !== 'inbox') return;
  const { key, prev } = state.undo;
  state.undo = null;
  setArchived(key, prev);
  state.selectedKey = key;
  renderList();
  if (state.openKey) openItem(key); // Undo while reading: go back to it.
  else select(key);
  $('#toast').hidden = true;
}

function showEmptyDetail() {
  $('#detail').innerHTML = EMPTY_DETAIL;
  state.attachments = null; // No composer showing, so nowhere to drop files.
}

function goBack() {
  const { key, scrollTop } = state.backTo;
  if (state.view === 'inbox') openItem(key);
  else openChannel(key, { restoreScroll: scrollTop });
}

function closeThread() {
  state.openKey = null;
  state.backTo = null;
  state.renderToken++;
  document.querySelector('.app').classList.remove('show-detail');
  showEmptyDetail();
}

// ---------------------------------------------------------------------------
// Composer autocomplete (Slack-style @people, @groups, @here, #channels)

const SPECIAL_MENTIONS = [
  { name: 'here', hint: 'Notify everyone online in this conversation' },
  { name: 'channel', hint: 'Notify everyone in this conversation' },
  { name: 'everyone', hint: 'Notify everyone in the workspace' },
];

// 0 = starts with the query, 1 = a word starts with it, 2 = contains it.
function matchRank(fields, q) {
  let best = Infinity;
  for (const f of fields) {
    const v = (f || '').toLowerCase();
    if (!v) continue;
    if (v.startsWith(q)) best = Math.min(best, 0);
    else if (v.split(/[\s._-]+/).some((w) => w.startsWith(q))) best = Math.min(best, 1);
    else if (q.length > 1 && v.includes(q)) best = Math.min(best, 2);
  }
  return best;
}

function searchMentionables(trigger, query) {
  const q = query.toLowerCase().trim();
  const { users, channels, usergroups } = state.mentionables;
  const results = [];
  const add = (score, item) => score < Infinity && results.push({ score, ...item });

  if (trigger === '#') {
    for (const c of channels) {
      add(matchRank([c.name], q) + (c.isMember ? 0 : 0.5), {
        insert: c.name,
        token: `<#${c.id}>`,
        html: `<span class="ac-avatar">${c.kind === 'private' ? '🔒' : '#'}</span><b>${escapeHtml(c.name)}</b>`,
      });
    }
  } else {
    // People already in this conversation come first, as in Slack.
    const here = new Set([...(state.detail?.messages.values() || [])].map((m) => m.user).filter(Boolean));
    for (const u of users) {
      const score = matchRank([u.name, u.realName], q) - (here.has(u.id) ? 10 : 0) + (u.isBot ? 3 : 0);
      add(score, {
        insert: u.name,
        token: `<@${u.id}>`,
        html: `${u.avatar ? `<img class="ac-avatar" src="${escapeHtml(u.avatar)}" alt="" />` : '<span class="ac-avatar">👤</span>'}<b>${escapeHtml(u.name)}</b>${
          u.realName && u.realName !== u.name ? `<span class="muted">${escapeHtml(u.realName)}</span>` : ''
        }`,
      });
    }
    for (const g of usergroups) {
      add(matchRank([g.handle, g.name], q) + 1, {
        insert: g.handle,
        token: `<!subteam^${g.id}>`,
        html: `<span class="ac-avatar">👥</span><b>@${escapeHtml(g.handle)}</b><span class="muted">${escapeHtml(g.name)} · ${g.userCount} people</span>`,
      });
    }
    if (q) {
      for (const s of SPECIAL_MENTIONS) {
        add(matchRank([s.name], q) + 2, {
          insert: s.name,
          token: `<!${s.name}>`,
          html: `<span class="ac-avatar">📣</span><b>@${s.name}</b><span class="muted">${s.hint}</span>`,
        });
      }
    }
  }
  return results.sort((a, b) => a.score - b.score).slice(0, 8);
}

function composerHtml(placeholder) {
  return `
    <form class="composer">
      <div class="attachments" hidden></div>
      <textarea placeholder="${escapeHtml(placeholder)}  (↵ send · ⇧↵ new line)"></textarea>
      <div class="row">
        <button type="submit" data-shortcut="send">Send</button>
        <button type="button" class="text-btn attach-btn" data-tip="Attach files (or drag / paste them in)">📎 Attach</button>
        <input type="file" class="file-input" multiple hidden />
        <span class="muted small composer-status"></span>
      </div>
    </form>`;
}

// ---------------------------------------------------------------------------
// Attachments: drag & drop anywhere on the conversation, paste, or the picker.

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // Files cross the extension bridge as base64.

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function bindAttachments(form) {
  const list = form.querySelector('.attachments');
  const input = form.querySelector('.file-input');
  const files = []; // [{ file, url }]

  const render = () => {
    list.hidden = !files.length;
    list.innerHTML = files
      .map(
        ({ file, url }, i) => `<div class="attachment-chip">
          ${url ? `<img src="${url}" alt="" />` : '<span class="file-icon">📄</span>'}
          <span class="name">${escapeHtml(file.name)}<span class="muted"> · ${formatBytes(file.size)}</span></span>
          <button type="button" class="remove" data-i="${i}" data-tip="Remove">×</button>
        </div>`,
      )
      .join('');
  };

  const add = (incoming) => {
    for (const file of incoming) {
      if (file.size > MAX_UPLOAD_BYTES) {
        toast(`${escapeHtml(file.name)} is too big (max ${formatBytes(MAX_UPLOAD_BYTES)}).`);
        continue;
      }
      files.push({ file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null });
    }
    render();
    form.querySelector('textarea').focus();
  };

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.remove');
    if (!btn) return;
    const [removed] = files.splice(Number(btn.dataset.i), 1);
    if (removed?.url) URL.revokeObjectURL(removed.url);
    render();
  });
  form.querySelector('.attach-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    add([...input.files]);
    input.value = '';
  });
  form.querySelector('textarea').addEventListener('paste', (e) => {
    const pasted = [...(e.clipboardData?.files || [])];
    if (!pasted.length) return;
    e.preventDefault();
    add(pasted);
  });

  return {
    add,
    files: () => files.map((f) => f.file),
    clear() {
      files.forEach((f) => f.url && URL.revokeObjectURL(f.url));
      files.length = 0;
      render();
    },
  };
}

// Drops anywhere on the reading pane go to whichever composer is showing.
function bindDropZone() {
  const pane = $('#detail');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  pane.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !state.attachments) return;
    depth++;
    pane.classList.add('dropping');
  });
  pane.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      pane.classList.remove('dropping');
    }
  });
  pane.addEventListener('dragover', (e) => {
    if (hasFiles(e) && state.attachments) e.preventDefault();
  });
  pane.addEventListener('drop', (e) => {
    if (!hasFiles(e) || !state.attachments) return;
    e.preventDefault();
    depth = 0;
    pane.classList.remove('dropping');
    state.attachments.add([...e.dataTransfer.files]);
  });
}

// threadTs null posts to the channel. afterSend re-renders the conversation.
function bindComposer(container, channel, threadTs, afterSend) {
  const form = container.querySelector('.composer');
  const textarea = form.querySelector('textarea');
  const ac = attachAutocomplete(textarea, { search: searchMentionables });
  const attachments = bindAttachments(form);
  state.attachments = attachments;
  const send = () => sendMessage(form, ac, attachments, channel, threadTs, afterSend);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  // Enter sends, Shift+Enter is a new line (as in Slack). Not mid-IME-composition.
  textarea.addEventListener('keydown', (e) => {
    if (e.isComposing || ac.handleKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
}

async function sendMessage(form, ac, attachments, channel, threadTs, afterSend) {
  const textarea = form.querySelector('textarea');
  const button = form.querySelector('button');
  const status = form.querySelector('.composer-status');
  const files = attachments.files();
  if (!textarea.value.trim() && !files.length) return;
  button.disabled = true;
  status.textContent = files.length ? `Uploading ${files.length} ${files.length === 1 ? 'file' : 'files'}…` : 'Sending…';
  try {
    if (files.length) {
      const payload = await Promise.all(
        files.map(async (f) => ({ name: f.name, type: f.type, size: f.size, base64: await readBase64(f) })),
      );
      await backend.uploadFiles(channel, threadTs, payload, ac.toSlackText());
    } else {
      await backend.reply(channel, threadTs, ac.toSlackText());
    }
    textarea.value = '';
    ac.reset();
    attachments.clear();
    status.textContent = '';
    await afterSend();
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Reactions

function setDetail(channel, messages) {
  state.detail = { channel, messages: new Map(messages.map((m) => [m.ts, m])) };
}

function bindReactions() {
  $('#detail').addEventListener('click', (e) => {
    const chip = e.target.closest('.reaction[data-name]');
    if (chip) return toggleReaction(chip.closest('.reactions').dataset.ts, chip.dataset.name);
    const add = e.target.closest('.msg-react');
    if (add) openEmojiPicker(add, (name) => toggleReaction(add.dataset.react, name));
  });
}

// Add or remove your reaction, optimistically, like clicking a chip in Slack.
async function toggleReaction(ts, name) {
  const m = state.detail?.messages.get(ts);
  if (!m) return;
  const me = state.auth.user_id;
  const before = structuredClone(m.reactions);
  let r = m.reactions.find((x) => x.name === name);
  const add = !r?.users.includes(me);
  if (add) {
    if (!r) m.reactions.push((r = { name, count: 0, users: [] }));
    r.count++;
    r.users.push(me);
    rememberEmoji(name);
  } else {
    r.count--;
    r.users = r.users.filter((u) => u !== me);
    if (!r.count) m.reactions = m.reactions.filter((x) => x !== r);
  }
  renderReactions(ts);
  try {
    await backend.react(state.detail.channel, ts, name, add);
  } catch (err) {
    m.reactions = before;
    renderReactions(ts);
    toast(`Couldn’t ${add ? 'add' : 'remove'} reaction: ${escapeHtml(err.message)}`);
  }
}

function renderReactions(ts) {
  const el = $(`#detail .reactions[data-ts="${CSS.escape(ts)}"]`);
  const m = state.detail?.messages.get(ts);
  if (el && m) el.innerHTML = reactionsHtml(m);
}

function rememberEmoji(name) {
  state.recentEmoji = [name, ...state.recentEmoji.filter((n) => n !== name)].slice(0, 16);
  backend.saveRecentEmoji(state.recentEmoji).catch(() => {});
}

function reactToLatest() {
  const buttons = $('#detail .messages')?.querySelectorAll('.msg-react');
  const last = buttons?.[buttons.length - 1];
  if (last) openEmojiPicker(last, (name) => toggleReaction(last.dataset.react, name));
}

// Emoji picker: type to search, arrows to move, Enter to pick, Esc to close.
const PICKER_COLUMNS = 9;
let picker = null; // { anchor, onPick, results, active }

function openEmojiPicker(anchor, onPick) {
  closeEmojiPicker();
  const el = $('#emoji-picker');
  picker = { anchor, onPick, results: [], active: 0 };
  el.hidden = false;
  const input = el.querySelector('input');
  input.value = '';
  renderPicker();

  const r = anchor.getBoundingClientRect();
  const p = el.getBoundingClientRect();
  const top = r.bottom + 6 + p.height < innerHeight ? r.bottom + 6 : Math.max(8, r.top - p.height - 6);
  el.style.top = `${top}px`;
  el.style.left = `${Math.min(Math.max(8, r.right - p.width), innerWidth - p.width - 8)}px`;
  anchor.closest('.message')?.classList.add('reacting');
  input.focus();
}

function closeEmojiPicker() {
  if (!picker) return;
  picker.anchor.closest('.message')?.classList.remove('reacting');
  picker = null;
  $('#emoji-picker').hidden = true;
}

function renderPicker() {
  const q = $('#emoji-picker input').value;
  const results = q.trim() ? searchEmoji(q) : [...new Set([...state.recentEmoji, ...searchEmoji('', 120)])];
  picker.results = results.filter((n) => emojiHtml(n));
  picker.active = Math.min(picker.active, Math.max(0, picker.results.length - 1));
  const grid = $('#emoji-picker .emoji-grid');
  grid.innerHTML = picker.results.length
    ? picker.results
        .map((n, i) => `<button class="emoji-cell${i === picker.active ? ' active' : ''}" data-name="${escapeHtml(n)}" data-tip=":${escapeHtml(n)}:">${emojiHtml(n)}</button>`)
        .join('')
    : '<p class="muted small">No emoji found.</p>';
  $('#emoji-picker .emoji-name').textContent = picker.results[picker.active] ? `:${picker.results[picker.active]}:` : '';
  grid.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function pickEmoji(name) {
  const { onPick } = picker;
  closeEmojiPicker();
  if (name) onPick(name);
}

function bindEmojiPicker() {
  const el = $('#emoji-picker');
  const input = el.querySelector('input');
  input.addEventListener('input', () => {
    picker.active = 0;
    renderPicker();
  });
  input.addEventListener('keydown', (e) => {
    const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: PICKER_COLUMNS, ArrowUp: -PICKER_COLUMNS };
    if (moves[e.key] !== undefined) {
      e.preventDefault();
      picker.active = Math.max(0, Math.min(picker.results.length - 1, picker.active + moves[e.key]));
      renderPicker();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickEmoji(picker.results[picker.active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeEmojiPicker();
    }
  });
  el.addEventListener('click', (e) => {
    const cell = e.target.closest('.emoji-cell');
    if (cell) pickEmoji(cell.dataset.name);
  });
  document.addEventListener('mousedown', (e) => {
    if (picker && !el.contains(e.target) && !e.target.closest('.msg-react')) closeEmojiPicker();
  });
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts. This one table drives the key handler, the hover
// tooltips (via data-shortcut) and the ? overlay.

const SHORTCUTS = {
  next: { group: 'Navigate', label: 'Next', show: ['J'], keys: ['j', 'ArrowDown'], run: () => moveSelection(1) },
  prev: { group: 'Navigate', label: 'Previous', show: ['K'], keys: ['k', 'ArrowUp'], run: () => moveSelection(-1) },
  open: { group: 'Navigate', label: 'Open', show: ['↵'], keys: ['Enter', 'o'], run: () => state.selectedKey && openItem(state.selectedKey) },
  close: { group: 'Navigate', label: 'Close · back to channel', show: ['Esc'], keys: ['Escape'], run: () => escape() },
  scrollDown: { group: 'Navigate', label: 'Scroll conversation', show: ['Space'], keys: [' '], run: () => scrollDetail(1) },
  scrollUp: { group: 'Navigate', label: 'Scroll conversation up', show: ['⇧', 'Space'], keys: ['Shift+ '], run: () => scrollDetail(-1) },

  inbox: { group: 'Lists', label: 'Inbox', show: ['I'], keys: ['i'], run: () => setView('inbox') },
  channels: { group: 'Lists', label: 'Channels', show: ['C'], keys: ['c'], run: () => setView('channels') },
  toggleView: { group: 'Lists', label: 'Switch Inbox ⇄ Channels', show: ['`'], keys: ['`'], run: () => cycleView() },
  filter1: { group: 'Lists', label: 'Inbox: all', show: ['1'], keys: ['1'], run: () => pickFilter(0) },
  filter2: { group: 'Lists', label: 'Inbox: unread', show: ['2'], keys: ['2'], run: () => pickFilter(1) },
  filter3: { group: 'Lists', label: 'Inbox: archived', show: ['3'], keys: ['3'], run: () => pickFilter(2) },
  search: { group: 'Lists', label: 'Filter list', show: ['/'], keys: ['/'], run: () => $('#search').focus() },
  refresh: { group: 'Lists', label: 'Refresh', show: ['⇧', 'R'], keys: ['Shift+R'], run: () => refreshView() },

  archive: { group: 'Actions', label: 'Archive · Done', show: ['E'], keys: ['e'], run: () => state.selectedKey && doneItem(state.selectedKey) },
  undo: { group: 'Actions', label: 'Undo archive / done', show: ['Z'], keys: ['z'], run: () => undoArchive() },
  reply: { group: 'Actions', label: 'Reply', show: ['R'], keys: ['r'], run: () => focusComposer() },
  react: { group: 'Actions', label: 'React to latest message', show: ['+'], keys: ['+'], run: () => reactToLatest() },
  send: { group: 'Actions', label: 'Send (⇧↵ for a new line)', show: ['↵'], keys: [] }, // Handled by the composer.
  slack: { group: 'Actions', label: 'Open in Slack', show: ['⇧', 'O'], keys: ['Shift+O'], run: () => openInSlack() },
  help: { group: 'Actions', label: 'Keyboard shortcuts', show: ['?'], keys: ['?'], run: () => toggleHelp() },
};

const KEYMAP = new Map(Object.values(SHORTCUTS).flatMap((s) => s.keys.map((k) => [k, s])));

const kbdHtml = (keys) => keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('');

function keyId(e) {
  if (e.shiftKey && (/^[A-Z]$/.test(e.key) || e.key === ' ')) return `Shift+${e.key.toUpperCase()}`;
  return e.key;
}

function onKeyDown(e) {
  hideTooltip();
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (typing) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!$('#help').hidden && e.key !== '?' && e.key !== 'Escape') return;
  if (!$('#lightbox').hidden && e.key !== 'Escape') return;
  const shortcut = KEYMAP.get(keyId(e));
  if (!shortcut) return;
  e.preventDefault();
  shortcut.run();
}

function escape() {
  if (!$('#lightbox').hidden) return closeLightbox();
  if (!$('#help').hidden) return toggleHelp();
  if (state.backTo) return goBack();
  if (state.openKey) return closeThread();
  if (state.query) {
    $('#search').value = '';
    state.query = '';
    renderList();
  }
}

const VIEW_ORDER = ['inbox', 'channels'];
function cycleView() {
  setView(VIEW_ORDER[(VIEW_ORDER.indexOf(state.view) + 1) % VIEW_ORDER.length]);
}

function pickFilter(i) {
  document.querySelector('.filters:not([hidden])')?.querySelectorAll('button')[i]?.click();
}

function scrollDetail(direction) {
  const box = $('#detail .messages');
  if (!box) {
    if (direction > 0 && state.selectedKey) openItem(state.selectedKey);
    return;
  }
  box.scrollBy({ top: direction * box.clientHeight * 0.8, behavior: 'smooth' });
}

function focusComposer() {
  if (!state.openKey) {
    if (!state.selectedKey) return;
    openItem(state.selectedKey); // Renders the composer synchronously.
  }
  $('#detail textarea')?.focus();
}

function openInSlack() {
  const link = $('#detail .open-slack');
  if (link) return window.open(link.href, '_blank', 'noreferrer');
  const i = state.view === 'inbox' && state.inboxItems.find((x) => x.key === state.selectedKey);
  const c = state.view === 'channels' && state.channelItems.find((x) => x.key === state.selectedKey);
  if (i) window.open(permalink(i.channel, i.threadTs || i.ts || i.lastTs, i.threadTs), '_blank', 'noreferrer');
  else if (c) window.open(permalink(c.id, c.latest), '_blank', 'noreferrer');
}

// In the filter box: ↓ / Enter jump into the results, Esc clears.
function bindSearchKeys() {
  $('#search').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      $('#search').blur();
      const first = visibleItems()[0];
      if (first) select(first.key);
    } else if (e.key === 'Escape' && state.query) {
      e.preventDefault();
      e.stopPropagation();
      $('#search').value = '';
      state.query = '';
      renderList();
    }
  });
}

function toggleHelp() {
  const help = $('#help');
  if (help.hidden) {
    const groups = {};
    for (const s of Object.values(SHORTCUTS)) (groups[s.group] ||= []).push(s);
    $('#help-body').innerHTML = Object.entries(groups)
      .map(
        ([group, items]) => `<section><h3>${group}</h3>${items
          .map((s) => `<div class="help-row"><span>${escapeHtml(s.label)}</span><span class="keys">${kbdHtml(s.show)}</span></div>`)
          .join('')}</section>`,
      )
      .join('');
  }
  help.hidden = !help.hidden;
}

// Hover tooltips: any element with data-shortcut (and optionally data-tip to
// override the label) shows its name and key after a short delay.
let tooltipTimer = null;
function bindTooltips() {
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-shortcut], [data-tip]');
    clearTimeout(tooltipTimer);
    if (!el) return hideTooltip();
    tooltipTimer = setTimeout(() => showTooltip(el), 350);
  });
  document.addEventListener('mousedown', hideTooltip);
  document.addEventListener('scroll', hideTooltip, true);
}

function showTooltip(el) {
  const s = SHORTCUTS[el.dataset.shortcut];
  if ((!s && !el.dataset.tip) || !el.isConnected) return;
  const tip = $('#tooltip');
  tip.innerHTML = `<span>${escapeHtml(el.dataset.tip || s.label)}</span>${s ? kbdHtml(s.show) : ''}`;
  tip.classList.toggle('wrap', !s);
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const below = r.bottom + 6 + t.height < innerHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 8);
  tip.style.left = `${left}px`;
  tip.style.top = `${below ? r.bottom + 6 : r.top - t.height - 6}px`;
}

function hideTooltip() {
  clearTimeout(tooltipTimer);
  $('#tooltip').hidden = true;
}

// ---------------------------------------------------------------------------
// Connect + boot

function showConnect(message) {
  $('#app').hidden = true;
  $('#connect').hidden = false;
  $('#connect-message').textContent = message;
  $('#connect-actions').hidden = false;
}

$('#connect-retry').addEventListener('click', () => boot());

function bindUi() {
  $('#thread-list').addEventListener('click', (e) => {
    const item = e.target.closest('.thread-item');
    if (!item) return;
    if (e.target.closest('[data-action="archive"]')) doneItem(item.dataset.key);
    else openItem(item.dataset.key);
  });
  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderList();
  });
  document.querySelectorAll('.views button').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));
  document.querySelectorAll('.filters[data-view="inbox"] button').forEach((btn) =>
    btn.addEventListener('click', () => setFilter(btn.dataset.filter)),
  );
  $('#refresh').addEventListener('click', refreshView);

  document.addEventListener('keydown', onKeyDown);
  bindReactions();
  bindEmojiPicker();
  bindDropZone();
  bindMedia();
  bindSearchKeys();
  bindTooltips();
  $('#help-btn').addEventListener('click', toggleHelp);
  $('#help-close').addEventListener('click', toggleHelp);
  $('#help').addEventListener('click', (e) => e.target === $('#help') && toggleHelp());

  const refreshAll = () => {
    if (document.visibilityState !== 'visible') return;
    loadInbox();
    loadChannels();
  };
  setInterval(refreshAll, REFRESH_MS);
  document.addEventListener('visibilitychange', refreshAll);
}

function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll('.filters[data-view="inbox"] button').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
  renderList();
}

let uiBound = false;
async function boot() {
  $('#app').hidden = true;
  $('#connect').hidden = false;
  $('#connect-actions').hidden = true;
  $('#connect-message').textContent = 'Connecting to Slack…';
  let auth;
  try {
    auth = await backend.connect();
  } catch (err) {
    return showConnect(err instanceof backend.AuthError ? err.message : `Couldn’t reach Slack: ${err.message}`);
  }
  state.auth = auth;
  $('#connect').hidden = true;
  $('#app').hidden = false;
  $('#me').textContent = `${auth.user} · ${auth.team}`;
  if (!uiBound) {
    bindUi();
    uiBound = true;
  }
  await backend.migrateMentionsDone().catch((err) => console.warn('Mention migration failed:', err.message));
  state.archived = await backend.loadArchived().catch(() => ({}));
  backend.loadRecentEmoji().then((r) => r && (state.recentEmoji = r)).catch(() => {});
  backend
    .getMentionables()
    .then((m) => (state.mentionables = m))
    .catch((err) => console.warn('Mention autocomplete unavailable:', err.message));
  backend
    .getCustomEmoji()
    .then((map) => {
      setCustomEmoji(map);
      renderList();
    })
    .catch((err) => console.warn('Custom emoji unavailable:', err.message));
  // Show the saved inbox immediately, then refresh it page by page.
  try {
    applyInbox(await backend.cachedInbox());
    state.inboxLoaded = false; // Mentions and DMs aren't in the cache; keep "Loading…" until they arrive.
  } catch (err) {
    console.warn('No cached inbox:', err.message);
  }
  loadInbox({ full: true });
  loadChannels(); // For the Channels tab count.
}

boot();
