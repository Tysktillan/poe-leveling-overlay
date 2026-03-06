const { app, BrowserWindow, globalShortcut, ipcMain, dialog, Tray, Menu } = require('electron');
const { Tail } = require('tail');
const fs = require('fs');
const path = require('path');
const koffi = require('koffi');

// Windows API: check if a key/button is currently pressed
const user32 = koffi.load('user32.dll');
const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');

// ---------------------------------------------------------------------------
// Persistent settings
// ---------------------------------------------------------------------------

const LEGACY_SETTINGS_FILE = path.join(__dirname, 'settings.json');

const DEFAULT_HOTKEYS = {
    toggleInteractive: 'CommandOrControl+Shift+F',
    toggleTree: 'CommandOrControl+Shift+T',
    toggleNotes: 'CommandOrControl+Shift+D',
    resetBuildSelection: 'CommandOrControl+Shift+R',
    toggleOverlay: 'CommandOrControl+Shift+H',
    stepForward: 'Alt+Shift+Right',
    stepBackward: 'Alt+Shift+Left'
};

function sanitizeRegexPresets(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const name = String(item.name || '').trim();
        const regex = String(item.regex || '').trim();
        if (!name || !regex) continue;
        out.push({ name, regex });
    }
    return out;
}

function sanitizeHotkeys(value) {
    const input = (value && typeof value === 'object') ? value : {};
    const out = {};
    for (const [action, fallback] of Object.entries(DEFAULT_HOTKEYS)) {
        const raw = input[action];
        const key = (typeof raw === 'string' && raw.trim()) ? raw.trim() : fallback;
        out[action] = key;
    }
    return out;
}

function formatHotkeyForDisplay(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw
        .replace(/CommandOrControl/gi, 'Ctrl')
        .replace(/CmdOrCtrl/gi, 'Ctrl')
        .replace(/ArrowRight/gi, 'Right')
        .replace(/ArrowLeft/gi, 'Left');
}

function getSettingsFilePath() {
    try {
        const dir = app.getPath('userData');
        fs.mkdirSync(dir, { recursive: true });
        return path.join(dir, 'settings.json');
    } catch (e) {
        return LEGACY_SETTINGS_FILE;
    }
}

function loadSettings() {
    const settingsFile = getSettingsFilePath();
    try {
        return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch (e) {
        // Backward compatibility: legacy settings beside main.js
        try {
            const legacy = JSON.parse(fs.readFileSync(LEGACY_SETTINGS_FILE, 'utf8'));
            try {
                fs.writeFileSync(settingsFile, JSON.stringify(legacy, null, 2));
            } catch (writeErr) { /* ignore migration errors */ }
            return legacy;
        } catch (legacyErr) {
            return {};
        }
    }
}

function saveSettings(settings) {
    fs.writeFileSync(getSettingsFilePath(), JSON.stringify(settings, null, 2));
}

function getDefaultPobPath() {
    const home = process.env.USERPROFILE || process.env.HOME;
    return path.join(home, 'Documents', 'Path of Building', 'Builds');
}

function getPobBuildsPath() {
    const settings = loadSettings();
    return settings.pobBuildsPath || getDefaultPobPath();
}

// ---------------------------------------------------------------------------
// PoE log path detection
// ---------------------------------------------------------------------------

const COMMON_POE_PATHS = [
    // Steam default
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Path of Exile\\logs\\Client.txt',
    // Steam custom library drives
    'D:\\SteamLibrary\\steamapps\\common\\Path of Exile\\logs\\Client.txt',
    'E:\\SteamLibrary\\steamapps\\common\\Path of Exile\\logs\\Client.txt',
    'F:\\SteamLibrary\\steamapps\\common\\Path of Exile\\logs\\Client.txt',
    // Standalone client
    'C:\\Path of Exile\\logs\\Client.txt',
    // Steam default (non-x86)
    'C:\\Program Files\\Steam\\steamapps\\common\\Path of Exile\\logs\\Client.txt',
];

function detectLogPath() {
    for (const p of COMMON_POE_PATHS) {
        try {
            fs.accessSync(p, fs.constants.R_OK);
            return p;
        } catch (e) { /* not found, try next */ }
    }
    return null;
}

function getLogPath() {
    const settings = loadSettings();
    if (settings.logPath) {
        try {
            fs.accessSync(settings.logPath, fs.constants.R_OK);
            return settings.logPath;
        } catch (e) {
            // Saved path no longer valid, fall through to auto-detect
        }
    }
    return detectLogPath();
}

let logPath = getLogPath();

// ---------------------------------------------------------------------------
// PoB builds folder scanning
// ---------------------------------------------------------------------------

function scanPobBuilds(rootDir) {
    const results = [];

    function scan(dir) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    scan(fullPath);
                } else if (entry.name.endsWith('.xml')) {
                    const folder = path.relative(rootDir, dir);
                    results.push({
                        name: entry.name.replace('.xml', ''),
                        fullPath: fullPath,
                        folder: folder || null
                    });
                }
            }
        } catch (e) {
            console.error('Error scanning PoB builds:', dir, e.message);
        }
    }

    scan(rootDir);
    return results;
}

function parseClassFromXml(xmlPath) {
    try {
        const xmlData = fs.readFileSync(xmlPath, 'utf8');
        const classMatch = xmlData.match(/className="([^"]+)"/);
        const ascendMatch = xmlData.match(/ascendClassName="([^"]+)"/);
        const rawClass = classMatch ? classMatch[1] : '';
        const rawAsc = ascendMatch ? ascendMatch[1] : '';
        return {
            className: resolveBaseClass(rawClass) || resolveBaseClass(rawAsc) || rawClass || 'Unknown',
            ascendancy: rawAsc
        };
    } catch (e) {
        return { className: 'Unknown', ascendancy: '' };
    }
}

let mainWindow;
let treeWindow;
let notesWindow;
let tray = null;
let isQuitting = false;
let parsedNotes = '';      // Raw notes text from PoB XML
let guideData = [];       // Merged step array (route + build overlay)
let tailInstance = null;
let currentStep = 0;      // Progression pointer
let lastShownStep = -1;   // For re-entering the same zone
let currentBuildFile = ''; // Track which build is loaded
let currentCharacter = ''; // Detected from game log
let latestEnteredZone = ''; // Most recent "You have entered" zone from the log
let activeMilestone = '';  // Persists across steps
let activeWeapon = '';     // Persists across steps
let currentLevel = 1;      // Detected from game log
let totalPassives = 0;     // Computed from level + quests
let currentBuildConfig = null; // The loaded build overlay (for PoB XML path etc.)
let parsedSkillSets = [];      // Gem link data parsed from PoB XML
let levelingRegexPresets = [];  // Effective regex presets (settings override or route defaults)
let routeRegexDefaults = [];    // Regex defaults from current route file
let settingsWindow = null;
let hotkeyBindings = sanitizeHotkeys(loadSettings().hotkeys);
let rebindHotkeys = null;

