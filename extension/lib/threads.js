// Thread inbox: every thread you're subscribed to (started, replied, mentioned,
// or followed), via the internal endpoint behind Slack's own "Threads" view.

import { storage } from '../platform.js';

// Slack caps this endpoint at 10 threads per page, whatever limit you ask for.
const PAGE_SIZE = 10;

const tsNum = (ts) => (ts ? Number(ts) : 0);
const maxTs = (...values) => values.filter(Boolean).reduce((a, b) => (tsNum(b) > tsNum(a) ? b : a), null);

const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const CHANNEL_RE = /<#([CGD][A-Z0-9]+)(?:\|[^>]*)?>|slack\.com\/archives\/([CGD][A-Z0-9]+)/g;

// Block Kit → a few simple pieces whose text is all Slack mrkdwn, so the UI
// renders them like message text. Apps (Notion, GitHub, ...) often put their
// links and content only in blocks, with a bare-bones fallback `text`.
const escapeMrkdwn = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textObject = (t) => (!t ? '' : t.type === 'plain_text' ? escapeMrkdwn(t.text) : t.text || '');

function richTextElement(e) {
  const style = (s) => {
    if (!s || !e.style) return s;
    if (e.style.code) s = `\`${s}\``;
    if (e.style.bold) s = `*${s}*`;
    if (e.style.italic) s = `_${s}_`;
    if (e.style.strike) s = `~${s}~`;
    return s;
  };
  switch (e.type) {
    case 'text': return style(escapeMrkdwn(e.text));
    case 'link': return e.text ? `<${e.url}|${escapeMrkdwn(e.text)}>` : `<${e.url}>`;
    case 'user': return `<@${e.user_id}>`;
    case 'channel': return `<#${e.channel_id}>`;
    case 'usergroup': return `<!subteam^${e.usergroup_id}>`;
    case 'broadcast': return `<!${e.range}>`;
    case 'emoji': return `:${e.name}:`;
    case 'date': return `<!date^${e.timestamp}^${e.format || '{date_short_pretty} {time}'}|${e.fallback || ''}>`;
    default: return '';
  }
}

function richText(block) {
  return (block.elements || [])
    .map((el) => {
      const inline = (el.elements || []).map(richTextElement).join('');
      if (el.type === 'rich_text_preformatted') return `\`\`\`${inline}\`\`\``;
      if (el.type === 'rich_text_quote') return inline.split('\n').map((l) => `&gt; ${l}`).join('\n');
      if (el.type === 'rich_text_list') {
        return (el.elements || [])
          .map((item, i) => `${el.style === 'ordered' ? `${i + 1}.` : '•'} ${(item.elements || []).map(richTextElement).join('')}`)
          .join('\n');
      }
      return inline;
    })
    .join('\n');
}

// all: keep rich_text-only blocks too (attachments have no mirrored `text`).
export function slimBlocks(blocks, { all = false } = {}) {
  // Ordinary typed messages only have rich_text, which `text` already mirrors.
  if (!blocks?.length || (!all && !blocks.some((b) => b.type !== 'rich_text'))) return null;
  const out = [];
  for (const b of blocks) {
    if (b.type === 'rich_text') out.push({ kind: 'text', text: richText(b) });
    else if (b.type === 'header') out.push({ kind: 'header', text: textObject(b.text) });
    else if (b.type === 'divider') out.push({ kind: 'divider' });
    else if (b.type === 'image') {
      out.push({ kind: 'image', url: b.image_url || '', alt: b.alt_text || b.title?.text || '', w: b.image_width || 0, h: b.image_height || 0 });
    }
    else if (b.type === 'context') {
      const text = (b.elements || []).filter((e) => e.type !== 'image').map(textObject).join(' ');
      if (text.trim()) out.push({ kind: 'context', text });
    } else if (b.type === 'section') {
      const text = textObject(b.text);
      if (text.trim()) out.push({ kind: 'text', text });
      const fields = (b.fields || []).map(textObject).filter(Boolean);
      if (fields.length) out.push({ kind: 'fields', fields });
      const link = b.accessory?.type === 'button' && b.accessory.url;
      if (link) out.push({ kind: 'buttons', buttons: [{ text: textObject(b.accessory.text), url: link }] });
    } else if (b.type === 'actions') {
      // Only link buttons; interactive ones need the app's backend.
      const buttons = (b.elements || [])
        .filter((e) => e.type === 'button' && e.url)
        .map((e) => ({ text: textObject(e.text), url: e.url }));
      if (buttons.length) out.push({ kind: 'buttons', buttons });
    }
  }
  return out.length ? out : null;
}

