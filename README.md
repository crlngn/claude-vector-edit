# artboard-vector

A Claude Code mod that adds point-level vector editing to the SVG shapes inside a `/design` artboard. It opens a small editor in the Claude desktop app's built-in browser pane; saves splice only the changed path data back into the artboard file and republish the canvas.

Tools: Move (select, marquee, drag, nudge, click an edge to add a point, Delete to remove), Lasso, Bend (drag edges, drag handles, double-click to toggle corner/smooth), undo/redo, auto-save toggle.

## Install

At the prompt of a terminal session:

```
/plugin install artboard-vector --marketplace crlngn/claude-vector-edit
```

then `y` to add the marketplace, and pick a scope (user is the usual choice).

From a shell:

```
claude plugin install artboard-vector --marketplace crlngn/claude-vector-edit
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `crlngn/claude-vector-edit`, then Add plugin.

## Use

In a session that has worked on a Design canvas (or with the canvas URL once):

```
/vector-edit Shapes.dc.html
/vector-edit https://claude.ai/artifact/<id> Shapes.dc.html
/vector-edit --list
```

With a shape selected in the canvas, `/vector-edit` alone opens on it. A comment on a shape sent to Claude that starts with `/vector-edit` or `vector:` opens the editor there too, when the comment is delivered to the session running the mod; any other comment goes to Claude as usual.

Only inline SVG geometry is editable (`path`, `rect`, `circle`, `ellipse`, `line`, `polygon`, `polyline`); shapes bound to template holes are shown locked, and CSS-drawn shapes are not shapes to the editor.

## Develop

```
node --test test/*.test.mjs
claude plugin validate .
claude plugin test .
```

Requires node on the machine (the editor server is a zero-dependency node script).