function getCustomRegexPresetsFromSettings() {
    const settings = loadSettings();
    return sanitizeRegexPresets(settings.regexPresets);
}

function getEffectiveRegexPresets(defaultPresets) {
    const custom = getCustomRegexPresetsFromSettings();
    return custom.length ? custom : (Array.isArray(defaultPresets) ? defaultPresets : []);
}

// ---------------------------------------------------------------------------
// Quest Gem Rewards
// ---------------------------------------------------------------------------

let questGemData = [];     // Loaded from quest-gem-rewards.json
let buildQuestGems = [];   // Computed for current build + class
let buildLillyRothGems = []; // Gems to buy from Lilly Roth (not covered by quest rewards)

let vendorUnlocks = []; // Loaded from quest-gem-rewards.json vendor_unlocks

const LILLY_ROTH_STEP = 'act6_the_twilight_strand';

function loadQuestGemData() {
    try {
        const filePath = path.join(__dirname, 'quest-gem-rewards.json');
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // Support both old array format and new object format
        if (Array.isArray(raw)) {
            questGemData = raw;
            vendorUnlocks = [];
        } else {
            questGemData = raw.quest_gem_rewards || [];
            vendorUnlocks = raw.vendor_unlocks || [];
        }
        console.log(`Loaded ${questGemData.length} quest reward entries, ${vendorUnlocks.length} vendor unlocks`);
    } catch (e) {
        console.warn('quest-gem-rewards.json not found:', e.message);
        questGemData = [];
        vendorUnlocks = [];
    }
}

function normalizeGemName(name) {
    return String(name || '')
        .trim()
        // Keep matching robust across PoB/game naming variants
        .replace(/^(Vaal|Awakened|Anomalous|Divergent|Phantasmal)\s+/i, '')
        .replace(/\bSupport\b/ig, '')
        .replace(/channelling/ig, 'channeling')
        .replace(/[^A-Za-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

const CLASS_ALIASES = {
    marauder: 'Marauder',
    juggernaut: 'Marauder',
    berserker: 'Marauder',
    chieftain: 'Marauder',
    witch: 'Witch',
    necromancer: 'Witch',
    occultist: 'Witch',
    elementalist: 'Witch',
    ranger: 'Ranger',
    deadeye: 'Ranger',
    raider: 'Ranger',
    pathfinder: 'Ranger',
    duelist: 'Duelist',
    slayer: 'Duelist',
    gladiator: 'Duelist',
    champion: 'Duelist',
    shadow: 'Shadow',
    assassin: 'Shadow',
    trickster: 'Shadow',
    saboteur: 'Shadow',
    templar: 'Templar',
    templat: 'Templar', // common typo safeguard
    inquisitor: 'Templar',
    hierophant: 'Templar',
    guardian: 'Templar',
    scion: 'Scion',
    ascendant: 'Scion'
};

function resolveBaseClass(name) {
    const key = String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z]/g, '');
    return CLASS_ALIASES[key] || '';
}

function hasBuildGem(buildGemNames, gemName) {
    if (buildGemNames.has(gemName)) return true;
    const target = normalizeGemName(gemName);
    for (const buildGem of buildGemNames) {
        if (normalizeGemName(buildGem) === target) return true;
    }
    return false;
}

function computeBuildQuestGems(skillSets, playerClass) {
    if (!questGemData.length || !skillSets.length) return { questGems: [], lillyRothGems: [] };
    const rewardClass = resolveBaseClass(playerClass) || String(playerClass || '').trim();
    if (!rewardClass) return { questGems: [], lillyRothGems: [] };

    // Collect all unique gem names from all skill sets in the build
    const buildGemNames = new Set();
    for (const ss of skillSets) {
        for (const skill of ss.skills) {
            for (const gem of skill.gems) {
                buildGemNames.add(gem.name);
            }
        }
    }

    // For each quest, find which build gems are rewards for this class
    const questGems = [];
    const coveredByQuest = new Set();
    const seen = new Set();
    for (const questEntry of questGemData) {
        const classGems = questEntry.rewards[rewardClass] || [];
        for (const gemName of classGems) {
            const normGem = normalizeGemName(gemName);
            if (hasBuildGem(buildGemNames, gemName) && !seen.has(normGem)) {
                seen.add(normGem);
                questGems.push({
                    gem: gemName,
                    quest: questEntry.quest,
                    act: questEntry.act,
                    npc: questEntry.npc || '',
                    optional: questEntry.optional || false
                });
                coveredByQuest.add(normGem);
            }
        }
    }

    // Gems in the build that are NOT covered by any quest reward for this class
    // Gems not covered by class quest rewards are Lilly Roth gems
    const lillyRothGems = [];
    for (const gemName of buildGemNames) {
        if (!coveredByQuest.has(normalizeGemName(gemName))) {
            lillyRothGems.push(gemName);
        }
    }
    lillyRothGems.sort();

    // Sort quest gems by act, then gem name
    questGems.sort((a, b) => a.act - b.act || a.gem.localeCompare(b.gem));

    return { questGems, lillyRothGems };
}

function buildQuestGemClaimsForStep(stepData, tasks) {
    if (!stepData || !stepData.quest_reward) return [];

    const questMatches = buildQuestGems.filter(qg => qg.quest === stepData.quest_reward);
    if (questMatches.length === 0) return [];

    const gems = questMatches.map(qg => qg.gem).sort((a, b) => a.localeCompare(b));
    const fallbackNpc = questMatches[0].npc || '';

    let npcFromTask = '';
    for (const task of (tasks || [])) {
        if (!/claim.*quest.*gem|claim.*gem.*reward/i.test(task)) continue;
        const m = String(task).match(/\bfrom\s+(.+)$/i);
        if (m) {
            npcFromTask = m[1].trim();
            break;
        }
    }

    const npc = npcFromTask || fallbackNpc || 'Quest NPC';
    return [`Claim ${gems.join(', ')} from ${npc}`];
}

// ---------------------------------------------------------------------------
// Route + Build merging
// ---------------------------------------------------------------------------

// Scans for route-*.json files
function findRouteFiles() {
    return fs.readdirSync(__dirname).filter(f => f.startsWith('route') && f.endsWith('.json'));
}

// Scans for build-*.json files
function findBuildFiles() {
    return fs.readdirSync(__dirname).filter(f => f.startsWith('build-') && f.endsWith('.json'));
}

// Merge a route array with a build overlay object.
// Generic route tasks come first, then build-specific tasks are appended.
// Build fields (weapon_target, tree_milestone, regex) are applied on top.
function mergeGuide(route, buildConfig) {
    const buildSteps = buildConfig.steps || {};

    return route.map(routeStep => {
        const merged = Object.assign({}, routeStep);
        const overlay = buildSteps[routeStep.step_id];

        if (overlay) {
            // Append build-specific tasks after generic ones
            if (overlay.tasks && overlay.tasks.length > 0) {
                merged.tasks = [...(routeStep.tasks || []), ...overlay.tasks];
            }
            // Apply build-specific fields
            if (overlay.weapon_target) merged.weapon_target = overlay.weapon_target;
            if (overlay.tree_milestone) merged.tree_milestone = overlay.tree_milestone;
            if (overlay.regex) merged.regex = overlay.regex;
        }

        return merged;
    });
}

// ---------------------------------------------------------------------------
// PoB XML Gem Parsing
// ---------------------------------------------------------------------------

function parseSkillsFromBlock(block) {
    const skills = [];
    const skillRegex = /<Skill\s[^>]*>[\s\S]*?<\/Skill>/g;
    let skillMatch;
    while ((skillMatch = skillRegex.exec(block)) !== null) {
        const skillBlock = skillMatch[0];
        const labelMatch = skillBlock.match(/label="([^"]*)"/);
        const enabledMatch = skillBlock.match(/enabled="([^"]+)"/);
        const label = labelMatch ? labelMatch[1].replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\^\d/g, '').trim() : '';
        const skillEnabled = enabledMatch ? enabledMatch[1] === 'true' : true;

        const gems = [];
        const gemRegex = /<Gem\s[^>]*\/>/g;
        let gemMatch;
        while ((gemMatch = gemRegex.exec(skillBlock)) !== null) {
            const gemTag = gemMatch[0];
            const nameMatch = gemTag.match(/nameSpec="([^"]+)"/);
            const gemIdMatch = gemTag.match(/gemId="([^"]+)"/);
            const enabledGem = gemTag.match(/enabled="([^"]+)"/);

            if (nameMatch) {
                const gemId = gemIdMatch ? gemIdMatch[1] : '';
                gems.push({
                    name: nameMatch[1].replace(/&apos;/g, "'").replace(/&amp;/g, '&'),
                    isSupport: gemId.includes('SupportGem'),
                    enabled: enabledGem ? enabledGem[1] === 'true' : true
                });
            }
        }

        if (gems.length > 0) {
            skills.push({ label, enabled: skillEnabled, gems });
        }
    }
    return skills;
}

