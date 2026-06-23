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

Works across the board, backlog, list/table view, epic child items, line cards, linked work items, and the issue page. Badges are placed so they never cover the issue key, title, or assignee, and smart-links inside descriptions and comments are left alone.

**Version 2 highlights:**
- **One batched API call per render** (`/rest/api/3/issue/bulkfetch`) instead of one request per visible card, with a concurrency cap and 429 backoff.
- **Status-category detection** (`new` / `indeterminate` / `done`), so it works on renamed or non-English workflows. The status-name lists are now optional overrides.
- **Settings menu** for tuning thresholds (via your userscript manager), so you no longer have to edit the file.
- TTL/LRU cache mirrored to `sessionStorage`, changelog pagination, and badge cleanup on navigation.

**[Install](https://raw.githubusercontent.com/cjonesde/jira-userscripts/main/Jira%20Stale%20Ticket%20Highlighter.user.js)** | Version 2.0.0

#### Configuration

Open your userscript manager's menu for this script and pick **"⚙ Configure thresholds"** to set:

| Setting | Default | Meaning |
| --- | --- | --- |
| Stale after | 30 days | Days without updates before 🕒 Stale |
| Stuck after | 14 days | Days old before 🛑 Stuck (never started) |
| Stuck in status after | 14 days | Days in the same active status before ⚓ Stuck in Status |
| Progress status names | (optional) | Override the changelog match for "has work started" |
| Done status names | (optional) | Override which statuses count as complete |

Detection now keys off Jira's **status category** (`To Do` / `In Progress` / `Done`), so completed tickets are skipped and active tickets are flagged even when statuses are renamed or localized. The status-name lists are only needed if your workflow's categories are mis-mapped, or to refine the changelog "has it ever started" check (changelog entries expose status names, not categories).

> The settings menu needs `GM_getValue`/`GM_setValue`, which Tampermonkey, Violentmonkey, and Greasemonkey all provide. Without them the script still runs on its defaults. To change defaults directly, edit the `DEFAULTS` object at the top of the script.

---

## Compatibility

- Jira Cloud (`*.atlassian.net`)
- Tampermonkey / Violentmonkey / Greasemonkey
- **Tested with Jira Cloud as of June 2026**

> **Note:** Atlassian may introduce breaking changes to Jira's frontend at any time without notice. If a script stops working, please [open an issue](https://github.com/cjonesde/jira-userscripts/issues).

## License

MIT
