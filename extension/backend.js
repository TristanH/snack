// In-page "backend": session handling and the operations the UI calls. Slack
// requests, storage and tabs go through platform.js to background.js.

import { SlackClient } from './lib/slack.js';
import { Directory } from './lib/directory.js';
import { ThreadService } from './lib/threads.js';
import { ChannelService } from './lib/channels.js';
import { MentionService } from './lib/mentions.js';
import { DmService } from './lib/dms.js';
import { mergeInbox } from './lib/inbox.js';
import * as platform from './platform.js';

const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive']);

let session = null; // { slack, directory, threads, channels, auth }

export class AuthError extends Error {}

async function open(team) {
  const slack = new SlackClient({ token: team.token, baseUrl: team.url, transport: platform.slackFetch });
  const auth = await slack.call('auth.test');
  if (auth.url) slack.baseUrl = auth.url;
  const directory = new Directory(slack);
  const threads = new ThreadService(slack, directory);
  const channels = new ChannelService(slack, directory);
  const mentions = new MentionService(slack, directory, auth.user_id);
  const dms = new DmService(slack, directory, auth.user_id);
  await Promise.all([directory.load(), threads.load()]);
  return { slack, directory, threads, channels, mentions, dms, auth };
}

// The saved token goes stale when Slack rotates it; in that case load Slack
// in a background tab so content.js can pick up a fresh one.
async function captureTeam() {
  try {
    return await platform.captureTeam();
  } catch (err) {
    if (err.message === 'no_slack_session') {
      throw new AuthError('Couldn’t find a Slack session. Sign in to Slack in this browser, then retry.');
    }
    throw err;
  }
}

export async function connect() {
  try {
    await platform.ping();
  } catch {
    throw new AuthError('Can’t reach the Snack extension. Make sure it’s installed and enabled, then reload this page.');
  }
  let team = await platform.storage.get('slackTeam');
  if (team) {
    try {
      session = await open(team);
      return session.auth;
    } catch (err) {
      if (!AUTH_ERRORS.has(err.code)) throw err;
    }
  }
  team = await captureTeam();
  try {
    session = await open(team);
  } catch (err) {
    if (AUTH_ERRORS.has(err.code)) throw new AuthError(`Slack rejected the session (${err.code}).`);
    throw err;
  }
  return session.auth;
}

// Re-establish the session once if Slack says the token is no longer valid.
async function withSession(fn) {
  if (!session) await connect();
  try {
    return await fn(session);
  } catch (err) {
    if (!AUTH_ERRORS.has(err.code)) throw err;
    session = null;
    await platform.storage.remove('slackTeam');
    await connect();
    return fn(session);
  }
}

export const getThread = (channel, ts) => withSession((s) => s.threads.replies(channel, ts));

export const markRead = (channel, threadTs, ts) =>
  withSession(async (s) => {
    await s.slack.call('subscriptions.thread.mark', { channel, thread_ts: threadTs, ts, read: 1 });
    s.threads.markRead(`${channel}:${threadTs}`);
  });

// text is Slack markup (already escaped, mentions as <@U…>); see autocomplete.js.
// threadTs null posts to the channel itself.
export const reply = (channel, threadTs, text) =>
  withSession((s) => s.slack.call('chat.postMessage', { channel, thread_ts: threadTs, text }));

// Upload files and post them (with optional text) in one message, using
// Slack's external upload flow. files: [{ name, type, size, base64 }].
export const uploadFiles = (channel, threadTs, files, text) =>
  withSession(async (s) => {
    const uploaded = [];
    for (const f of files) {
      const { upload_url: url, file_id: id } = await s.slack.call('files.getUploadURLExternal', { filename: f.name, length: f.size });
      await platform.uploadBytes(url, f.base64, f.type);
      uploaded.push({ id, title: f.name });
    }
    await s.slack.call('files.completeUploadExternal', {
      files: uploaded,
      channel_id: channel,
      thread_ts: threadTs || undefined,
      initial_comment: text || undefined,
    });
  });

