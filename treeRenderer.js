const canvas = document.getElementById('treeCanvas');
const ctx = canvas.getContext('2d');

let treeData = null;
let nodeCoords = {}; // Map of nodeId -> {x, y, data}
let activePathNodes = new Set(); // Nodes extracted from PoB XML
let nodePathOrder = []; // Ordered array for index-based checking
let totalPassives = 0; // Track from main process

ipcRenderer.on('update-passives', (event, passives) => {
    totalPassives = passives;

    // Debug dump
    try {
        require('fs').writeFileSync('debug_tree.txt', `totalPassives: ${totalPassives}\nactiveNodes: ${activePathNodes.size}\nnodePathOrder: ${nodePathOrder.length}\nstartNode: ${Object.values(nodeCoords).find(n => n.data.classStartIndex === 4)?.x}`);
    } catch (e) { }

    draw();
});

// Viewport state
let zoom = 0.20; // Default zoom level — tweak this value (lower = more zoomed out, range 0.05–1.5)
let panX = 0;
let panY = 0;

// Resize canvas
function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    draw();
}
window.addEventListener('resize', resize);
resize();

// Load tree data
try {
    const rawData = fs.readFileSync(path.join(__dirname, 'poe_tree.json'), 'utf8');
    treeData = JSON.parse(rawData);
    buildCoordinates();

    let pobSpecs = [];
    let classStartIdx = 4; // Default: Duelist

    // Class name → classStartIndex mapping
    const CLASS_START = {
        'Scion': 0, 'Marauder': 1, 'Ranger': 2, 'Witch': 3,
        'Duelist': 4, 'Templar': 5, 'Shadow': 6
    };

    // Load PoB XML — called by main process when a build is selected
    function loadPobXml(xmlFilename, className) {
        pobSpecs = [];
        classStartIdx = CLASS_START[className] ?? 4;

        try {
            const xmlPath = path.isAbsolute(xmlFilename)
                ? xmlFilename
                : path.join(__dirname, xmlFilename);
            const pobData = fs.readFileSync(xmlPath, 'utf8');
            const specMatches = [...pobData.matchAll(/<Spec [^>]*>/g)];
            const select = document.getElementById('specSelect');

            // Clear existing dropdown options
            if (select) {
                select.innerHTML = '';
                select.removeEventListener('change', onSpecChange);
            }

            specMatches.forEach((match, idx) => {
                const specStr = match[0];
                const titleMatch = specStr.match(/title="([^"]+)"/);
                const nodesMatch = specStr.match(/nodes="([0-9,]+)"/);

                if (nodesMatch) {
                    const title = titleMatch ? titleMatch[1] : `Spec ${idx + 1}`;
                    pobSpecs.push({ title, nodes: nodesMatch[1].split(',') });

                    if (select) {
                        const opt = document.createElement('option');
                        opt.value = pobSpecs.length - 1;
                        opt.text = title;
                        select.appendChild(opt);
                    }
                }
            });

            if (select) {
                select.addEventListener('change', onSpecChange);
            }

            // Center on the class start node
            centerOnClassStart();

            if (pobSpecs.length > 0) {
                loadSpec(0);
            }

            console.log(`Loaded PoB "${xmlFilename}" for ${className}: ${pobSpecs.length} specs`);
        } catch (err) {
            console.error("Failed to load or parse PoB XML:", xmlFilename, err);
        }
    }

    function onSpecChange(e) {
        loadSpec(parseInt(e.target.value, 10));
    }

    // IPC: main process tells us which PoB XML to load
    ipcRenderer.on('load-pob', (event, xmlFilename, className) => {
        loadPobXml(xmlFilename, className);
    });

    function loadSpec(index) {
        activePathNodes.clear();
        nodePathOrder = [];

        const spec = pobSpecs[index];
        if (!spec) return;

        // Mark all spec nodes as active (for drawing connections/nodes)
        spec.nodes.forEach(n => activePathNodes.add(n));

        // Build allocation order: spec-layered tiers + notable-first pathing
        // Filter out nodes that aren't drawable (ascendancy/proxy nodes without coordinates)
        nodePathOrder = buildConnectedOrder(spec.nodes, index, pobSpecs)
            .filter(n => nodeCoords[n] !== undefined);

        console.log(`Loaded Spec "${spec.title}": ${activePathNodes.size} active nodes, ${nodePathOrder.length} connected in path order`);
        draw();
    }

    // Builds a smart allocation order using two strategies:
    //
    // 1. SPEC LAYERING — nodes that appear in earlier specs (Act 1) are allocated
    //    before nodes that only appear in later specs (Act 5+). This respects
    //    the build author's intended progression.
    //
    // 2. NOTABLE PRIORITY — within each tier, notables and keystones are reached
    //    first via shortest-path from the already-allocated tree. Travel nodes
    //    are only picked up when needed to connect to a notable, or as backfill.
    //
    // Result: at level 33 on a 64-node spec, you see a connected tree that
    // reaches the most important nodes first, following the guide's progression.
    function buildConnectedOrder(specNodeIds, currentSpecIndex, allSpecs) {
        // Find class start node (uses dynamic classStartIdx)
        let startId = null;
        for (const id in treeData.nodes) {
            if (treeData.nodes[id].classStartIndex === classStartIdx) {
                startId = id;
                break;
            }
        }
        if (!startId) {
            console.warn('Could not find class start node, falling back to raw order');
            return specNodeIds.filter(n => {
                const nd = treeData.nodes[n];
                return nd && nd.classStartIndex === undefined;
            });
        }

        const specSet = new Set(specNodeIds.map(String));

        // Build bidirectional adjacency limited to spec nodes + start
        const allRelevant = new Set([...specSet, startId]);
        const adj = new Map();

        for (const id of allRelevant) {
            const node = treeData.nodes[id];
            if (!node || !node.out) continue;
            for (const outId of node.out) {
                const outStr = String(outId);
                if (!allRelevant.has(outStr)) continue;
                if (!adj.has(id)) adj.set(id, []);
                adj.get(id).push(outStr);
                if (!adj.has(outStr)) adj.set(outStr, []);
                adj.get(outStr).push(id);
            }
        }

        // --- Tier assignment ---
        // Each node gets the tier of the earliest spec it appears in.
        // Tier 0 = Act 1 nodes, Tier 1 = nodes added in Act 2-4, etc.
        const nodeTier = new Map();
        for (let s = 0; s <= currentSpecIndex; s++) {
            for (const n of allSpecs[s].nodes) {
                const nStr = String(n);
                if (!nodeTier.has(nStr) && specSet.has(nStr)) {
                    nodeTier.set(nStr, s);
                }
            }
        }
        // Nodes only in the current spec (no earlier appearance)
        for (const n of specNodeIds) {
            const nStr = String(n);
            if (!nodeTier.has(nStr)) nodeTier.set(nStr, currentSpecIndex);
        }

        // --- Identify notables/keystones per tier ---
        const numTiers = currentSpecIndex + 1;
        const notablesByTier = Array.from({ length: numTiers }, () => new Set());

        for (const nStr of specSet) {
            const nd = treeData.nodes[nStr];
            if (!nd || nd.classStartIndex !== undefined) continue;
            const tier = nodeTier.get(nStr) ?? currentSpecIndex;
            if (nd.isNotable || nd.isKeystone) {
                notablesByTier[tier].add(nStr);
            }
        }

        // --- Allocation state ---
        const allocated = new Set([startId]);
        const ordered = [];

        // Multi-source BFS from all allocated nodes to find the nearest
        // node in targetSet. Returns the target and the path of
        // non-allocated nodes leading to it.
        function findNearestTarget(targetSet) {
            const parent = new Map();
            const queue = [...allocated];
            for (const s of allocated) parent.set(s, null);

            while (queue.length > 0) {
                const current = queue.shift();

                if (targetSet.has(current) && !allocated.has(current)) {
                    // Trace path back to the allocated frontier
                    const path = [];
                    let node = current;
                    while (node !== null && !allocated.has(node)) {
                        path.unshift(node);
                        node = parent.get(node);
                    }
                    return { target: current, path };
                }

                const neighbors = adj.get(current) || [];
                for (const nb of neighbors) {
                    if (!parent.has(nb)) {
                        parent.set(nb, current);
                        queue.push(nb);
                    }
                }
            }
            return { target: null, path: [] };
        }

        function allocateNodes(nodeList) {
            for (const n of nodeList) {
                if (!allocated.has(n)) {
                    allocated.add(n);
                    const nd = treeData.nodes[n];
                    if (nd && nd.classStartIndex === undefined) {
                        ordered.push(n);
                    }
                }
            }
        }

        // --- Phase 1: Greedily reach notables, tier by tier ---
        // Earlier-tier notables are always allocated before later-tier ones.
        // Within a tier, the nearest notable (shortest path) is picked first.
        // Intermediate travel nodes from ANY tier get allocated as part of the path.
        for (let tier = 0; tier < numTiers; tier++) {
            const remaining = new Set(notablesByTier[tier]);
            for (const n of remaining) {
                if (allocated.has(n)) remaining.delete(n);
            }

            while (remaining.size > 0) {
                const { target, path } = findNearestTarget(remaining);
                if (!target) break; // remaining notables unreachable
                allocateNodes(path);
                remaining.delete(target);
            }
        }

        // --- Phase 2: Fill remaining travel nodes via BFS ---
        // These are non-notable nodes that weren't needed as paths to notables.
        const bfsQueue = [...allocated];
        const visited = new Set(allocated);

        while (bfsQueue.length > 0) {
            const current = bfsQueue.shift();
            const neighbors = adj.get(current) || [];
            for (const nb of neighbors) {
                if (!visited.has(nb) && specSet.has(nb)) {
                    visited.add(nb);
                    allocated.add(nb);
                    const nd = treeData.nodes[nb];
                    if (nd && nd.classStartIndex === undefined) {
                        ordered.push(nb);
                    }
                    bfsQueue.push(nb);
                }
            }
        }

        // Warn about unreachable nodes
        const unreachable = specNodeIds.filter(n => {
            const nd = treeData.nodes[n];
            return nd && nd.classStartIndex === undefined && !allocated.has(String(n));
        });
        if (unreachable.length > 0) {
            console.warn(`${unreachable.length} spec nodes not reachable from class start:`, unreachable.slice(0, 5));
        }

        return ordered;
    }

    function centerOnClassStart() {
        let startNode = Object.values(nodeCoords).find(n => n.data.classStartIndex === classStartIdx);
        if (startNode) {
            panX = canvas.width / 2 - (startNode.x * zoom);
            panY = canvas.height / 2 - (startNode.y * zoom);
        } else {
            panX = canvas.width / 2;
            panY = canvas.height / 2;
        }
    }
    centerOnClassStart();

    draw();
} catch (e) {
    console.error("Failed to load tree data", e);
}