// All the mrkdwn a message shows, for previews, search and name lookups.
export function messageTexts(m) {
  if (!m) return [];
  const blockTexts = (blocks) => (blocks || []).flatMap((b) => [b.text, ...(b.fields || [])]).filter(Boolean);
  const fromBlocks = blockTexts(m.blocks);
  return [
    ...(fromBlocks.length ? fromBlocks : [m.text]),
    ...(m.attachments || []).flatMap((a) => [a.text, a.pretext, ...(a.fields || []).map((f) => f.value), ...blockTexts(a.blocks)]),
  ];
}

const media = (url, w, h) => (url ? { url, w: w || 0, h: h || 0 } : null);

// Link previews (unfurls), quoted Slack messages, and app attachments.
function slimAttachment(a) {
  const isMessage = Boolean(a.is_msg_unfurl || a.is_share);
  return {
    title: a.title || (isMessage ? '' : a.author_name) || '',
    url: a.title_link || a.from_url || a.original_url || '',
    text: a.text || (a.blocks ? '' : a.fallback) || '',
    pretext: a.pretext || '',
    color: /^#?[0-9a-f]{3,8}$/i.test(a.color || '') ? `#${a.color.replace('#', '')}` : '',
    service: a.service_name || '',
    serviceIcon: a.service_icon || '',
    author: isMessage || a.title ? a.author_name || a.author_subname || '' : '',
    authorIcon: a.author_icon || '',
    authorUrl: a.author_link || '',
    isMessage,
    image: media(a.image_url, a.image_width, a.image_height),
    thumb: media(a.thumb_url, a.thumb_width, a.thumb_height),
    isVideo: Boolean(a.video_html || a.video_url),
    fields: (a.fields || []).map((f) => ({ title: f.title || '', value: f.value || '', short: Boolean(f.short) })),
    footer: a.footer || '',
    ts: a.ts ? String(a.ts) : null,
    blocks: a.blocks ? slimBlocks(a.blocks, { all: true }) : null,
  };
}

// Shared files; images/videos/PDFs carry a thumbnail to show inline.
function slimFile(f) {
  const thumb =
    media(f.thumb_720, f.thumb_720_w, f.thumb_720_h) ||
    media(f.thumb_480, f.thumb_480_w, f.thumb_480_h) ||
    media(f.thumb_360, f.thumb_360_w, f.thumb_360_h) ||
    media(f.thumb_video, f.thumb_video_w, f.thumb_video_h) ||
    media(f.thumb_pdf, f.thumb_pdf_w, f.thumb_pdf_h);
  return {
    name: f.title || f.name || 'file',
    url: f.permalink || f.url_private || '',
    full: f.url_private || '',
    mimetype: f.mimetype || '',
    size: f.size || 0,
    w: f.original_w || thumb?.w || 0,
    h: f.original_h || thumb?.h || 0,
    thumb,
  };
}

export function slimMessage(m) {
  if (!m) return null;
  return {
    ts: m.ts,
    threadTs: m.thread_ts || null,
    user: m.user || null,
    botId: m.bot_id || null,
    botName: m.bot_profile?.name || m.username || null,
    botIcon: m.bot_profile?.icons?.image_48 || m.icons?.image_48 || null,
    subtype: m.subtype || null,
    text: m.text || '',
    blocks: slimBlocks(m.blocks),
    attachments: (m.attachments || []).map(slimAttachment).filter((a) => a.title || a.text || a.image || a.thumb || a.blocks),
    files: (m.files || []).filter((f) => f.mode !== 'tombstone').map(slimFile),
    reactions: (m.reactions || []).map((r) => ({ name: r.name, count: r.count, users: r.users || [] })),
    edited: Boolean(m.edited),
    replyCount: m.reply_count || 0,
    latestReply: m.latest_reply || null,
  };
}