function parseGemsFromXml(xmlFileOrPath) {
    try {
        const xmlPath = path.isAbsolute(xmlFileOrPath)
            ? xmlFileOrPath
            : path.join(__dirname, xmlFileOrPath);
        const xmlData = fs.readFileSync(xmlPath, 'utf8');

        const skillSets = [];

        // Try matching <SkillSet ...>...</SkillSet> blocks first
        const ssRegex = /<SkillSet\s[^>]*>[\s\S]*?<\/SkillSet>/g;
        let ssMatch;
        while ((ssMatch = ssRegex.exec(xmlData)) !== null) {
            const ssBlock = ssMatch[0];
            const titleMatch = ssBlock.match(/title="([^"]+)"/);
            const rawTitle = titleMatch ? titleMatch[1] : 'Unknown';
            const title = rawTitle.replace(/\^\d/g, '').trim();

            const skills = parseSkillsFromBlock(ssBlock);
            if (skills.length > 0) {
                skillSets.push({ title, skills });
            }
        }

        // Fallback: if no SkillSets found, parse <Skill> blocks directly under <Skills>
        if (skillSets.length === 0) {
            const skillsMatch = xmlData.match(/<Skills\s[^>]*>([\s\S]*?)<\/Skills>/);
            if (skillsMatch) {
                const skills = parseSkillsFromBlock(skillsMatch[1]);
                if (skills.length > 0) {
                    skillSets.push({ title: 'Default', skills });
                }
            }
        }

        console.log(`Parsed ${skillSets.length} SkillSets from "${xmlFileOrPath}"`);
        return skillSets;
    } catch (err) {
        console.error('Failed to parse gems from XML:', err);
        return [];
    }
}

// ---------------------------------------------------------------------------
// PoB Notes Parsing
// ---------------------------------------------------------------------------

function parseNotesFromXml(xmlPath) {
    try {
        const xmlData = fs.readFileSync(xmlPath, 'utf8');
        const match = xmlData.match(/<Notes>([\s\S]*?)<\/Notes>/);
        if (match) {
            return match[1]
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&apos;/g, "'")
                .replace(/&quot;/g, '"')
                .trim();
        }
    } catch (e) {
        console.error('Failed to parse notes from XML:', e.message);
    }
    return '';
}

// ---------------------------------------------------------------------------
// Progress persistence
// ---------------------------------------------------------------------------

// Scan backward from a step to find the most recent milestone/weapon
function restoreStickyState(fromStep) {
    activeMilestone = '';
    activeWeapon = '';
    for (let i = Math.min(fromStep, guideData.length - 1); i >= 0; i--) {
        if (!activeMilestone && guideData[i].tree_milestone) activeMilestone = guideData[i].tree_milestone;
        if (!activeWeapon && guideData[i].weapon_target) activeWeapon = guideData[i].weapon_target;
        if (activeMilestone && activeWeapon) break;
    }
}

function sanitizeCharacterForFile(charName) {
    return String(charName || '').trim().replace(/[^a-zA-Z0-9]/g, '_');
}

function getProgressDataDir() {
    try {
        const dir = app.getPath('userData');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    } catch (e) {
        return __dirname;
    }
}

function legacyProgressFileForCharacter(charName) {
    const safeName = sanitizeCharacterForFile(charName);
    const charSuffix = safeName ? '-' + safeName : '';
    return path.join(__dirname, 'progress' + charSuffix + '.json');
}

function progressFileForCharacter(charName) {
    const safeName = sanitizeCharacterForFile(charName);
    const charSuffix = safeName ? '-' + safeName : '';
    return path.join(getProgressDataDir(), 'progress' + charSuffix + '.json');
}

function progressFile() {
    return progressFileForCharacter(currentCharacter);
}

function readSavedProgress(filePath, buildFilename) {
    try {
        const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // Support both old 'guide' key and new 'build' key for backward compat
        if (saved.build === buildFilename || saved.guide === buildFilename) {
            return {
                step: saved.step || 0,
                lastShown: saved.lastShown ?? -1,
                level: saved.level || 0,
                character: saved.character || ''
            };
        }
    } catch (e) { /* no saved progress in this file */ }
    return null;
}

function saveProgress() {
    try {
        fs.writeFileSync(progressFile(), JSON.stringify({
            build: currentBuildFile,
            step: currentStep,
            lastShown: lastShownStep,
            character: currentCharacter,
            level: currentLevel
        }));
    } catch (e) { /* silently fail */ }
}

