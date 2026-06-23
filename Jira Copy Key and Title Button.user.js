// ==UserScript==
// @name         Jira Copy Key & Title Button
// @namespace    https://github.com/cjonesde/jira-userscripts
// @version      1.6.2
// @description  Adds a button to Jira Cloud (full page, modal & Product Discovery) that copies Task Key and Title in multiple formats
// @author       Christopher Jones
// @match        https://*.atlassian.net/browse/*
// @match        https://*.atlassian.net/jira/*
// @match        https://*.atlassian.net/*issues*
// @match        https://*.atlassian.net/jira/polaris/*
// @homepageURL  https://github.com/cjonesde/jira-userscripts
// @supportURL   https://github.com/cjonesde/jira-userscripts/issues
// @downloadURL  https://raw.githubusercontent.com/cjonesde/jira-userscripts/main/Jira%20Copy%20Key%20and%20Title%20Button.user.js
// @updateURL    https://raw.githubusercontent.com/cjonesde/jira-userscripts/main/Jira%20Copy%20Key%20and%20Title%20Button.user.js
// @grant        none
// ==/UserScript==

/**
 * Adds a copy button to Jira Cloud that copies issue key and title as both
 * plain text and rich HTML (with clickable link). Works on issue pages,
 * modals, and Product Discovery views.
 */
