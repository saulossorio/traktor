/* Traffic Performance Dashboard: GoTraktor
 * Pulls live data client-side from the shared Google Sheet (CSV export per tab, by gid).
 * No backend, no build step, no stored/cached copy of the data.
 */

const SHEET_ID = '1U-hQ4LSeWmIbuXPxByUfi8IIBvrfjK4e';
const GIDS = {
  metaGeral: '72624759',   // base_meta-ads-geral
  metaRegiao: '1816778837', // base_meta-ads-regiao
  crm: '698346319',        // base_crm
  gads: '2044844396'       // base_gads
};
function csvUrl(gid) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
}

// Channel colors, deliberately from GoTraktor's brand palette, chosen to be
// unambiguous at a glance (previous blue/blue pairing read as "same color"
// per client feedback). Purple vs. orange: opposite-ish hues (~131° apart on
// the wheel, vs. ~100° for the purple/teal alternative) plus a clear
// warm/cool split, so they stay distinct even for common red-green color
// vision deficiency. Applied everywhere a channel is color-coded: charts,
// dots, toggle buttons, table rows. Nothing left on Chart.js's default blue.
const COLOR = {
  google: '#EA4335',                      // Google brand red
  googleSoft: 'rgba(234,67,53,0.30)',
  meta: '#0866FF',                        // Meta brand blue
  metaSoft: 'rgba(8,102,255,0.28)',
  googleDark: '#B0281B',                  // darker red, for line series / CRM-lead bars
  metaDark: '#0448B3'                     // darker blue, same role
};