function loadProgress(buildFilename, characterName = currentCharacter) {
    const genericFile = progressFileForCharacter('');
    const charFile = progressFileForCharacter(characterName);
    const legacyGenericFile = legacyProgressFileForCharacter('');
    const legacyCharFile = legacyProgressFileForCharacter(characterName);

    let charSaved = characterName ? readSavedProgress(charFile, buildFilename) : null;

    // Backward compatibility: read legacy progress beside main.js if present
    if (!charSaved && characterName) {
        const legacy = readSavedProgress(legacyCharFile, buildFilename);
        if (legacy) {
            charSaved = legacy;
            try {
                fs.writeFileSync(charFile, JSON.stringify({
                    build: buildFilename,
                    step: legacy.step,
                    lastShown: legacy.lastShown,
                    character: characterName,
                    level: legacy.level
                }));
            } catch (e) { /* ignore migration errors */ }
        }
    }

    if (charSaved) {
        return { step: charSaved.step, lastShown: charSaved.lastShown, level: charSaved.level, character: charSaved.character, source: 'character' };
    }

    // If a character name is known but no character-specific progress exists yet,
    // start from fresh state and rely on current zone matching.
    if (characterName) {
        return { step: 0, lastShown: -1, level: 0, character: characterName, source: 'none' };
    }

    let genericSaved = readSavedProgress(genericFile, buildFilename);
    if (!genericSaved) {
        const legacy = readSavedProgress(legacyGenericFile, buildFilename);
        if (legacy) {
            genericSaved = legacy;
            try {
                fs.writeFileSync(genericFile, JSON.stringify({
                    build: buildFilename,
                    step: legacy.step,
                    lastShown: legacy.lastShown,
                    character: legacy.character || '',
                    level: legacy.level
                }));
            } catch (e) { /* ignore migration errors */ }
        }
    }

    if (genericSaved) {
        return { step: genericSaved.step, lastShown: genericSaved.lastShown, level: genericSaved.level, character: genericSaved.character || '', source: 'generic' };
    }

    return { step: 0, lastShown: -1, level: 0, character: '', source: 'none' };
}

function findSavedLevelInLog(charName) {
    if (!logPath) return 1;
    try {
        const stats = fs.statSync(logPath);
        const chunkSize = Math.min(2 * 1024 * 1024, stats.size); // Read up to last 2MB
        const buffer = Buffer.alloc(chunkSize);
        const fd = fs.openSync(logPath, 'r');
        fs.readSync(fd, buffer, 0, chunkSize, stats.size - chunkSize);
        fs.closeSync(fd);

        const lines = buffer.toString('utf8').split('\n');
        // Search backwards
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].includes('is now level')) {
                const match = lines[i].match(/: (.+?) \(.+?\) is now level ([0-9]+)/);
                if (match && match[1] === charName) {
                    return parseInt(match[2], 10);
                }
            }
        }
    } catch (e) {
        console.error("Error reading log for level:", e);
    }
    return 1; // Fallback to level 1 if not found
}

// ---------------------------------------------------------------------------
// Window creation & event wiring
// ---------------------------------------------------------------------------

function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
}

function hideOverlaysToTray() {
    if (treeWindow && !treeWindow.isDestroyed()) treeWindow.hide();
    if (notesWindow && !notesWindow.isDestroyed()) notesWindow.hide();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function openSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.show();
        settingsWindow.focus();
        return;
    }

    settingsWindow = new BrowserWindow({
        width: 760,
        height: 760,
        resizable: true,
        title: 'Overlay Settings',
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    settingsWindow.loadFile('settings.html');
    settingsWindow.on('closed', () => { settingsWindow = null; });
}

function rebuildTrayMenu() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Show Overlay', click: () => showMainWindow() },
        { label: 'Settings', click: () => openSettingsWindow() },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                isQuitting = true;
                app.quit();
            }
        }
    ]));
}

function createTray() {
    if (tray) return;

    try {
        const iconPath = path.join(__dirname, 'build', 'icon.ico');
        const trayIcon = fs.existsSync(iconPath) ? iconPath : process.execPath;
        tray = new Tray(trayIcon);
        tray.setToolTip('PoE Leveling Overlay');
        rebuildTrayMenu();
        tray.on('double-click', () => showMainWindow());
    } catch (e) {
        // Keep app usable even if tray init fails in packaged environments.
        console.warn('Tray init failed:', e.message);
        tray = null;
    }
}

