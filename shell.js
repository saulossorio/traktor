/**
 * shell.js — App shell / view-switcher component (vanilla JS, no deps)
 * -----------------------------------------------------------------
 * Renders a fixed header + tab bar + single-view content area that fills the
 * viewport (100vh, no page-level scroll). Exactly one "view" panel is visible
 * at a time; the others are removed from layout (`hidden` attribute), not
 * just scrolled past. If a view's own content is taller than the viewport,
 * that view's panel scrolls internally — the header/tab bar never move.
 *
 * Pair with shell.css (must be loaded on the page).
 *
 * USAGE
 * -----
 *   const shell = initShell({
 *     container: '#shellRoot',              // CSS selector or Element. Required.
 *                                            // Its entire contents are replaced by the shell.
 *     title: 'Traffic Performance Dashboard', // optional string in the header bar.
 *                                              // Omit / '' to render without a header bar.
 *     views: [                              // required, at least 1 entry.
 *       // each entry is either a plain id string, or an object:
 *       { id: 'overview',    label: 'Overview',    default: true },
 *       { id: 'channels',    label: 'Channels' },
 *       { id: 'regional',    label: 'Regional' },
 *       { id: 'methodology', label: 'Methodology' }
 *     ],
 *     default: 'overview',                  // optional: id of the view shown first. If omitted,
 *                                            // falls back to whichever view has `default: true`,
 *                                            // then to the first view in the array.
 *     mountPoints: {                        // optional. For each key (a view id), the referenced
 *       overview: '#overviewSection',       // existing DOM node (CSS selector string or Element)
 *       channels: document.getElementById('channelsSection') // is MOVED (not cloned) into that
 *     },                                    // view's panel on init. IDs on the moved elements are
 *                                            // preserved, so existing getElementById(...) lookups
 *                                            // elsewhere in Antonio's code keep working unchanged.
 *     onChange: (viewId, previousViewId) => {} // optional, fired on every switch (not on init)
 *   });
 *
 * RETURNS a controller:
 *   shell.switchTo(viewId)   -> programmatically activate a view
 *   shell.getActiveView()    -> current view id (string)
 *   shell.getPanel(viewId)   -> the panel <div> Element for a view id (append/query content here)
 *   shell.destroy()          -> removes all shell DOM and listeners from the container
 *
 * EVENT
 *   Also dispatches a 'shell:viewchange' CustomEvent on the shell root element
 *   (bubbles, so you can listen on an ancestor too) on every switch:
 *     detail: { viewId, previousViewId }
 *   Use this instead of / alongside onChange, whichever fits Antonio's code better.
 *
 * ACCESSIBILITY
 *   Implements the ARIA APG "tabs" pattern (manual DOM, automatic activation):
 *   tablist/tab/tabpanel roles, roving tabindex, Left/Right/Home/End to move
 *   AND activate, Enter/Space to activate (native <button> behavior).
 */