// Bytes of a Slack-hosted image as an object URL, cached for the session.
const fileUrls = new Map(); // url -> Promise<object URL>
export function slackFileUrl(url) {
  if (!fileUrls.has(url)) {
    const p = platform.fetchFile(url).then(({ type, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      return URL.createObjectURL(new Blob([bytes], { type }));
    });
    p.catch(() => fileUrls.delete(url)); // Let a later view retry.
    fileUrls.set(url, p);
  }
  return fileUrls.get(url);
}

// Everyone/everything mentionable, for composer autocomplete.
export const getMentionables = () =>
  withSession(async (s) => {
    await s.directory.warm();
    const usergroups = await s.directory.usergroups().catch((err) => {
      console.warn('User groups unavailable:', err.message);
      return [];
    });
    return {
      users: [...s.directory.users.values()].filter((u) => !u.deleted),
      channels: [...s.directory.channels.values()].filter((c) => (c.kind === 'channel' || c.kind === 'private') && !c.isArchived),
      usergroups,
    };
  });

// Unread channels/DMs, minus muted and ignored ones.
export const getChannels = () =>
  withSession(async (s) => {
    await s.channels.refresh({ maxAgeMs: 15_000 });
    return s.channels.snapshot();
  });

export const getChannelMessages = (id) => withSession((s) => s.channels.messages(id));
export const markChannelRead = (id, ts) => withSession((s) => s.channels.markRead(id, ts));
export const dismissChannel = (id) => session?.channels.dismiss(id);

// The core inbox: threads you're in + DMs + every-message channels + @-mentions, as one list.
async function inboxSnapshot(s) {
  const readPosition = (m) =>
    m.threadTs ? s.threads.threads.get(`${m.channel}:${m.threadTs}`)?.lastRead : s.channels.lastReadOf.get(m.channel);
  const [t, d, m] = await Promise.all([s.threads.snapshot(), s.dms.snapshot(), s.mentions.snapshot(readPosition)]);
  return {
    items: mergeInbox({ threads: t.threads, dms: d.items, mentions: m.items }),
    users: { ...t.users, ...d.users, ...m.users },
    channels: { ...t.channels, ...d.channels, ...m.channels },
    bots: { ...t.bots, ...d.bots, ...m.bots },
    meta: t.meta,
  };
}

// Whatever is cached locally (threads), before any network refresh.
export const cachedInbox = () => withSession((s) => inboxSnapshot(s));

// full: allow a long thread catch-up (after time away). onUpdate(snapshot)
// fires as thread pages arrive so the list fills in progressively.
export const getInbox = ({ full = false, onUpdate } = {}) =>
  withSession(async (s) => {
    const others = Promise.all([
      s.mentions.refresh(),
      s.channels.refresh({ maxAgeMs: 15_000 }).then(() => s.dms.refresh(s.channels.counts, s.channels.everyMessageChannels())),
    ]);
    await s.threads.refresh({
      full,
      onPage: async (progress) => onUpdate?.({ ...(await inboxSnapshot(s)), progress }),
    });
    await others;
    return inboxSnapshot(s);
  });

export const getConversation = (channel, lastRead) => withSession((s) => s.dms.conversation(channel, lastRead));

// Mentions. Seen state comes from Slack's read positions (client.counts for
// channels, the thread inbox for threads).
export const getMentions = () =>
  withSession(async (s) => {
    await Promise.all([s.mentions.refresh(), s.channels.refresh()]);
    return s.mentions.snapshot((m) =>
      m.threadTs ? s.threads.threads.get(`${m.channel}:${m.threadTs}`)?.lastRead : s.channels.lastReadOf.get(m.channel),
    );
  });
export const markMentionSeen = (channel, ts, threadTs) => withSession((s) => s.mentions.markSeen(channel, ts, threadTs));
export const getMentionContext = (channel, ts, threadTs) => withSession((s) => s.mentions.context(channel, ts, threadTs));
// One-time move: mentions marked Done in the old Mentions tab become archived
// inbox items (a mention's archive timestamp is the mention itself).
export async function migrateMentionsDone() {
  const done = (await platform.storage.get('mentionsDone')) || {};
  const keys = Object.keys(done);
  if (!keys.length) return;
  await updateArchived(Object.fromEntries(keys.map((key) => [key, key.split(':').pop()])));
  await platform.storage.remove('mentionsDone');
}

// Reactions. Already reacted / already removed count as success.
export const react = (channel, ts, name, add) =>
  withSession(async (s) => {
    try {
      await s.slack.call(add ? 'reactions.add' : 'reactions.remove', { channel, timestamp: ts, name });
    } catch (err) {
      if (!['already_reacted', 'no_reaction'].includes(err.code)) throw err;
    }
  });

export const getCustomEmoji = () => withSession((s) => s.directory.customEmoji());
export const loadRecentEmoji = async () => (await platform.storage.get('recentEmoji')) || null;
export const saveRecentEmoji = (names) => platform.storage.set({ recentEmoji: names });

// Snack-only archive: { [threadKey]: lastTs at the time it was archived }.
export const loadArchived = async () => (await platform.storage.get('archived')) || {};
// Read-modify-write per entry, so two open Snack tabs don't clobber each other.
export async function updateArchived(changes) {
  const archived = await loadArchived();
  for (const [key, ts] of Object.entries(changes)) {
    if (ts) archived[key] = ts;
    else delete archived[key];
  }
  await platform.storage.set({ archived });
  return archived;
}

// Dev helpers, from DevTools on the Snack page:
//   await snack.call('subscriptions.thread.getView', { limit: 2 })
//   await snack.reloadExtension()   // pick up background/content script changes
globalThis.snack = {
  call: (method, params) => withSession((s) => s.slack.call(method, params)),
  reloadExtension: () => platform.rpc('dev.reload'),
};