function createWindow() {
    loadQuestGemData();

    mainWindow = new BrowserWindow({
        width: 350, height: 250, x: 30, y: 30,
        frame: false, transparent: true, alwaysOnTop: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    createTray();

    // Closing the main window hides to tray; use tray menu to quit.
    mainWindow.on('close', (event) => {
        if (isQuitting) return;
        event.preventDefault();
        hideOverlaysToTray();
    });

    treeWindow = new BrowserWindow({
        width: 800, height: 600, show: false,
        fullscreen: true, frame: false, transparent: true, alwaysOnTop: true,
        focusable: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    treeWindow.loadFile('tree.html');

    // Notes overlay window (hidden by default, toggled with Ctrl+Shift+D)
    notesWindow = new BrowserWindow({
        width: 750, height: 550, show: false,
        frame: false, transparent: true, alwaysOnTop: true,
        focusable: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    notesWindow.loadFile('notes.html');
    notesWindow.setIgnoreMouseEvents(true, { forward: true });

    // Notes window mouse focus: enable when hovering over content
    ipcMain.on('notes-ignore-mouse', (event, ignore, options) => {
        if (notesWindow) notesWindow.setIgnoreMouseEvents(ignore, options);
    });

    ipcMain.on('hide-notes', () => {
        notesWindow.hide();
    });

    ipcMain.on('resize-notes', (event, contentHeight) => {
        if (!notesWindow) return;
        const width = 700;
        const height = Math.min(Math.max(contentHeight + 2, 80), 600); // clamp 80-600
        notesWindow.setSize(width, height);
        notesWindow.center();
    });

    // Ignore all mouse events by default (click-through to game)
    // but forward them to renderer so it can listen for Right-Clicks
    treeWindow.setIgnoreMouseEvents(true, { forward: true });

    // Dynamic mouse focus toggling controlled by renderer
    ipcMain.on('tree-ignore-mouse', (event, ignore, options) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) win.setIgnoreMouseEvents(ignore, options);
    });

    // Synchronous mouse button state check for Ctrl+drag panning.
    // Forwarded mousemove events don't include reliable e.buttons,
    // so the renderer queries the actual OS-level button state.
    ipcMain.on('check-left-mouse', (event) => {
        // VK_LBUTTON = 0x01; high bit set = currently pressed
        event.returnValue = !!(GetAsyncKeyState(0x01) & 0x8000);
    });

    // Debug hook to print tree.html console logs
    treeWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        console.log(`[Tree Overlay] ${message} (line ${line})`);
    });

    ipcMain.on('hide-tree', () => {
        treeWindow.hide();
        globalShortcut.unregister('Escape');
    });

    mainWindow.loadFile('index.html');
    mainWindow.setAlwaysOnTop(true, 'screen-saver'); // Stay above fullscreen games

    // When the HTML finishes loading, send startup data
    mainWindow.webContents.on('did-finish-load', () => {
        const buildFiles = findBuildFiles();
        mainWindow.webContents.send('available-builds', buildFiles);
    });

    // Log path management
    ipcMain.handle('get-log-path', () => {
        return { logPath: logPath || null, detected: !!logPath };
    });

    ipcMain.handle('change-log-path', async () => {
        const defaultDir = logPath ? path.dirname(logPath) : 'C:\\';
        const result = await dialog.showOpenDialog({
            properties: ['openFile'],
            title: 'Select Path of Exile Client.txt Log File',
            defaultPath: defaultDir,
            filters: [{ name: 'Log Files', extensions: ['txt'] }]
        });
        if (!result.canceled && result.filePaths.length > 0) {
            const newPath = result.filePaths[0];
            const settings = loadSettings();
            settings.logPath = newPath;
            saveSettings(settings);
            logPath = newPath;
            return { logPath: newPath, detected: true };
        }
        return null;
    });

    // PoB builds folder browsing
    ipcMain.handle('get-pob-builds', () => {
        const pobPath = getPobBuildsPath();
        const builds = scanPobBuilds(pobPath);
        return { pobPath, builds };
    });

    ipcMain.handle('change-pob-folder', async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openDirectory'],
            title: 'Select Path of Building Builds Folder',
            defaultPath: getPobBuildsPath()
        });
        if (!result.canceled && result.filePaths.length > 0) {
            const settings = loadSettings();
            settings.pobBuildsPath = result.filePaths[0];
            saveSettings(settings);
            const builds = scanPobBuilds(result.filePaths[0]);
            return { pobPath: result.filePaths[0], builds };
        }
        return null;
    });

    ipcMain.removeHandler('settings-load');
    ipcMain.handle('settings-load', () => {
        const settings = loadSettings();
        const hotkeys = sanitizeHotkeys(settings.hotkeys);
        const customRegexPresets = sanitizeRegexPresets(settings.regexPresets);
        const routeFallback = routeRegexDefaults.length ? routeRegexDefaults : levelingRegexPresets;
        return {
            hotkeys,
            defaultHotkeys: DEFAULT_HOTKEYS,
            regexPresets: customRegexPresets.length ? customRegexPresets : routeFallback,
            routeRegexDefaults: routeFallback
        };
    });

    ipcMain.removeHandler('settings-save');
    ipcMain.handle('settings-save', (event, payload) => {
        const settings = loadSettings();
        const nextHotkeys = sanitizeHotkeys(payload && payload.hotkeys);
        const nextRegexPresets = sanitizeRegexPresets(payload && payload.regexPresets);

        settings.hotkeys = nextHotkeys;
        settings.regexPresets = nextRegexPresets;
        saveSettings(settings);

        hotkeyBindings = nextHotkeys;
        if (typeof rebindHotkeys === 'function') rebindHotkeys();

        levelingRegexPresets = getEffectiveRegexPresets(routeRegexDefaults);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('hotkeys-updated', hotkeyBindings);
            mainWindow.webContents.send('regex-presets', levelingRegexPresets);
        }

        return { ok: true };
    });
    // Direct PoB XML selection (no build-*.json overlay)
    ipcMain.on('pob-build-selected', (event, pobXmlPath) => {
        try {
            // Load route.json for steps + regex presets
            const routePath = path.join(__dirname, 'route.json');
            const routeFile = JSON.parse(fs.readFileSync(routePath, 'utf8'));
            guideData = routeFile.steps || routeFile;
            routeRegexDefaults = sanitizeRegexPresets(Array.isArray(routeFile.leveling_regex) ? routeFile.leveling_regex : []);
            levelingRegexPresets = getEffectiveRegexPresets(routeRegexDefaults);
            mainWindow.webContents.send('regex-presets', levelingRegexPresets);

            // Parse class info from the PoB XML
            const classInfo = parseClassFromXml(pobXmlPath);
            currentBuildConfig = {
                name: path.basename(pobXmlPath, '.xml'),
                pob_xml: pobXmlPath,
                class: classInfo.className,
                steps: {}
            };
            currentBuildFile = 'pob:' + pobXmlPath;
            currentCharacter = '';
            latestEnteredZone = '';
            currentStep = 0;
            currentLevel = 1;
            lastShownStep = -1;

            console.log(`Loaded PoB build "${currentBuildConfig.name}" (${classInfo.className}${classInfo.ascendancy ? ' / ' + classInfo.ascendancy : ''}) with ${guideData.length} steps`);

            // Parse and send gem data
            parsedSkillSets = parseGemsFromXml(pobXmlPath);
            mainWindow.webContents.send('gem-data', parsedSkillSets);

            // Compute and send quest gem reminders for this class
            const questResult = computeBuildQuestGems(parsedSkillSets, classInfo.className);
            buildQuestGems = questResult.questGems;
            buildLillyRothGems = questResult.lillyRothGems;
            mainWindow.webContents.send('quest-gem-data', buildQuestGems, questResult.lillyRothGems, 'pob:' + pobXmlPath);
            console.log(`Quest gem reminders: ${buildQuestGems.length} quest gems, ${questResult.lillyRothGems.length} Lilly Roth gems for ${classInfo.className}`);

            // Send PoB to tree window
            treeWindow.webContents.send('load-pob', pobXmlPath, classInfo.className);

            // Parse and send notes to notes overlay
            parsedNotes = parseNotesFromXml(pobXmlPath);
            notesWindow.webContents.send('load-notes', parsedNotes, currentBuildConfig.name);

            mainWindow.setIgnoreMouseEvents(true);
            startTailing();

            mainWindow.webContents.send('zone-change', {
                zone: 'Link Character',
                data: { tasks: ['Type anything in LOCAL chat (press Enter) to link your character.'] },
                step: 0,
                totalSteps: guideData.length
            });
        } catch (err) {
            console.error('Error loading PoB build', err);
        }
    });

    // When user clicks a build in the HTML, load route + merge
    ipcMain.on('build-selected', (event, buildFilename) => {
        try {
            // Load the build overlay
            const buildPath = path.join(__dirname, buildFilename);
            currentBuildConfig = JSON.parse(fs.readFileSync(buildPath, 'utf8'));
            currentBuildFile = buildFilename;

            // Find and load the route file (use route.json as default)
            const routeFile = currentBuildConfig.route || 'route.json';
            const routePath = path.join(__dirname, routeFile);
            const route = JSON.parse(fs.readFileSync(routePath, 'utf8'));
            const routeSteps = route.steps || route;

            // Merge route + build overlay
            guideData = mergeGuide(routeSteps, currentBuildConfig);

            routeRegexDefaults = sanitizeRegexPresets(Array.isArray(route.leveling_regex) ? route.leveling_regex : []);
            levelingRegexPresets = getEffectiveRegexPresets(routeRegexDefaults);
            mainWindow.webContents.send('regex-presets', levelingRegexPresets);
            currentCharacter = '';
            latestEnteredZone = '';
            currentStep = 0;
            currentLevel = 1;
            lastShownStep = -1;

            console.log(`Loaded build "${currentBuildConfig.name}" with ${routeFile} (${guideData.length} steps, ${Object.keys(currentBuildConfig.steps || {}).length} build overrides)`);

            // Send PoB XML path to tree renderer + parse gems
            if (currentBuildConfig.pob_xml) {
                treeWindow.webContents.send('load-pob', currentBuildConfig.pob_xml, currentBuildConfig.class || 'Duelist');
                parsedSkillSets = parseGemsFromXml(currentBuildConfig.pob_xml);
                mainWindow.webContents.send('gem-data', parsedSkillSets);

                // Compute and send quest gem reminders
                const buildClass = currentBuildConfig.class || '';
                const questResult2 = computeBuildQuestGems(parsedSkillSets, buildClass);
                buildQuestGems = questResult2.questGems;
                buildLillyRothGems = questResult2.lillyRothGems;
                mainWindow.webContents.send('quest-gem-data', buildQuestGems, questResult2.lillyRothGems, buildFilename);
                console.log(`Quest gem reminders: ${buildQuestGems.length} quest gems, ${questResult2.lillyRothGems.length} Lilly Roth gems for ${buildClass}`);

                // Parse and send notes to notes overlay
                parsedNotes = parseNotesFromXml(currentBuildConfig.pob_xml);
                notesWindow.webContents.send('load-notes', parsedNotes, currentBuildConfig.name);
            }

            mainWindow.setIgnoreMouseEvents(true);
            startTailing();

            // Prompt user to type in local chat to link character
            mainWindow.webContents.send('zone-change', {
                zone: 'Link Character',
                data: { tasks: ['Type anything in LOCAL chat (press Enter) to link your character.'] },
                step: 0,
                totalSteps: guideData.length
            });
        } catch (err) {
            console.error('Error loading build', err);
        }
    });

    // --- Legacy support: old guide-selected event still works ---
    ipcMain.on('guide-selected', (event, filename) => {
        const guidePath = path.join(__dirname, filename);
        try {
            guideData = JSON.parse(fs.readFileSync(guidePath, 'utf8'));
            currentBuildFile = filename;
            currentBuildConfig = null;
            currentCharacter = '';
            latestEnteredZone = '';
            currentStep = 0;
            currentLevel = 1;
            lastShownStep = -1;
            buildLillyRothGems = [];
            buildQuestGems = [];
            console.log('Loaded legacy guide ' + filename + ' (' + guideData.length + ' steps)');

            mainWindow.setIgnoreMouseEvents(true);
            startTailing();

            mainWindow.webContents.send('zone-change', {
                zone: 'Link Character',
                data: { tasks: ['Type anything in LOCAL chat (press Enter) to link your character.'] },
                step: 0,
                totalSteps: guideData.length
            });
        } catch (err) {
            console.error('Error reading guide', err);
        }
    });

    // ---------------------------------------------------------------------------
    // Hotkeys
    // ---------------------------------------------------------------------------

    // Interactive / Focus Mode Toggle
    let focusMode = false;
    let overlayHidden = false;

    function updateMainWindowMouseMode() {
        // In build selection mode, overlay must be clickable when visible.
        const inBuildSelection = !currentBuildFile;
        if (overlayHidden) {
            mainWindow.setIgnoreMouseEvents(true);
            return;
        }
        if (inBuildSelection) {
            mainWindow.setIgnoreMouseEvents(false);
            return;
        }
        mainWindow.setIgnoreMouseEvents(!focusMode);
    }

    function setFocusMode(enabled) {
        const next = !overlayHidden && !!enabled;
        focusMode = next;
        updateMainWindowMouseMode();

        if (next && mainWindow && !mainWindow.isDestroyed()) {
            // Ensure blur triggers on the first outside click after enabling interaction.
            mainWindow.focus();
            mainWindow.webContents.focus();
        }

        mainWindow.webContents.send('focus-mode', next);
    }

    function toggleTreeOverlay() {
        if (treeWindow.isVisible()) {
            treeWindow.hide();
            globalShortcut.unregister('Escape');
            return;
        }

        treeWindow.setAlwaysOnTop(true, 'screen-saver');
        treeWindow.showInactive();

        // Recalculate totalPassives fresh so it's never stale
        if (lastShownStep >= 0 && lastShownStep < guideData.length) {
            let qp = 0;
            for (let i = 0; i <= lastShownStep; i++) {
                if (guideData[i] && guideData[i].passive_reward) qp += guideData[i].passive_reward;
            }
            totalPassives = Math.max(0, currentLevel - 1) + qp;
            console.log(`[Passives] Tree opened - totalPassives=${totalPassives}`);
        }

        treeWindow.webContents.send('update-passives', totalPassives);
        globalShortcut.register('Escape', () => {
            treeWindow.hide();
            globalShortcut.unregister('Escape');
        });
    }

    function toggleNotesOverlay() {
        if (notesWindow.isVisible()) {
            notesWindow.hide();
            return;
        }
        notesWindow.setAlwaysOnTop(true, 'screen-saver');
        notesWindow.center();
        notesWindow.showInactive();
        notesWindow.setIgnoreMouseEvents(false);
    }

    function resetToBuildSelection() {
        // Stop tailing
        if (tailInstance) {
            tailInstance.unwatch();
            tailInstance = null;
        }
        // Reset main process state
        guideData = [];
        currentBuildConfig = null;
        currentBuildFile = '';
        currentCharacter = '';
        latestEnteredZone = '';
        currentStep = 0;
        lastShownStep = -1;
        currentLevel = 1;
        parsedSkillSets = [];
        buildQuestGems = [];
        buildLillyRothGems = [];
        parsedNotes = '';
        activeMilestone = '';
        activeWeapon = '';
        totalPassives = 0;
        if (focusMode) setFocusMode(false);
        if (treeWindow && treeWindow.isVisible()) treeWindow.hide();
        if (notesWindow && notesWindow.isVisible()) notesWindow.hide();
        updateMainWindowMouseMode();
        mainWindow.webContents.send('reset-to-build-select');
    }

    function toggleOverlayVisibility() {
        overlayHidden = !overlayHidden;
        mainWindow.setOpacity(overlayHidden ? 0 : 1);
        if (overlayHidden && focusMode) {
            setFocusMode(false);
        }
        updateMainWindowMouseMode();
    }

    function stepForward() {
        if (!guideData.length) return;
        if (currentStep < guideData.length) {
            lastShownStep = currentStep;
            currentStep = currentStep + 1;
            saveProgress();
            sendZoneData(guideData[lastShownStep].zone, guideData[lastShownStep], lastShownStep);
        }
    }

    function stepBackward() {
        if (!guideData.length) return;
        if (currentStep > 1) {
            currentStep = currentStep - 1;
            lastShownStep = currentStep - 1;
            saveProgress();
            sendZoneData(guideData[lastShownStep].zone, guideData[lastShownStep], lastShownStep);
        } else {
            currentStep = 0;
            lastShownStep = -1;
            saveProgress();
        }
    }

    // Clicking outside the overlay causes the window to blur; exit interaction.
    mainWindow.on('blur', () => {
        if (focusMode) setFocusMode(false);
    });

    let managedHotkeys = [];
    function unregisterManagedHotkeys() {
        for (const key of managedHotkeys) {
            globalShortcut.unregister(key);
        }
        managedHotkeys = [];
        globalShortcut.unregister('Escape');
    }

    function registerManagedHotkey(action, handler) {
        const accelerator = String(hotkeyBindings[action] || '').trim();
        if (!accelerator) {
            console.warn('Hotkey missing for action:', action);
            return;
        }
        const ok = globalShortcut.register(accelerator, handler);
        if (!ok) {
            console.warn(`Hotkey registration failed for ${action}: ${accelerator}`);
            return;
        }
        managedHotkeys.push(accelerator);
    }

    function applyHotkeyBindings() {
        unregisterManagedHotkeys();

        registerManagedHotkey('toggleInteractive', () => {
            if (!currentBuildFile) return;
            if (overlayHidden) return;
            setFocusMode(!focusMode);
        });

        registerManagedHotkey('toggleTree', () => {
            toggleTreeOverlay();
        });

        registerManagedHotkey('toggleNotes', () => {
            toggleNotesOverlay();
        });

        registerManagedHotkey('resetBuildSelection', () => {
            resetToBuildSelection();
        });

        registerManagedHotkey('toggleOverlay', () => {
            toggleOverlayVisibility();
        });

        registerManagedHotkey('stepForward', () => {
            stepForward();
        });

        registerManagedHotkey('stepBackward', () => {
            stepBackward();
        });
    }

    rebindHotkeys = applyHotkeyBindings;
    applyHotkeyBindings();

    // Copy completion flash
    ipcMain.on('copy-done', () => {
        if (mainWindow) {
            mainWindow.setOpacity(0.99);
            setTimeout(() => {
                if (mainWindow) mainWindow.setOpacity(overlayHidden ? 0 : 1);
            }, 50);
        }
    });

    // Resizing logic
    let lastHeight = 0;
    ipcMain.on('resize-window', (event, height) => {
        const roundedHeight = Math.min(Math.round(height + 24), 600);
        if (Math.abs(lastHeight - roundedHeight) > 5) {
            mainWindow.setBounds({ x: 30, y: 30, width: 350, height: roundedHeight });
            lastHeight = roundedHeight;
        }
    });
}

