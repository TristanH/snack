// Threads gregbot is working in.

import { slimMessage, collectRefs, messageTexts } from './threads.js';
import { storage } from '../platform.js';

const AUTHOR = 'gregbot';
// A cap, not a target: #search stops at paging.pages.
const PAGES = 40;
const DEFAULT_DAYS = 30;
const STORAGE_KEY = 'gregbotThreads';
const MAX_SAVED = 1500;
// Per thread, how much of gregbot's own text we keep for searching.
const SEARCH_TEXT_MAX = 1800;

const tsNum = (ts) => (ts ? Number(ts) : 0);
// Midnight local, `days` ago — so "1 month" covers all of that day rather than
// cutting at whatever time of day it happens to be. Must match app.js's copy.
function dayCutoff(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}
const threadTsOf = (permalink) => permalink?.match(/[?&]thread_ts=([\d.]+)/)?.[1] || null;

// Parsing a progress message: ":robot: Thinking… 4 min — <step>".
const LEADING_EMOJI = /^(?::[\w+'-]+:\s*)+/;
const SESSION_URL = /https:\/\/contextone\.dev\/dashboard\/computers\/\d+/;
const DASH = /\s+[—–-]\s+/;

const DID = {
  pr: /\bPR Ready\b/i,
  linear: /\bLinear: filed\b/i,
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

// Everything gregbot has said in a thread, flattened for searching.
function appendSearchText(prev = '', m) {
  if (prev.length >= SEARCH_TEXT_MAX) return prev;
  const add = messageTexts(m).filter(Boolean).join(' ').replace(/\s+/g, ' ');
  return `${prev} ${add}`.trim().slice(0, SEARCH_TEXT_MAX);
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
    this.inflightDays = undefined; // Window the in-flight fetch is for.
    this.generation = 0; // Bumped per refresh; an older one won't commit.
    this.coveredDays = 0; // Widest window the cache holds. 0 = nothing, null = all.
    this.syncedTo = null; // Newest message a complete sync saw.
    this.saveTimer = null;
  }

  // Last known state, so the view has something before the first request and a
  // refresh only has to fetch what's changed since.
  async load() {
    const saved = await storage.get(STORAGE_KEY);
    for (const t of saved?.threads || []) this.threads.set(t.key, t);
    this.callers = new Set(saved?.callers || []);
    this.coveredDays = saved?.coveredDays ?? 0;
    this.syncedTo = saved?.syncedTo || null;
    this.fetchedAt = saved?.fetchedAt || 0;
    this.days = saved?.coveredDays ?? DEFAULT_DAYS;
  }

  #scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const threads = [...this.threads.values()]
        .sort((a, b) => tsNum(b.lastTs) - tsNum(a.lastTs))
        .slice(0, MAX_SAVED);
      const { coveredDays, syncedTo, fetchedAt } = this;
      storage.set({ [STORAGE_KEY]: { threads, callers: [...this.callers], coveredDays, syncedTo, fetchedAt } });
    }, 500);
  }

  // alive(): false once a newer refresh has superseded this one.
  async #search(query, pages, { onPage, until = 0, alive = () => true } = {}) {
    const matches = [];
    for (let page = 1; page <= pages; page++) {
      if (!alive()) break;
      const r = await this.slack.call('search.messages', { query, sort: 'timestamp', sort_dir: 'desc', count: 100, page });
      const batch = r.messages?.matches || [];
      matches.push(...batch);
      const total = r.messages?.paging?.pages || 0;
      await onPage?.(page, Math.min(total, pages), batch);
      if (page >= total) break;
      if (until && batch.length && tsNum(batch[batch.length - 1]?.ts) < until) break;
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

  // Is this window asking for more history than the cache already covers?
  // 0 means nothing cached; null means all-time, the widest there is.
  #widens(days) {
    if (this.coveredDays === 0) return true;
    if (this.coveredDays === null) return false;
    return days === null || days > this.coveredDays;
  }

  // maxAgeMs: skip if refreshed that recently.
  refresh({ days = DEFAULT_DAYS, maxAgeMs = 0, onProgress } = {}) {
    // Only join an in-flight fetch if it's for the same window; a different one
    // supersedes it rather than queueing behind it.
    if (this.inflight && this.inflightDays === days) return this.inflight;
    if (!this.#widens(days) && Date.now() - this.fetchedAt < maxAgeMs) return Promise.resolve();
    const gen = ++this.generation;
    const alive = () => gen === this.generation;
    this.inflightDays = days;
    this.inflight = (async () => {
      // Slack's `after:` is date-granular, so ask for a day extra and trim to
      // the exact window below. days === null means every thread there is.
      const cutoff = days ? dayCutoff(days) : 0;
      const since = days ? ` after:${new Date((cutoff - 86400) * 1000).toISOString().slice(0, 10)}` : '';
      const botId = await this.#resolveBotId();
      // Catching up: stop paging once we reach what we already have.
      const full = this.#widens(days) || !this.syncedTo;
      const until = full ? cutoff : Math.max(cutoff, tsNum(this.syncedTo));

      // Merge, don't replace: a catch-up only carries what's new.
      const threads = new Map(this.threads);
      const inWindow = (m) => m.channel?.id && tsNum(m.ts) >= cutoff;
      const keyOf = (m) => `g:${m.channel.id}:${threadTsOf(m.permalink) || m.ts}`;
      let newest = null;

      // Pass 1: gregbot's replies decide which threads exist and their state.
      const absorb = (batch) => {
        for (const m of batch) {
          if (!inWindow(m)) continue;
          if (!newest || tsNum(m.ts) > tsNum(newest)) newest = m.ts;
          const key = keyOf(m);
          const prev = threads.get(key);
          const isNewest = !prev || tsNum(m.ts) > tsNum(prev.lastTs);
          const did = { ...(prev?.did || {}) };
          for (const [name, re] of Object.entries(DID)) {
            if (!did[name]) did[name] = messageTexts(m).some((t) => re.test(String(t || '')));
          }
          threads.set(key, {
            key,
            channel: m.channel.id,
            threadTs: threadTsOf(m.permalink) || m.ts,
            lastTs: isNewest ? m.ts : prev.lastTs,
            firstTs: prev && tsNum(prev.firstTs) < tsNum(m.ts) ? prev.firstTs : m.ts,
            // Can drift by a message or two at a catch-up boundary; it's a
            // cosmetic "N updates", not something anything keys off.
            count: (prev?.count || 0) + 1,
            last: isNewest ? slimMessage(m) : prev.last,
            searchText: appendSearchText(prev?.searchText, m),
            did,
            callers: prev?.callers || [],
            ask: prev?.ask || '',
            askTs: prev?.askTs || null,
          });
        }
      };

      const [, tags] = await Promise.all([
        this.#search(`from:@${AUTHOR}${since}`, PAGES, {
          alive,
          until,
          onPage: async (page, pages, batch) => {
            absorb(batch);
            // Publish what we have so far so the view can render it mid-sweep.
            this.threads = threads;
            await onProgress?.({ page, pages });
          },
        }),
        botId ? this.#search(`<@${botId}>${since}`, PAGES, { alive, until }) : Promise.resolve([]),
      ]);
      if (!alive()) return; // A newer window took over while we paged.

      // Pass 2: who called gregbot. Only enriches threads we already have — a
      // call gregbot hasn't answered yet has no state to show.
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
      // Only a sync that actually reached the horizon may widen what we claim
      // to cover, or there'd be a hole in the history.
      if (full) this.coveredDays = days;
      if (newest && tsNum(newest) > tsNum(this.syncedTo)) this.syncedTo = newest;
      this.fetchedAt = Date.now();
      this.#scheduleSave();
    })().finally(() => {
      // A superseded fetch must not clear the newer one's handle.
      if (gen === this.generation) {
        this.inflight = null;
        this.inflightDays = undefined;
      }
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
