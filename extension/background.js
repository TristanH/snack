// Privileged side of Snack. The UI (extension page or localhost dev page via
// bridge.js) asks for everything through these message handlers.

const SLACK_API_URL = /^https:\/\/[a-z0-9-]+\.slack\.com\/api\/[\w.]+$/;
const SLACK_UPLOAD_URL = /^https:\/\/files\.slack\.com\/upload\//;
const SLACK_FILE_URL = /^https:\/\/files\.slack\.com\/(files-pri|files-tmb)\//;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
const SLACK_CLIENT_URL = 'https://app.slack.com/client';

// Load Slack in a background tab so content.js can pick up a fresh session
// token, then close it again.
async function captureTeam(timeoutMs = 30_000) {
  const tab = await chrome.tabs.create({ url: SLACK_CLIENT_URL, active: false });
  try {
    return await new Promise((resolve, reject) => {
      const onChange = (changes, area) => {
        if (area !== 'local' || !changes.slackTeam?.newValue) return;
        cleanup();
        resolve(changes.slackTeam.newValue);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('no_slack_session'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        chrome.storage.onChanged.removeListener(onChange);
      };
      chrome.storage.onChanged.addListener(onChange);
    });
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

const handlers = {
  ping: () => 'pong',

  'storage.get': async ({ key }) => (await chrome.storage.local.get(key))[key] ?? null,
  'storage.set': ({ items }) => chrome.storage.local.set(items),
  'storage.remove': ({ key }) => chrome.storage.local.remove(key),

  // Chrome attaches the `d` session cookie because of our *.slack.com host
  // permission; only Slack API URLs are allowed through.
  'slack.fetch': async ({ url, body }) => {
    if (!SLACK_API_URL.test(url)) throw new Error(`Refusing non-Slack-API URL: ${url}`);
    const res = await fetch(url, { method: 'POST', body: new URLSearchParams(body), credentials: 'include' });
    return {
      status: res.status,
      retryAfter: res.headers.get('retry-after'),
      data: await res.json().catch(() => null),
    };
  },

  // Step 2 of Slack's external upload: send the bytes to the URL that
  // files.getUploadURLExternal handed out. Messages are JSON, hence base64.
  'slack.upload': async ({ url, base64, type }) => {
    if (!SLACK_UPLOAD_URL.test(url)) throw new Error(`Refusing non-Slack upload URL: ${url}`);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const res = await fetch(url, { method: 'POST', body: new Blob([bytes], { type: type || 'application/octet-stream' }) });
    if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status})`);
    return true;
  },

  // Images/thumbnails people shared in Slack. They need your session, so the
  // UI can't load them with a plain <img>; it gets the bytes from here.
  'slack.file': async ({ url }) => {
    if (!SLACK_FILE_URL.test(url)) throw new Error(`Refusing non-Slack file URL: ${url}`);
    const { slackTeam } = await chrome.storage.local.get('slackTeam');
    const headers = slackTeam?.token ? { Authorization: `Bearer ${slackTeam.token}` } : {};
    const res = await fetch(url, { credentials: 'include', headers });
    const type = res.headers.get('content-type') || '';
    // Without a valid session Slack answers with its sign-in page.
    if (!res.ok || type.startsWith('text/html')) throw new Error(`Couldn't load file (HTTP ${res.status})`);
    return { type, base64: toBase64(await res.arrayBuffer()) };
  },

  captureTeam: () => captureTeam(),

  // Lets the dev page pick up changes to background.js / content scripts
  // without a trip to chrome://extensions.
  'dev.reload': () => {
    setTimeout(() => chrome.runtime.reload(), 100);
    return true;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const handler = handlers[msg?.op];
  if (!handler) {
    sendResponse({ error: `Unknown operation "${msg?.op}". Reload Snack at chrome://extensions.` });
    return false;
  }
  Promise.resolve()
    .then(() => handler(msg.args || {}))
    .then(
      (result) => sendResponse({ result: result ?? null }),
      (err) => sendResponse({ error: err.message }),
    );
  return true; // Respond asynchronously.
});

// Toolbar button: focus the Snack tab if it's open, otherwise open one.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('app.html');
  const [existing] = await chrome.tabs.query({ url }).catch(() => []);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
