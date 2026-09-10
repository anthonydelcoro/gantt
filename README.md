# Collaborative Gantt

A single-page Gantt chart with real dependency scheduling, hosted on GitHub Pages.
The schedule lives in `schedule.json` in this repo, so Git handles versioning,
attribution and conflict detection — no server, no database, no per-seat cost.

What it does that a spreadsheet doesn't: four dependency types with lag, automatic
successor shifting, working-day arithmetic with holidays, summary rollups,
milestones, total float and critical path.

---

## Setup (about ten minutes)

**1. Create a repository** and add these four files to the root:

```
index.html      the page
app.js          the scheduler and GitHub sync
schedule.json   your data
README.md       this file
```

**2. Turn on Pages.** Settings → Pages → Source: *Deploy from a branch* → `main` / `root`.
After a minute the site is at `https://<owner>.github.io/<repo>/`.

**3. Everyone who needs to edit creates a token.** Go to
[Settings → Developer settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new):

- **Repository access:** *Only select repositories* → this repo only
- **Permissions:** *Repository permissions → Contents → Read and write*
- **Expiration:** whatever your team is comfortable with; you'll be prompted to renew

Copy the token, open the site, click ⚙, paste it, save. It is kept in that browser's
localStorage and sent only to `api.github.com`. It never enters the repo.

Anyone without a token still sees the schedule — read-only.

**4. Confirm the repo settings** in the same ⚙ dialog. The page guesses owner and repo
from the Pages URL, which is right most of the time; correct it if not.

> **Trying it locally first?** Don't open `index.html` by double-clicking it — browsers
> block `fetch` from `file://`, so the schedule won't load. Run
> `python3 -m http.server 8000` in the folder and visit `http://localhost:8000`.

---

## Using it

| Action | How |
| --- | --- |
| Rename a task | Click the name cell and type |
| Change duration | Click the Days cell (working days, weekends excluded) |
| Set a dependency | Drag from the edge of one bar to another, or type in the **Pred.** column |
| Move a task in time | Drag its bar — this pins the date (📌) |
| Release a pinned date | Select the row → **Unpin date** |
| Add a row | **+ Task** or **◆ Milestone**, inserted below the selection |
| Make a sub-task | Select the row → **→** (indent). Parents become summary rows automatically |
| Reorder | Drag the row in the grid |
| Undo | Ctrl/Cmd + Z |
| Save | **Save** or Ctrl/Cmd + S — this commits to `schedule.json` |

**Predecessor syntax** matches MS Project. The number is the row's `#`:

```
5           finish-to-start, no lag
5FS+3d      finish-to-start, three working days later
5SS         start-to-start
5FF-2d      finish-to-finish, two days early
5, 9FS+1d   several predecessors
```

**Pinned vs. driven dates.** A task with no predecessor sits at its own date. A task
with a predecessor is scheduled from it, as soon as possible. If you drag a task that
has a predecessor, it gets pinned (a "start no earlier than" constraint) and stops
moving earlier — the same thing MS Project does. Unpin to hand it back to the network.

**Critical path** is computed from total float — tasks with zero float. Toggle the
highlight with the **Critical path** button. The Float column shows slack in working
days.

**Non-working time.** Weekends are always skipped. Add company holidays to the
`holidays` array in `schedule.json` as `"YYYY-MM-DD"` and they're excluded too.

**Exports.** *Chart ▾* gives a print-ready SVG (vector, drops into Word, Illustrator
or a slide at any size) or a PNG. *CSV* gives the table with dates, float and
predecessors for anyone who wants it in a spreadsheet.

---

## How collaboration works

The page reads `schedule.json` along with its Git blob SHA. When you save, that SHA
goes back to GitHub. If someone committed in between, your SHA is stale and GitHub
**refuses the write** rather than silently overwriting their work — you get a banner
telling you to reload. While you have the page open it also polls every 45 seconds
and quietly pulls in a teammate's changes if you have nothing unsaved.

This is deliberately not real-time co-editing. Two people typing at once will make
one of them redo their edits. For two or three editors it's rarely a problem, and
you get things Project never gave you: every change is a commit, with an author, a
timestamp, a diff, and the ability to revert.

Practical habits that help:

- Save often. Small commits collide less.
- During planning, when everyone's in it at once, agree that one person drives.
- To see what changed: the repo's commit history on `schedule.json`.
- To roll back: revert the commit, or restore an older version of the file.

---

## Data format

```jsonc
{
  "project": "Example Project",
  "project_start": "2026-09-14",     // where unconstrained tasks begin
  "holidays": ["2026-11-26"],        // non-working days
  "tasks": [
    {
      "id": 3,                       // stable; what Pred. references
      "text": "Requirements",
      "parent": 1,                   // 0 = top level; a row with children is a summary
      "duration": 5,                 // working days; 0 or type "milestone" for a diamond
      "progress": 0.4,               // 0–1
      "type": "task",                // "task" | "milestone"
      "constraint_date": null        // "YYYY-MM-DD" pins the start
    }
  ],
  "links": [
    { "id": 1, "source": 3, "target": 4, "type": "0", "lag": 0 }
    // type: "0" FS, "1" SS, "2" FF, "3" SF. lag is in working days, may be negative.
  ]
}
```

The file is plain JSON, so you can also edit it directly, generate it from a script,
or diff it in a pull request.

---

## Limits worth knowing

- **Dependencies attach to leaf tasks, not summary rows.** Link the children. The page
  warns you if a link touches a summary.
- **No resource levelling, baselines, or cost tracking.** This is a schedule, not a
  PM suite. If you need those, you need Project or something like it.
- **Public repo means a public schedule.** GitHub Pages on a free account only serves
  public repos. If the plan is sensitive, either use a paid plan (Pages can serve
  private repos on Pro/Team), or keep the repo private, skip Pages, and have everyone
  run the folder locally with `python3 -m http.server`. In that setup *everyone* needs
  a token, including viewers — with a token the page reads through the GitHub API
  rather than off the Pages site.
- **Circular dependencies** are detected and reported rather than fixed. The tasks
  involved stay at their own dates until you break the loop.

## Under the hood

The chart is [DHTMLX Gantt Community Edition](https://github.com/DHTMLX/gantt) 10.0.3,
MIT-licensed, loaded from a CDN. It draws the grid, bars and dependency arrows.

Its automatic scheduling and critical-path features are PRO-only, so `app.js`
implements those: a working-day calendar, a topological sort over the dependency
graph, then a forward pass for early dates and a backward pass for total float —
standard CPM, about 200 lines. That's also why the schedule is recomputed from the
dependency network on every edit rather than stored as fixed dates.

To pin the library version or work offline, download
`codebase/dhtmlxgantt.js` and `.css` from the npm package into the repo and point
`index.html` at the local copies.
