// How the Snack UI reaches the browser: everything privileged (Slack requests
// with your session cookie, storage, tabs) lives in background.js.
//
// - As the extension page, we message background.js directly.
// - Served from the localhost dev server (see README), bridge.js relays the
//   same messages, so the identical UI can be driven like a normal web page.

const isExtensionPage = location.protocol === 'chrome-extension:';
const pending = new Map();
let nextId = 0;

if (!isExtensionPage) {
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.snack !== 'res') return;
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    try {
      p.resolve(e.data);
    } catch (err) {
      p.reject(err);
    }
  });
}

// background.js always answers { result } or { error }. No answer at all means
// the running extension is older than this page and doesn't know `op`.
function unwrap(op, res) {
  if (!res || !('result' in res || 'error' in res)) {
    throw new Error(`The Snack extension is out of date ("${op}" is missing). Reload it at chrome://extensions, then refresh this page.`);
  }
  if (res.error) throw new Error(res.error);
  return res.result;
}

const timedOut = (op) => new Error(`Snack extension didn't answer "${op}". Is it installed and up to date?`);

// Every call times out, so one hung request can't stall the app.
export function rpc(op, args = {}, { timeoutMs = 60_000 } = {}) {
  if (isExtensionPage) {
    let timer;
    return Promise.race([
      chrome.runtime.sendMessage({ op, args }).then((res) => unwrap(op, res), (err) => unwrap(op, { error: err.message })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timedOut(op)), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: (res) => resolve(unwrap(op, res)), reject });
    window.postMessage({ snack: 'req', id, op, args }, location.origin);
    setTimeout(() => {
      if (pending.delete(id)) reject(timedOut(op));
    }, timeoutMs);
  });
}

export const storage = {
  get: (key) => rpc('storage.get', { key }),
  set: (items) => rpc('storage.set', { items }),
  remove: (key) => rpc('storage.remove', { key }),
};

export const slackFetch = (url, body) => rpc('slack.fetch', { url, body });
export const captureTeam = () => rpc('captureTeam', {}, { timeoutMs: 45_000 });
export const uploadBytes = (url, base64, type) => rpc('slack.upload', { url, base64, type }, { timeoutMs: 5 * 60_000 });
export const fetchFile = (url) => rpc('slack.file', { url }, { timeoutMs: 2 * 60_000 });
export const ping = () => rpc('ping', {}, { timeoutMs: 2_000 });
