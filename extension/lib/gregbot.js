// Threads gregbot is working in.
//
// gregbot almost never starts a thread: a human posts a request, tags it, and
// gregbot replies in that thread. So a "ticket" here is the human's thread, and
// we find it through gregbot's own replies (search.messages), keyed by the
// thread_ts in each match's permalink — the same trick lib/mentions.js uses.
//
// A thread's state is whatever gregbot said last. Its progress updates start
// with "Thinking...", its results don't, so the newest gregbot message in a
// thread tells you whether it's still being worked on.

import { slimMessage, collectRefs } from './threads.js';

const AUTHOR = 'gregbot';
const PAGES = 3; // 100 matches a page; a busy week is ~900 gregbot messages.
const DEFAULT_DAYS = 7;

const tsNum = (ts) => (ts ? Number(ts) : 0);
const threadTsOf = (permalink) => permalink?.match(/[?&]thread_ts=([\d.]+)/)?.[1] || null;

// Progress updates look like:
//   "Thinking..."
//   "Thinking... :hourglass_flowing_sand: 23 min — switching to the QA build"
// Results look like ":ballot_box_with_check: Thought for 4 min…", "*PR Ready:*…",
// "*Answered:*…". Leading emoji are stripped so only the first word matters
// ("Thought" must not count as "Thinking").
const LEADING_EMOJI = /^(?::[\w+'-]+:\s*)+/;
const SESSION_URL = /https:\/\/contextone\.dev\/dashboard\/computers\/\d+/;
const DASH = /\s+[—–-]\s+/;

export function statusOf(text) {
  const t = String(text || '').replace(LEADING_EMOJI, '').trim();
  if (!/^Thinking\b/i.test(t)) return { working: false, minutes: null, step: '' };
  return {
    working: true,
    minutes: Number(t.match(/(\d+)\s*min\b/)?.[1]) || null,
    // Whatever follows the dash is what it's doing right now. Only the first
    // line: the "View session" link sits on the next one and gets its own button.
    step: t.split(DASH).slice(1).join(' — ').split('\n')[0].trim(),
  };
}

export class GregbotService {
  constructor(slack, directory) {
    this.slack = slack;
    this.directory = directory;
    this.threads = new Map();
    this.fetchedAt = 0;
    this.days = DEFAULT_DAYS;
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

  // Keeps the newest gregbot message per thread; that one carries the state.
  async refresh({ days = DEFAULT_DAYS } = {}) {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      // Slack's `after:` is date-granular, so ask for a day extra and trim to
      // the exact window below.
      const cutoff = Date.now() / 1000 - days * 86400;
      const after = new Date((cutoff - 86400) * 1000).toISOString().slice(0, 10);
      const matches = await this.#search(`from:@${AUTHOR} after:${after}`, PAGES);

      const threads = new Map();
      for (const m of matches) {
        const channel = m.channel?.id;
        if (!channel || tsNum(m.ts) < cutoff) continue;
        // The handful of threads gregbot starts itself have no thread_ts.
        const threadTs = threadTsOf(m.permalink) || m.ts;
        const key = `g:${channel}:${threadTs}`;
        const prev = threads.get(key);
        const newest = !prev || tsNum(m.ts) > tsNum(prev.lastTs);
        threads.set(key, {
          key,
          channel,
          threadTs,
          lastTs: newest ? m.ts : prev.lastTs,
          firstTs: prev && tsNum(prev.firstTs) < tsNum(m.ts) ? prev.firstTs : m.ts,
          count: (prev?.count || 0) + 1,
          last: newest ? slimMessage(m) : prev.last,
        });
      }
      this.threads = threads;
      this.days = days;
      this.fetchedAt = Date.now();
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async snapshot() {
    const items = [...this.threads.values()]
      .sort((a, b) => tsNum(b.lastTs) - tsNum(a.lastTs))
      .map((t) => ({
        ...t,
        ...statusOf(t.last?.text),
        sessionUrl: String(t.last?.text || '').match(SESSION_URL)?.[0] || null,
      }));

    const refs = collectRefs(items.map((t) => t.last));
    items.forEach((t) => refs.channels.add(t.channel));
    await this.directory.resolve(refs);

    return {
      items,
      counts: { working: items.filter((t) => t.working).length },
      days: this.days,
      fetchedAt: this.fetchedAt,
      ...this.directory.pick(refs),
    };
  }
}
