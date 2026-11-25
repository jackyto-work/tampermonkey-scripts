// ==UserScript==
// @name         Gmail Organizer Helpers
// @namespace    jackyto.gmail-organizer-helpers
// @version      0.9.3
// @description  One-click Gmail helpers: label a sender's new emails like their old ones (then mark read + archive), and delete everything on the current page.
// @author       Jacky, To
// @match        https://mail.google.com/mail/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

/*
 * HOW IT WORKS
 * ------------
 * Each toolbar button runs a WORKFLOW (section 9): a button definition plus a
 * Pipeline of named steps. Steps live in one shared library (section 8) so
 * workflows can reuse them. A step is:
 *
 *   { name: 'myStep', label: 'Shown on the button while running',
 *     when: ctx => boolean,            // optional: skip the step when false
 *     run:  async ctx => { ... } }     // do work; ctx.stop(msg) ends the run early
 *
 * Steps share one context object `ctx` (see createContext). Action steps push
 * a short phrase onto ctx.done ("archived") which the `report` step shows.
 *
 * EXTENDING
 * ---------
 * - Add a step to a workflow:
 *     WORKFLOWS.labelArchive.pipeline.insertAfter('applyLabels', { name: 'star', run: async ctx => {...} });
 *   Also available: insertBefore(name, step), replace(name, step), remove(name).
 * - Add a button: add an entry to WORKFLOWS (text, description, icon path, optional
 *   visibleWhen() condition, pipeline); it appears in the toolbar and the Tampermonkey menu.
 * - Add a setting: add an entry to SETTINGS_SCHEMA (it appears in the Settings panel)
 *   and read it with Settings.get(key).
 *
 * All knowledge of Gmail's page structure lives in SEL/TEXT (section 2) and the
 * Gmail module (section 5). If Gmail changes its UI, fix it there.
 */

