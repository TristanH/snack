# Snack

A custom Slack UI, as a Chrome extension: one inbox for threads you're in, DMs, channels you get every message from and @-mentions, plus a secondary view of channel unreads.

Snack is an unofficial personal project, not affiliated with Slack. It uses Slack's undocumented web-client API, which can change without notice.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension/` folder.
3. Click the Snack toolbar button (pin it from the puzzle-piece menu).

You just need to be signed in to Slack in the same browser. There's nothing to configure.

After editing files, refresh the Snack tab. Changes to `manifest.json`, `background.js` or `content.js` also need the reload button on `chrome://extensions`.

## How it works

Snack calls the same `/api/*` methods the Slack web client uses, with your own browser session:

- `content.js` runs on app.slack.com and copies the web client's `xoxc-` token into `chrome.storage.local`. If there's no token (or it went stale), Snack briefly opens Slack in a background tab to pick up a fresh one.
- The `d` session cookie never leaves Chrome. It's attached to Snack's requests automatically because the extension has `*.slack.com` host permissions.

The thread list comes from `subscriptions.thread.getView`, the internal endpoint behind Slack's "Threads" view. It includes threads you started, replied to, were mentioned in, or followed. Its quirks:

- It returns at most 10 threads per page, newest activity first.
- It pages backwards via `current_ts`. Each page holds threads whose latest reply is older than that value.

Snack syncs incrementally. The first run reads the last two weeks. After that it reads only until it reaches threads it has already seen, plus any still-unread threads from the last two weeks, so a refresh is usually a single request.

- `app.html`, `app.js`, `styles.css` — the UI
- `backend.js` — session handling and the operations the UI calls
- `lib/slack.js` — API client with concurrency limit + 429 retry
- `lib/inbox.js` — merges threads, DMs, every-message channels and mentions into the inbox
- `lib/threads.js` — thread fetching/pagination and message normalisation
- `lib/dms.js` — DMs and every-message channels with recent activity
- `lib/mentions.js` — @-mentions (search), replied/seen state
- `lib/channels.js` — unread channels, sidebar sections, muted/ignored filtering
- `lib/directory.js` — user/channel/bot name cache

To poke at raw endpoints, open DevTools on the Snack tab: `await snack.call('subscriptions.thread.getView', { limit: 2 })`.

## Features

- **Inbox**: one list of everything for you, newest activity first, each item labelled by type:
  - **Thread**: a thread you're in.
  - **DM**: a direct or group message.
  - **Channel**: a channel you set to notify you about every message ("All new messages" in Slack; channels that only inherit it from your default don't count). Channels whose name starts with "errors" stay in the Channels view instead.
  - **Mention**: an @-mention not already covered by one of the above.

  A mention inside one of your threads, DMs or every-message channels shows as an "@ you" badge on that item instead. Unread items have a blue dot. Archive (`e`) hides an item until something new arrives in it; archiving a mention is permanent. The archive lives only in Snack.
- **Channels**: passive unreads from channels you're in, grouped by your Slack sidebar sections. Muted channels and anything in a sidebar section named "ignore" are never fetched.
- Reply with `@`/`#` autocomplete, react with emoji, and drag, paste or attach files.

## Keyboard

Press `?` in Snack for the full list. Hovering any control shows its shortcut.

`j`/`k` move (with a conversation open they go straight to the next one) · `↵` open · `Esc` back · `e` archive/done · `z` undo · `r` reply · `+` react · `↵` send (`⇧↵` new line) · `` ` `` or `i`/`c` switch Inbox/Channels · `1`–`3` inbox filters · `/` filter list · `Space` scroll · `⇧R` refresh · `⇧O` open in Slack

## Dev page

To test Snack like a normal web page, which is how Claude drives it, serve the extension folder (caching disabled):

```sh
python3 dev-server.py
```

Then open http://localhost:4477/app.html. `bridge.js` (injected only on that origin) relays requests to the extension, so the page uses your real Slack session. After changing `background.js`, `content.js` or the manifest, run `await snack.reloadExtension()` in its console and reload the page.
