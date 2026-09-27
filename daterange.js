/**
 * daterange.js — Date-range filter widget (vanilla JS, no deps)
 * ---------------------------------------------------------------
 * Renders 4 preset buttons (Last 7 / 30 / 90 days, All time) plus a custom
 * from-to date picker (native <input type="date">), and emits a change
 * event/callback whenever the effective range changes.
 *
 * Pair with daterange.css (must be loaded on the page).
 *
 * DATE FORMAT: all dates in and out are ISO calendar-date strings
 * "YYYY-MM-DD" (no time/timezone component) — the same convention app.js
 * already uses throughout (parseAdDate/parseCRMDate/addDays/etc.), so values
 * from this widget compare/sort directly against Antonio's existing date
 * strings with no conversion.
 *
 * USAGE
 * -----
 *   const dateRange = initDateRange({
 *     container: '#dateRangeRoot',   // CSS selector or Element. Required.
 *     min: DERIVED.minDate,          // optional 'YYYY-MM-DD'. Clamps the custom date inputs
 *                                    // and becomes the `from` for the "All time" preset.
 *     max: DERIVED.maxDate,          // optional 'YYYY-MM-DD'. THIS IS THE REFERENCE DATE for
 *                                    // "Last N days" (i.e. last N days of DATA, ending on `max` —
 *                                    // matching how app.js's own period selector already computes
 *                                    // getRange()). If omitted, the browser's current date is used
 *                                    // as the reference instead, and "All time" degrades to
 *                                    // { from: null, to: null } meaning "no bound, don't filter".
 *     defaultPreset: 'last30',       // optional: 'last7' | 'last30' | 'last90' | 'all'. Default 'last30'.
 *     onChange: (range) => {}        // optional callback. Called once on init with the initial
 *                                    // range, then again on every change.
 *   });
 *
 * `range` SHAPE (passed to onChange and to the DOM event's detail):
 *   {
 *     preset: 'last7' | 'last30' | 'last90' | 'all' | 'custom',
 *     from:   'YYYY-MM-DD' | null,   // null only for 'all' when no `min`/`max` were configured
 *     to:     'YYYY-MM-DD' | null
 *   }
 *
 * EVENT
 *   Also dispatches a 'daterange:change' CustomEvent on the container element
 *   (bubbles) on every change, `event.detail` = the same range object above.
 *   NOT dispatched on init (use the onChange init call, or dateRange.getValue(),
 *   to read the starting value) — this matches how DOM change events normally behave.
 *
 * RETURNS a controller:
 *   dateRange.getValue()            -> current range object (shape above)
 *   dateRange.setValue({from, to})  -> programmatically apply a custom range (fires change)
 *   dateRange.setPreset(preset)     -> programmatically select a preset (fires change)
 *   dateRange.destroy()             -> removes DOM/listeners
 *
 * ACCESSIBILITY
 *   Presets are a `role="radiogroup"` of `role="radio"` buttons (mutually
 *   exclusive selection), roving tabindex, Left/Right/Home/End to move and
 *   select. Custom inputs are native <input type="date"> with <label for=...>
 *   associations — reliable keyboard/screen-reader support without a custom
 *   calendar widget.
 */
