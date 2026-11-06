// Faceted filter box, Slack/Linear style: click it and a menu of facets comes
// up ("Initiated by:", "In:", …); pick one and you get its values with counts;
// picking a value drops a chip into the box. Typed text still filters the list
// as a plain substring search, alongside whatever chips are set.
//
// This stays generic: the host supplies the facets and is told when the chips
// change. A view with no facets behaves exactly like a plain search input.

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const MAX_RESULTS = 10;
const SCROLL_STEP = 140; // About one chip per arrow press.

// facets() -> [{ key, label, values: [{ value, label, count }] }]
// chips are [{ facet, value, label, facetLabel }]; onChange gets the new list.
export function attachFilters(input, { facets, chips, onChange }) {
  // The chips and the input live on one line inside a horizontal scroller, so
  // the box never grows taller however many chips you add. The popup is a
  // sibling of that scroller, not a child: an overflow context would clip it.
  const wrap = document.createElement('div');
  wrap.className = 'filter-box';
  input.replaceWith(wrap);
  const scroll = document.createElement('div');
  scroll.className = 'filter-scroll';
  const chipsEl = document.createElement('span');
  chipsEl.className = 'filter-chips';
  const popup = document.createElement('div');
  popup.className = 'filter-popup';
  popup.hidden = true;
  scroll.append(chipsEl, input);
  wrap.append(scroll, popup);

  const canScroll = () => scroll.scrollWidth > scroll.clientWidth + 1;
  const scrollToInput = () => {
    scroll.scrollLeft = scroll.scrollWidth;
  };

  // A plain vertical wheel/trackpad gesture scrolls the row sideways, so you
  // can get at overflowing chips without a scrollbar.
  scroll.addEventListener(
    'wheel',
    (e) => {
      if (!canScroll()) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      e.preventDefault();
      scroll.scrollLeft += delta;
    },
    { passive: false },
  );

  let open = null; // { facet: key|null, results, active }

  const current = () => chips() || [];

  const facetOf = (chip) => facets().find((f) => f.key === chip?.facet);
  const isPinned = (chip) => Boolean(facetOf(chip)?.pinned);

  function renderChips() {
    chipsEl.innerHTML = current()
      .map((c, i) => {
        const pinned = isPinned(c);
        const tip = `${c.facetLabel}: ${c.label}`;
        return `<span class="filter-chip${pinned ? ' pinned' : ''}" data-i="${i}" title="${escapeHtml(tip)}"><b>${escapeHtml(
          c.facetLabel,
        )}:</b><span class="chip-v">${escapeHtml(c.label)}</span>${
          pinned ? '<span class="chip-caret" aria-hidden="true"></span>' : `<button class="chip-x" data-remove="${i}" aria-label="Remove">×</button>`
        }</span>`;
      })
      .join('');
  }

  function set(next) {
    onChange(next);
    renderChips();
    scrollToInput(); // Keep the caret in view after the row changes width.
  }

  function withChip(list, facetKey, v) {
    const f = facets().find((x) => x.key === facetKey);
    if (list.some((c) => c.facet === facetKey && c.value === v.value)) return list;
    const chip = { facet: facetKey, value: v.value, label: v.label, facetLabel: f?.label || facetKey };
    // A pinned chip is replaced where it sits, so it keeps its place at the front.
    if (f?.pinned) {
      const at = list.findIndex((c) => c.facet === facetKey);
      if (at !== -1) return list.map((c, i) => (i === at ? chip : c));
    }
    // Most facets accept several values and OR them; an exclusive one (an age
    // window, say) replaces whatever it had.
    const kept = f?.exclusive ? list.filter((c) => c.facet !== facetKey) : list;
    return [...kept, chip];
  }

  const addChip = (facetKey, v) => {
    const next = withChip(current(), facetKey, v);
    if (next !== current()) set(next);
  };

  const removeAt = (i) => {
    if (isPinned(current()[i])) return; // Pinned chips are permanent.
    set(current().filter((_, n) => n !== i));
  };

  // Pick the nth value of the pinned facet — what the 1/2/3 shortcuts drive.
  function selectPinned(index) {
    const f = facets().find((x) => x.pinned);
    const v = f?.values[index];
    if (f && v) addChip(f.key, v);
  }

  // ---------------------------------------------------------------------------
  // Pasted / typed queries: "in: dev-help, bookwise-nits  initiated by: artem"
  // becomes chips. Handy for handing someone a filter they can paste in.

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasQuerySyntax = (text) => /\S\s*:/.test(text);

  function bestValue(facet, token) {
    if (!facet) return null;
    const q = token.toLowerCase().replace(/^[@#]/, '');
    if (!q) return null;
    const exact = facet.values.find((v) => String(v.value).toLowerCase() === q);
    if (exact) return exact;
    let best = null;
    let bestRank = Infinity;
    for (const v of facet.values) {
      const r = rank(v.label, q);
      if (r >= 0 && r < bestRank) {
        best = v;
        bestRank = r;
      }
    }
    return best;
  }

  function takeValues(facet, raw) {
    const picked = [];
    const leftover = [];
    for (const chunk of raw.split(',').map((c) => c.trim()).filter(Boolean)) {
      const words = chunk.split(/\s+/);
      let hit = null;
      let used = 0;
      for (let n = words.length; n >= 1; n--) {
        const v = bestValue(facet, words.slice(0, n).join(' '));
        if (v) {
          hit = v;
          used = n;
          break;
        }
      }
      if (!hit) leftover.push(chunk);
      else {
        picked.push(hit);
        if (used < words.length) leftover.push(words.slice(used).join(' '));
      }
    }
    return { picked, leftover };
  }

  function parseQuery(text) {
    const all = facets();
    if (!all.length) return { chips: [], rest: text };
    // Longest name first, so "initiated by:" wins over "in:".
    const names = all
      .flatMap((f) => [f.label, f.key])
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const re = new RegExp(`(^|\\s)(${names.map(escapeRegExp).join('|')})\\s*:\\s*`, 'gi');

    const marks = [];
    for (let m = re.exec(text); m; m = re.exec(text)) {
      marks.push({ at: m.index + m[1].length, end: re.lastIndex, name: m[2] });
    }
    if (!marks.length) return { chips: [], rest: text };

    const chips = [];
    const rest = [text.slice(0, marks[0].at).trim()];
    marks.forEach((mark, i) => {
      const raw = text.slice(mark.end, i + 1 < marks.length ? marks[i + 1].at : text.length);
      const facet = all.find((f) => [f.label, f.key].some((n) => n && n.toLowerCase() === mark.name.toLowerCase()));
      const { picked, leftover } = takeValues(facet, raw);
      for (const v of picked) chips.push({ facet: facet.key, value: v });
      // Nothing matched, so show it back rather than silently eating it.
      if (leftover.length) rest.push(picked.length ? leftover.join(' ') : `${mark.name}: ${leftover.join(', ')}`);
    });
    return { chips, rest: rest.filter(Boolean).join(' ').trim() };
  }

  // Returns true if it recognised anything.
  function applyQuery(text) {
    const { chips: parsed, rest } = parseQuery(text);
    if (!parsed.length) return false;
    let next = current();
    for (const { facet, value } of parsed) next = withChip(next, facet, value);
    input.value = rest;
    close();
    set(next);
    return true;
  }

  function close() {
    open = null;
    popup.hidden = true;
  }

  // What you typed, as a value query. A leading @ or # is dropped so Slack
  // muscle memory works: "@artem" finds the person, "#dev-help" the channel.
  const query = () => input.value.trim().toLowerCase().replace(/^[@#]/, '');

  // Name first, then word-start, then anywhere; ties go to the bigger bucket.
  function rank(label, q) {
    const v = label.toLowerCase().replace(/^[@#]/, '');
    if (v.startsWith(q)) return 0;
    if (v.split(/[\s._-]+/).some((w) => w.startsWith(q))) return 1;
    return v.includes(q) ? 2 : -1;
  }

  const byRank = (a, b) => a.rank - b.rank || (b.v.count || 0) - (a.v.count || 0);

  // With no facet chosen the menu lists the facets; after that, its values.
  function rows() {
    const q = query();
    if (!open?.facet) {
      // Pinned facets are already on screen as a chip, so the generic menu
      // doesn't offer them — you open those by clicking the chip.
      const all = facets().filter((f) => f.values.length && !f.pinned);
      // Typing matches values across every facet, so you can go straight to a
      // name without picking "Initiated by" first.
      if (q) {
        const hits = [];
        for (const f of all) {
          for (const v of f.values) {
            const r = rank(v.label, q);
            if (r >= 0) hits.push({ rank: r, kind: 'value', facet: f.key, facetLabel: f.label, v });
          }
        }
        if (hits.length) return hits.sort(byRank).slice(0, MAX_RESULTS);
      }
      return all.map((f) => ({ kind: 'facet', facet: f.key, facetLabel: f.label, count: f.values.length }));
    }
    const f = facets().find((x) => x.key === open.facet);
    if (!f) return [];
    return f.values
      .map((v) => ({ rank: q ? rank(v.label, q) : 0, kind: 'value', facet: f.key, facetLabel: f.label, v }))
      .filter((r) => r.rank >= 0)
      .sort(byRank)
      .slice(0, MAX_RESULTS);
  }

  function render() {
    if (!open) return;
    open.results = rows();
    if (!open.results.length) return close();
    open.active = Math.min(open.active, open.results.length - 1);
    popup.innerHTML = open.results
      .map((r, i) => {
        const active = i === open.active ? ' active' : '';
        if (r.kind === 'facet') {
          return `<button class="filter-row${active}" data-i="${i}"><b>${escapeHtml(r.facetLabel)}</b><span class="muted">${r.count}</span></button>`;
        }
        const prefix = open.facet ? '' : `<b>${escapeHtml(r.facetLabel)}</b> `;
        return `<button class="filter-row${active}" data-i="${i}">${prefix}${escapeHtml(r.v.label)}${
          // != null, not truthy: a count of 0 is worth showing ("Archived 0"),
          // but a facet with no counts at all (Within) shouldn't show one.
          r.v.count != null ? `<span class="muted">${r.v.count}</span>` : ''
        }</button>`;
      })
      .join('');
    popup.hidden = false;
    popup.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  function show() {
    open = { facet: open?.facet || null, results: [], active: 0 };
    render();
  }

  function pick(i) {
    const r = open?.results[i];
    if (!r) return;
    if (r.kind === 'facet') {
      open.facet = r.facet; // Drill into its values.
      open.active = 0;
      input.value = '';
      return render();
    }
    addChip(r.facet, r.v);
    input.value = '';
    open.facet = null;
    open.active = 0;
    render();
  }

  input.addEventListener('paste', (e) => {
    const pasted = e.clipboardData?.getData('text') || '';
    if (!hasQuerySyntax(pasted)) return; // Ordinary text: let the browser paste it.
    const head = input.value.slice(0, input.selectionStart ?? input.value.length);
    const tail = input.value.slice(input.selectionEnd ?? input.value.length);
    e.preventDefault();
    const merged = `${head}${pasted}${tail}`;
    if (!applyQuery(merged)) {
      input.value = merged; // Nothing recognised — behave like a normal paste.
      show();
    }
  });

  input.addEventListener('focus', show);
  input.addEventListener('click', show);
  input.addEventListener('input', () => {
    if (open) {
      open.active = 0;
      render();
    }
  });

  // While the menu is up it owns these keys: stopImmediatePropagation so the
  // host's own search-box handler (jump into the list / clear) doesn't also run.
  const claim = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value) {
      // Removes the last chip you *can* remove, stepping over pinned ones.
      const back = [...current()].reverse().findIndex((c) => !isPinned(c));
      if (back !== -1) {
        claim(e);
        return removeAt(current().length - 1 - back);
      }
    }
    // ← / → scroll the chip row once the caret has nowhere left to go, so they
    // still move through typed text normally. Works with the menu open too.
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && canScroll()) {
      const left = e.key === 'ArrowLeft';
      const caret = input.selectionStart === input.selectionEnd ? input.selectionStart : null;
      const atEdge = caret !== null && (left ? caret === 0 : caret === input.value.length);
      if (atEdge) {
        claim(e);
        scroll.scrollBy({ left: left ? -SCROLL_STEP : SCROLL_STEP, behavior: 'smooth' });
        return;
      }
    }
    if (e.key === 'Enter' && hasQuerySyntax(input.value)) {
      claim(e);
      if (applyQuery(input.value)) return;
    }
    if (!open || popup.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      claim(e);
      open.active = Math.max(0, Math.min(open.results.length - 1, open.active + (e.key === 'ArrowDown' ? 1 : -1)));
      return render();
    }
    if (e.key === 'Enter') {
      claim(e);
      return pick(open.active);
    }
    if (e.key === 'Escape') {
      claim(e);
      if (open.facet) {
        open.facet = null; // Back out of a facet before closing it.
        return render();
      }
      close();
    }
  });

  popup.addEventListener('mousedown', (e) => e.preventDefault()); // Keep focus in the input.
  popup.addEventListener('click', (e) => {
    const row = e.target.closest('.filter-row');
    if (row) pick(Number(row.dataset.i));
  });

  chipsEl.addEventListener('click', (e) => {
    const x = e.target.closest('[data-remove]');
    if (x) return removeAt(Number(x.dataset.remove));
    // Clicking a pinned chip opens its values, so you can switch between them.
    const chip = e.target.closest('.filter-chip');
    const c = chip && current()[Number(chip.dataset.i)];
    if (!c || !isPinned(c)) return;
    input.value = '';
    open = { facet: c.facet, results: [], active: 0 };
    render();
    input.focus();
  });

  document.addEventListener('mousedown', (e) => {
    if (!wrap.contains(e.target)) close();
  });

  renderChips();
  return { renderChips, close, selectPinned, applyQuery, isOpen: () => Boolean(open) && !popup.hidden };
}
