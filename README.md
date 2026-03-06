<div align="center">

# PoE Leveling Overlay

**A transparent in-game overlay for Path of Exile that guides you through leveling**

Zone-by-zone tasks, quest-aware gem rewards, and passive tree tracking - pulled from your Path of Building XML.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-blue.svg)](#)
[![Built with Electron](https://img.shields.io/badge/Built%20with-Electron-47848F.svg)](https://www.electronjs.org/)

</div>

---

## What It Does

The overlay sits on top of your game and tells you what to do in each zone. It reads your PoE log file in real time and advances automatically when you enter a new area.

Import a build from **Path of Building** and the overlay loads:

- Skill gem links
- Passive tree progression
- Quest gem reminders based on class + gems in your build
- Build notes from PoB XML `<Notes>`

---

## Video Walkthrough

[![Watch the walkthrough](https://img.youtube.com/vi/tDDxlzWgYpw/hqdefault.jpg)](https://youtu.be/tDDxlzWgYpw)

https://youtu.be/tDDxlzWgYpw

---

## Features

| Feature | Description |
|---|---|
| **Auto-advancing guide** | Detects zone changes from `Client.txt` and shows the next step |
| **PoB build picker** | Scans your PoB Builds folder and loads `.xml` builds directly |
| **Quest-aware gem rewards** | Replaces generic quest reward text with exact gem claims when matched |
| **Quest gem checklist** | Shows pending quest/Lilly gems and lets you mark gems collected |
| **Passive tree overlay** | Visual tree with allocated, next, and future nodes |
| **Build notes overlay** | Toggle PoB notes in-game |
| **Leveling regex helper** | Preset/custom regex shown in town and copyable to clipboard |
| **Configurable hotkeys** | Change hotkeys from the Settings window |
| **Configurable regex presets** | Edit regex presets from the Settings window |
| **System tray support** | Close button hides to tray; tray menu supports Show, Settings, Quit |
| **Progress persistence** | Saves per character + build and resumes automatically |

---

## Quick Start

### Download

Grab `PoE-Leveling-Overlay.exe` from the **[Releases](../../releases)** page.

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

The overlay auto-detects your PoE `Client.txt` from common install locations.

If needed, click **Browse** next to **Game Log** on the startup screen.

### Step 2 - Select a Build

On startup, the app lists detected PoB `.xml` files.

- Click a PoB build to load it
- Click **Change** to point at another PoB Builds folder
- Optional custom `build-*.json` entries can also appear

### Step 3 - Link Your Character

After selecting a build, type anything in **Local chat** in-game. This links the current character so progress resumes per character/build.

### Step 4 - Optional Settings

Right-click the tray icon and open **Settings**.

- Change hotkeys
- Add/remove regex presets
- Reset to defaults or route defaults

### Step 5 - Play

The overlay now advances on zone changes and updates route tasks, gems, passives, and notes.

---

## Hotkeys (Default)

Hotkeys are configurable in **Tray -> Settings**.

| Default | Action |
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
- Disabled gems are dimmed

### Quest Gem Rewards

`quest-gem-rewards.json` is cross-referenced with:

- Loaded class
- Gems used in your PoB skill sets
- Current route step `quest_reward`

If a quest reward matches a build gem, the task is rewritten to the specific gem claim.

### Passive Tree

The tree overlay reads PoB `<Spec>` nodes and allocates in order by tier, prioritizing notable/keystone nodes.

Total passives are calculated as:

`(character level - 1) + passive quest rewards`

---

## Regex Presets

Regex presets come from `route.json` (`leveling_regex`) and are shown in town.

- You can choose a preset or use custom regex
- If custom presets are saved in Settings, they override route defaults
- Regex can be copied with one click

---

## Data Storage

Settings and progress are stored in Electron `userData` (release builds are typically under `%APPDATA%\PoE Leveling Overlay`).

- `settings.json` stores configured hotkeys and custom regex presets
- `progress-<character>.json` stores progression per character/build

Legacy files next to `main.js` are migrated when found.

---

## Building the Portable EXE

```bash
npm run dist
```

Output: `dist/PoE-Leveling-Overlay.exe`

---

## Project Structure

```text
main.js                  Electron main process (log tailing, route logic, IPC, hotkeys, tray)
index.html               Main overlay UI
settings.html            Settings window UI (hotkeys + regex presets)
notes.html               PoB notes overlay UI
tree.html                Passive tree overlay window
treeRenderer.js          Canvas tree rendering (pan/zoom)
poe_tree.json            Path of Exile passive tree data
route.json               Zone steps and leveling regex presets
quest-gem-rewards.json   Class-specific quest/vendor gem reward data
```

---

## Contributing

Contributions are welcome. Good areas to improve:

- Route/task data (`route.json`)
- Quest reward/vendor data (`quest-gem-rewards.json`)
- Build templates (`build-*.json`)
- UI polish and overlay ergonomics

---

## License

[MIT](LICENSE)
