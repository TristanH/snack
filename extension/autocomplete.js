// Slack-style @mention / #channel autocomplete for a composer <textarea>:
// a suggestion popup with keyboard navigation, highlighted mention "pills",
// whole-mention Backspace, and conversion to Slack markup (<@U…>, <#C…>,
// <!here>, <!subteam^…>) when sending.

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slackEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Text before the caret that is an in-progress "@que" or "#que" (one space allowed, for full names).
const TRIGGER_RE = /(^|[\s(])([@#])([^\s@#]*(?: [^\s@#]*)?)$/;
const MAX_RESULTS = 8;

// search(trigger, query) -> [{ insert, token, html }]
//   insert: text placed in the box (without the trigger), token: Slack markup,
//   html: the suggestion row's inner HTML.
export function attachAutocomplete(textarea, { search }) {
  const wrap = document.createElement('div');
  wrap.className = 'composer-input';
  textarea.replaceWith(wrap);
  const highlight = document.createElement('div');
  highlight.className = 'composer-highlight';
  highlight.setAttribute('aria-hidden', 'true');
  const popup = document.createElement('div');
  popup.className = 'autocomplete';
  popup.hidden = true;
  wrap.append(highlight, textarea, popup);

  let mentions = []; // [{ text: '@name', token: '<@U…>' }] inserted so far
  let open = null; // { start, results, active }

  function renderHighlight() {
    let html = escapeHtml(textarea.value);
    const texts = [...new Set(mentions.map((m) => m.text))].sort((a, b) => b.length - a.length);
    if (texts.length) {
      const re = new RegExp(`(${texts.map((t) => escapeRegExp(escapeHtml(t))).join('|')})`, 'g');
      html = html.replace(re, '<mark>$1</mark>');
    }
    highlight.innerHTML = `${html}\n`;
    highlight.scrollTop = textarea.scrollTop;
  }

  function close() {
    open = null;
    popup.hidden = true;
  }

  function update() {
    // Forget mentions whose text was edited away.
    mentions = mentions.filter((m) => textarea.value.includes(m.text));
    renderHighlight();
    const before = textarea.value.slice(0, textarea.selectionStart);
    const match = textarea.selectionStart === textarea.selectionEnd && before.match(TRIGGER_RE);
    if (!match) return close();
    const [, , trigger, query] = match;
    const results = search(trigger, query).slice(0, MAX_RESULTS);
    if (!results.length) return close();
    open = { start: before.length - query.length - 1, trigger, results, active: 0 };
    renderPopup();
  }

  function renderPopup() {
    popup.innerHTML = open.results
      .map((r, i) => `<div class="ac-item${i === open.active ? ' active' : ''}" data-i="${i}">${r.html}</div>`)
      .join('');
    popup.hidden = false;
  }

  function pick(i) {
    const r = open.results[i];
    const text = `${open.trigger}${r.insert}`;
    const value = textarea.value;
    const end = textarea.selectionStart;
    textarea.value = `${value.slice(0, open.start)}${text} ${value.slice(end)}`;
    const caret = open.start + text.length + 1;
    textarea.setSelectionRange(caret, caret);
    mentions.push({ text, token: r.token });
    close();
    renderHighlight();
  }

  // Returns true when the key was handled (so the composer shouldn't send).
  function handleKey(e) {
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = open.results.length;
        open.active = (open.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        renderPopup();
        return true;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(open.active);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return true;
      }
    }
    // Backspace right after a mention removes the whole mention, as in Slack.
    if (e.key === 'Backspace' && textarea.selectionStart === textarea.selectionEnd) {
      const caret = textarea.selectionStart;
      const before = textarea.value.slice(0, caret);
      const m = mentions.find((x) => before.endsWith(x.text));
      if (m) {
        e.preventDefault();
        textarea.value = textarea.value.slice(0, caret - m.text.length) + textarea.value.slice(caret);
        textarea.setSelectionRange(caret - m.text.length, caret - m.text.length);
        update();
        return true;
      }
    }
    return false;
  }

  textarea.addEventListener('input', update);
  textarea.addEventListener('click', update);
  textarea.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) update();
  });
  textarea.addEventListener('scroll', () => (highlight.scrollTop = textarea.scrollTop));
  textarea.addEventListener('blur', () => setTimeout(close, 150));
  popup.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.ac-item');
    if (!item) return;
    e.preventDefault(); // Keep focus in the textarea.
    pick(Number(item.dataset.i));
  });

  return {
    handleKey,
    // Slack message text: escaped, with inserted mentions as real mention markup.
    toSlackText() {
      let text = slackEscape(textarea.value.trim());
      const byText = [...new Map(mentions.map((m) => [slackEscape(m.text), m.token])).entries()].sort((a, b) => b[0].length - a[0].length);
      for (const [shown, token] of byText) {
        text = text.replace(new RegExp(`(^|[\\s(])${escapeRegExp(shown)}(?=$|[\\s.,!?:;)'])`, 'g'), `$1${token}`);
      }
      return text;
    },
    reset() {
      mentions = [];
      close();
      renderHighlight();
    },
  };
}
