// The core inbox: one list of everything that's for you.
//   thread  - a thread you're in (started, replied, followed)
//   dm      - a direct or group message
//   channel - a channel you get notified about for every message
//   mention - an @-mention of you that isn't already covered by the above
// A mention inside one of your threads, DMs or every-message channels folds
// into that item instead of showing twice.

const tsNum = (ts) => (ts ? Number(ts) : 0);

export function mergeInbox({ threads, dms, mentions }) {
  const items = new Map();
  for (const t of threads) items.set(t.key, { ...t, type: 'thread', unread: t.isUnread });
  for (const d of dms) items.set(d.key, { ...d });

  for (const m of mentions) {
    if (m.fromBot) continue; // Integrations pinging you aren't people waiting on you.
    const into =
      items.get(`${m.channel}:${m.threadTs || m.ts}`) ||
      items.get(`dm:${m.channel}`) ||
      (!m.threadTs && items.get(`channel:${m.channel}`)); // The channel row doesn't show thread replies.
    if (into) {
      into.mentioned = true;
      continue;
    }
    items.set(m.key, { ...m, type: 'mention', lastTs: m.ts, unread: !m.seen });
  }

  return [...items.values()].sort((a, b) => tsNum(b.lastTs) - tsNum(a.lastTs));
}
