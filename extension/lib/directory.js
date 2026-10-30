// Cache of users and conversations so names resolve instantly. Bulk-loaded
// with users.list + conversations.list (a couple of calls for the whole
// workspace) instead of one rate-limited *.info call per ID; *.info is only
// the fallback for IDs those lists miss (e.g. people from shared channels).

import { storage } from '../platform.js';

const STORAGE_KEY = 'directory';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BULK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function slimUser(u) {
  const p = u.profile || {};
  return {
    id: u.id,
    name: p.display_name || p.real_name || u.real_name || u.name || u.id,
    realName: p.real_name || u.real_name || '',
    avatar: p.image_72 || p.image_48 || '',
    isBot: Boolean(u.is_bot),
    deleted: Boolean(u.deleted),
    fetchedAt: Date.now(),
  };
}

function slimChannel(c) {
  let kind = 'channel';
  if (c.is_im) kind = 'im';
  else if (c.is_mpim) kind = 'mpim';
  else if (c.is_private || c.is_group) kind = 'private';
  return {
    id: c.id,
    name: c.name || c.name_normalized || c.id,
    kind,
    user: c.user || null,
    isMember: Boolean(c.is_member),
    isArchived: Boolean(c.is_archived),
    fetchedAt: Date.now(),
  };
}

export class Directory {
  constructor(slack) {
    this.slack = slack;
    this.users = new Map();
    this.channels = new Map();
    this.bots = new Map();
    this.saveTimer = null;
    this.bulkLoadedAt = 0;
    this.warming = null;
  }

  async load() {
    const data = await storage.get(STORAGE_KEY);
    for (const u of data?.users || []) this.users.set(u.id, u);
    for (const c of data?.channels || []) this.channels.set(c.id, c);
    for (const b of data?.bots || []) this.bots.set(b.id, b);
    this.bulkLoadedAt = data?.bulkLoadedAt || 0;
  }