(function () {
  'use strict';

  function resolveElement(target) {
    if (!target) return null;
    if (typeof target === 'string') return document.querySelector(target);
    if (target instanceof Element) return target;
    return null;
  }

  // Accepts a view entry as a string ('overview') or object ({id, label, default}).
  // Returns { id, label, default }.
  function normalizeView(entry) {
    if (typeof entry === 'string') {
      return { id: entry, label: labelFromId(entry), default: false };
    }
    if (entry && typeof entry === 'object' && entry.id) {
      return {
        id: entry.id,
        label: entry.label || labelFromId(entry.id),
        default: !!entry.default
      };
    }
    throw new Error('initShell: each entry in `views` must be a string id or an { id } object');
  }

  function labelFromId(id) {
    return String(id)
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  function initShell(config) {
    config = config || {};
    var root = resolveElement(config.container);
    if (!root) {
      throw new Error('initShell: `container` did not resolve to an Element (check the selector).');
    }
    if (!Array.isArray(config.views) || config.views.length === 0) {
      throw new Error('initShell: `views` must be a non-empty array.');
    }

    var views = config.views.map(normalizeView);
    var ids = views.map(function (v) { return v.id; });
    var dupes = ids.filter(function (id, i) { return ids.indexOf(id) !== i; });
    if (dupes.length) {
      throw new Error('initShell: duplicate view id(s): ' + dupes.join(', '));
    }

    // Resolve the default view: top-level config.default wins, then any view
    // flagged `default: true`, then just the first view in the list.
    var defaultId = config.default ||
      (views.filter(function (v) { return v.default; })[0] || {}).id ||
      views[0].id;
    if (ids.indexOf(defaultId) === -1) {
      throw new Error('initShell: default view id "' + defaultId + '" is not in `views`.');
    }

    var mountPoints = config.mountPoints || {};
    var onChange = typeof config.onChange === 'function' ? config.onChange : null;

    // ---- build DOM ----
    root.innerHTML = '';
    root.classList.add('app-shell');

    if (config.title) {
      var header = document.createElement('header');
      header.className = 'app-shell-header';
      var titleEl = document.createElement('div');
      titleEl.className = 'app-shell-title';
      titleEl.textContent = config.title;
      header.appendChild(titleEl);
      root.appendChild(header);
    }

    var tablist = document.createElement('div');
    tablist.className = 'app-shell-tabbar';
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', config.title ? config.title + ' views' : 'Abas do dashboard');
    root.appendChild(tablist);

    var panelsWrap = document.createElement('div');
    panelsWrap.className = 'app-shell-panels';
    root.appendChild(panelsWrap);

    var tabs = {};   // id -> <button>
    var panels = {}; // id -> <div>

    views.forEach(function (v) {
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.id = 'tab-' + v.id;
      tab.className = 'app-shell-tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'panel-' + v.id);
      tab.textContent = v.label;
      tablist.appendChild(tab);
      tabs[v.id] = tab;

      var panel = document.createElement('div');
      panel.id = 'panel-' + v.id;
      panel.className = 'app-shell-panel';
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', 'tab-' + v.id);
      panel.setAttribute('tabindex', '0'); // focusable so keyboard users can scroll a tall panel
      panelsWrap.appendChild(panel);
      panels[v.id] = panel;

      // Move existing content into this panel, if the caller mapped one.
      var mount = mountPoints[v.id] ? resolveElement(mountPoints[v.id]) : null;
      if (mount) panel.appendChild(mount);
    });

    // ---- activation ----
    var activeId = null;

    function setActive(id, opts) {
      opts = opts || {};
      if (!tabs[id]) return;
      var previousId = activeId;
      views.forEach(function (v) {
        var isActive = v.id === id;
        tabs[v.id].classList.toggle('active', isActive);
        tabs[v.id].setAttribute('aria-selected', isActive ? 'true' : 'false');
        tabs[v.id].tabIndex = isActive ? 0 : -1;
        panels[v.id].classList.toggle('active', isActive);
        if (isActive) panels[v.id].removeAttribute('hidden');
        else panels[v.id].setAttribute('hidden', '');
      });
      activeId = id;
      if (opts.focus) tabs[id].focus();
      if (previousId !== null && previousId !== id) {
        root.dispatchEvent(new CustomEvent('shell:viewchange', {
          bubbles: true,
          detail: { viewId: id, previousViewId: previousId }
        }));
        if (onChange) onChange(id, previousId);
      }
    }

    // Roving-tabindex keyboard nav: Left/Right/Home/End move focus AND activate
    // (automatic activation model, matches ARIA APG tabs pattern).
    tablist.addEventListener('keydown', function (e) {
      var currentIndex = ids.indexOf(activeId);
      var nextIndex = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIndex = (currentIndex + 1) % ids.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIndex = (currentIndex - 1 + ids.length) % ids.length;
      else if (e.key === 'Home') nextIndex = 0;
      else if (e.key === 'End') nextIndex = ids.length - 1;
      else return; // let Enter/Space fall through to native <button> click handling
      e.preventDefault();
      setActive(ids[nextIndex], { focus: true });
    });

    views.forEach(function (v) {
      tabs[v.id].addEventListener('click', function () { setActive(v.id, { focus: false }); });
    });

    // activeId starts as null, so this first call's transition check
    // (previousId !== null) correctly skips firing onChange/event on init.
    setActive(defaultId, { focus: false });

    return {
      switchTo: function (id) { setActive(id, { focus: false }); },
      getActiveView: function () { return activeId; },
      getPanel: function (id) { return panels[id] || null; },
      destroy: function () {
        root.innerHTML = '';
        root.classList.remove('app-shell');
      }
    };
  }

  // Exposed as a plain global, matching the spec's `initShell({...})` call style.
  window.initShell = initShell;
})();
