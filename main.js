const { app, BrowserWindow, globalShortcut, ipcMain, dialog } = require('electron');
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

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

function loadSettings() {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
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
        return {
            className: classMatch ? classMatch[1] : 'Unknown',
            ascendancy: ascendMatch ? ascendMatch[1] : ''
        };
    } catch (e) {
        return { className: 'Unknown', ascendancy: '' };
    }
}

let mainWindow;
let treeWindow;
let guideData = [];       // Merged step array (route + build overlay)
let tailInstance = null;
let currentStep = 0;      // Progression pointer
let lastShownStep = -1;   // For re-entering the same zone
let currentBuildFile = ''; // Track which build is loaded
let currentCharacter = ''; // Detected from game log
let activeMilestone = '';  // Persists across steps
let activeWeapon = '';     // Persists across steps
let currentLevel = 1;      // Detected from game log
let totalPassives = 0;     // Computed from level + quests
let currentBuildConfig = null; // The loaded build overlay (for PoB XML path etc.)
let parsedSkillSets = [];      // Gem link data parsed from PoB XML

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

function progressFile() {
    const charSuffix = currentCharacter ? '-' + currentCharacter.replace(/[^a-zA-Z0-9]/g, '_') : '';
    return path.join(__dirname, 'progress' + charSuffix + '.json');
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

function loadProgress(buildFilename) {
    try {
        const saved = JSON.parse(fs.readFileSync(progressFile(), 'utf8'));
        // Support both old 'guide' key and new 'build' key for backward compat
        if (saved.build === buildFilename || saved.guide === buildFilename) {
            return { step: saved.step || 0, lastShown: saved.lastShown ?? -1, level: saved.level || 0 };
        }
    } catch (e) { /* no saved progress */ }
    return { step: 0, lastShown: -1, level: 0 };
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

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 350, height: 250, x: 30, y: 30,
        frame: false, transparent: true, alwaysOnTop: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    treeWindow = new BrowserWindow({
        width: 800, height: 600, show: false,
        fullscreen: true, frame: false, transparent: true, alwaysOnTop: true,
        focusable: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    treeWindow.loadFile('tree.html');

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

    // Direct PoB XML selection (no build-*.json overlay)
    ipcMain.on('pob-build-selected', (event, pobXmlPath) => {
        try {
            // Load the generic guide directly
            const guidePath = path.join(__dirname, 'guide-duelist.json');
            guideData = JSON.parse(fs.readFileSync(guidePath, 'utf8'));

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
            currentStep = 0;
            currentLevel = 1;
            lastShownStep = -1;

            console.log(`Loaded PoB build "${currentBuildConfig.name}" (${classInfo.className}${classInfo.ascendancy ? ' / ' + classInfo.ascendancy : ''}) with ${guideData.length} steps`);

            // Parse and send gem data
            parsedSkillSets = parseGemsFromXml(pobXmlPath);
            mainWindow.webContents.send('gem-data', parsedSkillSets);

            // Send PoB to tree window
            treeWindow.webContents.send('load-pob', pobXmlPath, classInfo.className);

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

            // Merge route + build overlay
            guideData = mergeGuide(route, currentBuildConfig);

            currentCharacter = '';
            currentStep = 0;
            currentLevel = 1;
            lastShownStep = -1;

            console.log(`Loaded build "${currentBuildConfig.name}" with ${routeFile} (${guideData.length} steps, ${Object.keys(currentBuildConfig.steps || {}).length} build overrides)`);

            // Send PoB XML path to tree renderer + parse gems
            if (currentBuildConfig.pob_xml) {
                treeWindow.webContents.send('load-pob', currentBuildConfig.pob_xml, currentBuildConfig.class || 'Duelist');
                parsedSkillSets = parseGemsFromXml(currentBuildConfig.pob_xml);
                mainWindow.webContents.send('gem-data', parsedSkillSets);
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
            currentStep = 0;
            currentLevel = 1;
            lastShownStep = -1;
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
    globalShortcut.register('CommandOrControl+Shift+F', () => {
        focusMode = !focusMode;
        mainWindow.setIgnoreMouseEvents(!focusMode);
        mainWindow.webContents.send('focus-mode', focusMode);
    });

    // Tree Overlay Hotkey
    const treeShortcutOk = globalShortcut.register('CommandOrControl+Shift+T', () => {
        if (treeWindow.isVisible()) {
            treeWindow.hide();
            globalShortcut.unregister('Escape');
        } else {
            treeWindow.setAlwaysOnTop(true, 'screen-saver'); // Match mainWindow level
            treeWindow.showInactive();
            // Recalculate totalPassives fresh so it's never stale
            if (lastShownStep >= 0 && lastShownStep < guideData.length) {
                let qp = 0;
                for (let i = 0; i <= lastShownStep; i++) {
                    if (guideData[i] && guideData[i].passive_reward) qp += guideData[i].passive_reward;
                }
                totalPassives = Math.max(0, currentLevel - 1) + qp;
                console.log(`[Passives] Tree opened — recalc: level=${currentLevel}, fromLevel=${currentLevel - 1}, fromQuests=${qp}, total=${totalPassives}`);
            }
            treeWindow.webContents.send('update-passives', totalPassives);
            globalShortcut.register('Escape', () => {
                treeWindow.hide();
                globalShortcut.unregister('Escape');
            });
        }
    });
    if (!treeShortcutOk) console.warn('WARNING: Ctrl+Shift+T shortcut registration FAILED — another app may be using it');

    // Hide/Show Toggle Hotkey
    let overlayHidden = false;
    globalShortcut.register('CommandOrControl+Shift+H', () => {
        overlayHidden = !overlayHidden;
        mainWindow.setOpacity(overlayHidden ? 0 : 1);
    });

    // Reset Progress Hotkey
    globalShortcut.register('CommandOrControl+Shift+R', () => {
        currentStep = 0;
        lastShownStep = -1;
        saveProgress();
        console.log('Progress reset to step 0');
        mainWindow.webContents.send('zone-change', {
            zone: 'Progress Reset',
            data: { tasks: ['Guide reset to step 1. Enter a zone to begin.'] },
            step: 0,
            totalSteps: guideData.length
        });
    });

    // Manual Step Forward/Backward Hotkeys
    globalShortcut.register('CommandOrControl+Shift+Right', () => {
        if (!guideData.length) return;
        if (currentStep < guideData.length) {
            lastShownStep = currentStep;
            currentStep = currentStep + 1;
            saveProgress();
            sendZoneData(guideData[lastShownStep].zone, guideData[lastShownStep], lastShownStep);
        }
    });
    globalShortcut.register('CommandOrControl+Shift+Left', () => {
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
    });

    // Copy completion — flash repaint (no longer exits focus mode)
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
        mainWindow.webContents.send('zone-change', {
            zone: 'Log File Not Found',
            data: { tasks: ['PoE Client.txt not found. Click Ctrl+Shift+F, then set the log path on the startup screen.'] },
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
                const saved = loadProgress(currentBuildFile);
                currentStep = saved.step;
                lastShownStep = saved.lastShown;
                currentLevel = saved.level > 0 ? saved.level : findSavedLevelInLog(currentCharacter);
                if (saved.level !== currentLevel) saveProgress();

                restoreStickyState(lastShownStep);
                console.log('Restored progress for ' + currentCharacter + ': step ' + currentStep);
                mainWindow.webContents.send('zone-change', {
                    zone: 'Character Linked: ' + currentCharacter,
                    data: { tasks: ['Progress restored to step ' + currentStep + '. Enter a zone to continue!'] },
                    step: currentStep,
                    totalSteps: guideData.length
                });
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

            // 1. Re-entering the last matched zone? Re-show it without advancing.
            if (lastShownStep >= 0 && lastShownStep < guideData.length && guideData[lastShownStep].zone === zone) {
                sendZoneData(zone, guideData[lastShownStep], lastShownStep);
                return;
            }

            // 2. Forward scan from currentStep with lookahead
            const maxScan = Math.min(currentStep + LOOKAHEAD, guideData.length);
            for (let i = currentStep; i < maxScan; i++) {
                if (guideData[i].zone === zone) {
                    if (guideData[i].isTown && (i - currentStep) >= TOWN_LOOKAHEAD) {
                        continue;
                    }
                    currentStep = i + 1;
                    lastShownStep = i;
                    saveProgress();
                    console.log(`Step ${i + 1}/${guideData.length}: ${zone}`);
                    sendZoneData(zone, guideData[i], i);
                    return;
                }
            }

            // 3. No match — show zone name without advancing
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
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