// ---------------------------------------------------------------------------
// Zone detection & data dispatch
// ---------------------------------------------------------------------------

const LOOKAHEAD = 10;      // Steps ahead to scan for non-town zones
const TOWN_LOOKAHEAD = 2;  // Tighter lookahead for town zones (avoid false advances)

function isStepMarkedSkippable(step) {
    if (!step || typeof step !== 'object') return false;
    if (step.optional === true) return true;
    if (step.important === true) return false;

    const tasks = Array.isArray(step.tasks) ? step.tasks : [];
    const text = tasks.join(' ').toLowerCase();
    return /\bskip\b/.test(text) || /\boptional\b/.test(text);
}

function hasBlockingUnfinishedSteps(fromIndex, toIndexExclusive) {
    for (let i = fromIndex; i < toIndexExclusive; i++) {
        const step = guideData[i];
        if (!step) continue;
        if (step.isTown) continue;
        if (isStepMarkedSkippable(step)) continue;
        return true;
    }
    return false;
}

function findMatchingStepIndexForZone(zone) {
    // Re-entering the last matched zone: keep showing current step.
    if (lastShownStep >= 0 && lastShownStep < guideData.length && guideData[lastShownStep].zone === zone) {
        return lastShownStep;
    }

    // Forward scan from current progress position.
    const maxScan = Math.min(currentStep + LOOKAHEAD, guideData.length);
    for (let i = currentStep; i < maxScan; i++) {
        if (guideData[i].zone === zone) {
            if (guideData[i].isTown && (i - currentStep) >= TOWN_LOOKAHEAD) {
                continue;
            }

            // Do not jump over unresolved required non-town steps.
            if (i > currentStep && hasBlockingUnfinishedSteps(currentStep, i)) {
                continue;
            }

            return i;
        }
    }

    return -1;
}

