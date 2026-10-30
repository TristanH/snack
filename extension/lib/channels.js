// Passive unreads: channels you're in. DMs and channels you get notified about
// for every message live in the inbox instead. Which conversations are unread comes
// from client.counts (one call; what Slack's own sidebar uses); the messages
// themselves from conversations.history, starting at your last_read marker.

import { slimMessage, collectRefs } from './threads.js';

const PREVIEW_LIMIT = 100;
const CONTEXT_MESSAGES = 3;
const PREFS_MAX_AGE_MS = 10 * 60 * 1000;

// Conversations you've told Slack you don't care about are never synced:
// muted channels, and anything filed in a sidebar section with one of these names.
const IGNORED_SECTION_NAMES = new Set(['ignore']);

// Every-message channels that stay in the Channels view instead of the inbox.
const NOT_IN_INBOX = /^errors/;

// Names for Slack's built-in sidebar sections (they come back unnamed).
const BUILTIN_SECTION_NAMES = {
  stars: 'Starred',
  direct_messages: 'Direct messages',
  channels: 'Channels',
  slack_connect: 'Slack Connect',
};

const tsNum = (ts) => (ts ? Number(ts) : 0);

export class ChannelService {
  constructor(slack, directory) {
    this.slack = slack;
    this.directory = directory;
    this.unread = new Map(); // id -> { id, lastRead, latest, mentionCount, read, readFrom }
    this.ignoredCount = 0;
    this.lastReadOf = new Map(); // every conversation's read position, from client.counts
    this.previews = new Map(); // id -> { key, count, hasMore, latest }
    this.kept = new Map(); // read this session; stays listed until dismissed
    this.muted = new Set();
    this.notifyAll = new Set(); // channels set to notify on every message
    this.sections = []; // [{ id, name, type }] in sidebar order
    this.sectionOf = new Map(); // channel id -> section id
    this.prefsAt = 0;
    this.inflight = null;
    this.counts = null; // latest client.counts, shared with the inbox's DMs
    this.refreshedAt = 0;
  }

