# Project Schedule

A Gantt chart with real dependency scheduling, shared live by the team. Static page on
GitHub Pages, data in Firebase, Google sign in restricted to vt.edu.

Everyone sees edits as they happen. Writes go field by field, so two people working on
different rows never overwrite each other.

## Files

```
index.html      the page and all styling
app.js          the interface
scheduler.js    working day calendar and dependency resolution
store.js        Firebase reads, writes and presence
config.js       your Firebase project settings
```

## Setup

Firebase is already configured for project `gantt-chart-bf9ce`. What is left:

1. Put these five files in the root of a GitHub repository.
2. Settings, Pages, Source: Deploy from a branch, `main` / root.
3. In the Firebase console under Authentication, Settings, Authorized domains, add
   `yourname.github.io`. Without this Google sign in will refuse to open.
4. Confirm the database rules are published:

```json
{
  "rules": {
    "schedule": {
      ".read": "auth != null && auth.token.email_verified == true && auth.token.email.matches(/.*@vt[.]edu$/)",
      ".write": "auth != null && auth.token.email_verified == true && auth.token.email.matches(/.*@vt[.]edu$/)"
    }
  }
}
```

Open the page, sign in, and a starter schedule is created on first run. Everyone else
just signs in. There is nothing to install and no token to paste or renew.

Testing locally: run `python3 -m http.server 8000` in the folder and open
`http://localhost:8000`. Opening the file directly will not work, because browsers
block module loading and sign in popups from `file://`.

## Using it

| Action | How |
| --- | --- |
| Rename, set responsible, days, percent | Click the cell and type |
| Set a date | Click the Start or Finish cell, pick from the calendar |
| Add a sub task | Hover a row, click the plus on the right of the name |
| Add a phase | Plus in the Task Name column header |
| Delete | Hover a row, click the bin. Or select it and press Delete |
| Change nesting | Tab to indent, Shift Tab to outdent |
| Reorder | Drag the row number. Drop on the middle of a row to nest inside it |
| Collapse a phase | Triangle to the left of the name |
| Move a task in time | Drag its bar |
| Change length | Drag the right edge of the bar |
| Link two tasks | Hover a bar, drag the circle on either end onto another bar |
| Remove a link | Click the arrow |
| Change phase colour | Click the small square next to a phase name |
| Undo | Ctrl or Cmd Z |

**Milestones** are tasks with zero days. Set the Days cell to 0 and the bar becomes a
diamond. Set it back to a number and it becomes a normal task again.

**Percent done** on a phase is calculated from its children, weighted by length, so a
20 day task counts for more than a 2 day one. You cannot type over it directly.

**Days are working days.** Weekends are skipped automatically. Add university holidays
under Account, Non working days, and they are skipped too.

## How dates are decided

A task with nothing linked into it sits on its own date. A task with a predecessor is
scheduled from that predecessor, as early as it can start.

If you drag a linked task, or type a date into its Start cell, that becomes an override
and the task stays there. Anything downstream shifts to follow. The Start cell shows a
small amber dot when a date is set by hand. Right click that cell to clear the override
and let the dependency drive it again.

Dates are never saved. Only durations, links and overrides are stored, and each browser
computes the chart from those. That is why everyone always sees the same thing, and why
changing one duration ripples through immediately for the whole team.

Dependencies attach to individual tasks, not to phase rows. If you try to link a phase
the app tells you and asks you to link the tasks inside it. Links that would create a
loop are refused when you draw them.

## Exports

Export gives a PNG or SVG of the whole chart, laid out for printing rather than for the
screen, with every row shown including collapsed ones. The SVG is vector, so it scales
cleanly into a report or a poster. CSV gives the table with outline numbers, dates and
dependencies.

## Adding or removing people

Anyone with a vt.edu Google account can open it. To narrow that to specific people,
replace the rules with an allow list:

```json
{
  "rules": {
    "schedule": {
      ".read": "auth != null && auth.token.email_verified == true && root.child('members').child(auth.token.email.replace('.', ',')).exists()",
      ".write": "auth != null && auth.token.email_verified == true && root.child('members').child(auth.token.email.replace('.', ',')).exists()"
    },
    "members": { ".read": "auth != null", ".write": false }
  }
}
```

Then add each person under `members` in the database as a key like `jsmith@vt,edu` set
to `true`. Dots become commas because Firebase keys cannot contain a dot.

## Limits worth knowing

- No version history. Undo covers the last 30 changes in your own browser, but there is
  no way to see what the schedule looked like last Tuesday.
- No resource levelling, cost tracking or baselines. This is a schedule, not a full
  project management suite.
- Free Firebase covers this easily. The Spark plan allows 1 GB of storage and 100
  people connected at once, and a schedule like this is around 50 KB.
- Best on a laptop. It works on a tablet but the drag interactions want a mouse.

## Notes for whoever maintains it

`scheduler.js` is pure and has no dependencies, so it can be tested on its own. The
scheduling is a working day calendar plus a topological sort over the dependency graph
and a forward pass for dates. Durations are integers indexing into the calendar, which
is what makes weekend and holiday handling fall out for free.

`app.js` re-renders the grid and timeline whenever data changes. During a drag it moves
only the element being dragged and commits once on release, so nothing flickers.

Colours live on the top level phase row and every descendant inherits, which is why the
swatch only appears on phases.