  // Refresh the whole directory at most once a day.
  warm() {
    if (Date.now() - this.bulkLoadedAt < BULK_MAX_AGE_MS) return Promise.resolve();
    this.warming ||= Promise.all([
      this.#listAll('users.list', { limit: 1000 }, 'members', (u) => this.users.set(u.id, slimUser(u))),
      this.#listAll(
        'conversations.list',
        { limit: 1000, types: 'public_channel,private_channel,mpim,im', exclude_archived: false },
        'channels',
        (c) => this.channels.set(c.id, slimChannel(c)),
      ),
    ])
      .then(() => {
        this.bulkLoadedAt = Date.now();
        this.#scheduleSave();
      })
      .catch((err) => console.warn(`[directory] bulk load failed: ${err.code || err.message}`))
      .finally(() => {
        this.warming = null;
      });
    return this.warming;
  }

  async #listAll(method, params, key, add) {
    let cursor;
    do {
      const r = await this.slack.call(method, { ...params, cursor });
      (r[key] || []).forEach(add);
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  #scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const data = {
        users: [...this.users.values()],
        channels: [...this.channels.values()],
        bots: [...this.bots.values()],
        bulkLoadedAt: this.bulkLoadedAt,
      };
      storage.set({ [STORAGE_KEY]: data });
    }, 500);
  }

  #stale(entry) {
    return !entry || Date.now() - (entry.fetchedAt || 0) > MAX_AGE_MS;
  }

  async resolveUsers(ids) {
    const missing = [...new Set(ids)].filter((id) => id && this.#stale(this.users.get(id)));
    await Promise.all(
      missing.map(async (id) => {
        try {
          const r = await this.slack.call('users.info', { user: id });
          this.users.set(id, slimUser(r.user));
        } catch (err) {
          console.warn(`[directory] users.info ${id}: ${err.code || err.message}`);
          if (!this.users.has(id)) this.users.set(id, { id, name: id, fetchedAt: 0 });
        }
      }),
    );
    if (missing.length) this.#scheduleSave();
  }

  async resolveChannels(ids) {
    const missing = [...new Set(ids)].filter((id) => id && this.#stale(this.channels.get(id)));
    await Promise.all(
      missing.map(async (id) => {
        try {
          const r = await this.slack.call('conversations.info', { channel: id });
          this.channels.set(id, slimChannel(r.channel));
        } catch (err) {
          console.warn(`[directory] conversations.info ${id}: ${err.code || err.message}`);
          if (!this.channels.has(id)) this.channels.set(id, { id, name: id, kind: 'channel', fetchedAt: 0 });
        }
      }),
    );
    // DMs are named after the other person.
    const dmUsers = missing.map((id) => this.channels.get(id)?.user).filter(Boolean);
    await this.resolveUsers(dmUsers);
    if (missing.length) this.#scheduleSave();
  }

  // Integrations that post without a username or bot_profile (webhooks).
  async resolveBots(ids) {
    const missing = [...new Set(ids)].filter((id) => id && this.#stale(this.bots.get(id)));
    await Promise.all(
      missing.map(async (id) => {
        try {
          const { bot } = await this.slack.call('bots.info', { bot: id });
          this.bots.set(id, { id, name: bot.name || id, avatar: bot.icons?.image_72 || bot.icons?.image_48 || '', fetchedAt: Date.now() });
        } catch (err) {
          console.warn(`[directory] bots.info ${id}: ${err.code || err.message}`);
          if (!this.bots.has(id)) this.bots.set(id, { id, name: 'Bot', fetchedAt: 0 });
        }
      }),
    );
    if (missing.length) this.#scheduleSave();
  }

  // Workspace custom emoji: { name: imageUrl | "std:<shortcode>" }, refreshed daily.
  async customEmoji() {
    const cached = await storage.get('customEmoji');
    if (cached && Date.now() - cached.fetchedAt < BULK_MAX_AGE_MS) return cached.emoji;
    const { emoji = {} } = await this.slack.call('emoji.list');
    const resolved = {};
    for (const [name, value] of Object.entries(emoji)) {
      let target = value;
      for (let hops = 0; target?.startsWith('alias:') && hops < 5; hops++) {
        const aliased = target.slice(6);
        target = emoji[aliased] ?? `std:${aliased}`;
      }
      if (target) resolved[name] = target;
    }
    storage.set({ customEmoji: { emoji: resolved, fetchedAt: Date.now() } });
    return resolved;
  }

  // User groups (@design, @devs…) for mention autocomplete, refreshed daily.
  async usergroups() {
    const cached = await storage.get('usergroups');
    if (cached && Date.now() - cached.fetchedAt < BULK_MAX_AGE_MS) return cached.groups;
    const { usergroups = [] } = await this.slack.call('usergroups.list');
    const groups = usergroups
      .filter((g) => !g.date_delete)
      .map((g) => ({ id: g.id, handle: g.handle, name: g.name, userCount: g.user_count || 0 }));
    storage.set({ usergroups: { groups, fetchedAt: Date.now() } });
    return groups;
  }

  // refs: { users, channels, bots } sets, as returned by collectRefs().
  async resolve(refs) {
    await this.warm();
    await this.resolveChannels([...refs.channels]);
    await Promise.all([this.resolveUsers([...refs.users]), this.resolveBots([...refs.bots])]);
  }

  pick(refs) {
    const users = {};
    const channels = {};
    const bots = {};
    for (const id of refs.users) if (this.users.has(id)) users[id] = this.users.get(id);
    for (const id of refs.bots) if (this.bots.has(id)) bots[id] = this.bots.get(id);
    for (const id of refs.channels) {
      const c = this.channels.get(id);
      if (!c) continue;
      channels[id] = c;
      if (c.user && this.users.has(c.user)) users[c.user] = this.users.get(c.user);
    }
    return { users, channels, bots };
  }
}
