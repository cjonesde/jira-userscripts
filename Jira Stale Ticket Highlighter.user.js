// ==UserScript==
// @name         Jira Stale Ticket Highlighter
// @namespace    https://github.com/cjonesde/jira-userscripts
// @version      2.0.1
// @description  Highlights stale and stuck tickets on Jira boards with visual indicators
// @author       Christopher Jones
// @match        https://*.atlassian.net/*
// @homepageURL  https://github.com/cjonesde/jira-userscripts
// @supportURL   https://github.com/cjonesde/jira-userscripts/issues
// @downloadURL  https://raw.githubusercontent.com/cjonesde/jira-userscripts/main/Jira%20Stale%20Ticket%20Highlighter.user.js
// @updateURL    https://raw.githubusercontent.com/cjonesde/jira-userscripts/main/Jira%20Stale%20Ticket%20Highlighter.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.registerMenuCommand
// ==/UserScript==

/**
 * Highlights stale and stuck tickets on Jira boards with visual badges.
 *   🕒 Stale          - no updates for STALE_THRESHOLD_DAYS.
 *   🛑 Stuck          - old ticket (PING_PONG_MIN_AGE_DAYS) that never started.
 *   ⚓ Stuck in Status - lingering in an active status for STUCK_IN_STATUS_DAYS.
 *
 * v2 architecture (see issue #1):
 *   - One batched /rest/api/3/issue/bulkfetch per render instead of N per-issue calls.
 *   - Status detection keys off status.statusCategory (new/indeterminate/done), so it
 *     works on renamed or localized workflows; the status-name lists are optional overrides.
 *   - Single <style> block + one placeBadge(host, mode) for every placement path.
 *   - TTL/LRU cache mirrored to sessionStorage, concurrency cap + 429 backoff, scoped
 *     rAF-batched MutationObserver, and badge/padding cleanup on navigation.
 *   - Thresholds are tunable via the userscript-manager menu (GM_getValue/GM_setValue),
 *     with a graceful fallback to defaults when those APIs are unavailable.
 */