// Pull every user/channel ID a message references so names can be resolved.
export function collectRefs(messages, users = new Set(), channels = new Set(), bots = new Set()) {
  for (const m of messages) {
    if (!m) continue;
    if (m.user) users.add(m.user);
    if (m.botId && !m.botName && !m.user) bots.add(m.botId);
    for (const r of m.reactions || []) r.users.forEach((u) => users.add(u));
    for (const t of [m.text, ...messageTexts(m)]) {
      for (const [, id] of String(t || '').matchAll(MENTION_RE)) users.add(id);
      for (const [, id, linkId] of String(t || '').matchAll(CHANNEL_RE)) channels.add(id || linkId);
    }
  }
  return { users, channels, bots };
}

function normalizeThread(t) {
  const root = t.root_msg || t.root || t.message;
  if (!root) return null;
  const latest = t.latest_replies || [];
  const unread = t.unread_replies || [];
  const channel =
    root.channel || t.channel || t.channel_id || latest[0]?.channel || unread[0]?.channel || null;
  if (!channel) return null;

  const threadTs = root.thread_ts || root.ts;
  const replies = [...latest, ...unread];
  const lastReply = replies.reduce((a, b) => (!a || tsNum(b.ts) > tsNum(a.ts) ? b : a), null);
  const lastTs = maxTs(root.latest_reply, lastReply?.ts, root.ts);

  const unreadCount = unread.length;
  const isUnread =
    unreadCount > 0 || (root.last_read && root.latest_reply && tsNum(root.latest_reply) > tsNum(root.last_read));

  return {
    key: `${channel}:${threadTs}`,
    channel,
    threadTs,
    lastTs,
    replyCount: root.reply_count || replies.length,
    replyUsers: root.reply_users || [...new Set(replies.map((r) => r.user).filter(Boolean))],
    unreadCount,
    isUnread: Boolean(isUnread),
    lastRead: root.last_read || null,
    root: slimMessage(root),
    last: slimMessage(lastReply && lastReply.ts !== root.ts ? lastReply : null),
  };
}

const STORAGE_KEY = 'threads';
const MAX_SAVED = 2000;
const MAX_PAGES = 30;
// How far back a first sync (nothing cached yet) reads.
const FIRST_SYNC_DAYS = 14;
// Cached unread threads newer than this get re-read so their read state stays current.
const UNREAD_RECHECK_DAYS = 14;

export class ThreadService {
  constructor(slack, directory) {
    this.slack = slack;
    this.directory = directory;
    this.threads = new Map();
    this.meta = {};
    this.syncedTo = null; // newest reply time seen by the last complete sync
    this.fetchedAt = 0;
    this.inflight = null;
    this.saveTimer = null;
  }

  // Last known inbox, so Snack can show something before the first request.
  async load() {
    const saved = await storage.get(STORAGE_KEY);
    for (const t of saved?.threads || []) this.threads.set(t.key, t);
    Object.assign(this, { meta: saved?.meta || {}, syncedTo: saved?.syncedTo || null, fetchedAt: saved?.fetchedAt || 0 });
  }

