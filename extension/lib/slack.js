// Minimal Slack client for the same /api/* endpoints the Slack web app uses.
// Auth is the web client's xoxc- token plus the browser's own `d` cookie.
// Requests go out through `transport` (background.js), which is where Chrome
// attaches that cookie.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SlackError extends Error {
  constructor(method, data) {
    super(`${method} failed: ${data?.error || 'unknown_error'}`);
    this.method = method;
    this.code = data?.error || 'unknown_error';
    this.data = data;
  }
}

export class SlackClient {
  constructor({ token, transport, baseUrl = 'https://slack.com/', concurrency = 4 }) {
    this.token = token;
    this.transport = transport;
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
    // Rolling log of recent calls, for `await snack.stats()` when something is
    // being rate limited and it isn't obvious what's spending the budget.
    this.recent = [];
    this.throttled = 0;
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ method, params, resolve, reject });
      this.#drain();
    });
  }

  #drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this.#request(job.method, job.params)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          this.#drain();
        });
    }
  }

  async #request(method, params, attempt = 0) {
    const body = { token: this.token };
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      body[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }

    this.recent.push({ method, at: Date.now() });
    if (this.recent.length > 400) this.recent.splice(0, this.recent.length - 400);

    const res = await this.transport(`${this.baseUrl}api/${method}`, body);

    if (res.status === 429) this.throttled++;
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.retryAfter) || 2 ** attempt;
      console.warn(`[slack] rate limited on ${method}, retrying in ${wait}s`);
      await sleep(wait * 1000);
      return this.#request(method, params, attempt + 1);
    }

    const data = res.data || { ok: false, error: `http_${res.status}` };
    if (!data.ok) throw new SlackError(method, data);
    return data;
  }
}
