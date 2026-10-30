// Conversations that are wholly for you, for the inbox: direct messages (1:1
// and group), plus channels you get notified about for every message. Each is
// one row with its latest message. Read state comes from client.counts.

import { slimMessage, collectRefs } from './threads.js';

const RECENT_DAYS = 30;
const CONVERSATION_LIMIT = 50;
const COUNT_LIMIT = 100;

const tsNum = (ts) => (ts ? Number(ts) : 0);

export class DmService {
  constructor(slack, directory, userId) {
    this.slack = slack;
    this.directory = directory;
    this.userId = userId;
    this.items = [];
    this.previews = new Map(); // id -> { latest, message }
  }

  // counts: a client.counts response (ChannelService fetches it).
  // everyMessage: ids of channels set to notify on every message.
  async refresh(counts, everyMessage = new Set()) {
    if (!counts) return;
    const cutoff = Date.now() / 1000 - RECENT_DAYS * 86400;
    const recent = (c) => tsNum(c.latest) > cutoff;
    const dms = [...(counts.ims || []), ...(counts.mpims || [])].filter(recent);
    const channels = (counts.channels || []).filter((c) => everyMessage.has(c.id) && recent(c));
    await this.directory.resolveChannels([...dms, ...channels].map((c) => c.id));
    const mine = (c) => this.directory.channels.get(c.id)?.user === this.userId; // Your DM with yourself.
    const convs = [...dms.filter((c) => !mine(c)).map((c) => ({ c, type: 'dm' })), ...channels.map((c) => ({ c, type: 'channel' }))];
    await Promise.all(convs.map(({ c, type }) => this.#preview(c, type === 'channel')));
    this.items = convs.map(({ c, type }) => {
      const p = this.previews.get(c.id);
      const isUnread = Boolean(c.has_unreads) && tsNum(c.latest) > tsNum(c.last_read);
      return {
        key: `${type}:${c.id}`,
        type,
        channel: c.id,
        lastTs: c.latest,
        lastRead: c.last_read,
        // A channel can be "unread" with only new thread replies; those show up as threads.
        unread: isUnread && (type === 'dm' || p?.newCount > 0),
        // In DMs every message counts as a mention; channels count new messages.
        unreadCount: type === 'dm' ? c.mention_count || 0 : p?.newCount ? `${p.newCount}${p.hasMore ? '+' : ''}` : 0,
        last: p?.message || null,
      };
    });
  }

  // Latest message, refetched only when the conversation has something new.
  // For channels, also how many messages arrived since your read position.
  async #preview(c, countNew) {
    const key = countNew ? `${c.last_read}:${c.latest}` : c.latest;
    if (this.previews.get(c.id)?.key === key) return;
    try {
      let r = await this.slack.call('conversations.history', countNew ? { channel: c.id, oldest: c.last_read, limit: COUNT_LIMIT } : { channel: c.id, limit: 1 });
      const newCount = countNew ? (r.messages || []).length : null;
      const hasMore = countNew && Boolean(r.has_more);
      if (!r.messages?.length) r = await this.slack.call('conversations.history', { channel: c.id, limit: 1 });
      this.previews.set(c.id, { key, message: slimMessage(r.messages?.[0]), newCount, hasMore });
    } catch (err) {
      console.warn(`[dms] history ${c.id}: ${err.code || err.message}`);
    }
  }

  async snapshot() {
    const refs = collectRefs(this.items.map((d) => d.last));
    this.items.forEach((d) => refs.channels.add(d.channel));
    await this.directory.resolve(refs);
    return { items: this.items, ...this.directory.pick(refs) };
  }

  // Recent messages oldest-first, with where the unread part starts.
  async conversation(channel, lastRead) {
    const r = await this.slack.call('conversations.history', { channel, limit: CONVERSATION_LIMIT });
    const messages = (r.messages || []).reverse().map(slimMessage);
    const firstUnread = messages.find((m) => tsNum(m.ts) > tsNum(lastRead) && m.user !== this.userId);
    const refs = collectRefs(messages);
    refs.channels.add(channel);
    await this.directory.resolve(refs);
    return { messages, firstUnreadTs: firstUnread?.ts || null, ...this.directory.pick(refs) };
  }
}
