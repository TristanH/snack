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

  const addChip = (facet, v) => {
    const f = facets().find((x) => x.key === facet);
    if (current().some((c) => c.facet === facet && c.value === v.value)) return;
    const chip = { facet, value: v.value, label: v.label, facetLabel: f?.label || facet };
    // A pinned chip is replaced where it sits, so it keeps its place at the front.
    if (f?.pinned) {
      const at = current().findIndex((c) => c.facet === facet);
      if (at !== -1) return set(current().map((c, i) => (i === at ? chip : c)));
    }
    // Most facets accept several values and OR them; an exclusive one (an age
    // window, say) replaces whatever it had.
    const kept = f?.exclusive ? current().filter((c) => c.facet !== facet) : current();
    set([...kept, chip]);
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
  return { renderChips, close, selectPinned, isOpen: () => Boolean(open) && !popup.hidden };
}