(function () {
  'use strict';

  /* ========================================================================
   * 1. CONFIG
   * ====================================================================== */

  // User settings, edited in the in-page Settings panel (Tampermonkey menu → ⚙ Settings…).
  // type: 'toggle' (default), 'choice' (options: [[value, text], ...]), 'list' (one per line)
  // or 'delay' (Immediately / Never / After [min..max] seconds).
  // Settings are shown grouped by `group`, in the order listed here.
  const SETTINGS_SCHEMA = {
    buttonStyle: {
      group: 'General',
      label: 'Button style',
      type: 'choice',
      options: [['icon', 'Icon only'], ['both', 'Icon + text'], ['text', 'Text only']],
      default: 'icon',
    },
    debug: { group: 'General', label: 'Debug logging (browser console)', default: false },

    labelArchiveAutoApply: {
      group: 'Label & Archive',
      label: 'Auto-apply after',
      // Stored as "0" (immediately, no popup), "never" (wait for a click) or "1".."10" seconds.
      type: 'delay',
      min: 0,
      max: 10,
      default: '3',
      help: 'Countdown on the confirmation. Clicking inside the dialog pauses it.',
    },
    markAsRead: { group: 'Label & Archive', label: 'Mark as read', default: true },
    archive: { group: 'Label & Archive', label: 'Archive', default: true },
    includeLabeledInInbox: {
      group: 'Label & Archive',
      label: 'Also clear emails that already have the chosen label but are still in the inbox or unread',
      default: true,
    },
    ignoredLabels: {
      group: 'Label & Archive',
      label: 'Ignored labels',
      type: 'list',
      default: ['~ TO DO ~'],
      help: 'One label per line. Never copied, and emails that have them are skipped (never selected or changed).',
    },

    deleteAutoApply: {
      group: 'Delete page',
      label: 'Auto-delete after',
      // Same values as labelArchiveAutoApply. Defaults to waiting for a click.
      type: 'delay',
      min: 0,
      max: 10,
      default: 'never',
      help: 'Countdown on the confirmation. Clicking inside the dialog pauses it.',
    },
    deleteProtectedLabels: {
      group: 'Delete page',
      label: 'Protected labels',
      type: 'list',
      default: ['~ TO DO ~'],
      help: 'One label per line (exact name, e.g. "Job/interview"). Emails with any of these are never deleted.',
    },
    deleteBlockedSearches: {
      group: 'Delete page',
      label: 'Blocked searches',
      type: 'list',
      default: ['in:inbox', 'in:anywhere'],
      help: 'One search term per line. Hidden when a search has nothing but these terms '
        + '(exclusions like -in:spam are ignored). "in:inbox from:x" is still allowed.',
    },
  };

  const CONSTANTS = {
    timeoutMs: 10000,
    searchTimeoutMs: 20000,
    pageSize: 50,
    // Gmail's built-in labels; these don't count as "your" labels (case-insensitive).
    systemLabels: [
      'inbox', 'important', 'starred', 'sent', 'drafts', 'spam', 'trash', 'chats',
      'scheduled', 'snoozed', 'all mail', 'primary', 'social', 'updates', 'forums', 'promotions',
    ],
  };

  /* ========================================================================
   * 2. GMAIL SELECTORS & TEXT — the only place that knows Gmail's markup
   * ====================================================================== */

  const SEL = {
    row: 'tr.zA',
    rowCheckbox: 'div[role="checkbox"]',
    rowParticipant: 'span[email]',
    rowSubject: 'span.bog',
    rowLabelChip: 'div.at',
    rowThreadId: '[data-thread-id], [data-legacy-thread-id]',
    unreadRowClass: 'zE',
    toolbar: 'div[gh="mtb"]',
    toolbarButtonRow: '.G-tF', // row holding Gmail's button groups; our group is appended to it
    toolbarIconImage: 'div[role="button"] div', // elements whose background image is Gmail's icon
    darkIconPattern: /_white_/, // Gmail uses e.g. refresh_white_20dp.png on dark themes
    openedMessageSender: 'span.gD[email]',
    menu: 'div[role="menu"]',
    labelMenuItem: '[role="menuitemcheckbox"]',
    menuItem: '[role="menuitem"]',
  };

  const TEXT = {
    labelsButton: 'Labels',
    markReadButton: 'Mark as read',
    archiveButton: 'Archive',
    deleteButton: 'Delete',
    inboxLabel: 'Inbox',
    applyMenuItem: 'Apply',
  };

  /* ========================================================================
   * 3. SETTINGS & LOGGING
   * ====================================================================== */

  const Settings = (() => {
    const listeners = [];
    const get = (key) => GM_getValue(key, SETTINGS_SCHEMA[key].default);
    const set = (key, value) => {
      GM_setValue(key, value);
      listeners.forEach((fn) => fn(key, value));
    };
    // fn(key, value) is called whenever a setting changes.
    const onChange = (fn) => listeners.push(fn);

    // Opens the Settings panel and saves whatever changed.
    async function openPanel() {
      const values = await UI.settings(SETTINGS_SCHEMA, get);
      if (!values) return;
      for (const [key, value] of Object.entries(values)) {
        if (JSON.stringify(value) !== JSON.stringify(get(key))) set(key, value);
      }
      UI.toast('Settings saved.');
    }

    // Tampermonkey menu: one entry per workflow, then Settings.
    function registerMenu(runCommands) {
      for (const { caption, run } of runCommands) GM_registerMenuCommand(caption, run);
      GM_registerMenuCommand('⚙ Settings…', openPanel);
    }

    return { get, set, onChange, registerMenu, openPanel };
  })();

  const log = (...args) => { if (Settings.get('debug')) console.log('[GOH]', ...args); };

  /* ========================================================================
   * 4. DOM UTILITIES
   * ====================================================================== */

  const Dom = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),

    // Gmail keeps hidden copies of other views in the DOM; only visible ones count.
    isVisible: (el) => !!el && el.isConnected && el.getClientRects().length > 0,

    visible: (selector, root = document) =>
      [...root.querySelectorAll(selector)].filter(Dom.isVisible),

    async waitFor(fn, { timeout = CONSTANTS.timeoutMs, interval = 100, what = 'condition' } = {}) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const value = fn();
        if (value) return value;
        await Dom.sleep(interval);
      }
      throw new Error(`Timed out waiting for ${what}`);
    },

    // Gmail buttons listen for mousedown/mouseup, so a bare .click() is not enough.
    // - The Labels menu ignores events without a pointer position, so pass the element's center.
    // - `view` must be a real Window; Tampermonkey's sandboxed `window` is a proxy and is rejected.
    click(el) {
      const rect = el.getBoundingClientRect();
      const base = {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      };
      for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
        let event;
        try {
          event = new MouseEvent(type, { ...base, view: el.ownerDocument.defaultView });
        } catch {
          event = new MouseEvent(type, base);
        }
        el.dispatchEvent(event);
      }
    },

    pressEscape() {
      const target = document.activeElement || document.body;
      for (const type of ['keydown', 'keyup']) {
        target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', keyCode: 27, bubbles: true }));
      }
    },

    // Builds elements without innerHTML (Gmail enforces Trusted Types).
    el(tag, attrs = {}, ...children) {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? '' : value);
      }
      for (const child of children.flat(Infinity)) if (child != null) node.append(child);
      return node;
    },

    // 20px icon from a 24x24 SVG path (e.g. Material Icons).
    svgIcon(pathData) {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '20', height: '20', 'aria-hidden': 'true' })) {
        svg.setAttribute(k, v);
      }
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', pathData);
      path.setAttribute('fill', 'currentColor');
      svg.append(path);
      return svg;
    },
  };

  /* ========================================================================
   * 5. GMAIL — reading the page and performing actions
   * ====================================================================== */

  const Gmail = {
    myEmail() {
      const match = document.title.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
      return match ? match[0].toLowerCase() : null;
    },

    // Gmail's built-in labels plus the user's "ignored labels" setting.
    isIgnoredLabel: (name) => CONSTANTS.systemLabels.includes(name.trim().toLowerCase()) || Gmail.isUserIgnoredLabel(name),

    // Only the user's "ignored labels" setting (e.g. "~ TO DO ~").
    isUserIgnoredLabel(name) {
      const lower = name.trim().toLowerCase();
      return Settings.get('ignoredLabels').some((l) => l.trim().toLowerCase() === lower);
    },

    // Path after "#label/" when viewing a label, or null. Nested labels keep their "/"
    // ("#label/Job/interview"), and an open email appends "/<id>". Gmail hides the viewed
    // label's own chip on the rows, so row labels alone can't tell you the emails carry it.
    currentLabelPath() {
      const match = location.hash.match(/^#label\/(.+)$/);
      return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : null;
    },

    // The viewed label if it is one of `names` (or `names` includes it as "Parent/Child"…), else null.
    viewedLabelIn(names) {
      const path = Gmail.currentLabelPath();
      if (!path) return null;
      const lower = path.toLowerCase();
      return names.find((n) => {
        const name = n.trim().toLowerCase();
        return lower === name || lower.startsWith(`${name}/`);
      }) || null;
    },

    // True when any of the row's labels is in `names` (case-insensitive, exact).
    rowHasAnyLabel(row, names) {
      const wanted = new Set(names.map((n) => n.trim().toLowerCase()));
      return row.labels.some((l) => wanted.has(l.trim().toLowerCase()));
    },

    // True when Gmail shows its selection actions: emails are ticked, or one is open.
    hasSelection: () => !!(Gmail.toolbarButton(TEXT.archiveButton) || Gmail.toolbarButton(TEXT.deleteButton)),

    // The search text of the current results list, e.g. "from:shop@example.com", or null
    // (not a search, or an email opened from it). Later pages end in "/p2", "/p3"….
    currentSearchQuery() {
      const match = location.hash.match(/^#search\/([^/]+)(?:\/p\d+)?$/);
      return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : null;
    },

    // True on any page of a search results list, not inside an opened email.
    isSearchResults: () => Gmail.currentSearchQuery() !== null,

    // True when the search has nothing except `blockedTerms` (e.g. "in:inbox"), ignoring
    // exclusions like "-in:spam" / "-from:boss" and OR/AND/brackets. Such a search just
    // brings back the inbox or everything. Any other term ("from:x", a keyword) unblocks it.
    isBlockedSearch(query, blockedTerms) {
      if (!query) return true;
      const blocked = new Set(blockedTerms.map((t) => t.trim().toLowerCase()).filter(Boolean));
      const tokens = (query.match(/-?[\w-]+:(?:"[^"]*"|\([^)]*\)|\S+)|"[^"]*"|\S+/g) || [])
        .filter((raw) => !raw.startsWith('-')) // exclusions widen rather than narrow
        .map((raw) => raw.replace(/[(){}]/g, '').toLowerCase())
        .filter((t) => t && t !== 'or' && t !== 'and');
      return tokens.every((t) => blocked.has(t));
    },

    // Search results whose search isn't blocked by the "blocked searches" setting.
    isAllowedSearchResults: () => Gmail.isSearchResults()
      && !Gmail.isBlockedSearch(Gmail.currentSearchQuery(), Settings.get('deleteBlockedSearches')),

    // ---- rows ------------------------------------------------------------

    visibleRows: () => Dom.visible(SEL.row),

    rowId(tr) {
      const node = tr.querySelector(SEL.rowThreadId);
      return (node && (node.getAttribute('data-thread-id') || node.getAttribute('data-legacy-thread-id'))) || tr.id;
    },

    rowEmails: (tr) =>
      [...tr.querySelectorAll(SEL.rowParticipant)].map((s) => s.getAttribute('email').toLowerCase()),

    rowSender(tr) {
      const me = Gmail.myEmail();
      const emails = Gmail.rowEmails(tr);
      return emails.find((e) => e !== me) || emails[0] || null;
    },

    // The chip text is shortened for long nested labels ("…/Refund, Rebate, Reimb…"); title has the full name.
    rowLabels: (tr) =>
      [...tr.querySelectorAll(SEL.rowLabelChip)]
        .map((chip) => (chip.getAttribute('title') || chip.textContent || '').trim())
        .filter(Boolean),

    rowCheckbox: (tr) => tr.querySelector(SEL.rowCheckbox),

    isRowSelected(tr) {
      const cb = Gmail.rowCheckbox(tr);
      return !!cb && cb.getAttribute('aria-checked') === 'true';
    },

    parseRow(tr) {
      const labels = Gmail.rowLabels(tr);
      const subject = tr.querySelector(SEL.rowSubject);
      return {
        id: Gmail.rowId(tr),
        sender: Gmail.rowSender(tr),
        subject: subject ? subject.textContent.trim() : '',
        unread: tr.classList.contains(SEL.unreadRowClass),
        labels,
        userLabels: [...new Set(labels.filter((l) => !Gmail.isIgnoredLabel(l)))],
        // The "Inbox" chip only shows outside the inbox view (e.g. in search results).
        inInbox: labels.some((l) => l.toLowerCase() === TEXT.inboxLabel.toLowerCase()),
        hasUserIgnoredLabel: labels.some(Gmail.isUserIgnoredLabel),
      };
    },

    findRow: (id) => Gmail.visibleRows().find((tr) => Gmail.rowId(tr) === id),

    // ---- sender detection ------------------------------------------------

    // Returns the sender if the current view is (any page of) a plain "from:<email>" search.
    senderFromSearchHash() {
      const query = Gmail.currentSearchQuery();
      if (!query) return null;
      const from = query.match(/^\s*from:\s*"?([^\s"]+@[^\s"]+)"?\s*$/i);
      return from ? from[1].toLowerCase() : null;
    },

    // Senders of the ticked rows, or of the currently opened email.
    sendersOfSelection() {
      const selected = Gmail.visibleRows().filter(Gmail.isRowSelected);
      if (selected.length) {
        return [...new Set(selected.map(Gmail.rowSender).filter(Boolean))];
      }
      const me = Gmail.myEmail();
      const opened = Dom.visible(SEL.openedMessageSender)
        .map((s) => s.getAttribute('email').toLowerCase())
        .filter((e) => e !== me);
      return opened.length ? [opened[0]] : [];
    },

    // True when Label & Archive knows its sender: a "from:" search (which it always uses),
    // or ticked/opened emails that all come from the same sender.
    selectionHasOneSender: () => !!Gmail.senderFromSearchHash() || Gmail.sendersOfSelection().length === 1,

    // ---- navigation ------------------------------------------------------

    async openSenderSearch(email) {
      if (Gmail.senderFromSearchHash() === email) return;

      const before = new Set(Gmail.visibleRows());
      const start = Date.now();
      location.hash = `#search/${encodeURIComponent(`from:${email}`)}`;

      await Dom.waitFor(() => {
        const rows = Gmail.visibleRows();
        if (!rows.length) return false;
        // New list rendered, or (fallback) the rows shown are all from this sender.
        if (!rows.some((r) => before.has(r))) return true;
        return Date.now() - start > 2500 && rows.every((r) => Gmail.rowEmails(r).includes(email));
      }, { timeout: CONSTANTS.searchTimeoutMs, what: `search results for ${email}` });

      await Dom.sleep(300); // let Gmail finish rendering label chips
    },

    // ---- selection -------------------------------------------------------

    async setSelected(tr, selected) {
      if (Gmail.isRowSelected(tr) === selected) return;
      const cb = Gmail.rowCheckbox(tr);
      if (!cb) throw new Error('Row checkbox not found');
      Dom.click(cb);
      await Dom.waitFor(() => Gmail.isRowSelected(tr) === selected, { what: 'row selection to change' });
    },

    // Ticks exactly the rows with the given ids and unticks everything else.
    async selectOnly(ids) {
      const wanted = new Set(ids);
      for (const tr of Gmail.visibleRows()) {
        if (!wanted.has(Gmail.rowId(tr))) await Gmail.setSelected(tr, false);
      }
      for (const id of ids) {
        const tr = Gmail.findRow(id);
        if (!tr) throw new Error('An email to update is no longer in the list');
        await Gmail.setSelected(tr, true);
      }
    },

    // ---- toolbar actions -------------------------------------------------

    // List-view buttons are named by aria-label/data-tooltip; in an opened email Gmail uses title.
    toolbarButton(name) {
      const selector = ['aria-label', 'data-tooltip', 'title'].map((a) => `div[role="button"][${a}="${name}"]`).join(', ');
      return Dom.visible(selector).find((b) => b.getAttribute('aria-disabled') !== 'true') || null;
    },

    // Returns false (instead of throwing) when `optional` and the button isn't shown.
    async clickToolbarButton(name, { optional = false } = {}) {
      let button;
      try {
        button = await Dom.waitFor(() => Gmail.toolbarButton(name), {
          timeout: optional ? 1500 : CONSTANTS.timeoutMs,
          what: `the "${name}" button`,
        });
      } catch (err) {
        if (optional) return false;
        throw err;
      }
      Dom.click(button);
      return true;
    },

    // ---- labels menu -----------------------------------------------------

    labelItemName: (item) => (item.getAttribute('title') || item.textContent || '').trim(),

    findLabelItem(menu, name) {
      const target = name.toLowerCase();
      const named = [...menu.querySelectorAll(SEL.labelMenuItem)]
        .map((item) => [item, Gmail.labelItemName(item).toLowerCase()]);
      const exact = named.find(([, n]) => n === target);
      if (exact) return exact[0];
      // Nested labels may be shown as "Parent/Child" in one place and "Child" in the other.
      const nested = named.find(([, n]) => n.endsWith(`/${target}`) || target.endsWith(`/${n}`));
      return nested ? nested[0] : null;
    },

    // Applies label names to the currently ticked emails (`ids`, used to verify the result).
    async applyLabels(names, ids) {
      await Gmail.clickToolbarButton(TEXT.labelsButton);
      const menu = await Dom.waitFor(
        () => Dom.visible(SEL.menu).find((m) => m.querySelector(SEL.labelMenuItem)),
        { what: 'the Labels menu' },
      );

      await Dom.sleep(200); // let the menu finish opening before clicking inside it

      for (const name of names) {
        const item = Gmail.findLabelItem(menu, name);
        if (!item) throw new Error(`Label "${name}" not found in the Labels menu`);
        // Retry a couple of times; a click can be ignored while the menu is still settling.
        for (let attempt = 1; item.getAttribute('aria-checked') !== 'true'; attempt++) {
          Dom.click(item);
          try {
            await Dom.waitFor(() => item.getAttribute('aria-checked') === 'true', { timeout: 1500, what: `"${name}" to be ticked` });
          } catch (err) {
            if (attempt >= 3) throw err;
          }
        }
      }

      // Gmail only sometimes shows "Apply"; otherwise it commits the ticks when the menu closes.
      let apply = null;
      try {
        apply = await Dom.waitFor(
          () => Dom.visible(SEL.menuItem, menu).find((i) => i.textContent.trim() === TEXT.applyMenuItem),
          { timeout: 800, what: 'the Apply option' },
        );
      } catch { /* not shown */ }
      if (apply) Dom.click(apply);
      else Dom.pressEscape();
      await Dom.waitFor(() => !Dom.isVisible(menu), { what: 'the Labels menu to close' });

      // Don't trust the menu: confirm the label chips actually appear on the emails.
      await Dom.waitFor(() => ids.every((id) => {
        const tr = Gmail.findRow(id);
        return tr && names.every((n) => Gmail.rowHasLabel(tr, n));
      }), { what: 'the labels to appear on the emails' });
    },

    rowHasLabel(tr, name) {
      const target = name.toLowerCase();
      return Gmail.rowLabels(tr).some((l) => {
        const n = l.toLowerCase();
        return n === target || n.endsWith(`/${target}`) || target.endsWith(`/${n}`);
      });
    },

    closeMenus() {
      if (Dom.visible(SEL.menu).length) Dom.pressEscape();
    },
  };

  /* ========================================================================
   * 6. UI — toolbar buttons, dialogs, toasts
   * ====================================================================== */

  GM_addStyle(`
    .goh-group { display:inline-flex; align-items:center; vertical-align:middle; }
    .goh-btn { position:relative; display:inline-flex; align-items:center; gap:6px; cursor:pointer;
      vertical-align:middle; white-space:nowrap; user-select:none; color:#444; }
    .goh-btn svg { position:relative; flex:none; }
    .goh-btn.goh-busy { opacity:.5; cursor:progress; }
    .goh-btn.goh-hidden { display:none; }
    /* Icon only: same box, spacing and round hover highlight as Gmail's own toolbar buttons. */
    .goh-btn.goh-style-icon { justify-content:center; width:20px; height:20px; margin:0 12px; }
    .goh-btn.goh-style-icon::before { content:''; position:absolute; inset:-10px; border-radius:50%;
      background:transparent; transition:background .15s; }
    .goh-btn.goh-style-icon:hover::before { background:rgba(32,33,36,.08); }
    /* Icon + text / text only: compact pill. */
    .goh-btn.goh-style-both, .goh-btn.goh-style-text { height:28px; margin-left:8px; padding:0 10px;
      border:1px solid #c4c7c5; border-radius:14px; font:500 13px/1 'Google Sans',Roboto,sans-serif; color:#1f1f1f; }
    .goh-btn.goh-style-both { padding-left:8px; }
    .goh-btn.goh-style-both:hover, .goh-btn.goh-style-text:hover { background:rgba(32,33,36,.06); }
    .goh-btn.goh-danger.goh-style-both, .goh-btn.goh-danger.goh-style-text { color:#b3261e; }
    /* Dark Gmail themes (Gmail switches its own icons to white at 70% opacity). */
    .goh-dark .goh-btn { color:rgba(255,255,255,.7); }
    .goh-dark .goh-btn.goh-style-icon:hover::before { background:rgba(255,255,255,.12); }
    .goh-dark .goh-btn.goh-style-both, .goh-dark .goh-btn.goh-style-text { color:#e3e3e3; border-color:rgba(255,255,255,.35); }
    .goh-dark .goh-btn.goh-style-both:hover, .goh-dark .goh-btn.goh-style-text:hover { background:rgba(255,255,255,.1); }
    .goh-dark .goh-btn.goh-danger.goh-style-both, .goh-dark .goh-btn.goh-danger.goh-style-text { color:#f2b8b5; }
    .goh-overlay { position:fixed; inset:0; z-index:100000; background:rgba(0,0,0,.35);
      display:flex; align-items:center; justify-content:center; }
    .goh-modal { background:#fff; color:#1f1f1f; border-radius:12px; padding:20px 24px; width:min(460px, 92vw);
      max-height:80vh; overflow:auto; box-shadow:0 8px 32px rgba(0,0,0,.3); font:14px/1.45 Roboto,sans-serif; }
    .goh-modal h2 { margin:0 0 12px; font:500 18px 'Google Sans',Roboto,sans-serif; }
    .goh-modal p { margin:6px 0; }
    .goh-modal ul { margin:6px 0; padding-left:20px; color:#444; }
    .goh-modal textarea { width:100%; box-sizing:border-box; margin-top:6px; padding:6px 8px;
      border:1px solid #c4c7c5; border-radius:8px; font:13px/1.4 monospace; resize:vertical; }
    .goh-modal label { display:flex; gap:8px; align-items:center; padding:4px 0; cursor:pointer; }
    .goh-muted { color:#666; }
    /* Settings panel */
    .goh-modal.goh-modal-wide { width:min(560px, 94vw); }
    .goh-settings-group { margin:0 0 14px; padding:10px 14px 12px; border:1px solid #e0e0e0; border-radius:10px; }
    .goh-settings-group h3 { margin:0 0 6px; font:500 12px 'Google Sans',Roboto,sans-serif; color:#5f6368;
      text-transform:uppercase; letter-spacing:.05em; }
    .goh-setting { padding:6px 0; }
    .goh-setting + .goh-setting { border-top:1px solid #f1f3f4; }
    .goh-setting-choice { display:grid; grid-template-columns:1fr auto; align-items:center; column-gap:12px; }
    .goh-setting-choice .goh-setting-help { grid-column:1 / -1; }
    .goh-setting-label { font-weight:500; }
    .goh-setting-help { margin-top:2px; font-size:12px; color:#666; }
    .goh-modal select { padding:4px 8px; border:1px solid #c4c7c5; border-radius:8px; font:13px Roboto,sans-serif; background:#fff; }
    .goh-radios { display:flex; flex-direction:column; margin-top:2px; }
    .goh-radios label { padding:2px 0; }
    .goh-modal input.goh-number { width:52px; padding:2px 6px; border:1px solid #c4c7c5; border-radius:6px;
      font:13px Roboto,sans-serif; }
    .goh-setting-error { color:#b3261e; font-size:12px; }
    .goh-setting-error:empty { display:none; }
    /* Rich dialog content: summary rows, label pills, grouped email lists. */
    .goh-sender { margin:-6px 0 14px; font:500 14px 'Google Sans',Roboto,sans-serif; color:#0b57d0; word-break:break-all; }
    .goh-summary { display:grid; grid-template-columns:max-content 1fr; gap:8px 14px; align-items:center;
      padding:12px 14px; border-radius:10px; background:#f3f6fc; margin-bottom:14px; }
    .goh-summary dt { color:#5f6368; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    .goh-summary dd { margin:0; display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
    .goh-pill { display:inline-block; padding:2px 8px; border-radius:6px; background:#e8eaed; color:#1f1f1f;
      font:500 12px/18px Roboto,sans-serif; white-space:nowrap; }
    .goh-pill.goh-pill-label { background:#c2e7ff; color:#001d35; }
    .goh-pill.goh-pill-danger { background:#f9dedc; color:#8c1d18; }
    .goh-count.goh-count-danger { background:#b3261e; }
    .goh-sender.goh-query { font-family:monospace; font-size:13px; }
    .goh-count { display:inline-block; min-width:18px; padding:0 6px; border-radius:9px; background:#0b57d0; color:#fff;
      font:500 12px/18px Roboto,sans-serif; text-align:center; }
    .goh-section { margin:12px 0 4px; font:500 13px 'Google Sans',Roboto,sans-serif; color:#444;
      display:flex; align-items:center; gap:8px; }
    .goh-modal ul.goh-emails { list-style:none; margin:0; padding:0; border:1px solid #e0e0e0; border-radius:8px; overflow:hidden; }
    .goh-emails li { display:flex; align-items:center; gap:8px; padding:6px 10px; border-top:1px solid #eee; font-size:13px; }
    .goh-emails li:first-child { border-top:0; }
    .goh-emails .goh-subject { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#444; }
    .goh-emails li.goh-unread .goh-subject { font-weight:700; color:#1f1f1f; }
    .goh-emails li.goh-more { color:#666; font-style:italic; }
    .goh-note { margin-top:10px; font-size:12px; color:#666; }
    /* Buttons stay pinned to the bottom of the dialog while its content scrolls. */
    .goh-actions { position:sticky; bottom:-20px; display:flex; justify-content:flex-end; gap:8px;
      margin:16px -24px -20px; padding:12px 24px 20px; background:#fff; border-top:1px solid #eee; }
    .goh-actions button { border:0; border-radius:16px; padding:8px 16px; font:500 14px 'Google Sans',Roboto,sans-serif;
      cursor:pointer; background:transparent; color:#0b57d0; }
    .goh-actions button.goh-primary { background:#0b57d0; color:#fff; }
    .goh-actions button.goh-primary.goh-danger { background:#b3261e; }
    .goh-actions button:disabled { opacity:.4; cursor:default; }
    .goh-toast { position:fixed; left:24px; bottom:24px; z-index:100001; max-width:480px; padding:12px 16px;
      border-radius:8px; background:#303030; color:#fff; font:14px/1.4 Roboto,sans-serif; box-shadow:0 4px 16px rgba(0,0,0,.3); }
    .goh-toast.goh-error { background:#b3261e; }
  `);

  const UI = {
    // A button value function can return this to keep the dialog open.
    KEEP_OPEN: Symbol('keep-open'),

    toast(message, kind = 'info') {
      document.querySelectorAll('.goh-toast').forEach((t) => t.remove());
      const toast = Dom.el('div', { class: `goh-toast${kind === 'error' ? ' goh-error' : ''}`, text: message });
      document.body.append(toast);
      setTimeout(() => toast.remove(), kind === 'error' ? 10000 : 5000);
    },

    // Generic dialog. Resolves with the clicked button's value, or null on cancel/Esc.
    // onRender({ buttons, close, modal }) can wire up extras (close(value) closes it once).
    modal({ title, body = [], buttons, onRender, wide = false }) {
      return new Promise((resolve) => {
        let closed = false;
        const close = (value) => {
          if (closed) return;
          closed = true;
          overlay.remove();
          resolve(value);
        };
        const buttonEls = buttons.map((b) => Dom.el('button', {
          class: [b.primary && 'goh-primary', b.danger && 'goh-danger'].filter(Boolean).join(' ') || null,
          text: b.label,
          onclick: () => {
            const value = typeof b.value === 'function' ? b.value() : b.value;
            if (value !== UI.KEEP_OPEN) close(value); // e.g. validation failed
          },
        }));
        const modal = Dom.el('div', { class: `goh-modal${wide ? ' goh-modal-wide' : ''}`, role: 'dialog' },
          Dom.el('h2', { text: title }), body, Dom.el('div', { class: 'goh-actions' }, buttonEls));
        const overlay = Dom.el('div', {
          class: 'goh-overlay',
          onclick: (e) => { if (e.target === overlay) close(null); },
          onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Escape') close(null); },
        }, modal);
        document.body.append(overlay);
        if (onRender) onRender({ buttons: buttonEls, close, modal });
        (buttonEls.find((b) => b.classList.contains('goh-primary')) || buttonEls[0]).focus();
      });
    },

    // ---- building blocks for richer dialogs ----

    pill: (text, kind) => Dom.el('span', { class: `goh-pill${kind ? ` goh-pill-${kind}` : ''}`, text }),

    count: (n, kind) => Dom.el('span', { class: `goh-count${kind ? ` goh-count-${kind}` : ''}`, text: String(n) }),

    // rows: [[term, valueNodes], ...] shown as a two-column summary box (null rows are skipped).
    summary(rows) {
      const kept = rows.filter(Boolean);
      if (!kept.length) return null;
      return Dom.el('dl', { class: 'goh-summary' },
        kept.map(([term, value]) => [Dom.el('dt', { text: term }), Dom.el('dd', {}, value)]));
    },

    // A titled, counted list of emails (unread in bold), capped at `max` rows.
    // showLabels: true for the email's own labels, or a function(email) => label names.
    emailSection({ title, emails, max = 6, showLabels = false, countKind }) {
      if (!emails.length) return null;
      const labelsOf = typeof showLabels === 'function' ? showLabels : (e) => (showLabels ? e.userLabels : []);
      const items = emails.slice(0, max).map((e) => Dom.el('li', { class: e.unread ? 'goh-unread' : null },
        Dom.el('span', { class: 'goh-subject', text: e.subject || '(no subject)', title: e.subject || '' }),
        labelsOf(e).map((l) => UI.pill(l))));
      if (emails.length > max) items.push(Dom.el('li', { class: 'goh-more', text: `…and ${emails.length - max} more` }));
      return [
        Dom.el('div', { class: 'goh-section' }, title, UI.count(emails.length, countKind)),
        Dom.el('ul', { class: 'goh-emails' }, items),
      ];
    },

    // Counts down on the confirm button and confirms at 0. A click anywhere in the dialog
    // stops the countdown so it waits for the user (Cancel/Apply clicks still work).
    startAutoConfirm({ seconds, button, label, close, modal }) {
      let left = seconds;
      const show = () => { button.textContent = `${label} (auto in ${left}s)`; };
      const timer = setInterval(() => {
        left -= 1;
        if (!button.isConnected) clearInterval(timer);
        else if (left <= 0) { clearInterval(timer); close(true); }
        else show();
      }, 1000);
      const pause = () => {
        clearInterval(timer);
        button.textContent = label;
      };
      modal.addEventListener('mousedown', pause, { once: true });
      show();
    },

    // Yes/no dialog. Pass `body` nodes, or plain `lines` + `emails`. Resolves true only on confirm.
    // autoConfirmSeconds: confirm automatically after that many seconds unless the user interacts.
    async confirm({ title, body, lines = [], emails = [], confirmLabel, danger = false, autoConfirmSeconds }) {
      const shown = emails.slice(0, 8).map((e) => Dom.el('li', { text: e.subject || '(no subject)' }));
      if (emails.length > shown.length) {
        shown.push(Dom.el('li', { class: 'goh-muted', text: `…and ${emails.length - shown.length} more` }));
      }
      const result = await UI.modal({
        title,
        body: body || [
          lines.map((text) => Dom.el('p', { text })),
          shown.length ? Dom.el('ul', {}, shown) : null,
        ],
        buttons: [
          { label: 'Cancel', value: false },
          { label: confirmLabel, primary: true, danger, value: true },
        ],
        onRender: ({ buttons, close, modal }) => {
          if (autoConfirmSeconds > 0) {
            UI.startAutoConfirm({ seconds: autoConfirmSeconds, button: buttons[1], label: confirmLabel, close, modal });
          }
        },
      });
      return result === true;
    },

    // counts: [{ name, count }]. purpose: 'apply' (label unlabeled emails) or 'clear' (only
    // finish off labeled emails with that label). Resolves with the ticked label names, or null.
    async pickLabels({ sender, counts, total, purpose = 'apply' }) {
      const boxes = counts.map(({ name }) => Dom.el('input', { type: 'checkbox', value: name }));
      const prompt = purpose === 'apply'
        ? 'Pick the label(s) to apply:'
        : 'Nothing needs a label. Pick the label(s) whose emails still in the inbox or unread should be marked read and archived:';
      return UI.modal({
        title: 'Choose label(s)',
        body: [
          Dom.el('p', { text: `Older emails from ${sender} have different labels. ${prompt}` }),
          counts.map(({ name, count }, i) => Dom.el('label', {}, boxes[i], name,
            Dom.el('span', { class: 'goh-muted', text: `(${count} of ${total} emails)` }))),
        ],
        buttons: [
          { label: 'Cancel', value: null },
          { label: 'Continue', primary: true, value: () => boxes.filter((b) => b.checked).map((b) => b.value) },
        ],
        onRender: ({ buttons }) => {
          const next = buttons[1];
          const sync = () => { next.disabled = !boxes.some((b) => b.checked); };
          boxes.forEach((b) => b.addEventListener('change', sync));
          sync();
        },
      });
    },

    // Builds the control for one setting. Returns { control, read } where read() gives
    // { value } or { error }.
    settingControl(key, def, value) {
      const type = def.type || 'toggle';
      if (type === 'choice') {
        const control = Dom.el('select', {}, def.options.map(([v, text]) =>
          Dom.el('option', { value: v, text, selected: String(value) === v })));
        return { control, read: () => ({ value: control.value }) };
      }
      if (type === 'list') {
        const control = Dom.el('textarea', { spellcheck: 'false', rows: String(Math.max(2, value.length + 1)) });
        control.value = value.join('\n');
        return {
          control,
          read: () => ({ value: [...new Set(control.value.split('\n').map((v) => v.trim()).filter(Boolean))] }),
        };
      }
      if (type === 'delay') {
        // Immediately = "0", Never = "never", After N seconds = "N" (a custom 0 also means immediately).
        const current = String(value);
        const mode = current === '0' ? 'immediate' : current === 'never' ? 'never' : 'custom';
        const radio = (m) => Dom.el('input', { type: 'radio', name: `goh-${key}`, value: m, checked: mode === m });
        const [immediate, never, custom] = [radio('immediate'), radio('never'), radio('custom')];
        const seconds = Dom.el('input', {
          type: 'number', class: 'goh-number', min: String(def.min), max: String(def.max), step: '1',
          value: mode === 'custom' ? current : String(def.default),
        });
        seconds.addEventListener('focus', () => { custom.checked = true; });
        const control = Dom.el('div', { class: 'goh-radios' },
          Dom.el('label', {}, immediate, 'Immediately (no popup)'),
          Dom.el('label', {}, never, 'Never (wait for me)'),
          Dom.el('label', {}, custom, 'After', seconds, 'seconds'));
        const read = () => {
          if (immediate.checked) return { value: '0' };
          if (never.checked) return { value: 'never' };
          const text = seconds.value.trim();
          const n = Number(text);
          if (!/^\d+$/.test(text) || n < def.min || n > def.max) {
            return { error: `Enter a whole number of seconds from ${def.min} to ${def.max}.` };
          }
          return { value: String(n) };
        };
        return { control, read };
      }
      const control = Dom.el('input', { type: 'checkbox', checked: !!value });
      return { control, read: () => ({ value: control.checked }) };
    },

    // Settings panel built from the schema, grouped by `group`. Resolves with
    // { key: value } for every setting, or null on Cancel. Invalid input keeps it open.
    async settings(schema, get) {
      const controls = {};
      const groups = new Map();
      for (const [key, def] of Object.entries(schema)) {
        const type = def.type || 'toggle';
        const { control, read } = UI.settingControl(key, def, get(key));
        const error = Dom.el('div', { class: 'goh-setting-error' });
        controls[key] = { read, error };

        const help = def.help ? Dom.el('div', { class: 'goh-setting-help', text: def.help }) : null;
        const row = type === 'toggle'
          ? Dom.el('div', { class: 'goh-setting' }, Dom.el('label', {}, control, def.label), help, error)
          : Dom.el('div', { class: `goh-setting goh-setting-${type}` },
            Dom.el('div', { class: 'goh-setting-label', text: def.label }), control, help, error);
        // Any edit to the setting clears its error until the next Save.
        for (const type of ['input', 'change']) row.addEventListener(type, () => { error.textContent = ''; });
        if (!groups.has(def.group)) groups.set(def.group, []);
        groups.get(def.group).push(row);
      }

      const read = () => {
        const values = {};
        let valid = true;
        for (const [key, { read: readOne, error }] of Object.entries(controls)) {
          const result = readOne();
          error.textContent = result.error || '';
          if (result.error) valid = false;
          else values[key] = result.value;
        }
        return valid ? values : UI.KEEP_OPEN;
      };

      return UI.modal({
        title: 'Gmail Organizer Helpers — Settings',
        wide: true,
        body: [...groups].map(([group, rows]) => Dom.el('section', { class: 'goh-settings-group' },
          Dom.el('h3', { text: group }), rows)),
        buttons: [
          { label: 'Cancel', value: null },
          { label: 'Save', primary: true, value: read },
        ],
      });
    },
  };

  // One toolbar button per workflow, in a group after Gmail's own button groups.
  // Style follows the "Button style" setting; the tooltip uses Gmail's own (data-tooltip).
  const Toolbar = {
    active: null, // { key, text } while a workflow runs

    inject(workflows, onClick) {
      const style = Settings.get('buttonStyle');
      for (const toolbar of Dom.visible(SEL.toolbar)) {
        // Gmail may build its button row after the toolbar appears; keep our group inside it.
        const row = toolbar.querySelector(SEL.toolbarButtonRow);
        const existing = toolbar.querySelector('.goh-group');
        if (existing) {
          if (row && existing.parentElement !== row) row.append(existing);
          continue;
        }
        // Fallback if Gmail renames the row class: after 10s, use the toolbar itself.
        const parent = row || (performance.now() > 10000 ? toolbar : null);
        if (!parent) continue;
        const buttons = Object.entries(workflows).map(([key, wf]) => Dom.el('div', {
          class: `goh-btn goh-style-${style}${wf.button.danger ? ' goh-danger' : ''}`,
          role: 'button',
          'data-workflow': key,
          onclick: (e) => { e.stopPropagation(); onClick(key); },
        },
        style !== 'text' ? Dom.svgIcon(wf.button.icon) : null,
        style !== 'icon' ? Dom.el('span', { class: 'goh-text' }) : null));
        parent.append(Dom.el('div', { class: 'goh-group' }, buttons));
        Toolbar.render(workflows);
        Toolbar.lastThemeCheck = 0;
      }
      Toolbar.syncTheme();
      Toolbar.syncVisibility(workflows);
    },

    // Shows each button only while its `visibleWhen()` holds (kept visible while it runs).
    // Only toggles a class (the observer watches childList, so this can't loop).
    syncVisibility(workflows) {
      for (const b of document.querySelectorAll('.goh-btn')) {
        const key = b.getAttribute('data-workflow');
        const { visibleWhen } = workflows[key].button;
        const running = Toolbar.active && Toolbar.active.key === key;
        b.classList.toggle('goh-hidden', !!visibleWhen && !visibleWhen() && !running);
      }
    },

    // Matches Gmail's icon color: light icons on dark themes. Checked at most once a second.
    lastThemeCheck: 0,
    syncTheme() {
      if (Date.now() - Toolbar.lastThemeCheck < 1000) return;
      Toolbar.lastThemeCheck = Date.now();
      for (const group of document.querySelectorAll('.goh-group')) {
        const toolbar = group.closest(SEL.toolbar) || document;
        const dark = [...toolbar.querySelectorAll(SEL.toolbarIconImage)]
          .some((el) => !el.closest('.goh-group') && SEL.darkIconPattern.test(getComputedStyle(el).backgroundImage));
        group.classList.toggle('goh-dark', dark);
      }
    },

    // Rebuilds all buttons, e.g. after the button style changes.
    rebuild(workflows, onClick) {
      document.querySelectorAll('.goh-group').forEach((g) => g.remove());
      Toolbar.inject(workflows, onClick);
    },

    setActive(workflows, key, text) {
      Toolbar.active = key ? { key, text } : null;
      Toolbar.render(workflows);
      Toolbar.syncVisibility(workflows);
    },

    render(workflows) {
      for (const b of document.querySelectorAll('.goh-btn')) {
        const { text, description } = workflows[b.getAttribute('data-workflow')].button;
        const status = Toolbar.active && Toolbar.active.key === b.getAttribute('data-workflow') ? Toolbar.active.text : null;
        const label = b.querySelector('.goh-text');
        if (label) label.textContent = status || text;
        // Icon only: the name is the tooltip. With visible text: the tooltip explains the action.
        b.setAttribute('aria-label', status || text);
        b.setAttribute('data-tooltip', status || (label ? description : text));
        b.classList.toggle('goh-busy', !!Toolbar.active);
      }
    },
  };

  /* ========================================================================
   * 7. PIPELINE ENGINE
   * ====================================================================== */

  class Pipeline {
    constructor(steps = []) {
      this.steps = [...steps];
    }

    indexOf(name) {
      const i = this.steps.findIndex((s) => s.name === name);
      if (i < 0) throw new Error(`No pipeline step named "${name}"`);
      return i;
    }

    insertBefore(name, step) { this.steps.splice(this.indexOf(name), 0, step); return this; }
    insertAfter(name, step) { this.steps.splice(this.indexOf(name) + 1, 0, step); return this; }
    replace(name, step) { this.steps.splice(this.indexOf(name), 1, step); return this; }
    remove(name) { this.steps.splice(this.indexOf(name), 1); return this; }

    async run(ctx, { onStep = () => {} } = {}) {
      for (const step of this.steps) {
        if (ctx.stopped) break;
        if (step.when && !step.when(ctx)) { log('skip', step.name); continue; }
        log('step', step.name, ctx);
        onStep(step);
        try {
          await step.run(ctx);
        } catch (err) {
          err.step = step.name;
          throw err;
        }
      }
      return ctx;
    }
  }

  function createContext() {
    const ctx = {
      sender: null,        // email address being processed (sender workflows only)
      rows: [],            // parsed rows of the current list
      sources: [],         // rows that already have user labels
      toLabel: [],         // rows that get labels applied (Label & Archive)
      leftovers: [],       // labeled rows still in the inbox or unread (Label & Archive)
      skipped: [],         // rows with an ignored label; never selected or changed
      targets: [],         // rows the action steps act on (mark read, archive, delete)
      labels: [],          // label names to apply
      done: [],            // phrases for the report, e.g. "archived"
      warnings: [],
      stopped: false,
      stopMessage: null,
      stopKind: 'info',
      stop(message, kind = 'info') {
        ctx.stopped = true;
        ctx.stopMessage = message;
        ctx.stopKind = kind;
      },
    };
    return ctx;
  }

  /* ========================================================================
   * 8. STEP LIBRARY — shared building blocks for workflows
   * ====================================================================== */

  const ids = (rows) => rows.map((r) => r.id);
  const targetIds = (ctx) => ids(ctx.targets);

  // A labeled email that was never finished off; ignored-label emails never count.
  const isUnfinished = (r) => (r.inInbox || r.unread) && !r.hasUserIgnoredLabel;
  const hasAllLabels = (r, labels) =>
    labels.every((l) => r.userLabels.some((u) => u.toLowerCase() === l.toLowerCase()));

  // For 'delay' settings: "0" = no confirmation at all, "never" = wait for a click, "N" = countdown.
  const showsConfirmation = (key) => String(Settings.get(key)) !== '0';
  const countdownSeconds = (key) => {
    const value = String(Settings.get(key));
    return value === 'never' ? 0 : Number(value);
  };

  const Steps = {
    resolveSender: {
      name: 'resolveSender',
      label: 'Finding sender…',
      run: async (ctx) => {
        const fromSearch = Gmail.senderFromSearchHash();
        if (fromSearch) { ctx.sender = fromSearch; return; }

        const senders = Gmail.sendersOfSelection();
        if (!senders.length) return ctx.stop('Tick the checkbox of an email (or open one) first.');
        if (senders.length > 1) {
          return ctx.stop(`The selected emails are from ${senders.length} different senders. Select emails from one sender.`);
        }
        ctx.sender = senders[0];
      },
    },

    openSenderSearch: {
      name: 'openSenderSearch',
      label: 'Searching…',
      run: async (ctx) => { await Gmail.openSenderSearch(ctx.sender); },
    },

    collectRows: {
      name: 'collectRows',
      label: 'Reading emails…',
      run: async (ctx) => {
        ctx.rows = Gmail.visibleRows().map(Gmail.parseRow);
        if (!ctx.rows.length) return ctx.stop('No emails in this list.');
        if (ctx.rows.length >= CONSTANTS.pageSize) {
          ctx.warnings.push(`Only the ${ctx.rows.length} emails on this page were included.`);
        }
      },
    },

    // Guard so Delete page can't run on the inbox or a folder, even from the Tampermonkey menu.
    requireSearchResults: {
      name: 'requireSearchResults',
      run: async (ctx) => {
        if (!Gmail.isAllowedSearchResults()) {
          ctx.stop('Delete page only works on search results, and not on a blocked search like "in:inbox" on its own.');
        }
      },
    },

    // Every row except those with a protected label, which are never deleted.
    targetDeletableRows: {
      name: 'targetDeletableRows',
      run: async (ctx) => {
        const protectedLabels = Settings.get('deleteProtectedLabels');
        const viewed = Gmail.viewedLabelIn(protectedLabels);
        if (viewed) return ctx.stop(`Nothing deleted: you're viewing "${viewed}", a protected label.`);
        const isProtected = (r) => Gmail.rowHasAnyLabel(r, protectedLabels);
        ctx.skipped = ctx.rows.filter(isProtected);
        ctx.targets = ctx.rows.filter((r) => !isProtected(r));
        if (!ctx.targets.length) return ctx.stop('Nothing to delete: every email on this page has a protected label.');
      },
    },

    targetUnlabeledRows: {
      name: 'targetUnlabeledRows',
      label: 'Reading labels…',
      run: async (ctx) => {
        // Emails with an ignored label (e.g. "~ TO DO ~") are never selected or changed.
        // Their other labels can still be copied from, since that only reads them.
        ctx.skipped = ctx.rows.filter((r) => r.hasUserIgnoredLabel);
        ctx.sources = ctx.rows.filter((r) => r.userLabels.length);
        ctx.toLabel = ctx.rows.filter((r) => !r.userLabels.length && !r.hasUserIgnoredLabel);
        ctx.targets = [...ctx.toLabel];
      },
    },

    checkLabelSources: {
      name: 'checkLabelSources',
      run: async (ctx) => {
        if (ctx.toLabel.length && !ctx.sources.length) {
          return ctx.stop(`No labeled emails from ${ctx.sender} to copy a label from.`);
        }
      },
    },

    // Picks the label(s) to use: automatic when all labeled emails agree, else the picker.
    // Also needed with nothing to label, to decide which unfinished labeled emails to clear.
    chooseLabels: {
      name: 'chooseLabels',
      label: 'Choosing labels…',
      when: (ctx) => ctx.toLabel.length > 0 || (Settings.get('includeLabeledInInbox') && ctx.sources.some(isUnfinished)),
      run: async (ctx) => {
        const sets = new Map();
        for (const r of ctx.sources) sets.set([...r.userLabels].sort().join('\n'), r.userLabels);
        if (sets.size === 1) {
          ctx.labels = [...sets.values()][0];
          return;
        }

        const counts = new Map();
        for (const r of ctx.sources) for (const l of r.userLabels) counts.set(l, (counts.get(l) || 0) + 1);
        const picked = await UI.pickLabels({
          sender: ctx.sender,
          counts: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
          total: ctx.sources.length,
          purpose: ctx.toLabel.length ? 'apply' : 'clear',
        });
        if (!picked || !picked.length) return ctx.stop('Cancelled.');
        ctx.labels = picked;
      },
    },

    // Labeled emails that were never finished off (still in the inbox, or unread) and
    // already carry the chosen label(s). Emails with other labels are left alone.
    targetLabeledLeftovers: {
      name: 'targetLabeledLeftovers',
      when: (ctx) => Settings.get('includeLabeledInInbox') && ctx.labels.length > 0,
      run: async (ctx) => {
        ctx.leftovers = ctx.sources.filter((r) => isUnfinished(r) && hasAllLabels(r, ctx.labels));
        ctx.targets = [...ctx.toLabel, ...ctx.leftovers];
      },
    },

    checkLabelArchiveTargets: {
      name: 'checkLabelArchiveTargets',
      run: async (ctx) => {
        if (!ctx.targets.length) {
          return ctx.stop(`Nothing to do: every email from ${ctx.sender} on this page is labeled and done.`);
        }
      },
    },

    confirmLabelArchive: {
      name: 'confirmLabelArchive',
      label: 'Waiting for confirmation…',
      when: () => showsConfirmation('labelArchiveAutoApply'),
      run: async (ctx) => {
        const then = [];
        if (Settings.get('markAsRead')) then.push('Mark as read');
        if (Settings.get('archive')) then.push('Archive');
        const n = ctx.targets.length;
        const ok = await UI.confirm({
          title: 'Label & Archive',
          body: [
            Dom.el('div', { class: 'goh-sender', text: ctx.sender }),
            UI.summary([
              ctx.toLabel.length ? ['Label', ctx.labels.map((l) => UI.pill(l, 'label'))] : null,
              then.length ? ['Then', [then.map((a) => UI.pill(a)), Dom.el('span', { class: 'goh-muted', text: n === 1 ? '1 email' : `all ${n} emails` })]] : null,
            ]),
            UI.emailSection({ title: 'To label', emails: ctx.toLabel }),
            UI.emailSection({ title: 'Already labeled, still in inbox or unread', emails: ctx.leftovers, showLabels: true }),
            ctx.skipped.length
              ? Dom.el('div', { class: 'goh-note', text: `Skipping ${ctx.skipped.length} email(s) with an ignored label.` })
              : null,
          ],
          confirmLabel: `Apply to ${n} email${n === 1 ? '' : 's'}`,
          autoConfirmSeconds: countdownSeconds('labelArchiveAutoApply'),
        });
        if (!ok) ctx.stop('Cancelled.');
      },
    },

    confirmDelete: {
      name: 'confirmDelete',
      label: 'Waiting for confirmation…',
      when: () => showsConfirmation('deleteAutoApply'),
      run: async (ctx) => {
        const n = ctx.targets.length;
        const emails = (count) => `${count} email${count === 1 ? '' : 's'}`;
        // Show every label except Gmail's built-in ones (ignored labels included: they matter here).
        const visibleLabels = (e) => e.labels.filter((l) => !CONSTANTS.systemLabels.includes(l.toLowerCase()));
        const protectedLabels = Settings.get('deleteProtectedLabels');
        const protectedFound = [...new Set(ctx.skipped.flatMap((e) =>
          e.labels.filter((l) => Gmail.rowHasAnyLabel({ labels: [l] }, protectedLabels))))];
        const query = Gmail.currentSearchQuery();
        const ok = await UI.confirm({
          title: 'Delete page',
          body: [
            query ? Dom.el('div', { class: 'goh-sender goh-query', text: query }) : null,
            UI.summary([
              ['Action', [UI.pill('Move to Trash', 'danger'), Dom.el('span', { class: 'goh-muted', text: emails(n) })]],
              ctx.skipped.length
                ? ['Keep', [protectedFound.map((l) => UI.pill(l, 'label')), Dom.el('span', { class: 'goh-muted', text: emails(ctx.skipped.length) })]]
                : null,
            ]),
            UI.emailSection({ title: 'To delete', emails: ctx.targets, showLabels: visibleLabels, countKind: 'danger' }),
            UI.emailSection({ title: 'Kept (protected label)', emails: ctx.skipped, showLabels: visibleLabels, max: 3 }),
          ],
          confirmLabel: `Delete ${emails(n)}`,
          danger: true,
          autoConfirmSeconds: countdownSeconds('deleteAutoApply'),
        });
        if (!ok) ctx.stop('Cancelled.');
      },
    },

    selectTargets: {
      name: 'selectTargets',
      label: 'Selecting emails…',
      run: async (ctx) => { await Gmail.selectOnly(targetIds(ctx)); },
    },

    applyLabels: {
      name: 'applyLabels',
      label: 'Applying labels…',
      when: (ctx) => ctx.toLabel.length > 0,
      run: async (ctx) => {
        await Gmail.selectOnly(ids(ctx.toLabel));
        await Gmail.applyLabels(ctx.labels, ids(ctx.toLabel));
        ctx.done.push(`${ctx.toLabel.length} labeled "${ctx.labels.join('", "')}"`);
      },
    },

    markAsRead: {
      name: 'markAsRead',
      label: 'Marking as read…',
      when: (ctx) => Settings.get('markAsRead') && ctx.targets.some((t) => t.unread),
      run: async (ctx) => {
        await Gmail.selectOnly(targetIds(ctx));
        if (await Gmail.clickToolbarButton(TEXT.markReadButton, { optional: true })) ctx.done.push('marked read');
        await Dom.sleep(500);
      },
    },

    archive: {
      name: 'archive',
      label: 'Archiving…',
      when: () => Settings.get('archive'),
      run: async (ctx) => {
        await Gmail.selectOnly(targetIds(ctx));
        // No Archive button means none of them are in the inbox; nothing to do.
        if (await Gmail.clickToolbarButton(TEXT.archiveButton, { optional: true })) ctx.done.push('archived');
        await Dom.sleep(500);
      },
    },

    deleteTargets: {
      name: 'deleteTargets',
      label: 'Deleting…',
      run: async (ctx) => {
        await Gmail.selectOnly(targetIds(ctx));
        await Gmail.clickToolbarButton(TEXT.deleteButton);
        ctx.done.push('moved to Trash');
        await Dom.sleep(500);
      },
    },

    report: {
      name: 'report',
      label: 'Done',
      run: async (ctx) => {
        const from = ctx.sender ? ` from ${ctx.sender}` : '';
        UI.toast([`${ctx.targets.length} email(s)${from}: ${ctx.done.join(', ')}.`, ...ctx.warnings].join(' '));
      },
    },
  };

  /* ========================================================================
   * 9. WORKFLOWS — one toolbar button each
   * ====================================================================== */

  const WORKFLOWS = {
    labelArchive: {
      button: {
        text: 'Label & Archive',
        description: "Give this sender's unlabeled emails the same label(s) as their older ones, then mark read and archive",
        // Like Gmail's own Archive/Labels buttons, but only when the selection is from one
        // sender (resolveSender still checks, e.g. when run from the Tampermonkey menu).
        visibleWhen: () => Gmail.hasSelection() && Gmail.selectionHasOneSender(),
        // Material Icons "drive_file_move" (Apache 2.0); Gmail's Labels button already uses the tag icon
        icon: 'M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 12v-3h-4v-4h4V8l5 5-5 5z',
      },
      pipeline: new Pipeline([
        Steps.resolveSender,
        Steps.openSenderSearch,
        Steps.collectRows,
        Steps.targetUnlabeledRows,
        Steps.checkLabelSources,
        Steps.chooseLabels,
        Steps.targetLabeledLeftovers,
        Steps.checkLabelArchiveTargets,
        Steps.confirmLabelArchive,
        Steps.applyLabels,
        Steps.markAsRead,
        Steps.archive,
        Steps.report,
      ]),
    },

    deletePage: {
      button: {
        text: 'Delete page',
        description: 'Move every email on this page to Trash, except ones with a protected label',
        visibleWhen: () => Gmail.isAllowedSearchResults(), // never on folders or blocked searches like "in:inbox"
        // Material Icons "delete_sweep" (Apache 2.0)
        icon: 'M15 16h4v2h-4zm0-8h7v2h-7zm0 4h6v2h-6zM3 18c0 1.1.9 2 2 2h6c1.1 0 2-.9 2-2V8H3v10zM14 5h-3l-1-1H6L5 5H2v2h12z',
        danger: true,
      },
      pipeline: new Pipeline([
        Steps.requireSearchResults,
        Steps.collectRows,
        Steps.targetDeletableRows,
        Steps.confirmDelete,
        Steps.selectTargets,
        Steps.deleteTargets,
        Steps.report,
      ]),
    },
  };

  /* ========================================================================
   * 10. APP — wiring
   * ====================================================================== */

  let running = false;

  async function runWorkflow(key) {
    if (running) return;
    running = true;
    const ctx = createContext();
    try {
      await WORKFLOWS[key].pipeline.run(ctx, {
        onStep: (step) => Toolbar.setActive(WORKFLOWS, key, step.label || step.name),
      });
      if (ctx.stopped) UI.toast(ctx.stopMessage, ctx.stopKind);
    } catch (err) {
      console.error('[GOH]', err);
      Gmail.closeMenus();
      UI.toast(`Failed at step "${err.step || '?'}": ${err.message}`, 'error');
    } finally {
      running = false;
      Toolbar.setActive(WORKFLOWS, null);
    }
  }

  Settings.onChange((key) => {
    if (key === 'buttonStyle') Toolbar.rebuild(WORKFLOWS, runWorkflow);
  });

  Settings.registerMenu(Object.entries(WORKFLOWS).map(([key, wf]) => ({
    caption: `▶ ${wf.button.text}`,
    run: () => runWorkflow(key),
  })));

  let injectQueued = false;
  new MutationObserver(() => {
    if (injectQueued) return;
    injectQueued = true;
    requestAnimationFrame(() => { injectQueued = false; Toolbar.inject(WORKFLOWS, runWorkflow); });
  }).observe(document.body, { childList: true, subtree: true });
  Toolbar.inject(WORKFLOWS, runWorkflow);

  // Ticking emails only changes attributes, which the observer above doesn't see; a cheap poll
  // keeps `visibleWhen` buttons in step with Gmail's selection and the current view.
  setInterval(() => Toolbar.syncVisibility(WORKFLOWS), 250);
})();