  // Muted channels live in the notification prefs; sidebar sections in
  // users.channelSections.list. Neither changes often, so cache both.
  async #loadPrefs() {
    if (Date.now() - this.prefsAt < PREFS_MAX_AGE_MS) return;
    const [{ prefs }, sections] = await Promise.all([
      this.slack.call('users.prefs.get'),
      this.slack.call('users.channelSections.list').catch((err) => {
        console.warn(`[channels] sections: ${err.code || err.message}`);
        return null;
      }),
    ]);
    if (sections) this.#setSections(sections.channel_sections || []);
    let notif = prefs.all_notifications_prefs;
    if (typeof notif === 'string') notif = JSON.parse(notif);
    this.muted = new Set(
      Object.entries(notif?.channels || {})
        .filter(([, p]) => p.muted)
        .map(([id]) => id),
    );
    // Only channels you set to "All new messages" yourself, not ones that
    // inherit it from the workspace-wide default.
    this.notifyAll = new Set(
      Object.entries(notif?.channels || {})
        .filter(([, p]) => !p.muted && (p.desktop === 'everything' || p.mobile === 'everything'))
        .map(([id]) => id),
    );
    this.prefsAt = Date.now();
  }

  // Sections are a linked list (next_channel_section_id); walk it for sidebar order.
  #setSections(raw) {
    const byId = new Map(raw.map((s) => [s.channel_section_id, s]));
    const pointedTo = new Set(raw.map((s) => s.next_channel_section_id).filter(Boolean));
    let cur = raw.find((s) => !pointedTo.has(s.channel_section_id)) || raw[0];
    const ordered = [];
    while (cur && !ordered.includes(cur)) {
      ordered.push(cur);
      cur = byId.get(cur.next_channel_section_id);
    }
    for (const s of raw) if (!ordered.includes(s)) ordered.push(s);

    this.sections = ordered.map((s) => ({
      id: s.channel_section_id,
      name: s.name || BUILTIN_SECTION_NAMES[s.type] || '',
      type: s.type,
    }));
    this.sectionOf = new Map();
    for (const s of ordered) for (const id of s.channel_ids_page?.channel_ids || []) this.sectionOf.set(id, s.channel_section_id);
  }

  #isIgnored(id) {
    if (this.muted.has(id)) return true;
    const section = this.sections.find((s) => s.id === this.sectionOf.get(id));
    return Boolean(section && IGNORED_SECTION_NAMES.has(section.name.trim().toLowerCase()));
  }

  // Channels that belong in the inbox (every message notifies you).
  everyMessageChannels() {
    const name = (id) => this.directory.channels.get(id)?.name || '';
    return new Set([...this.notifyAll].filter((id) => !this.#isIgnored(id) && !NOT_IN_INBOX.test(name(id))));
  }

  // Conversations not filed anywhere land in Slack's default sections.
  #sectionFor(id) {
    if (this.sectionOf.has(id)) return this.sectionOf.get(id);
    const kind = this.directory.channels.get(id)?.kind;
    const type = kind === 'im' || kind === 'mpim' ? 'direct_messages' : 'channels';
    return this.sections.find((s) => s.type === type)?.id || null;
  }

  // maxAgeMs: skip if refreshed that recently (the inbox and Channels share this).
  refresh({ maxAgeMs = 0 } = {}) {
    if (this.inflight) return this.inflight;
    if (Date.now() - this.refreshedAt < maxAgeMs) return Promise.resolve();
    this.inflight = (async () => {
      const [counts] = await Promise.all([this.slack.call('client.counts', { org_wide_aware: true }), this.#loadPrefs()]);
      this.counts = counts;
      await this.directory.resolveChannels([...this.notifyAll]); // Names, for everyMessageChannels().
      const inInbox = this.everyMessageChannels();
      const unread = new Map();
      let ignored = 0;
      for (const c of [...(counts.channels || []), ...(counts.mpims || []), ...(counts.ims || [])]) {
        if (c.last_read) this.lastReadOf.set(c.id, c.last_read);
        if (!c.has_unreads || !counts.channels.includes(c)) continue; // DMs are in the inbox.
        if (inInbox.has(c.id)) continue; // So are every-message channels.
        if (this.#isIgnored(c.id)) {
          ignored++;
          continue;
        }
        unread.set(c.id, {
          id: c.id,
          lastRead: c.last_read,
          latest: c.latest,
          mentionCount: c.mention_count || 0,
          read: false,
        });
      }
      for (const [id, c] of this.kept) if (!unread.has(id)) unread.set(id, c);
      this.unread = unread;
      this.ignoredCount = ignored;
      await Promise.all([...unread.values()].filter((c) => !c.read).map((c) => this.#preview(c)));
      this.refreshedAt = Date.now();
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  // Count + latest unread message. Only refetched when something changed.
  async #preview(c) {
    const key = `${c.lastRead}:${c.latest}`;
    if (this.previews.get(c.id)?.key === key) return;
    try {
      const r = await this.slack.call('conversations.history', { channel: c.id, oldest: c.lastRead, limit: PREVIEW_LIMIT });
      const messages = r.messages || [];
      this.previews.set(c.id, {
        key,
        count: messages.length,
        hasMore: Boolean(r.has_more),
        latest: slimMessage(messages[0]),
      });
    } catch (err) {
      console.warn(`[channels] history ${c.id}: ${err.code || err.message}`);
    }
  }

  async snapshot() {
    const all = [...this.unread.values()];
    const items = all
      .map((c) => ({ ...c, key: `ch:${c.id}`, preview: this.previews.get(c.id) || null }))
      // has_unreads can be set with nothing new at the top level (e.g. only thread replies).
      .filter((c) => c.read || !c.preview || c.preview.count > 0)
      .sort((a, b) => tsNum(b.latest) - tsNum(a.latest));

    const refs = collectRefs(items.map((c) => c.preview?.latest));
    items.forEach((c) => refs.channels.add(c.id));
    await this.directory.resolve(refs);

    // Group by sidebar section (in sidebar order), newest first within each.
    const order = new Map(this.sections.map((s, i) => [s.id, i]));
    for (const c of items) c.section = this.#sectionFor(c.id);
    items.sort((a, b) => (order.get(a.section) ?? 999) - (order.get(b.section) ?? 999) || tsNum(b.latest) - tsNum(a.latest));

    const isUnread = (c) => !c.read && !(this.previews.get(c.id)?.count === 0);
    return {
      items,
      sections: this.sections,
      counts: {
        unread: all.filter(isUnread).length,
        ignored: this.ignoredCount,
      },
      ...this.directory.pick(refs),
    };
  }

  // Unread messages oldest-first, plus a few earlier ones for context.
  async messages(id) {
    const c = this.unread.get(id);
    const from = c?.readFrom || c?.lastRead;
    const [newer, older] = await Promise.all([
      this.slack.call('conversations.history', { channel: id, oldest: from, limit: 200 }),
      this.slack.call('conversations.history', { channel: id, latest: from, inclusive: true, limit: CONTEXT_MESSAGES }),
    ]);
    const unread = (newer.messages || []).reverse();
    const context = (older.messages || []).reverse();
    const messages = [...context, ...unread].map(slimMessage);

    const refs = collectRefs(messages);
    refs.channels.add(id);
    await this.directory.resolve(refs);
    return {
      messages,
      firstUnreadTs: unread[0]?.ts || null,
      hasMoreUnread: Boolean(newer.has_more),
      ...this.directory.pick(refs),
    };
  }

  async markRead(id, ts) {
    await this.slack.call('conversations.mark', { channel: id, ts });
    const c = this.unread.get(id);
    if (c) {
      c.readFrom ||= c.lastRead; // Reopening still shows what was new.
      c.lastRead = ts;
      c.read = true;
      c.mentionCount = 0;
      this.kept.set(id, c);
    }
  }

  dismiss(id) {
    this.kept.delete(id);
    if (this.unread.get(id)?.read) this.unread.delete(id);
  }
}