function inferActFromLevel(level) {
    const lvl = Number(level) || 1;
    if (lvl <= 13) return 1;
    if (lvl <= 23) return 2;
    if (lvl <= 34) return 3;
    if (lvl <= 42) return 4;
    if (lvl <= 46) return 5;
    if (lvl <= 52) return 6;
    if (lvl <= 57) return 7;
    if (lvl <= 62) return 8;
    if (lvl <= 67) return 9;
    return 10;
}

function findBestGlobalStepIndexForZone(zone) {
    const matches = [];
    for (let i = 0; i < guideData.length; i++) {
        if (guideData[i].zone === zone) {
            matches.push(i);
        }
    }

    if (matches.length === 0) return -1;
    if (matches.length === 1) return matches[0];

    const targetAct = inferActFromLevel(currentLevel);
    let bestIndex = matches[0];
    let bestScore = Number.MAX_SAFE_INTEGER;

    for (const idx of matches) {
        const act = guideData[idx].act || 1;
        const score = Math.abs(act - targetAct) * 1000 + idx;
        if (score < bestScore) {
            bestScore = score;
            bestIndex = idx;
        }
    }

    return bestIndex;
}

function sendZoneData(zone, stepData, stepIndex) {
    // Update tracked sticky state
    if (stepData.tree_milestone) activeMilestone = stepData.tree_milestone;
    if (stepData.weapon_target) activeWeapon = stepData.weapon_target;

    // Calculate total passives
    let passivesFromQuests = 0;
    for (let i = 0; i <= stepIndex; i++) {
        if (guideData[i] && guideData[i].passive_reward) {
            passivesFromQuests += guideData[i].passive_reward;
        }
    }
    totalPassives = Math.max(0, currentLevel - 1) + passivesFromQuests;
    console.log(`[Passives] level=${currentLevel}, fromLevel=${currentLevel - 1}, fromQuests=${passivesFromQuests}, total=${totalPassives} (step ${stepIndex})`);

    // Inject active milestone/weapon into data so renderer always has them
    const enrichedData = Object.assign({}, stepData);
    if (activeMilestone) enrichedData.tree_milestone = activeMilestone;
    if (activeWeapon) enrichedData.weapon_target = activeWeapon;
    enrichedData.totalPassives = totalPassives;
    enrichedData.currentAct = stepData.act || 1;
    if (stepData.isTown) enrichedData.isTown = true;

    // Replace generic quest reward lines with build-specific gem names when possible
    if (Array.isArray(enrichedData.tasks) && enrichedData.tasks.length > 0) {
        const claimTasks = buildQuestGemClaimsForStep(stepData, enrichedData.tasks);
        if (claimTasks.length > 0) {
            let replaced = false;
            enrichedData.tasks = enrichedData.tasks.map(task => {
                if (!replaced && /claim.*quest.*gem|claim.*gem.*reward/i.test(task)) {
                    replaced = true;
                    return claimTasks[0];
                }
                return task;
            });

            // If route text did not contain a generic claim line, add specific claim at top
            if (!replaced) {
                enrichedData.tasks = [...claimTasks, ...enrichedData.tasks];
            }
        }
    }
    if (stepData.step_id === LILLY_ROTH_STEP && buildLillyRothGems.length > 0) {
        const lillyTask = `- After clearing: Buy ${buildLillyRothGems.join(', ')} from Lilly Roth`;
        enrichedData.tasks = [lillyTask, ...(enrichedData.tasks || [])];
    }

    mainWindow.webContents.send('zone-change', {
        zone: zone,
        data: enrichedData,
        step: stepIndex + 1,
        totalSteps: guideData.length
    });

    if (treeWindow) {
        treeWindow.webContents.send('update-passives', totalPassives);
    }
    // Force repaint for transparent overlay behind fullscreen games
    mainWindow.setOpacity(0.99);
    setTimeout(() => { if (mainWindow) mainWindow.setOpacity(1); }, 50);
}

