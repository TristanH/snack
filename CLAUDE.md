# Notes for agents

Snack is a Chrome extension: a custom Slack client. Start with `README.md` for
architecture — it covers auth, the Slack endpoints used, and what each `lib/`
file does. This file covers the things that aren't obvious from reading the
code.

## Writing a filter for someone to paste

The filter box (top right) accepts a pasted or typed query, not just chips.
**You don't need to give anyone keystroke instructions.** Hand them a string:

```
in: bookwise-feedback, bookwise-nits status: working
```

Paste it, or type it and press Enter, and it becomes chips.

### Grammar

```
<facet>: <value>[, <value>…]  [<facet>: …]  [plain text]
```

- Facet names match either the **label** (`initiated by`) or the **key** (`by`),
  case-insensitively.
- Commas list several values for one facet.
- Repeating a facet is the same as listing (`in: a in: b` ≡ `in: a, b`).
- Values match on label, with a leading `@` or `#` ignored, or on the raw value
  id (`status: working`). Partial names work — `in: dev-help` finds
  `#dev-help`.
- Anything that isn't a recognised `facet: value` stays in the box as a plain
  text search, so you can combine the two.

### Examples

All of these are verified against the real facets.

```
in: bookwise-feedback, bookwise-nits status: working
```
Unfinished work across two channels. **"not done" / "isn't done" is
`status: working`** — the facet is binary, there's no third state.

```
in: dev-help, bookwise-feedback initiated by: tristan, artem status: working within: 7 days
```
Six chips, five facets. Multi-word facet labels work; names are matched
longest-first, so `initiated by:` wins over `in:`.

```
by: dan is: blocked has: pr within: 7d
```
The short key form, if brevity matters.

```
in: #bookwise-nits initiated by: @matiastucci status: done has: a linear ticket
```
A leading `#` or `@` is ignored, and values match on their label as well as
their id.

```
status: working is: quiet, blocked within: 3 days audiobook
```
Filters plus a free-text search — `audiobook` isn't a facet value, so it stays
in the box and searches the thread text.

### Facets

| key | label | notes |
|---|---|---|
| `by` | Initiated by | who `@`-ed gregbot in the thread; several people often did |
| `in` | In | channel |
| `status` | Status | `working` / `done` — **exclusive** |
| `is` | Is | `blocked` (awaiting prod-script approval), `quiet` (working but silent >30m) |
| `has` | Has | `pr`, `linear` |
| `age` | Within | `3d` / `7d` — **exclusive**, and changes how far back we fetch |

The Inbox has one facet, `show` (`all` / `unread` / `archived`), which is
**pinned**: always present, not removable, click it to switch.

Values are live Slack data, so they're not listed here — the menu is the source
of truth. The definitions are `gregbotFacets()` and `inboxFacets()` in
`extension/app.js`.

### Semantics

**OR within a facet, AND across facets.**

```
in: dev-help, bookwise-nits  by: artem, tristan  status: working
→ (dev-help OR nits) AND (artem OR tristan) AND working
```

Not supported: negation, and cross-facet OR — a condition can't apply to one
branch and not another, so `(working in A) OR (anything in B)` can't be
expressed. `exclusive` facets replace rather than accumulate, so
`status: working status: done` ends up as `done`.

## Adding a view

`VIEWS` in `extension/app.js` is the table. An entry says how to list, render,
open, load and empty itself; `renderList`, `openItem`, `doneItem`,
`refreshView` and `openInSlack` all read it. Adding a view should be a table
entry, not new branches — it used to be an `inbox`/`channels` test in 18
places.

Give new item keys a prefix (`g:`, `ch:`, `m:`). `rowCache` is global across
views and never cleared, so colliding keys reuse a row with the wrong shape.

## Gotchas that cost real time

- **Nothing in the `.filter-box` rule may set `overflow`.** It's the facet
  menu's positioned ancestor, so `hidden` or `auto` clips the dropdown
  invisibly. The inner `.filter-scroll` owns the overflow.
- **`.topbar` and `.panes` share a `grid-template-columns` value.** They must
  stay in step or the header stops aligning with the list/detail divider.
- **Measuring text:** `getBoundingClientRect()` returns the *transformed* box,
  so it's wrong on anything mid-animation; `offsetWidth` ignores transforms but
  rounds to whole pixels. For sub-pixel accuracy measure an offscreen probe
  (see `sizeBrand()`).
- **Restarting a CSS animation** needs a forced reflow between removing and
  re-adding the class, or the browser coalesces both and nothing happens (see
  `bindBrand()`).
- **`search.messages` is rate-limited harder than other methods.** A Gregbot
  refresh is two paged searches, which is why its background pass throttles to
  two minutes while the manual one forces.

## Testing

There's no test harness. The convention that's emerged: stub the Slack
transport and drive the real modules offline with fixture data taken from real
Slack messages, then check the UI by hand in both colour schemes. Those scripts
are throwaway and aren't committed.
