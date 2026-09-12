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
| Change or remove a link | Click the arrow |
| Overlap or space out two linked tasks | Click the arrow, set the offset |
| Change phase color | Click the small square next to a phase name |
| Undo | Ctrl or Cmd Z |
| Show or hide a column | Right click the column headers, or Account, Columns to show |
| Resize a column | Drag the divider in the header, like a spreadsheet |
| Move a column | Drag its header left or right |
| Open or fold everything | Expand all and Collapse all in the top bar |

**Colors** live on the phase row. Click the small square to the left of a phase name
and pick one of the eight presets or open the custom picker underneath them. The chart
updates as you slide the picker so you can see the result before committing. Everything
nested under that phase takes the color.

**Milestones** are tasks with zero days. Set the Days cell to 0 and the bar becomes a
diamond. Set it back to a number and it becomes a normal task again.

**Percent done** on a phase is calculated from its children, weighted by length, so a
20 day task counts for more than a 2 day one. You cannot type over it directly.

**Days are working days.** By default that means Monday to Friday. Open Account,
Working days of the week, and tick Saturday and Sunday if you want the schedule to run
straight through, or use the "all seven days" shortcut. Tasks and deadlines can then
land on a weekend like any other day, and the grey shading disappears from the chart.
You can also drop a day mid week, for example a four day week with Fridays off.

Account, Holidays and days off takes specific dates that are skipped on top of that.

The setting is shared, so changing it changes the chart for the whole team.

## How dates are decided

A task with nothing linked into it sits on its own date. A task with a predecessor is
scheduled from that predecessor, as early as it can start.

If you drag a linked task, or type a date into its Start cell, it stays exactly where
you put it, even if that overlaps the task before it. Anything downstream shifts to
follow. The Start cell shows a small amber dot when a date is set by hand. Right click
that cell to clear it and hand the row back to its dependency.

Dragging snaps to working days. If you drop a bar on a Saturday it lands on the Monday,
and the bar follows your cursor to the place it will actually end up, so nothing jumps
when you let go.

**Offsets.** By default a finish to start link means the next task begins on the next
working day. To have it begin on the same day the previous one finishes, click the
arrow between them and set the offset to -1. A positive number leaves a deliberate gap,
which is useful for things like curing time or a review window where nobody is working
but the calendar still has to pass. Offsets are part of the link, so they survive when
the task before them moves or changes length. That makes them a better tool than
dragging for anything you want to hold true permanently.

Dates are never saved. Only durations, links and overrides are stored, and each browser
computes the chart from those. That is why everyone always sees the same thing, and why
changing one duration ripples through immediately for the whole team.

Dependencies attach to individual tasks, not to phase rows. If you try to link a phase
the app tells you and asks you to link the tasks inside it. Links that would create a
loop are refused when you draw them.

## Columns and numbering

The grid shows a row number, Task Name, WBS, Responsible, Days, Start, Finish and
% Done.

There are two kinds of numbering and they do different jobs.

The **outline number** in front of each task name is worked out from where the row sits
in the tree, so it renumbers itself whenever you move or nest something. It tells you
the shape of the plan at a glance and you cannot edit it.

The **WBS column** is yours. Type whatever your project actually uses, a real work
breakdown code, a drawing number, a deliverable reference. It is attached to the task,
so it follows the row when you drag it somewhere else and does not change when
everything around it renumbers. Leave it blank if you do not need it, or hide the column
entirely.

Drag the dividers in the header to resize, the same as a spreadsheet. Drag a header
sideways to move that column. Right click the headers to switch columns off. Only Task
Name is fixed, because the tree lives on it. If you hide the row numbers you can still
drag rows around using the thin strip at the very left edge of each row.

Widths, order and hidden columns are stored in your own browser, so none of it changes
what anyone else sees.

**Expand all** and **Collapse all** in the top bar open or fold every phase at once.
Unlike the column settings, this one is shared, because which rows are folded is stored
with the schedule.

## Exports

Export gives a PNG or SVG of the chart with the table down the left, laid out for
printing rather than for the screen. The SVG is vector, so it scales cleanly into a
report or onto a poster. CSV gives the same table for a spreadsheet.

**By default the export is whatever is on screen.** The columns you have showing, the
rows you have expanded, in the order you have them. Collapse a phase you do not want in
a status report and it is not in the file either.

Three switches on the Export menu override that:

- **Include hidden columns** puts every column in the file without unhiding it on screen
- **Include collapsed rows** exports the whole plan even where you have phases folded up
- **Only the dates on screen** narrows the chart to the window you are looking at, which
  is useful for pulling out a single month. Bars running past the edge are cut off
  cleanly rather than squashed

Those switches are remembered per browser.

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

## Checking which version is deployed

Open the Account menu and look at the bottom. It shows a build stamp. If that is not the
build you just pushed, the browser is holding a cached copy of `app.js`. Reload with
Ctrl Shift R, or Cmd Shift R on a Mac. GitHub Pages also takes a minute or two to
publish after a commit.

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

Colors live on the top level phase row and every descendant inherits, which is why the
swatch only appears on phases.

The export shares its arrow routing and color logic with the on screen chart, so the two
cannot drift apart. It builds its own table rather than screenshotting the DOM, which is
why it can include columns you have hidden.