function startTailing() {
    if (tailInstance) return;
    if (!logPath) {
        console.error('Cannot start tailing: no log path configured');
        const resetHotkey = formatHotkeyForDisplay(hotkeyBindings.resetBuildSelection || DEFAULT_HOTKEYS.resetBuildSelection);
        mainWindow.webContents.send('zone-change', {
            zone: 'Log File Not Found',
            data: { tasks: ['PoE Client.txt not found. Press ' + resetHotkey + ' to return to build selection, then set the log path on the startup screen.'] },
            step: 0, totalSteps: 0
        });
        return;
    }

    tailInstance = new Tail(logPath, { useWatchFile: true, fsWatchOptions: { interval: 100 } });
    tailInstance.on("line", (line) => {
        // Detect character name from chat messages: "<CHANNEL> CharName: message"
        if (!currentCharacter && line.match(/<.+?> .+?: /)) {
            const match = line.match(/<.+?> (.+?): /);
            if (match) {
                currentCharacter = match[1];
                console.log('Character linked: ' + currentCharacter);
                mainWindow.webContents.send('character-linked', currentCharacter);
                const saved = loadProgress(currentBuildFile);
                currentStep = saved.step;
                lastShownStep = saved.lastShown;
                currentLevel = saved.level > 0 ? saved.level : findSavedLevelInLog(currentCharacter);
                if (saved.level !== currentLevel) saveProgress();

                restoreStickyState(lastShownStep);
                console.log('Restored progress for ' + currentCharacter + ': step ' + currentStep + ' (source: ' + saved.source + ')');

                let shown = false;
                if (latestEnteredZone) {
                    let zoneStepIndex = findMatchingStepIndexForZone(latestEnteredZone);
                    if (zoneStepIndex < 0 && saved.source !== 'character') {
                        zoneStepIndex = findBestGlobalStepIndexForZone(latestEnteredZone);
                    }
                    if (zoneStepIndex >= 0) {
                        currentStep = zoneStepIndex + 1;
                        lastShownStep = zoneStepIndex;
                        saveProgress();
                        sendZoneData(latestEnteredZone, guideData[zoneStepIndex], zoneStepIndex);
                        shown = true;
                    }
                }

                if (!shown && saved.source !== 'character' && guideData.length > 0) {
                    currentStep = 1;
                    lastShownStep = 0;
                    saveProgress();
                    sendZoneData(guideData[0].zone, guideData[0], 0);
                    shown = true;
                }

                if (!shown && lastShownStep >= 0 && lastShownStep < guideData.length) {
                    sendZoneData(guideData[lastShownStep].zone, guideData[lastShownStep], lastShownStep);
                }
            }
        }

        // Level-up detection: "CharName (Class) is now level X"
        if (line.includes('is now level')) {
            const match = line.match(/: (.+?) \(.+?\) is now level ([0-9]+)/);
            if (match) {
                currentLevel = parseInt(match[2], 10);
                saveProgress();

                if (!currentCharacter) {
                    currentCharacter = match[1];
                    console.log('Character detected from level-up: ' + currentCharacter);
                    mainWindow.webContents.send('character-linked', currentCharacter);
                    const saved = loadProgress(currentBuildFile);
                    currentStep = saved.step;
                    lastShownStep = saved.lastShown;
                    restoreStickyState(lastShownStep);
                }
                if (lastShownStep >= 0 && lastShownStep < guideData.length) {
                    sendZoneData(guideData[lastShownStep].zone, guideData[lastShownStep], lastShownStep);
                }
            }
        }

        // Robust sync: User types `/passives` in game
        // Parse the authoritative total directly from the game output
        if (line.includes('total Passive Skill Points')) {
            const match = line.match(/([0-9]+) total Passive Skill Points/);
            if (match) {
                totalPassives = parseInt(match[1], 10);
                console.log('Synced totalPassives from /passives: ' + totalPassives);
                if (treeWindow) {
                    treeWindow.webContents.send('update-passives', totalPassives);
                }
            }
        }
        // Also parse level from /passives for level tracking
        if (line.includes('Passive Skill Points from character level')) {
            const match = line.match(/([0-9]+) Passive Skill Points from character level/);
            if (match) {
                currentLevel = parseInt(match[1], 10) + 1;
                saveProgress();
                console.log('Synced level from /passives: ' + currentLevel);
            }
        }

        if (line.includes("You have entered")) {
            const zone = line.split("You have entered ")[1].replace(".", "").trim();
            latestEnteredZone = zone;

            if (!currentCharacter) {
                mainWindow.webContents.send('zone-change', {
                    zone: 'Link Character',
                    data: { tasks: ['Character not linked yet. Type anything in LOCAL chat to link, then progress will resume.'] },
                    step: 0,
                    totalSteps: guideData.length
                });
                return;
            }

            const matchedStepIndex = findMatchingStepIndexForZone(zone);
            if (matchedStepIndex >= 0) {
                currentStep = matchedStepIndex + 1;
                lastShownStep = matchedStepIndex;
                saveProgress();
                console.log(`Step ${matchedStepIndex + 1}/${guideData.length}: ${zone}`);
                sendZoneData(zone, guideData[matchedStepIndex], matchedStepIndex);
                return;
            }

            // 3. No nearby step match: keep current step and show generic objective
            mainWindow.webContents.send('zone-change', {
                zone: zone,
                data: { tasks: ["Proceed to next objective."] },
                step: currentStep,
                totalSteps: guideData.length
            });
        }
    });
}

app.whenReady().then(createWindow);

app.on('before-quit', () => {
    isQuitting = true;
});

app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        showMainWindow();
    }
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (tray) {
        tray.destroy();
        tray = null;
    }
});