(function () {
  'use strict';

  var PRESETS = [
    { id: 'last7', label: 'Últimos 7 dias', days: 7 },
    { id: 'last30', label: 'Últimos 30 dias', days: 30 },
    { id: 'last90', label: 'Últimos 90 dias', days: 90 },
    { id: 'all', label: 'Todo o período', days: null }
  ];

  function resolveElement(target) {
    if (!target) return null;
    if (typeof target === 'string') return document.querySelector(target);
    if (target instanceof Element) return target;
    return null;
  }

  // 'YYYY-MM-DD' -> Date at UTC midnight (avoids local-timezone off-by-one).
  function isoToUTCDate(iso) {
    return new Date(iso + 'T00:00:00Z');
  }
  function dateToISO(d) {
    return d.toISOString().slice(0, 10);
  }
  function addDaysISO(iso, n) {
    var d = isoToUTCDate(iso);
    d.setUTCDate(d.getUTCDate() + n);
    return dateToISO(d);
  }
  function todayISO() {
    return dateToISO(new Date());
  }
  function isValidISO(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(isoToUTCDate(s).getTime());
  }
  function formatDisplay(iso, locale) {
    return isoToUTCDate(iso).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function initDateRange(config) {
    config = config || {};
    var root = resolveElement(config.container);
    if (!root) {
      throw new Error('initDateRange: `container` did not resolve to an Element (check the selector).');
    }
    var min = isValidISO(config.min) ? config.min : null;
    var max = isValidISO(config.max) ? config.max : null;
    var referenceDate = max || todayISO(); // "last N days" counts back from this date
    var defaultPreset = config.defaultPreset || 'last30';
    if (!PRESETS.some(function (p) { return p.id === defaultPreset; })) defaultPreset = 'last30';
    var onChange = typeof config.onChange === 'function' ? config.onChange : null;
    var locale = document.documentElement.lang || 'en-US';

    // ---- build DOM ----
    root.innerHTML = '';
    root.classList.add('daterange');

    var presetGroup = document.createElement('div');
    presetGroup.className = 'daterange-presets';
    presetGroup.setAttribute('role', 'radiogroup');
    presetGroup.setAttribute('aria-label', 'Período pré-definido');
    root.appendChild(presetGroup);

    var presetButtons = {};
    PRESETS.forEach(function (p) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'daterange-preset';
      btn.setAttribute('role', 'radio');
      btn.textContent = p.label;
      presetGroup.appendChild(btn);
      presetButtons[p.id] = btn;
    });

    var customWrap = document.createElement('div');
    customWrap.className = 'daterange-custom';
    root.appendChild(customWrap);

    // Declared/assigned before first use below (a bare `function uid(){}` is
    // hoisted, but the `var uidCounter = 0` assignment is not — calling uid()
    // before this line would increment `undefined`, producing "drNaN-...").
    var uidCounter = 0;
    function uid() { return 'dr' + (++uidCounter) + '-' + Math.random().toString(36).slice(2, 7); }

    var fromLabel = document.createElement('label');
    fromLabel.className = 'daterange-label';
    fromLabel.setAttribute('for', 'daterange-from-' + uid());
    fromLabel.textContent = 'De';
    var fromInput = document.createElement('input');
    fromInput.type = 'date';
    fromInput.id = fromLabel.getAttribute('for');
    fromInput.className = 'daterange-input';
    if (min) fromInput.min = min;
    if (max) fromInput.max = max;

    var toLabel = document.createElement('label');
    toLabel.className = 'daterange-label';
    toLabel.setAttribute('for', 'daterange-to-' + uid());
    toLabel.textContent = 'Até';
    var toInput = document.createElement('input');
    toInput.type = 'date';
    toInput.id = toLabel.getAttribute('for');
    toInput.className = 'daterange-input';
    if (min) toInput.min = min;
    if (max) toInput.max = max;

    customWrap.appendChild(fromLabel);
    customWrap.appendChild(fromInput);
    customWrap.appendChild(toLabel);
    customWrap.appendChild(toInput);

    var errorEl = document.createElement('div');
    errorEl.className = 'daterange-error';
    errorEl.setAttribute('role', 'alert');
    errorEl.hidden = true;
    root.appendChild(errorEl);

    var summaryEl = document.createElement('div');
    summaryEl.className = 'daterange-summary';
    summaryEl.setAttribute('aria-live', 'polite');
    root.appendChild(summaryEl);

    // ---- state ----
    var current = null; // { preset, from, to }

    function computePreset(presetId) {
      if (presetId === 'all') {
        return { preset: 'all', from: min, to: max }; // null,null if min/max weren't configured
      }
      var def = PRESETS.filter(function (p) { return p.id === presetId; })[0];
      var to = max || referenceDate;
      var from = addDaysISO(to, -(def.days - 1));
      if (min && from < min) from = min;
      return { preset: presetId, from: from, to: to };
    }

    function renderPresetSelection(activePreset) {
      PRESETS.forEach(function (p) {
        var isActive = p.id === activePreset;
        var btn = presetButtons[p.id];
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
        btn.tabIndex = isActive ? 0 : -1;
      });
    }

    function renderSummary(range) {
      if (range.from && range.to) {
        summaryEl.textContent = 'Exibindo ' + formatDisplay(range.from, locale) + ' – ' + formatDisplay(range.to, locale);
      } else {
        summaryEl.textContent = 'Exibindo todos os dados disponíveis';
      }
    }

    function clearError() {
      errorEl.hidden = true;
      errorEl.textContent = '';
      fromInput.setAttribute('aria-invalid', 'false');
      toInput.setAttribute('aria-invalid', 'false');
    }
    function showError(msg) {
      errorEl.hidden = false;
      errorEl.textContent = msg;
      fromInput.setAttribute('aria-invalid', 'true');
      toInput.setAttribute('aria-invalid', 'true');
    }

    function applyRange(range, opts) {
      opts = opts || {};
      current = range;
      renderPresetSelection(range.preset);
      renderSummary(range);
      if (range.preset === 'custom') {
        fromInput.value = range.from || '';
        toInput.value = range.to || '';
      }
      if (!opts.silent) {
        root.dispatchEvent(new CustomEvent('daterange:change', { bubbles: true, detail: range }));
        if (onChange) onChange(range);
      }
    }

    // ---- preset interactions ----
    PRESETS.forEach(function (p) {
      presetButtons[p.id].addEventListener('click', function () {
        clearError();
        applyRange(computePreset(p.id));
      });
    });
    presetGroup.addEventListener('keydown', function (e) {
      var ids = PRESETS.map(function (p) { return p.id; });
      var currentIndex = ids.indexOf(current.preset === 'custom' ? ids[0] : current.preset);
      var nextIndex = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIndex = (currentIndex + 1) % ids.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIndex = (currentIndex - 1 + ids.length) % ids.length;
      else if (e.key === 'Home') nextIndex = 0;
      else if (e.key === 'End') nextIndex = ids.length - 1;
      else return;
      e.preventDefault();
      clearError();
      var range = computePreset(ids[nextIndex]);
      applyRange(range);
      presetButtons[range.preset].focus();
    });

    // ---- custom range interactions ----
    // Fires on 'change' (commits on blur/Enter), not on every keystroke, so a
    // half-typed date never emits a bogus range.
    function handleCustomInput() {
      var from = fromInput.value;
      var to = toInput.value;
      if (!from || !to) return; // wait until both are filled
      if (!isValidISO(from) || !isValidISO(to)) return;
      if (from > to) {
        showError('A data "De" deve ser igual ou anterior à data "Até".');
        return;
      }
      clearError();
      applyRange({ preset: 'custom', from: from, to: to });
    }
    fromInput.addEventListener('change', handleCustomInput);
    toInput.addEventListener('change', handleCustomInput);

    // ---- init ----
    applyRange(computePreset(defaultPreset), { silent: true });
    if (onChange) onChange(current); // fire once with the starting value, per documented contract

    return {
      getValue: function () { return current; },
      setValue: function (range) {
        if (!range || !isValidISO(range.from) || !isValidISO(range.to) || range.from > range.to) {
          throw new Error('daterange.setValue: expected { from: "YYYY-MM-DD", to: "YYYY-MM-DD" } with from <= to.');
        }
        clearError();
        applyRange({ preset: 'custom', from: range.from, to: range.to });
      },
      setPreset: function (presetId) {
        if (!PRESETS.some(function (p) { return p.id === presetId; })) {
          throw new Error('daterange.setPreset: unknown preset "' + presetId + '".');
        }
        clearError();
        applyRange(computePreset(presetId));
      },
      destroy: function () {
        root.innerHTML = '';
        root.classList.remove('daterange');
      }
    };
  }

  // Exposed as a plain global, matching shell.js's style.
  window.initDateRange = initDateRange;
})();