function buildCoordinates() {
    const { groups, nodes, constants } = treeData;
    const { orbitRadii, skillsPerOrbit } = constants;

    for (const id in nodes) {
        const node = nodes[id];
        // Skip nodes without a group, Ascendancy nodes, and Cluster Jewel proxies
        if (!node.group || !groups[node.group]) continue;
        if (node.ascendancyName) continue;

        const group = groups[node.group];
        if (group.isProxy) continue;

        const groupX = group.x;
        const groupY = group.y;

        // Calculate angle. 
        // 0 index is typically "up", going clockwise. Angle in radians.
        const orbitIndex = node.orbitIndex || 0;
        const orbit = node.orbit || 0;
        const nodesInOrbit = skillsPerOrbit[orbit];
        const radius = orbitRadii[orbit];

        // Match PoB/GGG angle calculation: (2 * PI / nodesInOrbit) * 360
        // Wait, GGG tree angles: 0 is North, increasing clockwise? Actually standard trig uses 0 as right.
        // Let's use standard. PoE tree generally has 0 as top or right, we'll test it out.
        // PoB angle logic: orbitAngles = { [orbit] = { [orbitIndex] = math.pi/180 * (-90 + (orbitIndex / orbitNodes) * 360) } }
        // Let's replicate this: 0 index = Top (-90 degrees)
        const angleDegrees = -90 + (orbitIndex / nodesInOrbit) * 360;
        const angleRadians = angleDegrees * Math.PI / 180;

        const nodeX = groupX + radius * Math.cos(angleRadians);
        const nodeY = groupY + radius * Math.sin(angleRadians);

        nodeCoords[id] = {
            id: id,
            x: nodeX,
            y: nodeY,
            data: node
        };
    }
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!treeData) return;

    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    // 1. Draw connections (lines)
    ctx.lineWidth = 14;

    for (const id in nodeCoords) {
        if (activePathNodes.size > 0 && !activePathNodes.has(id)) continue;

        const from = nodeCoords[id];
        if (!from.data.out) continue;

        for (const outId of from.data.out) {
            if (activePathNodes.size > 0 && !activePathNodes.has(outId)) continue;
            const to = nodeCoords[outId];
            if (!to) continue; // might be ascendancy node we skipped

            // Skip drawing class start edges unless we want them
            if (from.data.classStartIndex !== undefined || to.data.classStartIndex !== undefined) continue;

            const fromIdx = nodePathOrder.indexOf(id);
            const toIdx = nodePathOrder.indexOf(outId);

            // If BOTH nodes are within our unlocked passive points (or if one is the start node), light the path up
            const fromActive = fromIdx === -1 || fromIdx < totalPassives;
            const toActive = toIdx === -1 || toIdx < totalPassives;

            if (fromActive && toActive && totalPassives > 0) {
                ctx.strokeStyle = "rgba(255, 200, 50, 0.9)"; // bright gold line
            } else {
                ctx.strokeStyle = "rgba(100, 100, 100, 0.7)"; // thicker gray line
            }

            // TODO: In the future, draw curved lines for nodes in the same orbit
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.lineTo(to.x, to.y);
            ctx.stroke();
        }
    }

    // 2. Draw nodes
    let debugActive = 0, debugGreen = 0, debugInactive = 0;

    for (const id in nodeCoords) {
        if (activePathNodes.size > 0 && !activePathNodes.has(id)) continue;

        const n = nodeCoords[id];
        if (n.data.classStartIndex !== undefined) continue; // Skip huge class images for now

        let radius = 25;
        let baseColor = "rgba(120, 120, 120, 0.8)";
        let activeColor = "rgba(230, 230, 230, 1.0)";

        if (n.data.isNotable) {
            radius = 45;
            baseColor = "rgba(150, 130, 80, 0.8)";
            activeColor = "rgba(255, 200, 50, 1.0)"; // Gold
        } else if (n.data.isKeystone) {
            radius = 65;
            baseColor = "rgba(160, 90, 70, 0.8)";
            activeColor = "rgba(255, 100, 50, 1.0)"; // Orange
        } else if (n.data.isJewelSocket) {
            radius = 35;
            baseColor = "rgba(80, 130, 160, 0.8)";
            activeColor = "rgba(100, 200, 255, 1.0)"; // Blue
        } else if (n.data.isMastery) {
            radius = 35;
            baseColor = "rgba(130, 80, 160, 0.8)";
            activeColor = "rgba(200, 100, 255, 1.0)"; // Purple
        }

        const idx = nodePathOrder.indexOf(id);
        let isFirstNode = (idx === 0);
        if (idx === -1 || idx < totalPassives) {
            ctx.fillStyle = activeColor;
            debugActive++;
        } else if (idx === totalPassives) {
            // Next node to grab is highlighted special
            ctx.fillStyle = "rgba(100, 255, 100, 1.0)"; // bright green
            radius += 10; // make it pulse much bigger
            debugGreen++;
        } else {
            ctx.fillStyle = baseColor;
            radius = radius * 0.8; // make unallocated nodes slightly smaller
            debugInactive++;
        }

        ctx.beginPath();
        ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
        ctx.fill();

        // Draw a ring + label on the very first node so the user can find it
        if (isFirstNode) {
            ctx.save();
            ctx.strokeStyle = "rgba(100, 255, 100, 1.0)";
            ctx.lineWidth = 6;
            ctx.beginPath();
            ctx.arc(n.x, n.y, radius + 10, 0, Math.PI * 2);
            ctx.stroke();
            const nodeName = n.data.name || '';
            if (nodeName) {
                ctx.font = 'bold 28px sans-serif';
                ctx.fillStyle = 'rgba(0,0,0,0.7)';
                const textW = ctx.measureText(`1st: ${nodeName}`).width;
                ctx.fillRect(n.x - textW / 2 - 4, n.y - radius - 50, textW + 8, 34);
                ctx.fillStyle = "rgba(100, 255, 100, 1.0)";
                ctx.textAlign = 'center';
                ctx.fillText(`1st: ${nodeName}`, n.x, n.y - radius - 22);
            }
            ctx.restore();
        }
    }

    ctx.restore();

    // Debug: show totalPassives and draw counts on canvas
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(canvas.width - 320, 10, 310, 50);
    ctx.fillStyle = '#0f0';
    ctx.font = '14px monospace';
    ctx.fillText(`passives: ${totalPassives} / path: ${nodePathOrder.length}`, canvas.width - 315, 28);
    ctx.fillText(`drawn: ${debugActive} active + ${debugGreen} green + ${debugInactive} gray`, canvas.width - 315, 48);
    ctx.restore();
}

