// Threads gregbot is working in.
//
// gregbot almost never starts a thread: a human posts a request (often an
// intake form does), someone @-mentions gregbot in it, and gregbot replies in
// that thread. So a "ticket" here is the human's thread, and we find it two
// ways, both via search.messages, keyed by the thread_ts in each permalink —
// the trick lib/mentions.js uses:
//
//   from:@gregbot   → gregbot's own replies. The newest one carries the state.
//   <@gregbot>      → the humans who called it. Several people often call it in
//                     one thread, so every caller counts, not just the first.
//
// Progress updates start with "Thinking..."; results don't. So the newest
// gregbot message says whether a thread is still being worked on.

import { slimMessage, collectRefs, messageTexts } from './threads.js';

const AUTHOR = 'gregbot';
// A cap, not a target: #search stops at paging.pages. A week is ~850 gregbot
// messages and ~320 calls, so the default 3-day window is well inside this.
const PAGES = 12;
const DEFAULT_DAYS = 3;

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

// Things that happened somewhere in the thread (facet `has:`).
const DID = {
  pr: /\bPR Ready\b/i,
  linear: /\bLinear: filed\b/i,
  error: /\bfailed\b|\bcouldn[’']t\b/i,
};
// A live state, so it's only true of the newest message (facet `is:blocked`).
const AWAITING_APPROVAL = /waiting for approval/i;

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

// The instruction, without the "@gregbot " that addressed it.
const askOf = (text) => String(text || '').replace(/<@[UW][A-Z0-9]+>/g, '').trim();

export class GregbotService {
  constructor(slack, directory) {
    this.slack = slack;
    this.directory = directory;
    this.threads = new Map();
    this.callers = new Set(); // every user id seen calling gregbot, for the facet list
    this.botId = null;
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

  // gregbot's own user id, so we can search for mentions of it. Resolved from
  // the directory rather than hardcoded; without it we simply have no callers.
  async #resolveBotId() {
    if (this.botId) return this.botId;
    await this.directory.warm();
    const users = [...this.directory.users.values()].filter((u) => !u.deleted);
    const named = (re) => users.find((u) => u.isBot && (re.test(u.name || '') || re.test(u.realName || '')));
    const bot = named(new RegExp(`^${AUTHOR}$`, 'i')) || named(new RegExp(AUTHOR, 'i'));
    this.botId = bot?.id || null;
    if (!this.botId) console.warn(`[gregbot] couldn't find a bot user named "${AUTHOR}"; "called by" will be empty`);
    return this.botId;
  }

  // maxAgeMs: skip if refreshed that recently. search.messages is rate-limited
  // more tightly than most methods and a refresh is several pages, so the
  // periodic refresh passes a couple of minutes here.
  refresh({ days = DEFAULT_DAYS, maxAgeMs = 0 } = {}) {
    if (this.inflight) return this.inflight;
    if (days === this.days && Date.now() - this.fetchedAt < maxAgeMs) return Promise.resolve();
    this.inflight = (async () => {
      // Slack's `after:` is date-granular, so ask for a day extra and trim to
      // the exact window below.
      const cutoff = Date.now() / 1000 - days * 86400;
      const after = new Date((cutoff - 86400) * 1000).toISOString().slice(0, 10);
      const botId = await this.#resolveBotId();

      const [messages, tags] = await Promise.all([
        this.#search(`from:@${AUTHOR} after:${after}`, PAGES),
        botId ? this.#search(`<@${botId}> after:${after}`, PAGES) : Promise.resolve([]),
      ]);

      const threads = new Map();
      const inWindow = (m) => m.channel?.id && tsNum(m.ts) >= cutoff;
      const keyOf = (m) => `g:${m.channel.id}:${threadTsOf(m.permalink) || m.ts}`;

      // Pass 1: gregbot's replies decide which threads exist and their state.
      for (const m of messages) {
        if (!inWindow(m)) continue;
        const key = keyOf(m);
        const prev = threads.get(key);
        const newest = !prev || tsNum(m.ts) > tsNum(prev.lastTs);
        const did = { ...(prev?.did || {}) };
        for (const [name, re] of Object.entries(DID)) {
          if (!did[name]) did[name] = messageTexts(m).some((t) => re.test(String(t || '')));
        }
        threads.set(key, {
          key,
          channel: m.channel.id,
          threadTs: threadTsOf(m.permalink) || m.ts,
          lastTs: newest ? m.ts : prev.lastTs,
          firstTs: prev && tsNum(prev.firstTs) < tsNum(m.ts) ? prev.firstTs : m.ts,
          count: (prev?.count || 0) + 1,
          last: newest ? slimMessage(m) : prev.last,
          did,
          callers: prev?.callers || [],
          ask: prev?.ask || '',
          askTs: prev?.askTs || null,
        });
      }

      // Pass 2: who called gregbot. Only enriches threads we already have — a
      // call gregbot hasn't answered yet has no state to show.
      this.callers = new Set();
      for (const m of tags) {
        if (!inWindow(m) || !m.user || m.user === botId) continue;
        this.callers.add(m.user);
        const t = threads.get(keyOf(m));
        if (!t) continue;
        if (!t.callers.includes(m.user)) t.callers.push(m.user);
        // The earliest call is the one that kicked the thread off.
        if (!t.askTs || tsNum(m.ts) < tsNum(t.askTs)) {
          t.askTs = m.ts;
          t.ask = askOf(m.text);
        }
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
      .map((t) => {
        const status = statusOf(t.last?.text);
        const text = String(t.last?.text || '');
        return {
          ...t,
          ...status,
          blocked: AWAITING_APPROVAL.test(text),
          sessionUrl: text.match(SESSION_URL)?.[0] || null,
        };
      });

    const refs = collectRefs(items.map((t) => t.last));
    items.forEach((t) => {
      refs.channels.add(t.channel);
      t.callers.forEach((u) => refs.users.add(u));
    });
    this.callers.forEach((u) => refs.users.add(u));
    await this.directory.resolve(refs);

    return {
      items,
      counts: { working: items.filter((t) => t.working).length, blocked: items.filter((t) => t.blocked).length },
      callers: [...this.callers],
      days: this.days,
      fetchedAt: this.fetchedAt,
      ...this.directory.pick(refs),
    };
  }
}