// ---------- formatting helpers ----------
const fmtBRL = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n || 0);
const fmtInt = n => new Intl.NumberFormat('pt-BR').format(Math.round(n || 0));
const fmtPct = (n, d = 2) => (isFinite(n) ? (n * 100).toFixed(d) : '0.00') + '%';
const fmtDateShort = iso => { const [y, m, d] = iso.split('-'); return `${d}/${m}`; };

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- date parsers ----------
// Ad-platform sheets: "YYYY-MM-DD HH:MM:SS" -> take first 10 chars
function parseAdDate(s) {
  return s.trim().slice(0, 10);
}
// CRM sheet mixes two formats in the same column:
//   "YYYY-MM-DD HH:MM:SS" (first ~2 months of rows) and "DD/MM/YYYY" (last month of rows)
// Confirmed unambiguous: DD/MM/YYYY rows contain day values > 12 (e.g. 29/06/2026), ruling out MM/DD.
function parseCRMDate(s) {
  s = s.trim();
  if (s.includes('/')) {
    const [d, m, y] = s.split('/');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return s.slice(0, 10);
}

function normalizeGoogleRegion(name) {
  return name.startsWith('State of ') ? name.slice(9) : name;
}

// ---------- fetch + parse ----------
async function fetchCSV(gid, label) {
  const res = await fetch(csvUrl(gid), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} fetching sheet tab`);
  const text = await res.text();
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (parsed.errors && parsed.errors.length) {
    console.warn(`${label}: CSV parse warnings`, parsed.errors);
  }
  if (!parsed.data.length) throw new Error(`${label}: sheet returned no rows`);
  return parsed.data;
}

let RAW = null;         // normalized raw rows
let DERIVED = null;     // pre-aggregated per-date structures
let CHARTS = {};        // live Chart.js instances, keyed by canvas id
let SHELL = null;       // shell controller (Devi's component)
let DATE_RANGE = null;  // date-range controller (Devi's component)
let currentRange = null; // { start, end } ISO strings, set by the date-range widget's onChange

// Channel filter state, driven by the two independent toggle buttons
// (#channelToggleGroup .channel-toggle[data-channel]). Both start active.
// Invariant enforced in wireControls(): at least one must always stay on.
// A click that would turn off the last active channel is a no-op.
let activeChannels = { google: true, meta: true };

// App shell is initialized immediately (independent of data): it just needs
// the mount-point DOM nodes to exist, which they do from page load. Views
// stay switchable even while the live fetch is in flight.
function initAppShell() {
  const shellRoot = document.querySelector('#shellRoot');
  // `.global-filters` (Período/Canal) is a static HTML sibling BEFORE
  // #shellRoot (see index.html) so it exists at page load, before any JS
  // runs. initShell() below replaces #shellRoot's contents wholesale
  // (`root.innerHTML = ''`) and builds `.app-shell-tabbar` +
  // `.app-shell-panels` from scratch, so there is no static position in the
  // HTML that lands the filters between them — the tab bar doesn't exist
  // until this call returns. Grab a reference now, before it's detached from
  // the DOM, then relocate it right after initShell() renders the tab bar.
  const globalFilters = document.querySelector('.global-filters');

  SHELL = initShell({
    container: '#shellRoot',
    // no `title` passed on purpose: the existing topbar already carries the
    // dashboard title + live-status indicator; a second shell header would
    // just duplicate it.
    // Split into more, smaller views (was 4 tabs, each stacking several
    // panels) specifically so every single view's content fits the viewport
    // with no internal scrolling. See the scroll-height measurements in the
    // handoff notes. shell.js supports an arbitrary number of views for
    // exactly this reason.
    views: [
      { id: 'overview', label: 'Visão Geral', default: true },
      { id: 'channels', label: 'Canais' },
      { id: 'funnel', label: 'Funil' },
      { id: 'campaigns', label: 'Campanhas' },
      { id: 'regional', label: 'Regional' },
      { id: 'methodology', label: 'Sobre' }
    ],
    mountPoints: {
      overview: '#overviewSection',
      channels: '#channelsSection',
      funnel: '#funnelSection',
      campaigns: '#campaignsSection',
      regional: '#regionalSection',
      methodology: '#methodologySection'
    },
    // The Funil tab's bars are measured (offsetWidth) to decide whether the
    // value fits inside the fill or needs the outside fallback — see
    // layoutFunnelValues() in app.js. That measurement is meaningless while
    // the panel is hidden (shell.js keeps inactive views out of layout via
    // the `hidden` attribute, so every fill reads 0px wide until its tab is
    // actually shown). Re-run it right when the Funil tab becomes active so
    // the very first time a user looks at it, the numbers are already
    // correctly placed.
    onChange: (viewId) => { if (viewId === 'funnel') layoutFunnelValues(); }
  });

  // Relocate the filters band from "before the shell" to "inside the shell,
  // between the tab row and the panel content" — topbar -> tabs -> filters
  // -> content (spec change, was topbar -> filters -> tabs -> content).
  // initShell() (above) has already rendered `.app-shell-tabbar` as the
  // first child of `#shellRoot` and `.app-shell-panels` as the second by
  // this point (it builds + calls setActive() synchronously before
  // returning), so the tabbar is a reliable anchor. insertAdjacentElement
  // moves the existing node (preserving its listeners: the date-range
  // popover toggle and the two channel-toggle buttons are wired later, in
  // wireControls()/initDateRangeWidget(), both called from loadAll() after
  // this function has already run, so no listener is attached-then-lost by
  // the move either way).
  if (globalFilters && shellRoot) {
    const tabbar = shellRoot.querySelector('.app-shell-tabbar');
    if (tabbar) tabbar.insertAdjacentElement('afterend', globalFilters);
  }
}

async function loadAll() {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  try {
    const [metaGeral, metaRegiao, crm, gads] = await Promise.all([
      fetchCSV(GIDS.metaGeral, 'base_meta-ads-geral'),
      fetchCSV(GIDS.metaRegiao, 'base_meta-ads-regiao'),
      fetchCSV(GIDS.crm, 'base_crm'),
      fetchCSV(GIDS.gads, 'base_gads')
    ]);

    RAW = normalize({ metaGeral, metaRegiao, crm, gads });
    DERIVED = buildDerived(RAW);

    statusDot.classList.add('ok');
    statusText.textContent = `Ao vivo · BI_Base_teste.xlsx · ${new Date().toLocaleTimeString('pt-BR')}`;

    wireControls();
    initDateRangeWidget(); // fires onChange once immediately -> sets currentRange and triggers the first renderAll()
  } catch (err) {
    statusDot.classList.add('err');
    statusText.textContent = 'Falha ao carregar dados ao vivo';
    const banner = document.getElementById('errorBanner');
    banner.classList.remove('hidden');
    banner.textContent = `Não foi possível carregar os dados ao vivo da Google Sheet: ${err.message}. Verifique se a planilha ainda está compartilhada como "Qualquer pessoa com o link pode visualizar" e recarregue a página.`;
    console.error(err);
  }
}

function normalize({ metaGeral, metaRegiao, crm, gads }) {
  const metaGeralN = metaGeral.map(r => ({
    date: parseAdDate(r['Date']),
    spend: parseFloat(r['Total Cost']) || 0,
    clicks: parseFloat(r['Clicks']) || 0,
    impressions: parseFloat(r['Impressions']) || 0,
    conversations: parseFloat(r['Messaging conversations started']) || 0
  }));

  const metaRegiaoN = metaRegiao.map(r => ({
    date: parseAdDate(r['Date']),
    region: r['Region'],
    spend: parseFloat(r['Total Cost']) || 0,
    clicks: parseFloat(r['Clicks']) || 0,
    impressions: parseFloat(r['Impressions']) || 0,
    conversations: parseFloat(r['Messaging conversations started']) || 0
  }));

  const gadsN = gads.map(r => ({
    date: parseAdDate(r['Date']),
    region: normalizeGoogleRegion(r['Region']),
    spend: parseFloat(r['Cost']) || 0,
    impressions: parseFloat(r['Impressions']) || 0,
    clicks: parseFloat(r['Clicks']) || 0,
    conversions: parseFloat(r['Conversions']) || 0
  }));

  const crmN = crm.map(r => ({
    date: parseCRMDate(r['Data']),
    canal: r['Canal'],
    campanha: (r['Campanha'] || '').trim()
  }));

  return { metaGeral: metaGeralN, metaRegiao: metaRegiaoN, gads: gadsN, crm: crmN };
}

function buildDerived(raw) {
  // Google: sum region rows to a daily series
  const googleDaily = {};
  raw.gads.forEach(r => {
    const d = googleDaily[r.date] || (googleDaily[r.date] = { spend: 0, clicks: 0, impressions: 0, conversions: 0 });
    d.spend += r.spend; d.clicks += r.clicks; d.impressions += r.impressions; d.conversions += r.conversions;
  });

  // Meta: already daily totals
  const metaDaily = {};
  raw.metaGeral.forEach(r => {
    metaDaily[r.date] = { spend: r.spend, clicks: r.clicks, impressions: r.impressions, conversations: r.conversations };
  });

  // CRM leads per date per channel, and per date+campaign (Google only)
  const leadsDaily = {}; // date -> {google, meta}
  const campaignDaily = {}; // date -> {campaignName: count}  (Google only)
  raw.crm.forEach(r => {
    const l = leadsDaily[r.date] || (leadsDaily[r.date] = { google: 0, meta: 0 });
    if (r.canal === 'Google') {
      l.google += 1;
      const camp = r.campanha || '(sem campanha marcada)';
      const c = campaignDaily[r.date] || (campaignDaily[r.date] = {});
      c[camp] = (c[camp] || 0) + 1;
    } else if (r.canal === 'Meta') {
      l.meta += 1;
    }
  });

  // Region rollups (raw, filtered later by date range)
  const googleRegionRows = raw.gads;
  const metaRegionRows = raw.metaRegiao;

  // master date range = union of everything
  const allDates = [
    ...Object.keys(googleDaily), ...Object.keys(metaDaily), ...Object.keys(leadsDaily)
  ];
  const minDate = allDates.reduce((a, b) => (b < a ? b : a));
  const maxDate = allDates.reduce((a, b) => (b > a ? b : a));

  return { googleDaily, metaDaily, leadsDaily, campaignDaily, googleRegionRows, metaRegionRows, minDate, maxDate };
}

// ---------- filtering / aggregation for a given period ----------
function datesInRange(start, end) {
  const out = [];
  let d = start;
  while (d <= end) { out.push(d); d = addDays(d, 1); }
  return out;
}

function computeAggregates(start, end) {
  const dates = datesInRange(start, end);
  const g = DERIVED.googleDaily, m = DERIVED.metaDaily, l = DERIVED.leadsDaily;

  let gSpend = 0, gClicks = 0, gImpr = 0, gConv = 0, gLeads = 0;
  let mSpend = 0, mClicks = 0, mImpr = 0, mConv = 0, mLeads = 0;
  const series = [];

  dates.forEach(date => {
    const gd = g[date] || { spend: 0, clicks: 0, impressions: 0, conversions: 0 };
    const md = m[date] || { spend: 0, clicks: 0, impressions: 0, conversations: 0 };
    const ld = l[date] || { google: 0, meta: 0 };
    gSpend += gd.spend; gClicks += gd.clicks; gImpr += gd.impressions; gConv += gd.conversions; gLeads += ld.google;
    mSpend += md.spend; mClicks += md.clicks; mImpr += md.impressions; mConv += md.conversations; mLeads += ld.meta;
    series.push({
      date,
      googleSpend: gd.spend, googleLeads: ld.google, googleClicks: gd.clicks,
      metaSpend: md.spend, metaLeads: ld.meta, metaClicks: md.clicks
    });
  });

  return {
    start, end, dates, series,
    google: { spend: gSpend, clicks: gClicks, impressions: gImpr, engagements: gConv, leads: gLeads },
    meta: { spend: mSpend, clicks: mClicks, impressions: mImpr, engagements: mConv, leads: mLeads }
  };
}

// ---------- rendering ----------
// Collapses the two independent toggle booleans back into the single
// 'all' | 'google' | 'meta' string every downstream render* function already
// consumes (unchanged from the old <select>'s value contract). This is the
// "exact same filtering logic" every panel already respects, just fed from a
// different control.
function currentFilters() {
  let channel;
  if (activeChannels.google && activeChannels.meta) channel = 'all';
  else if (activeChannels.google) channel = 'google';
  else channel = 'meta';
  return { channel };
}

function updateChannelToggleUI() {
  document.querySelectorAll('.channel-toggle').forEach(btn => {
    const isActive = activeChannels[btn.dataset.channel];
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

// Date range now comes from Devi's daterange widget (see initDateRangeWidget).
// The channel filter is two independently-toggleable buttons (replaced the
// old <select>: Saul's complaint was that hiding the choice inside a
// dropdown with a combined "Google + Meta" option was bad UX). Both start
// active; clicking one flips only that channel. At least one channel must
// always stay active. A click that would turn off the last remaining one is
// blocked (no-op) rather than silently reactivating the other, since a
// blocked click is the clearer signal to the user of the two options.
// Scroll affordance for wide tables (see .table-wrap in style.css). Toggles
// is-scrollable-left / is-scrollable-right classes per wrap based on actual
// scroll position, so the edge-fade mask only appears on the side(s) that
// genuinely have more content — a table narrower than its container gets no
// fade at all. Applied to every `.table-wrap`, not just #channelTable, since
// they're the same component and can hit the same overflow. Uses
// ResizeObserver (not a call from renderAll)
// so it self-corrects if a table's rendered width changes after re-render
// (e.g. currency values changing column width) without needing every
// render* function to remember to call it.
function initTableScrollAffordances() {
  document.querySelectorAll('.table-wrap').forEach(wrap => {
    const update = () => {
      const scrollable = wrap.scrollWidth > wrap.clientWidth + 1; // +1: rounding slack
      wrap.classList.toggle('is-scrollable-left', scrollable && wrap.scrollLeft > 1);
      wrap.classList.toggle('is-scrollable-right', scrollable && wrap.scrollLeft < wrap.scrollWidth - wrap.clientWidth - 1);
    };
    wrap.addEventListener('scroll', update, { passive: true });
    new ResizeObserver(update).observe(wrap);
    update();
  });
}

function wireControls() {
  document.querySelectorAll('.channel-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const ch = btn.dataset.channel;
      const other = ch === 'google' ? 'meta' : 'google';
      if (activeChannels[ch] && !activeChannels[other]) return; // would leave zero channels active: blocked
      activeChannels[ch] = !activeChannels[ch];
      updateChannelToggleUI();
      renderAll();
    });
  });
}

// DERIVED.minDate/maxDate must already exist (called from loadAll after
// buildDerived()). The widget needs them both: `min` clamps the custom
// range inputs and backs "All time"; `max` is the reference date "Last N
// days" counts back from (this dataset's actual last day, not the browser's
// real today, since this is a fixed historical export).
function initDateRangeWidget() {
  DATE_RANGE = initDateRange({
    container: '#dateRangeRoot',
    min: DERIVED.minDate,
    max: DERIVED.maxDate,
    defaultPreset: 'last30',
    onChange: (range) => {
      currentRange = { start: range.from, end: range.to };
      updateDateRangeCompactLabel(range);
      closeDateRangePopover();
      renderAll();
    }
  });
  wireDateRangePopover();
}

// ---------- date-range compact dropdown wrapper ----------
// Devi's daterange.js/daterange.css are left untouched. This only wraps the
// widget's mount point (#dateRangeRoot) in a collapsible popover and drives
// the closed-state label off the widget's own onChange payload / getValue().
// Own compact date format (not daterange.js's locale-verbose
// toLocaleDateString, which produced the leftover "31 de mai. de 2026"
// wording): short, unambiguous, locale-independent.
const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
function fmtDateCompact(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${parseInt(d, 10)} ${MONTHS_SHORT[parseInt(m, 10) - 1]} ${y}`;
}
function updateDateRangeCompactLabel(range) {
  const label = document.getElementById('dateRangeCompactLabel');
  if (!label) return;
  label.textContent = (range.from && range.to)
    ? `${fmtDateCompact(range.from)} – ${fmtDateCompact(range.to)}`
    : 'Todo o período';
}
function openDateRangePopover() {
  const compact = document.getElementById('dateRangeCompact');
  const popover = document.getElementById('dateRangePopover');
  const toggle = document.getElementById('dateRangeToggle');
  if (!compact || !popover || !toggle) return;
  compact.classList.add('open');
  popover.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
}
function closeDateRangePopover() {
  const compact = document.getElementById('dateRangeCompact');
  const popover = document.getElementById('dateRangePopover');
  const toggle = document.getElementById('dateRangeToggle');
  if (!compact || !popover || !toggle) return;
  compact.classList.remove('open');
  popover.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
}
function wireDateRangePopover() {
  const compact = document.getElementById('dateRangeCompact');
  const toggle = document.getElementById('dateRangeToggle');
  if (!compact || !toggle) return;
  toggle.addEventListener('click', () => {
    if (compact.classList.contains('open')) closeDateRangePopover();
    else openDateRangePopover();
  });
  // click outside closes
  document.addEventListener('click', (e) => {
    if (compact.classList.contains('open') && !compact.contains(e.target)) closeDateRangePopover();
  });
  // Escape closes and returns focus to the toggle
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && compact.classList.contains('open')) {
      closeDateRangePopover();
      toggle.focus();
    }
  });
}

function renderAll() {
  if (!currentRange) return; // guard: daterange widget always fires onChange once on init before this can matter
  const { channel } = currentFilters();
  const { start, end } = currentRange;
  const agg = computeAggregates(start, end);

  renderKPIs(agg, channel);
  renderChannelTable(agg, channel);
  renderTrendChart(agg, channel);
  renderFunnel(agg, channel);
  renderCampaignChart(start, end, channel);
  renderRegionCharts(start, end, channel);
}


// Helper function to create a tooltip-enabled KPI card
function makeKPICard(label, value, sub, category) {
  const tooltips = {
    'Investimento total': 'Soma do investimento em anúncios.',
    'Leads no CRM': 'Leads captados no CRM.',
    'Custo por lead': 'Custo por lead: investimento ÷ leads no CRM.',
    'Cliques': 'Cliques reportados pela plataforma. Inclui cliques fraudulentos.',
    'CTR': 'Taxa de cliques: cliques ÷ impressões.',
    'CPC': 'Custo por clique: investimento ÷ cliques.'
  };
  const tooltip = tooltips[label] || '';
  const tooltipHtml = tooltip ? `<div class="tooltip-container" style="position: absolute; right: 14px; top: 14px;"><span class="tooltip-icon">ⓘ</span><div class="tooltip-text">${tooltip}</div></div>` : '';

  return `<div class="kpi-card cat-${category}" style="position: relative;">
    <div class="kpi-label"><span class="kpi-label-text">${label}</span>${tooltipHtml}</div>
    <div class="kpi-value">${value}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
  </div>`;
}

function renderKPIs(agg, channel) {
  let spend, leads, clicks, impressions;
  if (channel === 'google') {
    ({ spend, leads, clicks, impressions } = agg.google);
  } else if (channel === 'meta') {
    ({ spend, leads, clicks, impressions } = agg.meta);
  } else {
    spend = agg.google.spend + agg.meta.spend;
    leads = agg.google.leads + agg.meta.leads;
    clicks = agg.google.clicks + agg.meta.clicks;
    impressions = agg.google.impressions + agg.meta.impressions;
  }
  const cpl = leads > 0 ? spend / leads : null;
  const ctr = impressions > 0 ? clicks / impressions : 0;
  const cpc = clicks > 0 ? spend / clicks : 0;

  const cards = [
    { label: 'Investimento total', value: fmtBRL(spend), sub: channel === 'all' ? `Google ${fmtBRL(agg.google.spend)} · Meta ${fmtBRL(agg.meta.spend)}` : '', cat: 'spend' },
    { label: 'Leads no CRM', value: fmtInt(leads), sub: channel === 'all' ? `Google ${fmtInt(agg.google.leads)} · Meta ${fmtInt(agg.meta.leads)}` : '', cat: 'leads' },
    { label: 'Custo por lead', value: cpl !== null ? fmtBRL(cpl) : '-', sub: cpl === null ? 'Nenhum lead no período' : '', cat: 'efficiency' },
    { label: 'Cliques', value: fmtInt(clicks), sub: '', cat: 'leads' },
    { label: 'CTR', value: fmtPct(ctr), sub: 'cliques / impressões', cat: 'efficiency' },
    { label: 'CPC', value: fmtBRL(cpc), sub: 'custo médio por clique', cat: 'efficiency' }
  ];
  const grid = document.getElementById('kpiGrid');
  grid.innerHTML = cards.map(c => makeKPICard(c.label, c.value, c.sub, c.cat)).join('');
}


function renderChannelTable(agg, channel) {
  const total = agg.google.spend + agg.meta.spend;
  const rows = [
    { name: 'Google Ads', dot: 'google', d: agg.google },
    { name: 'Meta Ads', dot: 'meta', d: agg.meta }
  ].filter(r => channel === 'all' || r.dot === channel);
  const body = rows.map(r => {
    const ctr = r.d.impressions > 0 ? r.d.clicks / r.d.impressions : 0;
    const cpc = r.d.clicks > 0 ? r.d.spend / r.d.clicks : 0;
    const cpl = r.d.leads > 0 ? r.d.spend / r.d.leads : null;
    const leadRate = r.d.clicks > 0 ? r.d.leads / r.d.clicks : 0;
    const share = total > 0 ? r.d.spend / total : 0;
    return `<tr>
      <td><span class="channel-tag"><span class="channel-dot ${r.dot}"></span>${r.name}</span></td>
      <td>${fmtBRL(r.d.spend)}</td>
      <td>${fmtPct(share, 1)}</td>
      <td>${fmtInt(r.d.clicks)}</td>
      <td>${fmtInt(r.d.impressions)}</td>
      <td>${fmtPct(ctr)}</td>
      <td>${fmtBRL(cpc)}</td>
      <td>${fmtInt(r.d.engagements)}</td>
      <td>${fmtInt(r.d.leads)}</td>
      <td>${cpl !== null ? fmtBRL(cpl) : '-'}</td>
      <td>${fmtPct(leadRate)}</td>
    </tr>`;
  }).join('');
  document.querySelector('#channelTable tbody').innerHTML = body;
}

function destroyChart(id) {
  if (CHARTS[id]) { CHARTS[id].destroy(); delete CHARTS[id]; }
}

function renderTrendChart(agg, channel) {
  const labels = agg.series.map(r => fmtDateShort(r.date));
  const datasets = [];
  if (channel !== 'meta') {
    datasets.push({ type: 'bar', label: 'Investimento Google', data: agg.series.map(r => r.googleSpend), backgroundColor: COLOR.googleSoft, yAxisID: 'y', order: 2 });
    datasets.push({ type: 'line', label: 'Leads Google', data: agg.series.map(r => r.googleLeads), borderColor: COLOR.googleDark, backgroundColor: COLOR.googleDark, yAxisID: 'y1', tension: 0.25, pointRadius: 1.5, order: 1 });
  }
  if (channel !== 'google') {
    datasets.push({ type: 'bar', label: 'Investimento Meta', data: agg.series.map(r => r.metaSpend), backgroundColor: COLOR.metaSoft, yAxisID: 'y', order: 2 });
    datasets.push({ type: 'line', label: 'Leads Meta', data: agg.series.map(r => r.metaLeads), borderColor: COLOR.metaDark, backgroundColor: COLOR.metaDark, yAxisID: 'y1', tension: 0.25, pointRadius: 1.5, order: 1 });
  }
  destroyChart('trendChart');
  const ctx = document.getElementById('trendChart');
  CHARTS.trendChart = new Chart(ctx, {
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { position: 'left', title: { display: true, text: 'Investimento (R$)' }, grid: { color: '#eef1f5' } },
        y1: { position: 'right', title: { display: true, text: 'Leads' }, grid: { display: false }, beginAtZero: true }
      },
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

function renderFunnelColumn(title, dotClass, steps) {
  const top = steps[0].value || 1;
  let html = `<div class="funnel-col"><h3><span class="channel-dot ${dotClass}"></span>${title}</h3>`;
  steps.forEach((s, i) => {
    // visually scaled width (power scale) so every stage stays visible; labels show real numbers
    const widthPct = Math.max(4, Math.pow(s.value / top, 0.35) * 100);
    // Number lives inside the fill by default (white text). When the fill is too
    // narrow to hold it, layoutFunnelValues() below hides this and shows the
    // ".step-value-outside" copy instead, colored to match the bar, positioned
    // just past the fill's right edge. Both copies are rendered up front because
    // "does it fit" depends on the fill's actual rendered pixel width, which is
    // only knowable after layout — see layoutFunnelValues().
    html += `<div class="funnel-step">
      <div class="step-label">${s.label}</div>
      <div class="funnel-bar-track">
        <div class="funnel-bar-fill" style="width:${widthPct}%; background:${s.color}">
          <span class="step-value-inline">${fmtInt(s.value)}</span>
        </div>
        <span class="step-value-outside" style="color:${s.color}">${fmtInt(s.value)}</span>
      </div>
    </div>`;
    if (i > 0) {
      const prev = steps[i - 1].value;
      const pct = prev > 0 ? fmtPct(s.value / prev) : '-';
      html += `<div class="funnel-drop">${pct} da etapa anterior</div>`;
    }
  });
  html += `</div>`;
  return html;
}

// After the funnel bars are in the DOM, decide per-bar whether the in-fill white
// number fits. Measured against real rendered pixel widths (not guessed from the
// value's magnitude) because widthPct is a power-scaled percentage, so a bar's
// pixel width doesn't correlate cleanly with its digit count.
function layoutFunnelValues() {
  document.querySelectorAll('.funnel-bar-track').forEach(track => {
    const fill = track.querySelector('.funnel-bar-fill');
    const inline = track.querySelector('.step-value-inline');
    const outside = track.querySelector('.step-value-outside');
    if (!fill || !inline || !outside) return;
    const needed = inline.scrollWidth + 16; // number width + breathing room on both sides
    const fits = fill.offsetWidth >= needed;
    inline.style.display = fits ? '' : 'none';
    // NOTE: .step-value-outside defaults to display:none in the stylesheet, so
    // showing it needs an explicit non-none value here — style.display = ''
    // only clears the inline override and falls back to that CSS default
    // (i.e. stays hidden), it does not mean "show".
    outside.style.display = fits ? 'none' : 'inline-block';
    // .funnel-bar-track now centers .funnel-bar-fill (justify-content:center),
    // so the fill is no longer left-anchored at 0 — fill.offsetLeft must be
    // added in, or the fallback number lands short of the fill's real right
    // edge for every bar narrow enough to not span the full track width.
    if (!fits) outside.style.left = `${fill.offsetLeft + fill.offsetWidth + 6}px`;
  });
}

function renderFunnel(agg, channel) {
  const cols = [];
  if (channel !== 'meta') {
    cols.push(renderFunnelColumn('Google Ads', 'google', [
      { label: 'Impressões', value: agg.google.impressions, color: COLOR.google },
      { label: 'Cliques', value: agg.google.clicks, color: COLOR.google },
      { label: 'Conversões (plataforma)', value: agg.google.engagements, color: COLOR.google },
      { label: 'Leads no CRM', value: agg.google.leads, color: COLOR.googleDark }
    ]));
  }
  if (channel !== 'google') {
    cols.push(renderFunnelColumn('Meta Ads', 'meta', [
      { label: 'Impressões', value: agg.meta.impressions, color: COLOR.meta },
      { label: 'Cliques', value: agg.meta.clicks, color: COLOR.meta },
      { label: 'Conversas iniciadas', value: agg.meta.engagements, color: COLOR.meta },
      { label: 'Leads no CRM', value: agg.meta.leads, color: COLOR.metaDark }
    ]));
  }
  document.getElementById('funnelGrid').innerHTML = cols.join('');
  layoutFunnelValues();
}

function renderCampaignChart(start, end, channel) {
  const note = document.getElementById('campaignNote');
  const wrap = document.querySelector('#campaignChart').parentElement;
  if (channel === 'meta') {
    note.textContent = 'Ative o canal "GOOGLE" no filtro de Canal, acima, para ver este detalhamento.';
    destroyChart('campaignChart');
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  note.textContent = '';

  const totals = {};
  datesInRange(start, end).forEach(date => {
    const c = DERIVED.campaignDaily[date];
    if (!c) return;
    Object.entries(c).forEach(([camp, n]) => { totals[camp] = (totals[camp] || 0) + n; });
  });
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  destroyChart('campaignChart');
  const ctx = document.getElementById('campaignChart');
  CHARTS.campaignChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: entries.map(e => e[0]),
      datasets: [{ label: 'Leads no CRM', data: entries.map(e => e[1]), backgroundColor: COLOR.google, borderRadius: 4, maxBarThickness: 60 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, title: { display: true, text: 'Leads' } } }
    }
  });
}

function renderRegionCharts(start, end, channel) {
  const gWrap = document.getElementById('regionGoogleChart').closest('.chart-wrap');
  const mWrap = document.getElementById('regionMetaChart').closest('.chart-wrap');

  if (channel === 'meta') { gWrap.style.display = 'none'; destroyChart('regionGoogleChart'); } else { gWrap.style.display = ''; }
  if (channel === 'google') { mWrap.style.display = 'none'; destroyChart('regionMetaChart'); } else { mWrap.style.display = ''; }

  if (channel !== 'meta') {
    const totals = {};
    DERIVED.googleRegionRows.forEach(r => {
      if (r.date < start || r.date > end) return;
      totals[r.region] = (totals[r.region] || 0) + r.spend;
    });
    let entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, 10);
    const otherSum = entries.slice(10).reduce((a, e) => a + e[1], 0);
    if (otherSum > 0) top.push(['Outras regiões', otherSum]);
    destroyChart('regionGoogleChart');
    CHARTS.regionGoogleChart = new Chart(document.getElementById('regionGoogleChart'), {
      type: 'bar',
      data: { labels: top.map(e => e[0]), datasets: [{ label: 'Investimento', data: top.map(e => e[1]), backgroundColor: COLOR.google, borderRadius: 4 }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmtBRL(c.raw) } } },
        scales: { x: { ticks: { callback: v => fmtBRL(v) } } }
      }
    });
  }

  if (channel !== 'google') {
    const totals = {};
    DERIVED.metaRegionRows.forEach(r => {
      if (r.date < start || r.date > end) return;
      totals[r.region] = (totals[r.region] || 0) + r.spend;
    });
    const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    destroyChart('regionMetaChart');
    CHARTS.regionMetaChart = new Chart(document.getElementById('regionMetaChart'), {
      type: 'bar',
      data: { labels: entries.map(e => e[0]), datasets: [{ label: 'Investimento', data: entries.map(e => e[1]), backgroundColor: COLOR.meta, borderRadius: 4 }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmtBRL(c.raw) } } },
        scales: { x: { ticks: { callback: v => fmtBRL(v) } } }
      }
    });
  }
}

initAppShell();
initTableScrollAffordances();
loadAll();

// Funnel bar widths are relative to a fluid grid column, so a window resize can
// change whether a number fits inside its bar. Re-run the fit check (cheap: no
// re-render, just remeasures existing DOM) on resize, debounced.
let funnelResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(funnelResizeTimer);
  funnelResizeTimer = setTimeout(layoutFunnelValues, 150);
});