// Interactivity (Pan/Zoom)
//
// Two pan modes:
//   Shift + Left Click Drag → captured drag (game does NOT get the click)
//   Ctrl  + Left Click Drag → passthrough pan (game pans its tree too)
//
// With { forward: true }, Electron forwards mousemove to the renderer but
// NOT mousedown/mouseup. We check e.buttons & 1 on forwarded mousemove
// events to detect left-button-held state for Ctrl+drag panning.

let isDragging = false;
let ctrlPanning = false;
let lastX = 0;
let lastY = 0;
let mouseCaptured = false;

window.addEventListener('mousemove', e => {
    // --- Ctrl + Left Click Drag: pan overlay while game also pans ---
    // The click passes through to the game (panning the in-game tree)
    // while we track the drag via forwarded mousemove to pan the overlay.
    // Forwarded events don't include e.buttons, so we query OS-level state.
    if (e.ctrlKey && !e.shiftKey) {
        const leftButtonDown = ipcRenderer.sendSync('check-left-mouse');
        if (!leftButtonDown) {
            // Ctrl held but left button not pressed — don't pan
            if (ctrlPanning) ctrlPanning = false;
            return;
        }
        if (!ctrlPanning) {
            // First frame of drag — just record position, don't jump
            ctrlPanning = true;
            lastX = e.clientX;
            lastY = e.clientY;
            return;
        }
        panX += (e.clientX - lastX);
        panY += (e.clientY - lastY);
        lastX = e.clientX;
        lastY = e.clientY;
        draw();
        return;
    }

    // Ctrl released or left button released — stop panning
    if (ctrlPanning) {
        ctrlPanning = false;
    }

    // --- Shift: capture mouse exclusively for overlay interaction ---
    const isHoveringUI = e.target && e.target.closest && (e.target.closest('#controls') || e.target.closest('#close'));
    const shouldCapture = e.shiftKey || isHoveringUI;

    if (shouldCapture && !mouseCaptured) {
        mouseCaptured = true;
        ipcRenderer.send('tree-ignore-mouse', false);
    } else if (!shouldCapture && mouseCaptured && !isDragging) {
        mouseCaptured = false;
        ipcRenderer.send('tree-ignore-mouse', true, { forward: true });
    }

    if (!isDragging) return;
    panX += (e.clientX - lastX);
    panY += (e.clientY - lastY);
    lastX = e.clientX;
    lastY = e.clientY;
    draw();
});

canvas.addEventListener('mousedown', e => {
    // Shift + Left Click: captured drag (game does NOT get this click)
    if (e.button === 0 && e.shiftKey) {
        isDragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
    }
});

window.addEventListener('mouseup', e => {
    if (e.button === 0 && isDragging) {
        isDragging = false;
        if (!e.shiftKey) {
            mouseCaptured = false;
            ipcRenderer.send('tree-ignore-mouse', true, { forward: true });
        }
    }
});

canvas.addEventListener('wheel', e => {
    // Only allow zoom if Shift is held (prevents accidental game camera zoom)
    if (!e.shiftKey) return;

    const mouseX = e.clientX;
    const mouseY = e.clientY;

    const zoomFactor = 1.1;
    const newZoom = e.deltaY < 0 ? zoom * zoomFactor : zoom / zoomFactor;

    if (newZoom < 0.05 || newZoom > 1.5) return;

    panX = mouseX - (mouseX - panX) * (newZoom / zoom);
    panY = mouseY - (mouseY - panY) * (newZoom / zoom);
    zoom = newZoom;

    draw();
});
