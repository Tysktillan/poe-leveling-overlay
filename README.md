<div align="center">

# PoE Leveling Overlay

**A transparent in-game overlay for Path of Exile that guides you through leveling**

Zone-by-zone tasks, quest-aware gem rewards, and passive tree tracking - all pulled from your Path of Building XML.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-blue.svg)](#)
[![Built with Electron](https://img.shields.io/badge/Built%20with-Electron-47848F.svg)](https://www.electronjs.org/)

</div>

---

## What It Does

The overlay sits on top of your game and tells you what to do in each zone. It reads your PoE log file in real time - when you enter a new area, the guide advances automatically.

Import a build from **Path of Building** and the overlay loads:

- Skill gem links
- Passive tree progression
- Quest gem reminders based on class + gems in your build
- Build notes from PoB XML `<Notes>`

---

## Features

| Feature | Description |
|---|---|
| **Auto-advancing guide** | Detects zone changes from `Client.txt` and shows the next step |
| **PoB build picker** | Scans your PoB Builds folder and loads `.xml` builds directly |
| **Skill gem tracker** | Gem links grouped by PoB skill set with active/support styling |
| **Quest-aware gem rewards** | Replaces generic "Claim quest gem reward" with specific gem names when matched |
| **Quest gem checklist** | Shows pending quest/Lilly gems and lets you mark gems collected |
| **Passive tree overlay** | Visual tree with allocated, next, and future nodes |
| **Build notes overlay** | Toggle PoB notes in-game (`Ctrl+Shift+D`) |
| **Leveling regex helper** | Preset/custom regex shown in town and copyable to clipboard |
| **Progress persistence** | Saves per character/build and resumes automatically |
| **Click-through overlay** | Overlay stays pass-through unless interactive mode is enabled |

---

## Quick Start

### Download

Grab `PoE-Leveling-Overlay.exe` from the **[Releases](../../releases)** page. No installation needed - just run it.

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

### Step 1 - Game Log Path

The overlay auto-detects your PoE `Client.txt` from common install locations:

```
C:\Program Files (x86)\Steam\steamapps\common\Path of Exile\logs\Client.txt
D:\SteamLibrary\steamapps\common\Path of Exile\logs\Client.txt
C:\Path of Exile\logs\Client.txt
```

If needed, click **Browse** next to **Game Log** on the startup screen.

### Step 2 - Select a Build

On startup, the app shows your PoB Builds folder and lists detected `.xml` files.

- Click a PoB build to load it
- Click **Change** to point at another PoB Builds folder
- Optional custom `build-*.json` entries can also appear in the build list

### Step 3 - Link Your Character

After selecting a build, type anything in **Local chat** in-game (press Enter and send a message). This links your current character.

### Step 4 - Play

The overlay now:

- Advances on zone changes
- Shows route tasks and quest turn-ins
- Replaces generic quest gem tasks with exact gem names when applicable
- Tracks passive points and tree progression

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+F` | Toggle interactive mode |
| `Ctrl+Shift+H` | Hide/show main overlay |
| `Alt+Shift+Right` | Next step |
| `Alt+Shift+Left` | Previous step |
| `Ctrl+Shift+T` | Toggle passive tree overlay |
| `Ctrl+Shift+D` | Toggle build notes overlay |
| `Ctrl+Shift+R` | Reset to build selection |
| `Escape` | Close active overlay window |
| `Shift + Scroll` | Tree zoom |
| `Shift + Drag` | Tree pan |

---

## Path of Building Integration

### Skill Gems

PoB skill sets (for example `A1`, `A3`, `EarlyMaps`) appear in a dropdown.

- Active gems are highlighted
- Support gems are styled separately
- Disabled gems are shown with reduced opacity

### Quest Gem Rewards

`quest-gem-rewards.json` is cross-referenced with:

- Your loaded class
- Gems used in your PoB skill sets
- Current route step `quest_reward`

This allows the overlay to show exact claims, for example:

- `Claim Rolling Magma from Tarkleigh`

### Passive Tree

The tree overlay reads PoB `<Spec>` nodes and allocates in this order:

1. Earlier spec tiers first
2. Notables/keystones prioritized within tier
3. Travel nodes filled via shortest-path traversal

Total passives are calculated as:

`(character level - 1) + passive quest rewards`

### Notes Overlay

The PoB XML `<Notes>` block is parsed and shown in a separate overlay (`Ctrl+Shift+D`).

---

## Building the Portable EXE

```bash
npm run dist
```

Output: `dist/PoE-Leveling-Overlay.exe`

---

## Project Structure

```
main.js                  Electron main process - log tailing, route logic, IPC
index.html               Main overlay UI
notes.html               PoB notes overlay UI
tree.html                Passive tree overlay window
treeRenderer.js          Canvas tree rendering (pan/zoom)
poe_tree.json            Path of Exile passive tree data
route.json               Zone-by-zone route steps and quest_reward mapping
zone-guide.json          Leveling regex preset definitions
quest-gem-rewards.json   Class-specific quest/vendor gem reward data
```

---

## Contributing

Contributions are welcome. Good areas to improve:

- Build templates (`build-*.json`)
- Regex presets (`zone-guide.json`)
- Route/task data (`route.json`)
- Quest reward/vendor data (`quest-gem-rewards.json`)
- UI polish and overlay ergonomics

---

## License

[MIT](LICENSE)