(function () {
    'use strict';
    console.log('[Jira Copy] Script loaded');

    const CHECK_INTERVAL = 1500;
    const COPY_BUTTON_CLASS = "jira-universal-copy-button";
    const TOAST_CONTAINER_ID = "jira-copy-toast-container";

    const COPY_BUTTON_HTML = `
        <div class="${COPY_BUTTON_CLASS}-wrapper" style="display: inline-flex; align-items: center; margin-right: 4px;">
            <button class="${COPY_BUTTON_CLASS} css-1pxwk5s" type="button" tabindex="0" title="Copy Key & Title" style="display: flex; flex-direction: row; align-items: center; padding: 4px 6px; font-size: 11px; min-height: auto; line-height: 1; white-space: nowrap; gap: 4px;">
                <span class="css-1uc6u2g" style="display: flex; justify-content: center;">
                    <span aria-hidden="true" style="color: currentcolor;">
                        <svg fill="none" viewBox="0 0 16 16" role="presentation" style="width: 12px; height: 12px;"><path fill="currentcolor" d="M4 2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1h1.5a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-8A1.5 1.5 0 0 1 3.5 3H4V2Zm1 .5V3h.5A1.5 1.5 0 0 1 7 4.5V5h2v-.5A1.5 1.5 0 0 1 10.5 3H11V2.5a.5.5 0 0 0-.5-.5H5.5a.5.5 0 0 0-.5.5ZM3.5 4A.5.5 0 0 0 3 4.5v8a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-8a.5.5 0 0 0-.5-.5H11v.5a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5V4H7v.5a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5V4H3.5Z"/></svg>
                    </span>
                </span>
                <span class="css-178ag6o" style="font-size: 11px;">Copy</span>
            </button>
        </div>`;

    const isVisible = (el) => !!(el && (el.offsetParent || (el.getClientRects?.().length ?? 0)));

    const createButtonElement = () => {
        const tpl = document.createElement('template');
        tpl.innerHTML = COPY_BUTTON_HTML.trim();
        // Return the actual element, not a fragment, so insertAdjacentElement works
        return tpl.content.firstElementChild.cloneNode(true);
    };

    const showToast = (message) => {
        let container = document.getElementById(TOAST_CONTAINER_ID);
        if (!container) {
            container = document.createElement('div');
            container.id = TOAST_CONTAINER_ID;
            Object.assign(container.style, {
                position: 'fixed',
                top: '16px',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: '999999',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                alignItems: 'center',
                pointerEvents: 'none'
            });
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.textContent = message;
        Object.assign(toast.style, {
            background: '#0747A6',
            color: '#fff',
            padding: '8px 12px',
            borderRadius: '4px',
            boxShadow: '0 4px 10px rgba(0, 0, 0, 0.25)',
            fontSize: '12px',
            fontWeight: '600',
            opacity: '0',
            transition: 'opacity 0.2s ease-in-out',
            pointerEvents: 'auto'
        });

        container.appendChild(toast);
        requestAnimationFrame(() => { toast.style.opacity = '1'; });

        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => {
                toast.remove();
                if (!container.children.length) {
                    container.remove();
                }
            }, 200);
        }, 2500);
    };

    const copyToClipboard = (htmlText, plainText) => {
        const listener = (e) => {
            e.clipboardData.setData("text/html", htmlText);
            e.clipboardData.setData("text/plain", plainText);
            e.preventDefault();
        };
        document.addEventListener("copy", listener);
        document.execCommand("copy");
        document.removeEventListener("copy", listener);
    };

    const copyTaskKeyAndTitle = (modalContext) => {
        let issueKey = '';
        let issueTitle = '';
        try {
            const polarisKeyElement = document.querySelector('a[data-testid="polaris-ideas.ui.idea-view.breadcrumbs.key.key"]');
            const isPolaris = isVisible(polarisKeyElement);

            if (isPolaris) {
                issueKey = polarisKeyElement?.textContent?.trim() || '';
                const polarisTitle = document.querySelector('div[data-testid="polaris-ideas.ui.idea-view.summary.container"]');
                issueTitle = polarisTitle?.textContent?.trim() || '';
            } else {
                const context = modalContext || document;
                issueKey = context.querySelector('a[data-testid*="breadcrumbs.current-issue.item"] span')?.textContent?.trim() ||
                    context.querySelector('[data-testid*="key-renderer.issue-key-renderer.text"]')?.textContent?.trim() ||
                    '';
                issueTitle = context.querySelector('h1[data-testid*="summary.heading"]')?.textContent?.trim() || '';
            }

            if (!issueKey) { throw new Error("Could not find issue key."); }

            if (!issueTitle) {
                const docTitle = document.title;
                if (docTitle.includes(issueKey)) {
                    issueTitle = docTitle.substring(docTitle.indexOf(issueKey) + issueKey.length).replace(/^-/, '').replace(/- Jira$/, '').trim();
                }
            }

            const jiraBaseUrl = window.location.origin;
            const issueUrl = `${jiraBaseUrl}/browse/${issueKey}`;
            const plainText = `${issueKey} ${issueTitle || ''}`.trim();
            const htmlText = `<a href="${issueUrl}">${issueKey}</a> ${issueTitle || ''}`;

            copyToClipboard(htmlText, plainText);
            showToast(`Copied: ${plainText}`);

        } catch (e) {
            console.error("Jira Copy Script: Error during copy:", e);
            showToast(`Error: ${e.message}`);
        }
    };

    const injectButton = (target, position = 'append') => {
        if (!target) return false;

        // Precise check to avoid duplicates in specific context
        const existing = target.querySelector(`.${COPY_BUTTON_CLASS}`) ||
            (target.parentElement && target.parentElement.querySelector(`.${COPY_BUTTON_CLASS}`));
        if (existing) return true;

        const element = createButtonElement();
        if (position === 'before' && target.parentNode) {
            target.parentNode.insertBefore(element, target);
        } else if (position === 'after' && target.parentNode) {
            target.parentNode.insertBefore(element, target.nextSibling);
        } else {
            target.appendChild(element);
        }
        return true;
    };

    const initPlugin = () => {
        // Context-aware checking allows multiple buttons (e.g. Page + Modal)
        // We do NOT check global document.querySelector logic anymore to allow Modal injection

        const modal = document.querySelector('section[role="dialog"][data-testid*="modal-dialog"]');
        const searchContext = modal || document;

        // Try Polaris (Product Discovery) first
        const polarisTarget = searchContext.querySelector('div[data-testid="polaris-ideas.ui.idea-view.collaboration-controls.more-button-container"]');
        if (polarisTarget && isVisible(polarisTarget)) {
            injectButton(polarisTarget.parentElement || polarisTarget, 'before');
            return;
        }

        // Standard Jira placement
        const actionBar = searchContext.querySelector('[data-testid="issue.views.issue-base.foundation.quick-add.quick-add-container"]');
        if (actionBar && isVisible(actionBar)) {
            injectButton(actionBar, 'before');
            return;
        }

        const breadcrumbs = searchContext.querySelector('[data-testid*="breadcrumbs"]');
        if (breadcrumbs && isVisible(breadcrumbs)) {
            injectButton(breadcrumbs, 'after');
            return;
        }

        const summary = searchContext.querySelector('h1[data-testid*="summary"]');
        if (summary && isVisible(summary)) {
            injectButton(summary);
            return;
        }
    };

    const attachClickHandler = () => {
        document.body.addEventListener('click', (event) => {
            const button = event.target.closest(`.${COPY_BUTTON_CLASS}`);
            if (!button) return;
            event.stopPropagation();
            const modalCtx = button.closest('section[role="dialog"]');
            copyTaskKeyAndTitle(modalCtx || null);
        });
    };

    // Run immediately - Jira is a SPA, DOMContentLoaded has already fired
    setInterval(initPlugin, CHECK_INTERVAL);
    attachClickHandler();

    // Also run once immediately
    initPlugin();
})();
