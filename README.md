# Jira Userscripts

A collection of Tampermonkey/Greasemonkey userscripts that enhance Jira Cloud functionality.

## Installation

1. Install a userscript manager like [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
2. Click on a script's "Install" link below, or copy the script contents into a new userscript

## Scripts

### Jira Copy Key & Title Button

Adds a convenient copy button to Jira Cloud that copies the issue key and title in both plain text and rich HTML formats (with clickable links).

**Features:**
- Works on full issue pages, modals, and Product Discovery views
- Copies as both plain text (`DEV-123 Issue Title`) and rich HTML (clickable link)
- Toast notification confirms successful copy

**[Install](https://raw.githubusercontent.com/cjonesde/jira-userscripts/main/Jira%20Copy%20Key%20and%20Title%20Button.user.js)** | Version 1.6.2

---

### Jira Board/Backlog Indicator

Displays a visual badge showing whether a ticket is on the active Board or in the Backlog.

**Features:**
- Color-coded badges: green "BOARD" or blue "BACKLOG"
- Automatic board detection from URL or API
- Works on issue pages and modals
- Caches results for performance

**[Install](https://raw.githubusercontent.com/cjonesde/jira-userscripts/main/Jira%20Board%20or%20Backlog%20Indicator.user.js)** | Version 1.5.4

---

### Jira Stale Ticket Highlighter

Highlights stale and stuck tickets on Jira boards with visual indicators.

**Features:**
- 🕒 **Stale** (red badge): Tickets with no updates for 30+ days
- 🛑 **Stuck** (orange badge): Old tickets (14+ days) that never reached an active status
- ⚓ **Stuck in Status** (purple badge): Tickets stuck in the same active status for 14+ days

Works across the board, backlog, list view, epic child items, linked work items, and the issue page. Badges are placed so they never cover the issue key, title, or assignee, and smart-links inside descriptions and comments are left alone.

**[Install](https://raw.githubusercontent.com/cjonesde/jira-userscripts/main/Jira%20Stale%20Ticket%20Highlighter.user.js)** | Version 1.1.7

#### Configuration

The script uses status names to determine ticket state. You'll need to edit the `CONFIG` object at the top of the script to match your Jira workflow:

```javascript
const CONFIG = {
    STALE_THRESHOLD_DAYS: 30,      // Days without updates before "Stale"
    PING_PONG_MIN_AGE_DAYS: 14,    // Days old before "Stuck" (never started)
    STUCK_IN_STATUS_DAYS: 14,      // Days in same status before "Stuck in Status"
    PROGRESS_STATUSES: [           // Statuses that mean work has started
        'In Progress',
        'Tech Review',
        'Merged',
        'Testing',
        'Ready for Release'
    ],
    DONE_STATUSES: [               // Statuses that mean work is complete
        'Done',
        'Done (deployed to prod)',
        'Closed'
    ]
};
```

**Important:** Update `PROGRESS_STATUSES` and `DONE_STATUSES` to match the exact status names in your Jira project. The script uses these to determine:
- Whether a ticket has ever been worked on (for "Stuck" detection)
- Whether to skip completed tickets
- Which statuses trigger "Stuck in Status" warnings

---

## Compatibility

- Jira Cloud (`*.atlassian.net`)
- Tampermonkey / Violentmonkey / Greasemonkey
- **Tested with Jira Cloud as of January 2026**

> **Note:** Atlassian may introduce breaking changes to Jira's frontend at any time without notice. If a script stops working, please [open an issue](https://github.com/cjonesde/jira-userscripts/issues).

## License

MIT