(function () {
    'use strict';

    // ---------------------------------------------------------------------------
    // Config (defaults + persisted overrides)
    // ---------------------------------------------------------------------------
    const DEFAULTS = {
        STALE_THRESHOLD_DAYS: 30,
        PING_PONG_MIN_AGE_DAYS: 14,
        STUCK_IN_STATUS_DAYS: 14,
        // Optional name overrides. Detection prefers status.statusCategory; these only
        // matter for instances whose categories are mis-mapped, and for reading history
        // (changelog entries expose status NAMES, not categories).
        PROGRESS_STATUSES: ['In Progress', 'Tech Review', 'Merged', 'Testing', 'Ready for Release'],
        DONE_STATUSES: ['Done', 'Done (deployed to prod)', 'Closed'],
        DEBUG: false
    };

    // Storage/menu shim. Prefers the modern promise-based GM.* API (Greasemonkey 4+, also
    // exposed by Tampermonkey/Violentmonkey), falls back to the legacy synchronous GM_*, and
    // degrades to defaults when neither exists (@grant none / the offline test fixture).
    // `typeof GM` is safe even when GM was never declared, so this never throws.
    const hasModern = (name) => (typeof GM !== 'undefined') && GM && typeof GM[name] === 'function';
    const store = {
        async get(key, fallback) {
            try { if (hasModern('getValue')) { const v = await GM.getValue(key, fallback); return v === undefined ? fallback : v; } } catch (e) { /* ignore */ }
            try { if (typeof GM_getValue === 'function') return GM_getValue(key, fallback); } catch (e) { /* ignore */ }
            return fallback;
        },
        async set(key, value) {
            try { if (hasModern('setValue')) { await GM.setValue(key, value); return; } } catch (e) { /* ignore */ }
            try { if (typeof GM_setValue === 'function') GM_setValue(key, value); } catch (e) { /* ignore */ }
        },
        menu(label, fn) {
            try { if (hasModern('registerMenuCommand')) { GM.registerMenuCommand(label, fn); return; } } catch (e) { /* ignore */ }
            try { if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(label, fn); } catch (e) { /* ignore */ }
        }
    };

    const toNum = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
    const toList = (v) => {
        if (v == null) return null;
        if (Array.isArray(v)) return v;
        const a = String(v).split(',').map((s) => s.trim()).filter(Boolean);
        return a.length ? a : null;
    };

    // Async because the modern GM.getValue returns a promise. Resolves to DEFAULTS when no
    // storage API is available, so the script always has a usable CONFIG.
    async function loadConfig() {
        const c = Object.assign({}, DEFAULTS);
        c.STALE_THRESHOLD_DAYS = toNum(await store.get('STALE_THRESHOLD_DAYS', c.STALE_THRESHOLD_DAYS), c.STALE_THRESHOLD_DAYS);
        c.PING_PONG_MIN_AGE_DAYS = toNum(await store.get('PING_PONG_MIN_AGE_DAYS', c.PING_PONG_MIN_AGE_DAYS), c.PING_PONG_MIN_AGE_DAYS);
        c.STUCK_IN_STATUS_DAYS = toNum(await store.get('STUCK_IN_STATUS_DAYS', c.STUCK_IN_STATUS_DAYS), c.STUCK_IN_STATUS_DAYS);
        c.PROGRESS_STATUSES = toList(await store.get('PROGRESS_STATUSES', null)) || DEFAULTS.PROGRESS_STATUSES;
        c.DONE_STATUSES = toList(await store.get('DONE_STATUSES', null)) || DEFAULTS.DONE_STATUSES;
        c.DEBUG = !!(await store.get('DEBUG', c.DEBUG));
        return c;
    }

    let CONFIG = Object.assign({}, DEFAULTS); // sync defaults until loadConfig() resolves in init()

    const log = (...args) => { if (CONFIG.DEBUG) console.log('[Jira Stale Highlighter]', ...args); };
    console.log('[Jira Stale Highlighter] v2.0.1 loaded');

    const DAY_MS = 1000 * 60 * 60 * 24;

    // ---------------------------------------------------------------------------
    // Cache: TTL + LRU, mirrored to sessionStorage
    // ---------------------------------------------------------------------------
    const CACHE_TTL_MS = 10 * 60 * 1000;
    const CACHE_MAX = 500;
    const SS_KEY = 'jiraStaleHighlighter.cache.v2';
    const cache = new Map(); // key -> { data, ts }

    function ssLoad() {
        try {
            const raw = sessionStorage.getItem(SS_KEY);
            if (!raw) return;
            const obj = JSON.parse(raw);
            const now = Date.now();
            for (const k of Object.keys(obj)) {
                const e = obj[k];
                if (e && typeof e.ts === 'number' && (now - e.ts) < CACHE_TTL_MS) cache.set(k, e);
            }
        } catch (e) { /* corrupt / unavailable - ignore */ }
    }

    let ssTimer = null;
    function ssSave() {
        try {
            clearTimeout(ssTimer);
            ssTimer = setTimeout(() => {
                try {
                    const obj = {};
                    cache.forEach((e, k) => { obj[k] = e; });
                    sessionStorage.setItem(SS_KEY, JSON.stringify(obj));
                } catch (e) { /* quota / unavailable - ignore */ }
            }, 500);
        } catch (e) { /* ignore */ }
    }

    function cacheGet(key) {
        const e = cache.get(key);
        if (!e) return null;
        if ((Date.now() - e.ts) >= CACHE_TTL_MS) { cache.delete(key); return null; }
        cache.delete(key); cache.set(key, e); // LRU bump
        return e.data;
    }

    function cacheSet(key, data) {
        cache.set(key, { data, ts: Date.now() });
        while (cache.size > CACHE_MAX) {
            const oldest = cache.keys().next().value;
            cache.delete(oldest);
        }
        ssSave();
    }

    function cacheClear() {
        cache.clear();
        try { sessionStorage.removeItem(SS_KEY); } catch (e) { /* ignore */ }
    }

    // ---------------------------------------------------------------------------
    // Networking: retry/backoff + concurrency cap + batched bulkfetch
    // ---------------------------------------------------------------------------
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function fetchWithRetry(url, opts, tries = 3) {
        let delay = 500;
        for (let i = 0; i <= tries; i++) {
            let resp;
            try {
                resp = await fetch(url, opts);
            } catch (err) {
                if (i === tries) throw err;
                await sleep(delay); delay *= 2; continue;
            }
            if (resp.status === 429 || resp.status === 503) {
                if (i === tries) return resp;
                const ra = parseFloat(resp.headers.get('Retry-After'));
                await sleep(Number.isFinite(ra) ? ra * 1000 : delay);
                delay *= 2; continue;
            }
            return resp;
        }
    }

    // Minimal promise concurrency limiter.
    function makeLimiter(max) {
        let active = 0;
        const queue = [];
        const pump = () => {
            if (active >= max || queue.length === 0) return;
            active++;
            const { fn, resolve, reject } = queue.shift();
            Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump(); });
        };
        return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
    }
    const changelogLimit = makeLimiter(4);

    const MAX_BATCH = 100; // bulkfetch hard limit
    const inFlight = new Set();

    function chunk(arr, n) {
        const out = [];
        for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
        return out;
    }

    // Fetch & compute signals for a set of keys, populating the cache. Skips keys that
    // are already cached or in flight, so repeated scans never refetch.
    async function fetchBatch(keys) {
        const fresh = keys.filter((k) => !inFlight.has(k) && !cacheGet(k));
        if (!fresh.length) return;
        fresh.forEach((k) => inFlight.add(k));
        try {
            for (const part of chunk(fresh, MAX_BATCH)) {
                await fetchChunk(part);
            }
        } finally {
            fresh.forEach((k) => inFlight.delete(k));
        }
    }

    async function fetchChunk(keys) {
        let issues = [];
        try {
            const resp = await fetchWithRetry('/rest/api/3/issue/bulkfetch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({
                    issueIdsOrKeys: keys,
                    fields: ['updated', 'created', 'status'],
                    expand: ['changelog']
                })
            });
            if (!resp.ok) {
                // Permission/rate failure for the whole batch. Negative-cache so we do not
                // loop on the same forbidden keys; the TTL lets us retry later.
                log('bulkfetch failed', resp.status);
                keys.forEach((k) => cacheSet(k, { key: k, skip: true }));
                return;
            }
            const json = await resp.json();
            issues = json.issues || [];
        } catch (err) {
            log('bulkfetch error', err);
            keys.forEach((k) => cacheSet(k, { key: k, skip: true }));
            return;
        }

        const seen = new Set();
        const needPaging = [];
        for (const issue of issues) {
            seen.add(issue.key);
            const { data, truncated } = computeSignals(issue);
            // Truncated history: do NOT cache the partial result. The key stays in flight
            // (no refetch) and uncached (so no concurrent scan paints a badge from partial
            // data and then locks it in via reserveHost) until fetchFullChangelog completes.
            if (truncated && !data.isDone) needPaging.push(issue);
            else cacheSet(issue.key, data);
        }
        // Keys the API never returned (deleted / no permission) - negative-cache them.
        keys.forEach((k) => { if (!seen.has(k)) cacheSet(k, { key: k, skip: true }); });

        // Issues whose embedded changelog was truncated need the dedicated paginated
        // endpoint so "Stuck"/"Stuck in Status" never fire on a partial history.
        await Promise.all(needPaging.map((issue) => changelogLimit(async () => {
            try {
                const { histories, complete } = await fetchFullChangelog(issue.key);
                cacheSet(issue.key, computeSignals(issue, histories, complete).data);
            } catch (err) {
                log('changelog paging failed', issue.key, err);
                // best-effort: cache the (incomplete) embedded read; computeSignals stays
                // conservative because the embedded page is short, and this avoids a refetch loop.
                cacheSet(issue.key, computeSignals(issue).data);
            }
        })));
    }

    // Walk the dedicated paginated changelog. Returns { histories, complete } where complete
    // is false if we hit the page cap before reaching the end, so the caller can stay
    // conservative rather than judge "Stuck" off a partial history.
    async function fetchFullChangelog(key, maxPages = 20) {
        const all = [];
        let startAt = 0;
        const maxResults = 100;
        let complete = false;
        for (let p = 0; p < maxPages; p++) {
            const resp = await fetchWithRetry(
                `/rest/api/3/issue/${encodeURIComponent(key)}/changelog?startAt=${startAt}&maxResults=${maxResults}`,
                { headers: { Accept: 'application/json' } }
            );
            if (!resp.ok) break;
            const json = await resp.json();
            const values = json.values || [];
            for (const v of values) all.push({ created: v.created, items: v.items || [] });
            const total = json.total || 0;
            if (json.isLast || values.length < maxResults || (startAt + values.length) >= total) { complete = true; break; }
            startAt += values.length;
        }
        return { histories: all, complete };
    }

    // ---------------------------------------------------------------------------
    // Signal computation (category-first, name lists as override)
    // ---------------------------------------------------------------------------
    function computeSignals(issue, overrideHistories, overrideComplete) {
        const f = issue.fields || {};
        const now = Date.now();
        const updated = Date.parse(f.updated);
        const created = Date.parse(f.created);
        const status = f.status || {};
        const statusName = status.name || '';
        const statusLower = statusName.toLowerCase();
        const catKey = (status.statusCategory && status.statusCategory.key) || '';

        const progressNames = CONFIG.PROGRESS_STATUSES.map((s) => s.toLowerCase());
        const doneNames = CONFIG.DONE_STATUSES.map((s) => s.toLowerCase());

        const isDone = catKey === 'done' || doneNames.includes(statusLower);
        if (isDone) return { data: { key: issue.key, isDone: true }, truncated: false };

        const isInProgress = catKey === 'indeterminate' || progressNames.includes(statusLower);

        const daysSinceUpdate = (now - updated) / DAY_MS;
        const daysSinceCreation = (now - created) / DAY_MS;
        const isStale = Number.isFinite(daysSinceUpdate) && daysSinceUpdate > CONFIG.STALE_THRESHOLD_DAYS;

        const cl = issue.changelog || {};
        const histories = overrideHistories || cl.histories || [];
        // Did we read the issue's FULL history? bulkfetch embeds only the first changelog page.
        // Embedded path: complete unless the page is short of the reported total. Paged path:
        // the caller passes whether the page walk actually reached the end.
        const embeddedComplete = !(cl.total != null && (cl.histories || []).length < cl.total);
        const historyComplete = overrideHistories ? (overrideComplete !== false) : embeddedComplete;
        const truncated = !overrideHistories && !embeddedComplete; // caller should page when embedded is short

        // PING PONG: old ticket that never reached an active status. Only assert it when we have
        // the full history; an incomplete history might be hiding a progress transition.
        let touchedProgress = isInProgress;
        if (!touchedProgress) {
            outer:
            for (const h of histories) {
                for (const it of (h.items || [])) {
                    if (it.field === 'status' && progressNames.includes(String(it.toString || '').toLowerCase())) {
                        touchedProgress = true; break outer;
                    }
                }
            }
        }
        const isPingPong = !touchedProgress && historyComplete && Number.isFinite(daysSinceCreation)
            && daysSinceCreation > CONFIG.PING_PONG_MIN_AGE_DAYS;

        // STUCK IN STATUS: how long since the ticket last entered its current status.
        let statusChanged = created;
        const sorted = histories.slice().sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
        for (const h of sorted) {
            let hit = false;
            for (const it of (h.items || [])) {
                if (it.field === 'status' && String(it.toString || '').toLowerCase() === statusLower) {
                    statusChanged = Date.parse(h.created); hit = true; break;
                }
            }
            if (hit) break;
        }
        // Only trust "time in current status" when the history is complete: a truncated page
        // walk reads the oldest entries first and can miss the recent transition we need.
        const daysInStatus = (now - statusChanged) / DAY_MS;
        const isStuckInStatus = isInProgress && historyComplete && Number.isFinite(daysInStatus)
            && daysInStatus > CONFIG.STUCK_IN_STATUS_DAYS;

        return {
            data: {
                key: issue.key,
                isDone: false,
                isStale,
                isPingPong,
                isStuckInStatus,
                daysSinceUpdate,
                daysSinceCreation,
                daysInStatus,
                currentStatus: statusName
            },
            truncated
        };
    }

    // ---------------------------------------------------------------------------
    // Styling: one injected <style> block, single source of truth for colors
    // ---------------------------------------------------------------------------
    const STYLE_ID = 'jira-stale-highlighter-style';
    const KINDS = {
        stale: { bg: '#fff0f0', bd: '#ccc', fg: '#666' },
        stuck: { bg: '#fff8e1', bd: '#ff9900', fg: '#cc7a00' },
        status: { bg: '#f3e5f5', bd: '#7b1fa2', fg: '#7b1fa2' }
    };

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const variants = Object.keys(KINDS).map((k) => {
            const c = KINDS[k];
            return `.jst-chip--${k},.jst-detail--${k}{background:${c.bg};border-color:${c.bd};color:${c.fg}}`;
        }).join('');
        const css =
            '.jst-chip{display:inline-flex;align-items:center;font-size:10px;line-height:1.5;padding:0 5px;' +
            'border:1px solid;border-radius:4px;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.1);' +
            'box-sizing:border-box;flex:none}' +
            '.jst-overlay{position:absolute;z-index:1000}' +
            '.jst-overlay--tl{top:4px;left:8px}' +
            '.jst-overlay--tr{top:4px;right:8px}' +
            '.jst-inline{margin-left:8px;vertical-align:middle}' +
            '.jst-flow{margin-left:8px;vertical-align:middle}' +
            '.jst-grid-wrap{position:absolute;right:6px;top:50%;transform:translateY(-50%);' +
            'display:flex;gap:4px;align-items:center;z-index:5}' +
            '.jst-detail{display:inline-block;margin-left:10px;padding:2px 6px;border:1px solid;border-radius:4px;' +
            'font-size:12px;font-weight:bold;vertical-align:middle;position:relative;z-index:1000}' +
            `.jst-bordered-stuck{border:2px solid ${KINDS.stuck.bd} !important;box-sizing:border-box}` +
            `.jst-bordered-status{border:2px solid ${KINDS.status.bd} !important;box-sizing:border-box}` +
            variants;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    function makeChip(kind, label, key) {
        const el = document.createElement('div');
        el.className = `jst-chip jst-chip--${kind} jira-stale-indicator`;
        el.dataset.issueKey = key || '';
        el.textContent = label;
        return el;
    }

    function makeDetailBadge(kind, label, key) {
        const el = document.createElement('div');
        el.className = `jst-detail jst-detail--${kind} jira-stale-indicator-detail`;
        el.setAttribute('data-issue-key', key || '');
        el.dataset.issueKey = key || '';
        el.textContent = label;
        return el;
    }

    // List form, used by overlay / inline / grid (each signal is its own chip).
    function signalChips(data) {
        const chips = [];
        if (data.isStale) chips.push(['stale', `🕒 Stale (${Math.floor(data.daysSinceUpdate)}d)`]);
        if (data.isPingPong) chips.push(['stuck', `🛑 Stuck (${Math.floor(data.daysSinceCreation)}d)`]);
        if (data.isStuckInStatus) chips.push(['status', `⚓ Stuck: ${data.currentStatus} (${Math.floor(data.daysInStatus)}d)`]);
        return chips;
    }

    // Full set (priority order), used by the issue-detail header. Mirrors signalChips so the
    // detail view shows every active signal too, but keeps the "Stuck in <status>" wording that
    // reads better in a header than the board's compact "Stuck: <status>".
    function detailSpecs(data) {
        const specs = [];
        if (data.isStale) specs.push(['stale', `🕒 Stale (${Math.floor(data.daysSinceUpdate)}d)`]);
        if (data.isPingPong) specs.push(['stuck', `🛑 Stuck (${Math.floor(data.daysSinceCreation)}d)`]);
        if (data.isStuckInStatus) specs.push(['status', `⚓ Stuck in ${data.currentStatus} (${Math.floor(data.daysInStatus)}d)`]);
        return specs;
    }

    // ---------------------------------------------------------------------------
    // Shape helpers (classify once, cache on the node to avoid layout thrash)
    // ---------------------------------------------------------------------------
    function isGrid(el) {
        if (el.dataset.staleShape) return el.dataset.staleShape === 'grid';
        const grid = getComputedStyle(el).display === 'grid';
        el.dataset.staleShape = grid ? 'grid' : 'flow';
        return grid;
    }

    function ensureRelative(el) {
        if (el.dataset.staleRel) return;
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        el.dataset.staleRel = '1';
    }

    // True when an element lives inside rendered rich text or an editor. Never badge those:
    // their smart-links point at other issues and a badge would overlay the prose.
    function inRichText(el) {
        return !!(el && el.closest && el.closest(
            '.ak-renderer-document, .ProseMirror, [contenteditable="true"], ' +
            '[data-testid*="issue.activity"], [data-testid*="comment"]'
        ));
    }

    // Remove our badges and undo the inline styles/classes we added to a container. Used
    // when React reuses a card/row node for a different issue.
    function clearStaleArtifacts(container) {
        container.querySelectorAll('.jira-stale-indicator, .jira-stale-indicator-detail').forEach((n) => n.remove());
        if (container.dataset.staleReservedTop) { container.style.paddingTop = ''; delete container.dataset.staleReservedTop; }
        if (container.dataset.staleReservedRight) { container.style.paddingRight = ''; delete container.dataset.staleReservedRight; }
        if (container.dataset.staleBorder) {
            container.classList.remove('jst-bordered-stuck', 'jst-bordered-status');
            delete container.dataset.staleBorder;
        }
        delete container.dataset.staleCheckedKey;
        delete container.dataset.staleSig;
    }

    // ---------------------------------------------------------------------------
    // Placement: every path routes through placeBadge(host, mode, data)
    // ---------------------------------------------------------------------------
    // Signature of the rendered state. A TTL refresh that changes an issue's signals must
    // repaint, so the dedupe compares this rather than the key alone.
    function dataSig(data) {
        if (!data || data.skip || data.isDone) return 'none';
        return [
            data.isStale ? 's' + Math.floor(data.daysSinceUpdate) : '',
            data.isPingPong ? 'p' + Math.floor(data.daysSinceCreation) : '',
            data.isStuckInStatus ? 'q' + Math.floor(data.daysInStatus) : '',
            data.currentStatus || ''
        ].join('|');
    }

    // Returns false only when the host already shows our up-to-date badge for this key.
    // A different key OR a changed signature clears and lets the caller repaint.
    function reserveHost(host, key, sig) {
        const prior = host.querySelector('.jira-stale-indicator, .jira-stale-indicator-detail');
        if (prior) {
            if (prior.dataset.issueKey === key && host.dataset.staleSig === sig) return false;
            clearStaleArtifacts(host);
        } else if (host.dataset.staleCheckedKey === key && host.dataset.staleSig === sig) {
            return false;
        }
        host.dataset.staleCheckedKey = key;
        host.dataset.staleSig = sig;
        return true;
    }

    function placeBadge(host, mode, data) {
        const key = data.key || '';

        if (mode === 'detail') return placeDetail(host, data);

        if (!reserveHost(host, key, dataSig(data))) return;
        const chips = signalChips(data);
        if (!chips.length) return; // "checked" marker already set; nothing to draw

        if (mode === 'grid') {
            ensureRelative(host);
            if (!host.dataset.staleReservedRight) {
                const cur = parseFloat(getComputedStyle(host).paddingRight) || 0;
                host.style.paddingRight = (cur + (chips.length * 92 + 14)) + 'px';
                host.dataset.staleReservedRight = '1';
            }
            const wrap = document.createElement('div');
            wrap.className = 'jst-grid-wrap jira-stale-indicator';
            wrap.dataset.issueKey = key;
            chips.forEach(([k, l]) => wrap.appendChild(makeChip(k, l, key)));
            host.appendChild(wrap);
            return;
        }

        if (mode === 'inline') {
            chips.forEach(([k, l]) => {
                const chip = makeChip(k, l, key);
                chip.classList.add('jst-inline');
                host.appendChild(chip);
            });
            return;
        }

        // mode === 'overlay' | 'timeline'
        const timeline = mode === 'timeline';
        if (!timeline) {
            ensureRelative(host);
            if (!host.dataset.staleReservedTop) {
                const cur = parseFloat(getComputedStyle(host).paddingTop) || 0;
                host.style.paddingTop = (cur + 20) + 'px';
                host.dataset.staleReservedTop = '1';
            }
        }
        chips.forEach(([k, l]) => {
            const chip = makeChip(k, l, key);
            if (timeline) {
                chip.classList.add('jst-flow');
            } else {
                chip.classList.add('jst-overlay', k === 'stale' ? 'jst-overlay--tl' : 'jst-overlay--tr');
                if (k === 'stuck') { host.classList.add('jst-bordered-stuck'); host.dataset.staleBorder = '1'; }
                if (k === 'status') { host.classList.add('jst-bordered-status'); host.dataset.staleBorder = '1'; }
            }
            host.appendChild(chip);
        });
    }

    // Issue-detail header: one badge per active signal, near the key/breadcrumb, never inside
    // the description. All badges live in a single wrapper so the whole set shares one insertion
    // point and one dedupe anchor (issueKey + signature).
    function placeDetail(element, data) {
        const key = data.key || '';
        const sig = dataSig(data);
        const specs = detailSpecs(data);

        const existing = element.querySelector('.jira-stale-indicator-detail');
        if (existing) {
            // Up-to-date badges for this issue+state already present -> nothing to repaint.
            if (specs.length && existing.dataset.issueKey === key && existing.dataset.staleSig === sig) return;
            // Cleared (clean/done/skip), a different issue, or this issue's state changed ->
            // drop every badge we placed and repaint. querySelectorAll covers the wrapper and,
            // defensively, any stray badge from an older single-badge build.
            element.querySelectorAll('.jira-stale-indicator-detail').forEach((n) => n.remove());
        }
        if (!specs.length) return; // refreshed to a non-flagged state: leave nothing behind.

        const wrap = document.createElement('span');
        wrap.className = 'jira-stale-indicator-detail jst-detail-wrap';
        wrap.setAttribute('data-issue-key', key);
        wrap.dataset.issueKey = key;
        wrap.dataset.staleSig = sig;
        specs.forEach(([kind, label]) => wrap.appendChild(makeDetailBadge(kind, label, key)));

        // 1. Next to our companion copy button, if present.
        const copyButton = element.querySelector('.jira-universal-copy-button-wrapper');
        if (copyButton && copyButton.offsetParent && !inRichText(copyButton)) {
            copyButton.parentNode.insertBefore(wrap, copyButton.nextSibling);
            return;
        }
        // 2. Before the action bar.
        const actionBar = element.querySelector('[data-testid="issue.views.issue-base.foundation.quick-add.quick-add-container"]');
        if (actionBar && !inRichText(actionBar)) {
            actionBar.insertAdjacentElement('beforebegin', wrap);
            return;
        }
        // 3. After breadcrumbs, or a real (non-smart-link) key link.
        let breadcrumbs = element.querySelector('[data-testid*="breadcrumbs"]');
        if (breadcrumbs && inRichText(breadcrumbs)) breadcrumbs = null;
        if (!breadcrumbs && key) {
            const keyLink = [...document.querySelectorAll(`a[href*="/browse/${key}"]`)]
                .find((a) => !inRichText(a) && a.getBoundingClientRect().width > 0);
            if (keyLink) breadcrumbs = keyLink;
        }
        if (breadcrumbs) {
            breadcrumbs.insertAdjacentElement('afterend', wrap);
            return;
        }
        // 4. Fall back to the summary heading.
        const summarySelectors = [
            'h1[data-testid*="summary"][data-testid*="heading"]',
            'h1',
            '[data-testid="issue.views.issue-base.foundation.summary.heading"]',
            '[data-testid="issue-field-summary.ui.issue-field-summary-inline-edit--container"]',
            'div[data-testid*="summary"]'
        ];
        for (const sel of summarySelectors) {
            const found = element.querySelectorAll(sel);
            for (const summary of found) {
                if (inRichText(summary)) continue;
                if (summary.innerText && summary.innerText.trim().length > 0) {
                    summary.appendChild(wrap);
                    return;
                }
            }
        }
        log('Failed to find insertion point for detail indicator', key);
    }

    // Route a card/row element to the right placement mode, then draw. skip/done/clean data
    // still flows through placeBadge so a badge from a prior state (issue moved to Done, or a
    // forbidden refresh) gets cleared instead of lingering.
    function applyHighlights(element, data, context) {
        if (!data) return;

        if (context === 'detail') { placeBadge(element, 'detail', data); return; }

        const timeline = window.location.href.toLowerCase().includes('/timeline');

        // Dense list rows (issue tables, line cards, grid backlog) render the key as a tiny
        // inline / screen-reader <a>. An absolute overlay there covers the key and spills
        // onto the title, so resolve ONE row container and flow chips into it instead.
        let rowContainer = element.closest(
            '[data-testid*="merged-cell"], [data-testid*="issue-line-card.card-container"], ' +
            '[data-testid*="card-contents.card-container"]'
        );
        if (!rowContainer && element.tagName === 'A') {
            const st = getComputedStyle(element);
            const r = element.getBoundingClientRect();
            if (st.display.startsWith('inline') || st.position === 'absolute' || r.width < 4) {
                let p = element.parentElement, hops = 0;
                while (p && hops < 6) {
                    if (p.getBoundingClientRect().width > r.width + 80) { rowContainer = p; break; }
                    p = p.parentElement; hops++;
                }
            }
        }
        if (!timeline && rowContainer) {
            placeBadge(rowContainer, isGrid(rowContainer) ? 'grid' : 'inline', data);
            return;
        }

        // Overlay path (kanban / business-board cards). Use the first child of div cards so
        // we never touch the draggable root's layout.
        let anchor = element;
        if (element.tagName !== 'A' && element.firstElementChild) anchor = element.firstElementChild;
        placeBadge(anchor, timeline ? 'timeline' : 'overlay', data);
    }

    // ---------------------------------------------------------------------------
    // Key extraction
    // ---------------------------------------------------------------------------
    function keyFromHref(href) {
        const m = href && href.match(/\/browse\/([A-Z][A-Z0-9]+-[0-9]+)/);
        return m ? m[1] : null;
    }

    function getIssueKeyFromElement(element) {
        if (element.tagName === 'A') { const k = keyFromHref(element.href); if (k) return k; }
        const link = element.querySelector('a[href*="/browse/"]');
        if (link) { const k = keyFromHref(link.href); if (k) return k; }
        const tm = (element.innerText || '').match(/([A-Z][A-Z0-9]+-[0-9]+)/);
        return tm ? tm[1] : null;
    }

    function getIssueKeyFromUrl(url) {
        const k = keyFromHref(url);
        if (k) return k;
        try {
            const params = new URLSearchParams(url.split('?')[1]);
            const sel = params.get('selectedIssue');
            if (sel) return sel;
        } catch (e) { /* ignore */ }
        return null;
    }

    function resolveDetailKey(container) {
        let key = getIssueKeyFromUrl(window.location.href);
        if (!key) {
            const link = container.querySelector('a[href*="/browse/"]');
            if (link) key = keyFromHref(link.href);
        }
        return key;
    }

    // ---------------------------------------------------------------------------
    // Scan: collect visible targets, batch the cache misses, apply from cache
    // ---------------------------------------------------------------------------
    function collectTargets() {
        const targets = [];
        const seenCards = new Set();

        const els = document.querySelectorAll('div[data-testid*="card-content"], div.ghx-issue, a[href*="/browse/"]');
        els.forEach((el) => {
            let card = null;
            if (el.tagName === 'A') {
                if (/\/browse\/[A-Z][A-Z0-9]+-[0-9]+/.test(el.href)) {
                    const insideSoftwareCard = el.closest(
                        'div[data-testid="platform-board-kit.ui.card.card"], div.ghx-issue, div.js-issue, div[data-testid*="card-content"]'
                    );
                    const insideView = el.closest(
                        'div[role="dialog"], div[data-testid*="modal-dialog"], #jira-issue-header, ' +
                        '[data-testid*="issue.views.issue-base.foundation.summary.heading"]'
                    );
                    // Skip rich-text smart-links (description / comments / activity), editor and renderer.
                    const insideEditor = el.closest('.ProseMirror, [contenteditable="true"], input, textarea, .ak-renderer-document');
                    if (!insideSoftwareCard && !insideView && !insideEditor) card = el;
                }
            } else {
                card = el.closest('div[data-testid="platform-board-kit.ui.card.card"], div.ghx-issue, div.js-issue') || el;
            }
            if (card && !seenCards.has(card)) {
                seenCards.add(card);
                const key = getIssueKeyFromElement(card);
                if (key) targets.push({ key, element: card, context: 'card' });
            }
        });

        // Open modals.
        document.querySelectorAll('div[role="dialog"], div[data-testid*="modal-dialog"]').forEach((modal) => {
            if (modal.offsetParent !== null) {
                const key = resolveDetailKey(modal);
                if (key) targets.push({ key, element: modal, context: 'detail' });
            }
        });

        // Full-page issue view.
        if (window.location.pathname.includes('/browse/') || window.location.search.includes('selectedIssue')) {
            const header = document.querySelector('div[id="jira-issue-header"]');
            const container = header ? (header.closest('#jira-frontend') || header.parentElement) : document.body;
            const key = resolveDetailKey(container);
            if (key) targets.push({ key, element: container, context: 'detail' });
        }

        return targets;
    }

    let scanScheduled = false;
    function scheduleScan() {
        if (scanScheduled) return;
        scanScheduled = true;
        const run = () => { scanScheduled = false; scanPage(); };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else setTimeout(run, 16);
    }

    function scanPage() {
        injectStyle();
        let targets;
        try { targets = collectTargets(); } catch (err) { log('collect error', err); return; }

        const toFetch = new Set();
        for (const t of targets) {
            const cached = cacheGet(t.key);
            if (cached) {
                try { applyHighlights(t.element, cached, t.context); } catch (err) { log('apply error', t.key, err); }
            } else if (!inFlight.has(t.key)) {
                toFetch.add(t.key);
            }
        }
        if (toFetch.size) {
            fetchBatch([...toFetch]).then(scheduleScan).catch((err) => log('batch error', err));
        }
    }

    // ---------------------------------------------------------------------------
    // Observation + navigation
    // ---------------------------------------------------------------------------
    function isOurNode(node) {
        return !!(node.classList && (
            node.classList.contains('jira-stale-indicator') ||
            node.classList.contains('jira-stale-indicator-detail') ||
            node.id === STYLE_ID
        ));
    }

    const observer = new MutationObserver((mutations) => {
        // Only react to nodes WE did not add, and batch the rescan into one rAF tick so a
        // burst of Jira re-renders (and our own inserts) cannot thrash the scan.
        for (const m of mutations) {
            if (m.type !== 'childList') continue;
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1 || isOurNode(node)) continue;
                scheduleScan();
                return;
            }
        }
    });

    function startObserving() {
        if (document.body) observer.observe(document.body, { childList: true, subtree: true });
        else document.addEventListener('DOMContentLoaded', startObserving, { once: true });
    }

    function cleanupAll() {
        document.querySelectorAll('.jira-stale-indicator, .jira-stale-indicator-detail').forEach((n) => n.remove());
        document.querySelectorAll('[data-stale-reserved-top]').forEach((el) => {
            el.style.paddingTop = ''; el.removeAttribute('data-stale-reserved-top');
        });
        document.querySelectorAll('[data-stale-reserved-right]').forEach((el) => {
            el.style.paddingRight = ''; el.removeAttribute('data-stale-reserved-right');
        });
        document.querySelectorAll('[data-stale-border]').forEach((el) => {
            el.classList.remove('jst-bordered-stuck', 'jst-bordered-status');
            el.removeAttribute('data-stale-border');
        });
        document.querySelectorAll('[data-stale-checked-key]').forEach((el) => el.removeAttribute('data-stale-checked-key'));
        document.querySelectorAll('[data-stale-sig]').forEach((el) => el.removeAttribute('data-stale-sig'));
    }

    let lastUrl = window.location.href;
    function onUrlChange() {
        if (window.location.href === lastUrl) return;
        lastUrl = window.location.href;
        log('URL change ->', lastUrl);
        cleanupAll();   // never let a previous view's badges/padding persist
        scheduleScan();
    }

    // ---------------------------------------------------------------------------
    // Settings UI (GM menu command + small modal; inert when no GM storage API exists)
    // ---------------------------------------------------------------------------
    // Built entirely with DOM methods (no innerHTML) so persisted status names can never
    // become an injection vector.
    function openSettings() {
        if (document.getElementById('jst-settings-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'jst-settings-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(9,30,66,.54);z-index:2147483647;' +
            'display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;';

        const panel = document.createElement('div');
        panel.style.cssText = 'background:#fff;color:#172b4d;border-radius:8px;padding:20px 22px;width:360px;' +
            'box-shadow:0 8px 24px rgba(9,30,66,.4);max-height:90vh;overflow:auto;';

        const heading = document.createElement('div');
        heading.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:4px';
        heading.textContent = 'Stale Ticket Highlighter';
        const sub = document.createElement('div');
        sub.style.cssText = 'font-size:12px;color:#5e6c84';
        sub.textContent = 'Tune thresholds. Saved per browser.';
        panel.appendChild(heading);
        panel.appendChild(sub);

        const inputs = {};
        const field = (id, label, value, hint) => {
            const lab = document.createElement('label');
            lab.style.cssText = 'display:block;margin:12px 0 4px;font-size:12px;font-weight:600';
            lab.textContent = label;
            const input = document.createElement('input');
            input.value = String(value);
            input.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #dfe1e6;border-radius:4px;font-size:13px';
            inputs[id] = input;
            panel.appendChild(lab);
            panel.appendChild(input);
            if (hint) {
                const h = document.createElement('div');
                h.style.cssText = 'font-size:11px;color:#5e6c84;margin-top:3px';
                h.textContent = hint;
                panel.appendChild(h);
            }
        };

        field('stale', 'Stale after (days without update)', CONFIG.STALE_THRESHOLD_DAYS);
        field('pingpong', 'Stuck after (days old, never started)', CONFIG.PING_PONG_MIN_AGE_DAYS);
        field('status', 'Stuck in status after (days)', CONFIG.STUCK_IN_STATUS_DAYS);
        field('progress', 'Progress status names (optional override, comma-separated)', CONFIG.PROGRESS_STATUSES.join(', '),
            'Detection uses status categories by default; this only refines the changelog match.');
        field('done', 'Done status names (optional override, comma-separated)', CONFIG.DONE_STATUSES.join(', '));

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:18px';
        const mkBtn = (text, primary) => {
            const b = document.createElement('button');
            b.textContent = text;
            b.style.cssText = primary
                ? 'padding:6px 12px;border:0;background:#0052cc;color:#fff;border-radius:4px;cursor:pointer'
                : 'padding:6px 12px;border:1px solid #dfe1e6;background:#fff;border-radius:4px;cursor:pointer';
            return b;
        };
        const resetBtn = mkBtn('Reset', false);
        const cancelBtn = mkBtn('Cancel', false);
        const saveBtn = mkBtn('Save', true);
        btnRow.appendChild(resetBtn);
        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(saveBtn);
        panel.appendChild(btnRow);

        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        cancelBtn.addEventListener('click', close);

        resetBtn.addEventListener('click', async () => {
            await Promise.all(['STALE_THRESHOLD_DAYS', 'PING_PONG_MIN_AGE_DAYS', 'STUCK_IN_STATUS_DAYS', 'PROGRESS_STATUSES', 'DONE_STATUSES']
                .map((k) => store.set(k, '')));
            await applyNewConfig();
            close();
        });

        saveBtn.addEventListener('click', async () => {
            await Promise.all([
                store.set('STALE_THRESHOLD_DAYS', toNum(inputs.stale.value, DEFAULTS.STALE_THRESHOLD_DAYS)),
                store.set('PING_PONG_MIN_AGE_DAYS', toNum(inputs.pingpong.value, DEFAULTS.PING_PONG_MIN_AGE_DAYS)),
                store.set('STUCK_IN_STATUS_DAYS', toNum(inputs.status.value, DEFAULTS.STUCK_IN_STATUS_DAYS)),
                store.set('PROGRESS_STATUSES', inputs.progress.value),
                store.set('DONE_STATUSES', inputs.done.value)
            ]);
            await applyNewConfig();
            close();
        });
    }

    async function applyNewConfig() {
        CONFIG = await loadConfig();
        cacheClear();   // thresholds changed -> recompute everything
        cleanupAll();
        scheduleScan();
    }

    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
    async function init() {
        CONFIG = await loadConfig(); // stays at DEFAULTS if no storage API is available
        ssLoad();
        injectStyle();
        startObserving();
        store.menu('⚙ Configure thresholds', openSettings);
        window.addEventListener('popstate', onUrlChange);
        setInterval(onUrlChange, 500); // fallback for pushState navigations
        setTimeout(scanPage, 800);
        scheduleScan();

        // Test seam: inert in production. A harness that sets window.__JST_TEST = {} BEFORE this
        // script loads gets handles to drive deterministic refresh/clear scenarios.
        try {
            if (typeof window !== 'undefined' && window.__JST_TEST && typeof window.__JST_TEST === 'object') {
                window.__JST_TEST.scanPage = scanPage;
                window.__JST_TEST.cacheSet = cacheSet;
                window.__JST_TEST.cleanupAll = cleanupAll;
            }
        } catch (e) { /* ignore */ }
    }

    init();
})();
