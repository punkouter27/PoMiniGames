// PoCapitol Tactical Radar & Crowd Pressure Heatmap
// Renders an overhead tactical HUD tablet with campus floorplan, police line statuses,
// and real-time crowd pressure gradient heatmap.

import { areas, lineDefs, obstacles, milestones } from './world.js';

export function createRadar(canvas, { onSelectUnit } = {}) {
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    let width = canvas.width, height = canvas.height;
    let cachedDpr = 1;

    // Mapping from world coordinates (x in [-40, 40], z in [-75, 110]) to canvas coords
    const WORLD_X_MIN = -45, WORLD_X_MAX = 45;
    const WORLD_Z_MIN = -78, WORLD_Z_MAX = 108;
    const WORLD_W = WORLD_X_MAX - WORLD_X_MIN;
    const WORLD_D = WORLD_Z_MAX - WORLD_Z_MIN;

    function resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        cachedDpr = dpr;
        const rect = canvas.getBoundingClientRect();
        const displayW = Math.max(160, Math.floor(rect.width || 220));
        const displayH = Math.max(240, Math.floor(rect.height || 310));
        if (canvas.width !== displayW * dpr || canvas.height !== displayH * dpr) {
            canvas.width = displayW * dpr;
            canvas.height = displayH * dpr;
        }
        width = canvas.width;
        height = canvas.height;
    }

    function toCanvas(wx, wz) {
        const u = (wx - WORLD_X_MIN) / WORLD_W;
        // In world coords, -Z is inside (top), +Z is lawn (bottom)
        const v = (wz - WORLD_Z_MIN) / WORLD_D;
        return {
            x: u * width,
            y: v * height,
        };
    }

    function toWorld(cx, cy) {
        const u = cx / width;
        const v = cy / height;
        return {
            x: WORLD_X_MIN + u * WORLD_W,
            z: WORLD_Z_MIN + v * WORLD_D,
        };
    }

    // Offscreen buffer for heatmap density accumulation
    const heatCanvas = document.createElement('canvas');
    heatCanvas.width = 120;
    heatCanvas.height = 170;
    const heatCtx = heatCanvas.getContext('2d');

    let currentUnits = [];

    // Pointer click interaction to select units
    canvas.addEventListener('pointerdown', e => {
        if (!onSelectUnit || !currentUnits.length) return;
        const rect = canvas.getBoundingClientRect();
        const cx = (e.clientX - rect.left) * cachedDpr;
        const cy = (e.clientY - rect.top) * cachedDpr;
        const worldPos = toWorld(cx, cy);

        // Find closest unit within 6 meters
        let best = null, bestDist = 6.0;
        for (const u of currentUnits) {
            const d = Math.hypot(u.x - worldPos.x, u.z - worldPos.z);
            if (d < bestDist) {
                bestDist = d;
                best = u;
            }
        }
        if (best) onSelectUnit(best);
    });

    let pulseTime = 0;

    function render(state, selectedUnit = null, dt = 0.016) {
        if (!state) return;
        resize();
        pulseTime += dt;
        ctx.save();
        ctx.clearRect(0, 0, width, height);

        // 1. Tactical Blueprint Background
        ctx.fillStyle = '#0c1118';
        ctx.fillRect(0, 0, width, height);

        // Subtle tactical grid
        ctx.strokeStyle = 'rgba(70, 100, 140, 0.12)';
        ctx.lineWidth = 1 * cachedDpr;
        const stepX = width / 8, stepY = height / 14;
        ctx.beginPath();
        for (let x = 0; x <= width; x += stepX) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
        for (let y = 0; y <= height; y += stepY) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
        ctx.stroke();

        // 2. Blueprint Architectural Spaces
        ctx.fillStyle = 'rgba(25, 36, 52, 0.7)';
        ctx.strokeStyle = 'rgba(90, 140, 190, 0.35)';
        ctx.lineWidth = 1.2 * cachedDpr;

        for (const area of areas) {
            const p0 = toCanvas(area.x - area.w / 2, area.z - area.d / 2);
            const p1 = toCanvas(area.x + area.w / 2, area.z + area.d / 2);
            const rw = p1.x - p0.x, rh = p1.y - p0.y;
            ctx.fillRect(p0.x, p0.y, rw, rh);
            ctx.strokeRect(p0.x, p0.y, rw, rh);

            // Special Rotunda circle highlight
            if (area.name === 'Rotunda') {
                const center = toCanvas(area.x, area.z);
                const rx = (area.w / 2 / WORLD_W) * width;
                const ry = (area.d / 2 / WORLD_D) * height;
                ctx.beginPath();
                ctx.ellipse(center.x, center.y, rx, ry, 0, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(120, 180, 240, 0.4)';
                ctx.stroke();
            }
        }

        // Obstacles (Inauguration bleachers)
        ctx.fillStyle = 'rgba(60, 45, 35, 0.8)';
        ctx.strokeStyle = 'rgba(160, 120, 80, 0.5)';
        for (const obs of obstacles) {
            const p0 = toCanvas(obs.x - obs.w / 2, obs.z - obs.d / 2);
            const p1 = toCanvas(obs.x + obs.w / 2, obs.z + obs.d / 2);
            ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
            ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
        }

        // 3. Crowd Pressure Heatmap Accumulation
        heatCtx.clearRect(0, 0, heatCanvas.width, heatCanvas.height);
        heatCtx.globalCompositeOperation = 'lighter';

        const heatScaleX = heatCanvas.width / WORLD_W;
        const heatScaleY = heatCanvas.height / WORLD_D;

        for (const c of state.companions) {
            if (c.health <= 0) continue;
            const hx = (c.x - WORLD_X_MIN) * heatScaleX;
            const hy = (c.z - WORLD_Z_MIN) * heatScaleY;
            const pressure = (c.crowding || 1) / 5;
            const rad = Math.max(6, Math.min(20, (c.crowding + 2) * 2.5));

            const grad = heatCtx.createRadialGradient(hx, hy, 1, hx, hy, rad);
            if (pressure > 0.7) {
                grad.addColorStop(0, 'rgba(255, 60, 40, 0.45)');
                grad.addColorStop(0.5, 'rgba(255, 180, 0, 0.25)');
            } else if (pressure > 0.35) {
                grad.addColorStop(0, 'rgba(255, 190, 20, 0.35)');
                grad.addColorStop(0.6, 'rgba(60, 220, 100, 0.15)');
            } else {
                grad.addColorStop(0, 'rgba(40, 180, 240, 0.22)');
                grad.addColorStop(0.7, 'rgba(20, 120, 220, 0.08)');
            }
            grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

            heatCtx.fillStyle = grad;
            heatCtx.beginPath();
            heatCtx.arc(hx, hy, rad, 0, Math.PI * 2);
            heatCtx.fill();
        }

        // Draw heat buffer onto main tactical map with screen blend
        ctx.globalAlpha = 0.85;
        ctx.globalCompositeOperation = 'screen';
        ctx.drawImage(heatCanvas, 0, 0, width, height);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1.0;

        // 4. Police Lines and Integrity Bars
        for (let i = 0; i < lineDefs.length; i++) {
            const def = lineDefs[i];
            const line = state.lines[i];
            const p0 = toCanvas(def.x0, def.z);
            const p1 = toCanvas(def.x1, def.z);
            const integrity = line ? line.integrity : 100;
            const broken = line && line.state === 'broken';

            ctx.lineWidth = (broken ? 1.5 : 3.0) * cachedDpr;
            ctx.strokeStyle = broken
                ? 'rgba(180, 50, 50, 0.4)'
                : integrity > 60
                ? 'rgba(70, 160, 255, 0.95)'
                : integrity > 25
                ? 'rgba(255, 200, 40, 0.95)'
                : 'rgba(255, 60, 50, 0.95)';

            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y);
            ctx.lineTo(p1.x, p1.y);
            ctx.stroke();

            // Line label and integrity tag
            if (!broken) {
                ctx.fillStyle = '#b0d0ff';
                ctx.font = `${Math.round(8 * cachedDpr)}px monospace`;
                ctx.fillText(`L${i + 1} ${Math.round(integrity)}%`, p1.x + 3 * cachedDpr, p1.y + 3 * cachedDpr);
            }
        }

        // 5. Units & Factions Rendering
        const units = [];

        // Demonstrate crowd
        for (const c of state.companions) {
            units.push({ ...c, faction: 'raider' });
            const p = toCanvas(c.x, c.z);
            const downed = c.health <= 0;

            ctx.fillStyle = downed
                ? 'rgba(120, 120, 130, 0.4)'
                : c.temperament === 'medic'
                ? '#50ff90'
                : c.temperament === 'pusher'
                ? '#ff9f43'
                : '#54a0ff';

            const dotR = (downed ? 1.5 : 2.2) * cachedDpr;
            ctx.beginPath();
            ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
            ctx.fill();
        }

        // Police officers
        for (const e of state.enemies) {
            units.push({ ...e, faction: 'police' });
            const p = toCanvas(e.x, e.z);
            const downed = e.health <= 0;

            ctx.fillStyle = downed ? 'rgba(90, 80, 90, 0.35)' : '#00d2d3';
            const dotR = (downed ? 1.4 : 2.4) * cachedDpr;
            ctx.beginPath();
            ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
            ctx.fill();
        }

        // Player / Subject Beacon
        const playerOrSubject = state.role === 'none' ? state.companions.find(c => c.id === state.subject) : state.player;
        if (playerOrSubject) {
            const p = toCanvas(playerOrSubject.x, playerOrSubject.z);
            const pulse = (Math.sin(pulseTime * 5) + 1) * 0.5;
            ctx.strokeStyle = '#feca57';
            ctx.lineWidth = 1.5 * cachedDpr;
            ctx.beginPath();
            ctx.arc(p.x, p.y, (4 + pulse * 4) * cachedDpr, 0, Math.PI * 2);
            ctx.stroke();

            ctx.fillStyle = '#feca57';
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2.8 * cachedDpr, 0, Math.PI * 2);
            ctx.fill();
        }

        // 6. Selected Unit Highlight Reticle
        if (selectedUnit) {
            const p = toCanvas(selectedUnit.x, selectedUnit.z);
            ctx.strokeStyle = '#ff3838';
            ctx.lineWidth = 1.8 * cachedDpr;
            const r = 7 * cachedDpr;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.moveTo(p.x - r - 3 * cachedDpr, p.y); ctx.lineTo(p.x + r + 3 * cachedDpr, p.y);
            ctx.moveTo(p.x, p.y - r - 3 * cachedDpr); ctx.lineTo(p.x, p.y + r + 3 * cachedDpr);
            ctx.stroke();
        }

        currentUnits = units;
        ctx.restore();
    }

    function destroy() {
        // cleanup listeners
    }

    return { render, destroy, dispose: destroy };
}