  #sorted() {
    return [...this.threads.values()].sort((a, b) => tsNum(b.lastTs) - tsNum(a.lastTs));
  }

  #scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const { meta, syncedTo, fetchedAt } = this;
      storage.set({ [STORAGE_KEY]: { threads: this.#sorted().slice(0, MAX_SAVED), meta, syncedTo, fetchedAt } });
    }, 500);
  }

  // One page of subscriptions.thread.getView, newest activity first. Slack
  // pages backwards with `current_ts`: each page holds threads whose latest
  // reply is older than it. (`max_ts` in the response is not a cursor.)
  async #fetchPage(before) {
    return this.slack.call('subscriptions.thread.getView', {
      current_ts: before || (Date.now() / 1000).toFixed(6),
      limit: PAGE_SIZE,
      org_wide_aware: true,
    });
  }

  // Slack lists threads by latest reply, so anything older than what the last
  // sync saw hasn't changed, except read state, so recently unread threads are
  // re-read too. Usually that's a single page.
  #horizon() {
    const now = Date.now() / 1000;
    const recheck = now - UNREAD_RECHECK_DAYS * 86400;
    const unread = [...this.threads.values()].filter((t) => t.isUnread && tsNum(t.lastTs) > recheck).map((t) => tsNum(t.lastTs));
    const synced = this.syncedTo ? tsNum(this.syncedTo) : now - FIRST_SYNC_DAYS * 86400;
    return Math.min(synced, ...unread);
  }

  // Pages are merged in as they arrive and `onPage` fires after each one, so
  // the UI can render the newest threads while older pages are still loading.
  async #fetch(maxPages, onPage) {
    const horizon = this.#horizon();
    let before = null;
    let pages = 0;
    let hasMore = true;
    let caughtUp = false;
    let newest = null;

    while (hasMore && !caughtUp && pages < maxPages) {
      const r = await this.#fetchPage(before);
      pages++;
      if (pages === 1) {
        this.meta = {
          totalUnreadReplies: r.total_unread_replies ?? null,
          newThreadsCount: r.new_threads_count ?? null,
        };
      }

      let oldest = null;
      for (const raw of r.threads || []) {
        const t = normalizeThread(raw);
        if (!t) continue;
        this.threads.set(t.key, t);
        if (!oldest || tsNum(t.lastTs) < tsNum(oldest)) oldest = t.lastTs;
        if (!newest || tsNum(t.lastTs) > tsNum(newest)) newest = t.lastTs;
      }

      // Stop if pagination isn't advancing.
      hasMore = Boolean(r.has_more) && Boolean(oldest) && (!before || tsNum(oldest) < tsNum(before));
      caughtUp = Boolean(oldest) && tsNum(oldest) < horizon;
      before = oldest;
      this.fetchedAt = Date.now();
      await onPage?.({ pages, done: !hasMore || caughtUp || pages >= maxPages });
    }

    // Only a sync that reached the horizon may move it; otherwise there'd be a gap.
    if ((caughtUp || !hasMore) && newest && tsNum(newest) > tsNum(this.syncedTo)) this.syncedTo = newest;
  }

  // Reads newest-first until caught up with the last sync. full allows a longer
  // catch-up (after time away); a periodic refresh reads at most a few pages.
  async refresh({ full = false, onPage } = {}) {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      await this.#fetch(full || this.threads.size === 0 ? MAX_PAGES : 3, onPage);
      this.#scheduleSave();
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  markRead(key) {
    const t = this.threads.get(key);
    if (t) {
      t.isUnread = false;
      t.unreadCount = 0;
      this.#scheduleSave();
    }
  }

  async snapshot() {
    const threads = this.#sorted();
    const refs = collectRefs(threads.flatMap((t) => [t.root, t.last]));
    threads.forEach((t) => t.replyUsers.slice(0, 4).forEach((u) => refs.users.add(u)));
    threads.forEach((t) => refs.channels.add(t.channel));

    await this.directory.resolve(refs);

    return {
      threads,
      ...this.directory.pick(refs),
      meta: { ...this.meta, fetchedAt: this.fetchedAt },
    };
  }

  async replies(channel, ts) {
    const messages = [];
    let cursor;
    do {
      const r = await this.slack.call('conversations.replies', { channel, ts, limit: 200, cursor });
      messages.push(...(r.messages || []));
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);

    const slim = messages.map(slimMessage);
    const refs = collectRefs(slim);
    refs.channels.add(channel);
    await this.directory.resolve(refs);
    return { messages: slim, ...this.directory.pick(refs) };
  }
}
