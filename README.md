<div align="center">

# PoE Leveling Overlay

**A transparent in-game overlay for Path of Exile that guides you through leveling**

Zone-by-zone tasks, skill gem links, and passive tree tracking — all pulled directly from your Path of Building XML.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-blue.svg)](#)
[![Built with Electron](https://img.shields.io/badge/Built%20with-Electron-47848F.svg)](https://www.electronjs.org/)

</div>

---

## What It Does

The overlay sits on top of your game and tells you exactly what to do in each zone. It reads your PoE log file in real time — when you enter a new area, the guide automatically advances.

Import any build from **Path of Building** and the overlay shows your gem links and tracks your passive tree progression as you level.

**No manual configuration needed** — just pick your PoB XML and go.

---

## Features

| Feature | Description |
|---|---|
| **Auto-advancing guide** | Detects zone changes from your game log and shows the next steps |
| **Path of Building import** | Load any `.xml` build — gems, tree, and class are parsed automatically |
| **Skill gem tracker** | Gem links organized by phase (Act 1, Act 3, Maps, etc.) with main/support coloring |
| **Passive tree overlay** | Visual tree with allocated, next-to-pick (green), and future nodes |
| **Smart tree ordering** | Notables are prioritized, earlier-spec nodes come first, travel nodes fill in via shortest path |
| **Item filter regex** | Copy-ready regex for finding weapon upgrades |
| **Progress persistence** | Saves per character — close and resume anytime |
| **Click-through** | Overlay never blocks your game; toggle interactive mode only when needed |

---

## Quick Start

### Download

Grab `PoE-Leveling-Overlay.exe` from the **[Releases](../../releases)** page. No installation needed — just run it.

### Run from Source

```bash
git clone https://github.com/Tysktillan/poe-leveling-overlay.git
cd poe-leveling-overlay
npm install
npm start
```

> Requires [Node.js](https://nodejs.org/) v18+

---

## Setup Guide

### Step 1 — Game Log Path

The overlay auto-detects your PoE `Client.txt` from common install locations:

```
C:\Program Files (x86)\Steam\steamapps\common\Path of Exile\logs\Client.txt
D:\SteamLibrary\steamapps\common\Path of Exile\logs\Client.txt
C:\Path of Exile\logs\Client.txt
```

If your install is elsewhere, click **Browse** next to "Game Log" on the startup screen. Your choice is saved for future sessions.

> A green checkmark confirms the log file was found. A red warning means you need to set it manually.

### Step 2 — Select a Build

On the startup screen you have two options:

- **Path of Building XML** — browse your PoB Builds folder and click any `.xml` file. The overlay detects the class automatically and loads all skill sets and tree specs.
- **Custom builds** — pre-configured builds (like Duelist Sunder) that include route data and build-specific overlays.

The PoB Builds folder defaults to `Documents\Path of Building\Builds` but can be changed with the **Change** button.

### Step 3 — Link Your Character

After selecting a build, type anything in **Local chat** in-game (just press Enter and type). This lets the overlay detect your character name and begin tracking.

### Step 4 — Play

The overlay now runs automatically:

- Advances when you enter the next zone
- Shows tasks, quest objectives, and navigation tips
- Tracks your level and passive points

---

## Keyboard Shortcuts

### Overlay Controls

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+F` | Toggle interactive mode (click the overlay) |
| `Ctrl+Shift+H` | Hide / show the overlay |
| `Ctrl+Shift+R` | Reset guide progress |
| `Ctrl+Shift+Right` | Skip to next step |
| `Ctrl+Shift+Left` | Go back one step |

### Passive Tree

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+T` | Toggle tree overlay |
| `Escape` | Close tree overlay |
| `Shift + Scroll` | Zoom in / out |
| `Shift + Drag` | Pan (captured — game doesn't see the click) |
| `Ctrl + Drag` | Pan (pass-through — game pans its tree too) |

---

## Path of Building Integration

### Skill Gems

Your PoB skill sets (named things like "A1", "A3", "EarlyMaps") appear in a dropdown on the overlay. Each group shows:

- **Active gems** highlighted in gold
- **Support gems** in blue
- Disabled gems shown at reduced opacity

Switch between skill sets as you progress through acts.

### Passive Tree

The tree overlay reads your PoB's `<Spec>` nodes and calculates allocation order using:

1. **Spec layering** — nodes from earlier specs (Act 1) are allocated before nodes added in later specs
2. **Notable priority** — within each tier, notables and keystones are reached first via shortest path
3. **Travel backfill** — remaining travel nodes fill in via BFS

Your total passive points = `(character level - 1) + quest passive rewards`

The tree highlights:
- **Gold/white** — allocated nodes
- **Bright green** — next node to pick
- **Green ring + label** — the very first node from class start
- **Gray** — future allocations

---

## How It Works

```
 PoE Game                    Overlay
 --------                    -------
 Client.txt  ──tail──>  main.js (Electron)
                            │
              ┌─────────────┼─────────────┐
              v             v             v
         Zone Match    Gem Parser    Tree Renderer
              │             │             │
              v             v             v
         index.html    Gem Section   tree.html
        (task list)   (skill links)  (canvas tree)
```

1. Tails `Client.txt` for zone-enter events
2. Matches zone names against the leveling guide data
3. Calculates passive points from level + quest rewards
4. Sends updates to the overlay windows via IPC

---

## Building the Portable .exe

```bash
npm run dist
```

Output: `dist/PoE-Leveling-Overlay.exe`

---

## Project Structure

```
main.js                  Electron main process — log tailing, guide logic, IPC
index.html               Overlay UI — task display, gem viewer, build selector
tree.html                Passive tree overlay window
treeRenderer.js          Canvas-based tree rendering with pan/zoom
poe_tree.json            Path of Exile passive tree data
route.json               Generic zone-by-zone leveling route
guide-duelist.json       Class guide (Duelist) for direct PoB mode
build-duelist-sunder.json   Example build overlay with route merge
```

---

## Contributing

Contributions are welcome. Some ideas:

- **Leveling guides for other classes** — add a `guide-<class>.json` following the existing format
- **Build configs** — create `build-*.json` files for popular builds
- **UI improvements** — the overlay is plain HTML/CSS, easy to modify

---

## License

[MIT](LICENSE)
