# gmail-organizer-helpers

Tampermonkey userscript for Gmail. Adds two buttons to Gmail's toolbar
that turn multi-step cleanups into a single click:

- **Label & Archive** — gives a sender's unlabeled emails the same
  label(s) as their older emails, then marks them read and archives them.
- **Delete page** — moves every email on the current search results page
  to Trash, except ones with a protected label.

## Install

1. Install [Tampermonkey](https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo).
2. On Chrome 120+, go to `chrome://extensions` → Tampermonkey → Details →
   enable **"Allow User Scripts"** (without it, userscripts silently don't run).
3. Click this link to open the raw script — Tampermonkey intercepts any
   URL ending in `.user.js` and shows its own install page:
   [gmail-organizer-helpers.user.js](https://raw.githubusercontent.com/jackyto-work/tampermonkey-scripts/main/gmail-organizer-helpers/gmail-organizer-helpers.user.js)
   → **Install**.

   <details>
   <summary>Manual install instead (e.g. editing before install)</summary>

   Tampermonkey Dashboard → **+ Create a new script** → select all,
   delete the boilerplate, paste in the full contents of
   `gmail-organizer-helpers.user.js` → save.
   </details>
4. Reload Gmail. The buttons appear to the right of Gmail's own toolbar
   buttons (after the ⋮ menu).

## What it adds

| Button | Shown when | Does |
| --- | --- | --- |
| **Label & Archive** (folder with arrow) | Emails from **one** sender are ticked, or an email is open | See below |
| **Delete page** (trash with lines) | On search results for a sender or keyword — never the inbox, folders, or a blocked search like `in:inbox` | Moves every email on the page to Trash, except ones with a protected label |

Buttons follow Gmail's look (20px icons, round hover highlight, Gmail's
own tooltip) and switch to light icons on dark themes.

### Label & Archive

1. Works out the sender: the `from:` search you're on, or the ticked/opened
   email. If you're not on that sender's search, it opens it (staying on
   the current results page if you're already there, e.g. page 2).
2. Splits the emails on the page:
   - **To label** — emails with no label of yours.
   - **Already labeled, still in the inbox or unread** — emails that already
     have the chosen label but were never finished off (optional setting).
   - **Skipped** — emails with an *ignored label* (e.g. `~ TO DO ~`) are
     never selected or changed.
3. Picks the label(s) to apply: automatic when all the sender's labeled
   emails agree, otherwise a picker shows each label with how many emails
   carry it.
4. Shows a confirmation (sender, label pills, the email lists) with a
   countdown on **Apply** — it applies automatically unless you click
   inside the dialog, which pauses it. **Enter** applies, **Esc** cancels.
5. Applies the label(s), checks the label chips actually appear, then marks
   read and archives. The changed emails stay ticked so you can see them.

### Delete page

Confirmation shows the search, how many emails go to Trash, which
protected labels are kept, and the lists — with the same optional
countdown. Emails go to Trash (recoverable for 30 days).

## Settings

Tampermonkey icon → **⚙ Settings…** opens a settings panel inside Gmail:

| Section | Setting |
| --- | --- |
| General | Button style (Icon only / Icon + text / Text only), Debug logging |
| Label & Archive | Auto-apply after (Immediately / Never / After 0–10 seconds), Mark as read, Archive, Also clear emails that already have the chosen label but are still in the inbox or unread, Ignored labels |
| Delete page | Auto-delete after (Immediately / Never / After 0–10 seconds), Protected labels, Blocked searches |

Lists take one entry per line. A search is blocked when it has nothing
but blocked terms (exclusions like `-in:spam` are ignored), so
`in:inbox` is blocked but `in:inbox from:x` isn't.

The Tampermonkey menu also has **▶ Label & Archive** and **▶ Delete page**
to run either workflow directly.

## Notes

- Works one results page at a time (Gmail shows 50 by default); run it
  again on the next page for older emails.
- Everything is done by clicking Gmail's own UI, so Gmail UI changes can
  break it. All knowledge of Gmail's markup lives in the `SEL` / `TEXT`
  constants and the `Gmail` module — that's where to fix things.
- Simulated clicks carry a pointer position (Gmail's Labels menu ignores
  clicks without one) and use the page's real `window` (Tampermonkey's
  sandboxed `window` is rejected by `MouseEvent`).
- Built for English-language Gmail: button names like "Archive" and
  "Labels" are matched by text.

## Extending

Each button is a **workflow**: a button definition plus a pipeline of
named steps shared through a step library. Add a step with
`pipeline.insertAfter('applyLabels', { name, run: async (ctx) => {...} })`
(also `insertBefore`, `replace`, `remove`), add a button with a new
`WORKFLOWS` entry, and add a setting with a `SETTINGS_SCHEMA` entry — it
appears in the Settings panel automatically. See the comment block at the
top of the script.
