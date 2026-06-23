// ==UserScript==
// @name         Jira Board/Backlog Indicator
// @namespace    https://github.com/cjonesde/jira-userscripts
// @version      1.5.4
// @description  Display if a ticket is on the Board or in the Backlog with automatic detection
// @author       Christopher Jones
// @match        https://*.atlassian.net/jira/*
// @match        https://*.atlassian.net/browse/*
// @homepageURL  https://github.com/cjonesde/jira-userscripts
// @supportURL   https://github.com/cjonesde/jira-userscripts/issues
// @downloadURL  https://raw.githubusercontent.com/cjonesde/jira-userscripts/main/Jira%20Board%20or%20Backlog%20Indicator.user.js
// @updateURL    https://raw.githubusercontent.com/cjonesde/jira-userscripts/main/Jira%20Board%20or%20Backlog%20Indicator.user.js
// @grant        none
// ==/UserScript==

/**
 * Displays a color-coded badge showing whether a Jira ticket is on the
 * active Board (green) or in the Backlog (blue). Automatically detects
 * the board context from URL or API.
 */
(function () {
    'use strict';

    const log = (...args) => console.log('[Jira Indicator]', ...args);

    const CACHE = new Map();
    let lastIssueKey = null;
    let lastBoardId = null;
    let processingKey = null;
    let placementTimer = null;
    let indicatorPlacedForKey = null;

    log('Script loaded');

    function getIssueKey() {
        const path = window.location.pathname;
        const browseMatch = path.match(/\/browse\/([A-Z]+-[0-9]+)/);
        if (browseMatch) return browseMatch[1];

        const urlParams = new URLSearchParams(window.location.search);
        const selectedIssue = urlParams.get('selectedIssue');
        if (selectedIssue) return selectedIssue;

        return null;
    }

    function detectBoardId() {
        const pathMatch = window.location.pathname.match(/\/boards\/(\d+)/);
        if (pathMatch && pathMatch[1]) {
            return pathMatch[1];
        }

        const params = new URLSearchParams(window.location.search);
        return params.get('rapidView') || params.get('boardId') || null;
    }

    async function fetchBoardIdForIssue(key) {
        try {
            const boardsResp = await fetch(`/rest/agile/1.0/issue/${key}/board`);
            if (!boardsResp.ok) return null;

            const boardsData = await boardsResp.json();
            const boards = boardsData?.values || [];

            if (boards.length > 0) {
                return (boards[0].id || boards[0].boardId).toString();
            }
        } catch (error) {
            log('Error fetching board:', error.message);
        }
        return null;
    }

    async function checkBoardMembership(boardId, key) {
        const jql = `issueKey=${key}`;

        try {
            const backlogResp = await fetch(`/rest/agile/1.0/board/${boardId}/backlog?jql=${encodeURIComponent(jql)}&maxResults=1`);
            if (backlogResp.ok) {
                const backlogData = await backlogResp.json();
                if ((backlogData?.total ?? backlogData?.issues?.length ?? 0) > 0) {
                    return 'Backlog';
                }
            }
        } catch (error) {
            log('Error checking backlog:', error.message);
        }

        try {
            const boardResp = await fetch(`/rest/agile/1.0/board/${boardId}/issue?jql=${encodeURIComponent(jql)}&maxResults=1`);
            if (boardResp.ok) {
                const boardData = await boardResp.json();
                if ((boardData?.total ?? boardData?.issues?.length ?? 0) > 0) {
                    return 'Board';
                }
            }
        } catch (error) {
            log('Error checking board:', error.message);
        }

        return 'Unknown';
    }

    async function checkStatus(key, boardId) {
        if (!boardId) return 'Backlog';

        const cacheKey = `${boardId}:${key}`;
        if (CACHE.has(cacheKey)) {
            return CACHE.get(cacheKey);
        }

        const membership = await checkBoardMembership(boardId, key);
        const status = membership === 'Unknown' ? 'Backlog' : membership;

        CACHE.set(cacheKey, status);
        return status;
    }

    function getProjectKey(key) {
        const [project] = key.split('-');
        return project ? project.toUpperCase() : null;
    }

    async function fetchBoardsForProject(projectKey) {
        if (!projectKey) return [];

        const boards = [];
        let startAt = 0;
        let more = true;

        while (more) {
            try {
                const resp = await fetch(`/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=50&startAt=${startAt}`);
                if (!resp.ok) break;

                const data = await resp.json();
                const values = data?.values || [];
                boards.push(...values);

                if (data.isLast || values.length === 0) {
                    more = false;
                } else {
                    startAt += values.length;
                }
            } catch (error) {
                log('Error fetching boards:', error.message);
                break;
            }
        }

        return boards;
    }

    async function findBoardContextForIssue(key) {
        const projectKey = getProjectKey(key);
        if (!projectKey) return null;

        const boards = await fetchBoardsForProject(projectKey);
        if (!boards.length) return null;

        for (const board of boards) {
            const candidateId = board?.id ?? board?.boardId;
            if (!candidateId) continue;

            const boardId = candidateId.toString();
            const membership = await checkBoardMembership(boardId, key);
            if (membership !== 'Unknown') {
                return { boardId, status: membership };
            }
        }

        return null;
    }

    function createIndicator(text, color, bg) {
        const indicator = document.createElement('div');
        indicator.id = 'jira-board-backlog-indicator';
        indicator.textContent = text;
        Object.assign(indicator.style, {
            padding: '4px 8px',
            marginLeft: '8px',
            borderRadius: '3px',
            fontWeight: '600',
            fontSize: '11px',
            display: 'inline-flex',
            alignItems: 'center',
            verticalAlign: 'middle',
            backgroundColor: bg,
            color: color,
            flexShrink: '0'
        });
        return indicator;
    }

    function placeIndicator(indicator) {
        const existing = document.getElementById('jira-board-backlog-indicator');
        if (existing) existing.remove();

        const copyButton = document.querySelector('.jira-universal-copy-button-wrapper');
        if (copyButton && copyButton.offsetParent) {
            copyButton.insertAdjacentElement('afterend', indicator);
            return true;
        }

        const actionBar = document.querySelector('[data-testid="issue.views.issue-base.foundation.quick-add.quick-add-container"]');
        if (actionBar) {
            actionBar.insertAdjacentElement('beforebegin', indicator);
            return true;
        }

        const breadcrumbs = document.querySelector('[data-testid*="breadcrumbs"]');
        if (breadcrumbs && breadcrumbs.offsetParent) {
            breadcrumbs.insertAdjacentElement('afterend', indicator);
            return true;
        }

        return false;
    }

    async function updateIndicator() {
        const key = getIssueKey();
        if (!key) {
            indicatorPlacedForKey = null;
            return;
        }

        if (processingKey === key) return;

        const existingIndicator = document.getElementById('jira-board-backlog-indicator');
        if (indicatorPlacedForKey === key && existingIndicator && existingIndicator.offsetParent) {
            return;
        }

        processingKey = key;

        if (key !== lastIssueKey) {
            lastIssueKey = key;
            CACHE.clear();
        }

        let boardId = detectBoardId();
        let resolvedStatus = null;

        if (boardId && boardId !== lastBoardId) {
            lastBoardId = boardId;
            CACHE.clear();
        } else if (!boardId) {
            boardId = await fetchBoardIdForIssue(key);
            if (boardId) {
                lastBoardId = boardId;
            }
        } else {
            boardId = lastBoardId;
        }

        if (!boardId) {
            const fallback = await findBoardContextForIssue(key);
            if (fallback) {
                ({ boardId, status: resolvedStatus } = fallback);
                lastBoardId = boardId;
                CACHE.set(`${boardId}:${key}`, resolvedStatus);
            }
        }

        if (!boardId) {
            processingKey = null;
            return;
        }

        const status = resolvedStatus || await checkStatus(key, boardId);

        let text, bg, color;
        if (status === 'Board') {
            text = 'BOARD';
            bg = '#E3FCEF';
            color = '#006644';
        } else {
            text = 'BACKLOG';
            bg = '#DEEBFF';
            color = '#0747A6';
        }

        const indicator = createIndicator(text, color, bg);

        if (placementTimer) {
            clearTimeout(placementTimer);
        }

        const tryPlace = (attempt = 0) => {
            if (attempt > 5) {
                log('Failed to place indicator after 5 attempts');
                processingKey = null;
                return;
            }

            if (placeIndicator(indicator)) {
                processingKey = null;
                indicatorPlacedForKey = key;
                return;
            }

            placementTimer = setTimeout(() => tryPlace(attempt + 1), 300);
        };

        tryPlace();
    }

    let debounceTimer = null;
    function debounced(fn, delay) {
        return () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(fn, delay);
        };
    }

    const observer = new MutationObserver(debounced(updateIndicator, 1000));
    observer.observe(document.body, { childList: true, subtree: true });

    let lastUrl = window.location.href;
    setInterval(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            processingKey = null;
            updateIndicator();
        }
    }, 1000);

    updateIndicator();
})();
