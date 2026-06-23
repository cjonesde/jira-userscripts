// ==UserScript==
// @name         Jira Stale Ticket Highlighter
// @namespace    https://github.com/wuhup/jira-userscripts
// @version      1.1.7
// @description  Highlights stale and stuck tickets on Jira boards with visual indicators
// @author       Christopher Jones
// @match        https://*.atlassian.net/*
// @homepageURL  https://github.com/wuhup/jira-userscripts
// @supportURL   https://github.com/wuhup/jira-userscripts/issues
// @downloadURL  https://raw.githubusercontent.com/wuhup/jira-userscripts/main/Jira%20Stale%20Ticket%20Highlighter.user.js
// @updateURL    https://raw.githubusercontent.com/wuhup/jira-userscripts/main/Jira%20Stale%20Ticket%20Highlighter.user.js
// @grant        none
// ==/UserScript==

/**
 * Highlights stale and stuck tickets on Jira boards with visual badges.
 * Shows "Stale" for tickets with no updates, "Stuck" for old tickets that
 * never started, and "Stuck in Status" for tickets lingering in active states.
 * Edit the CONFIG object below to match your Jira workflow status names.
 */
(function () {
    'use strict';

    console.log('[Jira Stale Highlighter] Script loaded');

    const CONFIG = {
        STALE_THRESHOLD_DAYS: 30,
        PING_PONG_MIN_AGE_DAYS: 14,
        STUCK_IN_STATUS_DAYS: 14,
        PROGRESS_STATUSES: [
            'In Progress',
            'Tech Review',
            'Merged',
            'Testing',
            'Ready for Release'
        ],
        DONE_STATUSES: [
            'Done',
            'Done (deployed to prod)',
            'Closed'
        ]
    };

    const log = (...args) => console.log('[Jira Stale Highlighter]', ...args);

    log('Script initialized with config:', CONFIG);

    // Utility: Debounce
    function debounced(fn, delay) {
        let timer = null;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    }

    // Utility: Parse Jira Key from URL or text
    function getIssueKeyFromElement(element) {
        // Business Board: The element itself might be the link
        if (element.tagName === 'A' && element.href.includes('/browse/')) {
            const match = element.href.match(/\/browse\/([A-Z][A-Z0-9]+-[0-9]+)/);
            if (match) return match[1];
        }

        // Software Board: Try to find a link inside
        const link = element.querySelector('a[href*="/browse/"]');
        if (link) {
            const match = link.href.match(/\/browse\/([A-Z][A-Z0-9]+-[0-9]+)/);
            if (match) return match[1];
        }
        // Fallback: check text content
        const textMatch = element.innerText.match(/([A-Z][A-Z0-9]+-[0-9]+)/);
        return textMatch ? textMatch[1] : null;
    }

    // Main Logic
    const processedKeys = new Set();
    const CACHE = new Map();

    // True when an element lives inside rendered rich text (description, comments,
    // activity) or an editor. We must never attach a badge there: those bodies contain
    // smart-links to other issues, and a badge would overlay the prose.
    function inRichText(el) {
        return !!(el && el.closest && el.closest('.ak-renderer-document, .ProseMirror, [contenteditable="true"], [data-testid*="issue.activity"], [data-testid*="comment"]'));
    }

    // Remove our badges and undo the inline styles/markers we added to a container.
    // Used when a card/row DOM node is reused by React for a different issue, so we
    // never leave a previous issue's badge or reserved spacing behind.
    function clearStaleArtifacts(container) {
        container.querySelectorAll('.jira-stale-indicator, .jira-stale-indicator-detail').forEach((n) => n.remove());
        if (container.dataset.staleReservedTop) { container.style.paddingTop = ''; delete container.dataset.staleReservedTop; }
        if (container.dataset.staleReservedRight) { container.style.paddingRight = ''; delete container.dataset.staleReservedRight; }
        if (container.dataset.staleBorder) { container.style.border = ''; container.style.boxSizing = ''; delete container.dataset.staleBorder; }
        delete container.dataset.staleCheckedKey;
    }

    // Helper: Parse Key from URL
    function getIssueKeyFromUrl(url) {
        const match = url.match(/\/browse\/([A-Z][A-Z0-9]+-[0-9]+)/);
        if (match) return match[1];

        const params = new URLSearchParams(url.split('?')[1]);
        const selected = params.get('selectedIssue');
        if (selected) return selected;

        return null;
    }

    async function processCard(cardElement) {
        const key = getIssueKeyFromElement(cardElement);
        if (!key) return;

        // Key-aware skip: only short-circuit if this node already carries an indicator for
        // the SAME issue. If React reused the node for a different issue, fall through so
        // applyHighlights can clear the old badge and reapply. (Inline/row badges live on an
        // ancestor, not inside cardElement, so those dedupe in applyHighlights instead.)
        const existing = cardElement.querySelector('.jira-stale-indicator');
        if (existing && existing.dataset.issueKey === key) return;
        if (!existing && cardElement.dataset.staleCheckedKey === key) return;

        if (CACHE.has(key)) {
            applyHighlights(cardElement, CACHE.get(key), 'card');
            return;
        }

        // Fetch if not cached
        fetchAndApply(key, cardElement, 'card');
    }



    async function fetchAndApply(key, element, context) {
        if (processedKeys.has(key) && !CACHE.has(key)) return; // Already fetching?
        processedKeys.add(key);
        log('Fetching data for', key, 'context:', context);

        try {
            const data = await fetchIssueData(key);
            CACHE.set(key, data);
            applyHighlights(element, data, context);
            processedKeys.delete(key); // Done processing for now
        } catch (err) {
            console.error('Error fetching data for', key, err);
            processedKeys.delete(key);
        }
    }

    async function fetchIssueData(key) {
        const url = `/rest/api/3/issue/${key}?fields=updated,created,status&expand=changelog`;
        const initialResp = await fetch(url);

        if (!initialResp.ok) {
            throw new Error(`API Error: ${initialResp.status}`);
        }

        const data = await initialResp.json();

        const now = new Date();
        const updated = new Date(data.fields.updated);
        const created = new Date(data.fields.created);
        const currentStatus = data.fields.status?.name || '';
        const currentStatusLower = currentStatus.toLowerCase();

        const daysSinceUpdate = (now - updated) / (1000 * 60 * 60 * 24);
        const daysSinceCreation = (now - created) / (1000 * 60 * 60 * 24);

        // Skip completed tickets
        const doneStatusesLower = CONFIG.DONE_STATUSES.map(s => s.toLowerCase());
        const isDone = doneStatusesLower.includes(currentStatusLower);
        if (isDone) {
            return { key, isStale: false, isPingPong: false, isStuckInStatus: false, isDone: true };
        }

        // STALE: No updates for X days
        const isStale = daysSinceUpdate > CONFIG.STALE_THRESHOLD_DAYS;


        // 3. PING PONG Check: Old ticket that never reached "In Progress"
        let isPingPong = false;
        let touchedProgress = false;
        const progressStatusesLower = CONFIG.PROGRESS_STATUSES.map(s => s.toLowerCase());

        if (progressStatusesLower.includes(currentStatusLower)) {
            touchedProgress = true;
        } else {
            // Check history for any progress status
            const histories = data.changelog?.histories || [];
            for (const history of histories) {
                for (const item of (history.items || [])) {
                    if (item.field === 'status') {
                        const toStr = (item.toString || '').toLowerCase();
                        if (progressStatusesLower.includes(toStr)) {
                            touchedProgress = true;
                            break;
                        }
                    }
                }
                if (touchedProgress) break;
            }
        }

        if (!touchedProgress && daysSinceCreation > CONFIG.PING_PONG_MIN_AGE_DAYS) {
            isPingPong = true;
        }


        // 4. STUCK IN STATUS Check: Ticket stuck in an active status too long
        // Find when ticket last transitioned to its current status
        let statusChangedDate = created;
        let foundStatusTransition = false;

        const histories = data.changelog?.histories || [];
        histories.sort((a, b) => new Date(b.created) - new Date(a.created));

        for (const history of histories) {
            for (const item of (history.items || [])) {
                if (item.field === 'status' && (item.toString || '').toLowerCase() === currentStatusLower) {
                    statusChangedDate = new Date(history.created);
                    foundStatusTransition = true;
                    break;
                }
            }
            if (foundStatusTransition) break;
        }

        const daysInStatus = (now - statusChangedDate) / (1000 * 60 * 60 * 24);
        let isStuckInStatus = false;

        if (progressStatusesLower.includes(currentStatusLower)) {
            if (daysInStatus > CONFIG.STUCK_IN_STATUS_DAYS) {
                isStuckInStatus = true;
            }
        }

        return { key, isStale, isPingPong, isStuckInStatus, daysSinceUpdate, daysSinceCreation, daysInStatus, currentStatus };
    }

    function applyHighlights(element, data, context) {
        if (context === 'detail') {
            log('applyHighlights called for detail', data);
        }

        if (data.isDone) {
            if (context === 'detail') log('Skipping detail highlight because issue is DONE');
            return;
        }

        if (context === 'card') {
            // Target Anchor for positioning
            let anchor = element;
            if (element.tagName !== 'A') {
                // Software Board: Use first child to avoid messing with root card layout (drag & drop)
                if (element.firstElementChild) {
                    anchor = element.firstElementChild;
                }
            }

            // Ensure anchor is relative so absolute indicators position correctly
            if (getComputedStyle(anchor).position === 'static') {
                anchor.style.position = 'relative';
            }

            const isTimeline = window.location.href.toLowerCase().includes('/timeline');

            // Issue tables and line cards (an epic's child items, list view, JQL results)
            // render the issue key as a tiny INLINE <a>. An absolute overlay there covers
            // the key and spills onto the title cell, and reserving vertical padding is a
            // no-op on inline elements. So flow inline chips into the row's flex container
            // instead, after the title. This never overlays the key or title.
            // Dense list rows (issue tables, line cards, backlog cards) render the key as a
            // tiny inline or screen-reader <a>, and Jira may hand us several elements per row
            // (key link, summary link, card-contents wrappers). Resolve ONE canonical row
            // container, dedupe on it, and place chips so they never cover the key, title, or
            // assignee. Board/business-board cards don't match and keep the overlay path below.
            let rowContainer = element.closest('[data-testid*="merged-cell"], [data-testid*="issue-line-card.card-container"], [data-testid*="card-contents.card-container"]');
            if (!rowContainer && element.tagName === 'A') {
                const st = getComputedStyle(element);
                const r = element.getBoundingClientRect();
                // Inline / screen-reader-only key links with no known container: climb to the
                // first ancestor clearly wider than the key (the row), never the key wrapper.
                if (st.display.startsWith('inline') || st.position === 'absolute' || r.width < 4) {
                    let p = element.parentElement, hops = 0;
                    while (p && hops < 6) {
                        if (p.getBoundingClientRect().width > r.width + 80) { rowContainer = p; break; }
                        p = p.parentElement; hops++;
                    }
                }
            }
            if (!isTimeline && rowContainer) {
                // Key-aware dedup: one chip set per row. If the row already shows a chip for a
                // DIFFERENT issue (React reused the node), clear it first; if it was checked for
                // this issue and needs no chip, skip without reprocessing every scan.
                const prior = rowContainer.querySelector('.jira-stale-indicator');
                if (prior) {
                    if (prior.dataset.issueKey === data.key) return;
                    clearStaleArtifacts(rowContainer);
                } else if (rowContainer.dataset.staleCheckedKey === data.key) {
                    return;
                }
                rowContainer.dataset.staleCheckedKey = data.key || '';

                const chipDefs = [];
                if (data.isStale)         chipDefs.push(['🕒 Stale (' + Math.floor(data.daysSinceUpdate) + 'd)', '#fff0f0', '#ccc', '#666']);
                if (data.isPingPong)      chipDefs.push(['🛑 Stuck (' + Math.floor(data.daysSinceCreation) + 'd)', '#fff8e1', '#ff9900', '#cc7a00']);
                if (data.isStuckInStatus) chipDefs.push(['⚓ Stuck: ' + data.currentStatus + ' (' + Math.floor(data.daysInStatus) + 'd)', '#f3e5f5', '#7b1fa2', '#7b1fa2']);
                if (!chipDefs.length) return; // checked marker already set above

                const mkChip = (def) => {
                    const chip = document.createElement('div');
                    chip.className = 'jira-stale-indicator';
                    chip.dataset.issueKey = data.key || '';
                    chip.innerText = def[0];
                    chip.style.cssText = 'display: inline-flex; align-items: center; background: ' + def[1] + '; border: 1px solid ' + def[2] + '; font-size: 10px; line-height: 1.5; padding: 0 5px; border-radius: 4px; color: ' + def[3] + '; white-space: nowrap; box-shadow: 0 1px 2px rgba(0,0,0,0.1); flex: none;';
                    return chip;
                };

                if (getComputedStyle(rowContainer).display === 'grid') {
                    // Grid rows (backlog): appended flow items land in occupied cells, so reserve
                    // a right-edge slot and pin an absolute wrapper there, clear of every column.
                    if (getComputedStyle(rowContainer).position === 'static') rowContainer.style.position = 'relative';
                    if (!rowContainer.dataset.staleReservedRight) {
                        const cur = parseFloat(getComputedStyle(rowContainer).paddingRight) || 0;
                        rowContainer.style.paddingRight = (cur + (chipDefs.length * 92 + 14)) + 'px';
                        rowContainer.dataset.staleReservedRight = '1';
                    }
                    const wrap = document.createElement('div');
                    wrap.className = 'jira-stale-indicator';
                    wrap.dataset.issueKey = data.key || '';
                    wrap.style.cssText = 'position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: flex; gap: 4px; align-items: center; z-index: 5;';
                    chipDefs.forEach((d) => wrap.appendChild(mkChip(d)));
                    rowContainer.appendChild(wrap);
                } else {
                    // Flex / inline rows (issue tables, line cards): chips flow in after the title.
                    chipDefs.forEach((d) => {
                        const chip = mkChip(d);
                        chip.style.marginLeft = '8px';
                        chip.style.verticalAlign = 'middle';
                        rowContainer.appendChild(chip);
                    });
                }
                return;
            }

            // Overlay path (kanban board / business-board cards). Key-aware so a card node
            // reused by React for a different issue can't keep a previous issue's badge, and
            // a "checked" marker stops us reprocessing cards that need no badge every scan.
            const priorOverlay = anchor.querySelector('.jira-stale-indicator');
            if (priorOverlay) {
                if (priorOverlay.dataset.issueKey === data.key) return;
                clearStaleArtifacts(anchor);
            } else if (anchor.dataset.staleCheckedKey === data.key) {
                return;
            }
            anchor.dataset.staleCheckedKey = data.key || '';

            // Reserve a top strip so badges sit ABOVE the card's own content instead
            // of overlaying it. Without this, the stale badge covers the issue key on
            // backlog/anchor rows (key is top-left) and the summary on board cards.
            // Idempotent via a data flag so re-scans don't compound the padding.
            if (!isTimeline && (data.isStale || data.isPingPong || data.isStuckInStatus)) {
                if (!anchor.dataset.staleReservedTop) {
                    const currentPadTop = parseFloat(getComputedStyle(anchor).paddingTop) || 0;
                    anchor.style.paddingTop = (currentPadTop + 20) + 'px';
                    anchor.dataset.staleReservedTop = '1';
                }
            }

            // 1. STALE (Updates)
            if (data.isStale) {
                // Software default
                const indicator = document.createElement('div');
                indicator.className = 'jira-stale-indicator';
                indicator.dataset.issueKey = data.key || '';
                indicator.innerText = `🕒 Stale (${Math.floor(data.daysSinceUpdate)}d)`;

                // Default styling (Software Boards - div cards)
                let css = 'position: absolute; top: 4px; left: 8px; background: #fff0f0; border: 1px solid #ccc; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #666; z-index: 20; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';

                // Business Boards (Anchor cards) - Place inside to avoid clipping/grid issues
                if (element.tagName === 'A') {
                    // Use positive top to place inside card, avoid breaking grid layout
                    css = 'position: absolute; top: 4px; left: 8px; background: #fff0f0; border: 1px solid #ccc; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #666; z-index: 1000; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';
                }

                if (isTimeline) {
                    // Flow naturally after text
                    css = 'display: inline-flex; margin-left: 8px; vertical-align: middle; background: #fff0f0; border: 1px solid #ccc; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #666; z-index: 1000; white-space: nowrap; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';
                }

                indicator.style.cssText = css;
                anchor.appendChild(indicator);
            }

            // PING PONG: Old & not started
            if (data.isPingPong) {
                if (!isTimeline) {
                    anchor.style.border = '2px solid #ff9900';
                    anchor.style.boxSizing = 'border-box';
                    anchor.dataset.staleBorder = '1';
                }

                const ppIndicator = document.createElement('div');
                ppIndicator.className = 'jira-stale-indicator';
                ppIndicator.dataset.issueKey = data.key || '';
                ppIndicator.innerText = `🛑 Stuck (${Math.floor(data.daysSinceCreation)}d)`;

                let css = 'position: absolute; top: 4px; right: 8px; background: #fff8e1; border: 1px solid #ff9900; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #cc7a00; z-index: 20; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';

                // Business Boards
                if (element.tagName === 'A') {
                    css = 'position: absolute; top: 4px; right: 8px; background: #fff8e1; border: 1px solid #ff9900; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #cc7a00; z-index: 1000; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';
                }

                if (isTimeline) {
                    // Flow naturally after text
                    css = 'display: inline-flex; margin-left: 8px; vertical-align: middle; background: #fff8e1; border: 1px solid #ff9900; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #cc7a00; z-index: 1000; white-space: nowrap; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';
                }

                ppIndicator.style.cssText = css;
                anchor.appendChild(ppIndicator);
            }

            // STUCK IN STATUS: Active but stuck
            if (data.isStuckInStatus) {
                const stuckIndicator = document.createElement('div');
                stuckIndicator.className = 'jira-stale-indicator';
                stuckIndicator.dataset.issueKey = data.key || '';
                stuckIndicator.innerText = `⚓ Stuck: ${data.currentStatus} (${Math.floor(data.daysInStatus)}d)`;

                let css = 'position: absolute; top: 4px; right: 8px; background: #f3e5f5; border: 1px solid #7b1fa2; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #7b1fa2; z-index: 20; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';

                if (element.tagName === 'A') {
                    css = 'position: absolute; top: 4px; right: 8px; background: #f3e5f5; border: 1px solid #7b1fa2; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #7b1fa2; z-index: 1000; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';
                }

                if (isTimeline) {
                    // Flow naturally after text
                    css = 'display: inline-flex; margin-left: 8px; vertical-align: middle; background: #f3e5f5; border: 1px solid #7b1fa2; font-size: 10px; padding: 1px 4px; border-radius: 4px; color: #7b1fa2; z-index: 1000; white-space: nowrap; box-shadow: 0 1px 2px rgba(0,0,0,0.1);';
                } else {
                    // Only apply border if NOT timeline
                    anchor.style.border = '2px solid #7b1fa2';
                    anchor.style.boxSizing = 'border-box';
                    anchor.dataset.staleBorder = '1';
                }

                stuckIndicator.style.cssText = css;
                anchor.appendChild(stuckIndicator);
            }

        } else if (context === 'detail') {
            let targetParams = null;

            if (data.isStale) {
                targetParams = { text: `🕒 Stale (${Math.floor(data.daysSinceUpdate)}d)`, bg: '#fff0f0', border: '#ccc', color: '#666' };
            } else if (data.isPingPong) {
                targetParams = { text: `🛑 Stuck (${Math.floor(data.daysSinceCreation)}d)`, bg: '#fff8e1', border: '#ff9900', color: '#cc7a00' };
            } else if (data.isStuckInStatus) {
                targetParams = { text: `⚓ Stuck in ${data.currentStatus} (${Math.floor(data.daysInStatus)}d)`, bg: '#f3e5f5', border: '#7b1fa2', color: '#7b1fa2' };
            }

            if (targetParams) {
                // Secondary check: if an indicator with this key already exists in the container
                const existing = element.querySelector(`.jira-stale-indicator-detail[data-issue-key="${data.key}"]`);
                if (existing) {
                    return;
                }

                const badge = document.createElement('div');
                badge.className = 'jira-stale-indicator-detail';
                badge.setAttribute('data-issue-key', data.key || '');
                badge.innerText = targetParams.text;
                badge.style.cssText = `display: inline-block; margin-left: 10px; background: ${targetParams.bg}; border: 1px solid ${targetParams.border}; color: ${targetParams.color}; padding: 2px 6px; border-radius: 4px; font-size: 12px; font-weight: bold; vertical-align: middle; z-index: 1000; position: relative;`;

                // Try copy button first
                const copyButton = element.querySelector('.jira-universal-copy-button-wrapper');
                if (copyButton && copyButton.offsetParent && !inRichText(copyButton)) {
                    if (copyButton.nextSibling && copyButton.nextSibling.classList && copyButton.nextSibling.classList.contains('jira-stale-indicator-detail')) return;

                    log('Placing detail indicator next to Copy Button');
                    copyButton.parentNode.insertBefore(badge, copyButton.nextSibling);
                    return;
                }

                // Try action bar
                const actionBar = element.querySelector('[data-testid="issue.views.issue-base.foundation.quick-add.quick-add-container"]');
                if (actionBar && !inRichText(actionBar)) {
                    if (actionBar.previousSibling && actionBar.previousSibling.classList && actionBar.previousSibling.classList.contains('jira-stale-indicator-detail')) return;

                    log('Placing detail indicator before Action Bar');
                    actionBar.insertAdjacentElement('beforebegin', badge);
                    return;
                }

                // Try breadcrumbs (never inside the description/comment rich-text body)
                let breadcrumbs = element.querySelector('[data-testid*="breadcrumbs"]');
                if (breadcrumbs && inRichText(breadcrumbs)) breadcrumbs = null;

                if (!breadcrumbs && data.key) {
                    // Pick a key link that is NOT a smart-link inside prose, so the badge lands
                    // on the breadcrumb/header, never mid-description.
                    const keyLink = [...document.querySelectorAll(`a[href*="/browse/${data.key}"]`)]
                        .find((a) => !inRichText(a) && a.getBoundingClientRect().width > 0);
                    if (keyLink) {
                        breadcrumbs = keyLink;
                        log('Found issue key link directly:', data.key);
                    }
                }

                if (breadcrumbs) {
                    if (breadcrumbs.nextSibling && breadcrumbs.nextSibling.classList && breadcrumbs.nextSibling.classList.contains('jira-stale-indicator-detail')) return;

                    log('Placing detail indicator after Breadcrumbs/KeyLink');
                    breadcrumbs.insertAdjacentElement('afterend', badge);
                    return;
                }

                // Fallback to summary
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
                        if (inRichText(summary)) continue; // never inside description/comment body
                        if (summary.innerText && summary.innerText.trim().length > 0) {
                            if (summary.querySelector('.jira-stale-indicator-detail')) return;

                            log('Found summary via fallback selector:', sel);
                            summary.appendChild(badge);
                            return;
                        }
                    }
                }

                log('Failed to find insertion point for detail indicator');
            }
        }
    }

    let lastUrl = window.location.href;
    const POLLING_INTERVAL = 500;
    const RETRY_LIMIT = 10;
    const RETRY_DELAY = 300;

    async function processIssueView(containerElement, attempt = 1) {
        let key = getIssueKeyFromUrl(window.location.href);

        // Fallback: check breadcrumbs
        if (!key) {
            const breadcrumbLink = containerElement.querySelector('a[href*="/browse/"]');
            if (breadcrumbLink) {
                const match = breadcrumbLink.href.match(/\/browse\/([A-Z][A-Z0-9]+-[0-9]+)/);
                if (match) key = match[1];
            }
        }

        if (!key) {
            if (attempt <= RETRY_LIMIT) {
                setTimeout(() => processIssueView(containerElement, attempt + 1), RETRY_DELAY);
            } else {
                log('Failed to identify issue key after multiple attempts');
            }
            return;
        }

        // Skip board headers
        const isBoardHeader = containerElement.matches('div[data-testid*="board-header"], div[data-testid*="project-header"], h1, h2, header');
        const insideBoardHeader = containerElement.closest('div[data-testid*="board-header"], div[data-testid*="project-header"], header');
        if (isBoardHeader || insideBoardHeader) return;

        const existingIndicator = containerElement.querySelector('.jira-stale-indicator-detail');
        if (existingIndicator) {
            if (existingIndicator.dataset.issueKey === key) return;
            existingIndicator.remove(); // container reused for a different issue
        }

        if (CACHE.has(key)) {
            applyHighlights(containerElement, CACHE.get(key), 'detail');
            return;
        }

        fetchAndApply(key, containerElement, 'detail');
    }

    function scanPage() {
        const selector = 'div[data-testid*="card-content"], div.ghx-issue, a[href*="/browse/"]';
        const elements = document.querySelectorAll(selector);
        const processedCards = new Set();

        try {
            elements.forEach(el => {
                let card = null;

                if (el.tagName === 'A') {
                    if (/\/browse\/[A-Z][A-Z0-9]+-[0-9]+/.test(el.href)) {
                        const isInsideSoftwareCard = el.closest('div[data-testid="platform-board-kit.ui.card.card"], div.ghx-issue, div.js-issue, div[data-testid*="card-content"]');
                        const isInsideView = el.closest('div[role="dialog"], div[data-testid*="modal-dialog"], #jira-issue-header, [data-testid*="issue.views.issue-base.foundation.summary.heading"]');

                        // Skip links inside rich-text (description, comments, activity): both the
                        // editor (.ProseMirror) and the read-only renderer (.ak-renderer-document).
                        // Smart-links in prose are not list rows and must not be badged.
                        const isInsideEditor = el.closest('.ProseMirror, [contenteditable="true"], input, textarea, .ak-renderer-document');

                        if (!isInsideSoftwareCard && !isInsideView && !isInsideEditor) {
                            card = el;
                        }
                    }
                } else {
                    card = el.closest('div[data-testid="platform-board-kit.ui.card.card"], div.ghx-issue, div.js-issue');
                    if (!card) card = el;
                }

                if (card && !processedCards.has(card)) {
                    processedCards.add(card);
                    processCard(card);
                }
            });
        } catch (err) {
            log('Error scanning cards:', err);
        }

        // Scan modals
        const modals = document.querySelectorAll('div[role="dialog"], div[data-testid*="modal-dialog"]');
        modals.forEach(modal => {
            if (modal.offsetParent !== null) {
                processIssueView(modal);
            }
        });

        // Scan full page view
        if (window.location.pathname.includes('/browse/') || window.location.search.includes('selectedIssue')) {
            const issueHeader = document.querySelector('div[id="jira-issue-header"]');
            const container = issueHeader ? (issueHeader.closest('#jira-frontend') || issueHeader.parentElement) : document.body;

            processIssueView(container);
        }
    }

    const observer = new MutationObserver(debounced(scanPage, 300));
    observer.observe(document.body, { childList: true, subtree: true });

    setInterval(() => {
        const currentUrl = window.location.href;
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            log('URL change detected via poll:', currentUrl);
            scanPage();
        }
    }, POLLING_INTERVAL);

    setTimeout(scanPage, 1000);

})();
