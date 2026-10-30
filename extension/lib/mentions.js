// Messages that @-mention you, from search.messages. "Seen" mirrors Slack's
// read position, so viewing a mention in Slack or Snack clears it.

import { slimMessage, collectRefs } from './threads.js';

const PAGES = 2; // 200 most recent mentions
const CONTEXT_BEFORE = 4;
const CONTEXT_AFTER = 6;

const tsNum = (ts) => (ts ? Number(ts) : 0);
const threadTsOf = (permalink) => permalink?.match(/[?&]thread_ts=([\d.]+)/)?.[1] || null;

export class MentionService {
  constructor(slack, directory, userId) {
    this.slack = slack;
    this.directory = directory;
    this.userId = userId;
    this.mentions = new Map();
    this.inflight = null;
  }

  async #search(query, pages) {
    const matches = [];
    for (let page = 1; page <= pages; page++) {
      const r = await this.slack.call('search.messages', { query, sort: 'timestamp', sort_dir: 'desc', count: 100, page });
      matches.push(...(r.messages?.matches || []));
      if (page >= (r.messages?.paging?.pages || 0)) break;
    }
    return matches;
  }

  refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const me = this.userId;
      const [mentions, mine] = await Promise.all([this.#search(`<@${me}>`, PAGES), this.#search(`from:<@${me}>`, PAGES)]);

      // Your latest message per place: "<channel>:top" for the channel itself,
      // "<channel>:<thread_ts>" for each thread.
      const lastMine = new Map();
      for (const m of mine) {
        const where = `${m.channel?.id}:${threadTsOf(m.permalink) || 'top'}`;
        if (tsNum(m.ts) > tsNum(lastMine.get(where))) lastMine.set(where, m.ts);
      }
      const after = (where, ts) => tsNum(lastMine.get(where)) > tsNum(ts);

      const next = new Map();
      for (const m of mentions) {
        const channel = m.channel?.id;
        if (!channel || m.user === me) continue;
        const threadTs = threadTsOf(m.permalink);
        // In a thread: answered by a later reply in that thread. In the channel:
        // by a later message in the channel, or a reply in its own thread.
        const replied = threadTs
          ? after(`${channel}:${threadTs}`, m.ts)
          : after(`${channel}:top`, m.ts) || after(`${channel}:${m.ts}`, m.ts);
        next.set(`m:${channel}:${m.ts}`, {
          key: `m:${channel}:${m.ts}`,
          channel,
          ts: m.ts,
          threadTs,
          replied,
          message: slimMessage(m),
        });
      }
      this.mentions = next;
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  // readPosition(m): Slack's last_read for the mention's thread or channel
  // (null when unknown, e.g. old threads, which count as seen).
  async snapshot(readPosition) {
    const items = [...this.mentions.values()].sort((a, b) => tsNum(b.ts) - tsNum(a.ts));
    for (const i of items) {
      const lastRead = readPosition(i);
      i.seen = i.seen || !lastRead || tsNum(lastRead) >= tsNum(i.ts);
    }
    const refs = collectRefs(items.map((i) => i.message));
    items.forEach((i) => refs.channels.add(i.channel));
    await this.directory.resolve(refs);
    // Integrations (GitHub, alerts…) mention you, but there's no one to reply to.
    for (const i of items) i.fromBot = !i.message.user || Boolean(this.directory.users.get(i.message.user)?.isBot);
    return { items, ...this.directory.pick(refs) };
  }

  // Mark read in Slack up to the mention itself (not past it), so later
  // messages stay unread.
  async markSeen(channel, ts, threadTs) {
    if (threadTs) await this.slack.call('subscriptions.thread.mark', { channel, thread_ts: threadTs, ts, read: 1 });
    else await this.slack.call('conversations.mark', { channel, ts });
    const m = this.mentions.get(`m:${channel}:${ts}`);
    if (m) m.seen = true;
  }

  // The mention in context: its whole thread, or the surrounding channel messages.
  async context(channel, ts, threadTs) {
    let messages;
    if (threadTs) {
      messages = [];
      let cursor;
      do {
        const r = await this.slack.call('conversations.replies', { channel, ts: threadTs, limit: 200, cursor });
        messages.push(...(r.messages || []));
        cursor = r.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } else {
      // history returns newest first, so for "just after" bound the window and keep the earliest few.
      const [before, after] = await Promise.all([
        this.slack.call('conversations.history', { channel, latest: ts, inclusive: true, limit: CONTEXT_BEFORE + 1 }),
        this.slack.call('conversations.history', { channel, oldest: ts, latest: String(tsNum(ts) + 3 * 86400), limit: 200 }),
      ]);
      messages = [...(before.messages || [])].reverse().concat((after.messages || []).reverse().slice(0, CONTEXT_AFTER));
    }
    const slim = messages.map(slimMessage);
    const refs = collectRefs(slim);
    refs.channels.add(channel);
    await this.directory.resolve(refs);
    return { messages: slim, ...this.directory.pick(refs) };
  }
}
