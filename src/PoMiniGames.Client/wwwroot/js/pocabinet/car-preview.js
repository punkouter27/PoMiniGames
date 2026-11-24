// pocabinet/car-preview.js
//
// Live 3D studio turntable for the Paint Shop: displays the actual coupe model with
// LivingPaint clearcoat, metallic flake, analytical cabin interior glass, and the
// selected procedural livery so players inspect changes in real time before racing.

import * as THREE from './three.js';
import { mountCar, unmountCar } from './cars.js';
import { pulseUiShader } from './uishader.js';
import { uiClick } from './audio.js';
import { createStage } from '../platform/stage/stage.js';
import { attachRenderer, configureRenderer } from '../platform/3d/renderer.js';

/**
 * Mount a 3D car preview turntable inside `canvasId`.
 * @param {string} canvasId
 * @param {string} colorHex
 * @param {number} liveryIndex
 */
export function mountCarPreview(canvasId, colorHex = '#3470d8', liveryIndex = 1) {
    const canvas = typeof canvasId === 'string' ? document.getElementById(canvasId) : canvasId;
    if (!canvas) return null;

    let renderer;
    try {
        // r186: the WebGPURenderer on its WebGL2 backend (lightweight preview turntable, no adapter probe warning).
        renderer = new THREE.WebGPURenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power', forceWebGL: true });
    } catch {
        return null;
    }

    configureRenderer(THREE, renderer, { tone: 'aces', exposure: 1.18 });

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 280 / 136, 0.1, 40);
    camera.position.set(3.55, 1.55, 3.85);
    camera.lookAt(0, 0.42, 0);

    // Three-point studio lighting + cool showroom rim.
    scene.add(new THREE.HemisphereLight(0xdce8ff, 0x161b26, 1.35));
    const key = new THREE.DirectionalLight(0xfff4df, 2.5);
    key.position.set(4.5, 6.0, 3.5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x52a8ff, 1.65);
    rim.position.set(-4.8, 3.2, -3.8);
    scene.add(rim);

    // Subtle illuminated turntable plinth under the wheels.
    const plinthGeo = new THREE.RingGeometry(1.75, 2.15, 48);
    const plinthMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        depthWrite: false,
    });
    const plinth = new THREE.Mesh(plinthGeo, plinthMat);
    plinth.rotation.x = -Math.PI * 0.5;
    plinth.position.y = 0.01;
    scene.add(plinth);

    const car = mountCar(scene, {
        id: 'player',
        color: colorHex,
        livery: Number.isFinite(Number(liveryIndex)) ? Number(liveryIndex) : 1,
        style: 0,
    });

    let yaw = 0.58;
    let yawVel = 0.55;
    let wipeFlash = 0;
    let dragging = false;
    let lastX = 0;
    let disposed = false;

    const onDown = (e) => {
        dragging = true;
        lastX = e.clientX;
        yawVel = 0;
        canvas.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e) => {
        if (!dragging) return;
        const dx = (e.clientX - lastX) * 0.012;
        yaw += dx;
        yawVel = Math.max(-6, Math.min(6, dx * 48));
        lastX = e.clientX;
    };
    const onUp = (e) => {
        dragging = false;
        canvas.releasePointerCapture?.(e.pointerId);
    };

    // The stage owns the loop and the sizing (the canvas is not appended or context-lost: the
    // page keeps it). The turntable has no camera shake.
    const stage = createStage({
        kind: '3d', container: canvas, maxDt: 0.05, exclude: ['shake'],
        onFrame: (dt) => {
            if (!dragging) {
                yaw += yawVel * dt;
                yawVel += (0.55 - yawVel) * (1 - Math.exp(-dt * 2.8));
            }
            if (wipeFlash > 0.002) {
                wipeFlash *= Math.exp(-dt * 5.2);
                rim.intensity = 1.65 + wipeFlash * 2.2;
                plinthMat.opacity = 0.22 + wipeFlash * 0.48;
                const sc = 1 + wipeFlash * 0.08;
                plinth.scale.set(sc, sc, 1);
            } else if (wipeFlash > 0) {
                wipeFlash = 0;
                rim.intensity = 1.65;
                plinthMat.opacity = 0.22;
                plinth.scale.set(1, 1, 1);
            }
            car.group.rotation.y = yaw;
            car.livery?.tick(dt, 0, 0);
            renderer.render(scene, camera);
        },
    });
    attachRenderer(stage, renderer, { camera, loseContext: false });
    stage.listen(canvas, 'pointerdown', onDown);
    stage.listen(canvas, 'pointermove', onMove);
    stage.listen(window, 'pointerup', onUp);
    renderer.init().then(() => { if (!disposed) stage.start(); }).catch((e) => console.warn('pocabinet/car-preview: renderer init failed', e));

    return {
        setLook(nextHex, nextLivery) {
            if (disposed) return;
            if (nextHex && car.paint?.color) {
                car.paint.color.set(nextHex);
                car.paintHex = nextHex;
            }
            if (nextLivery !== undefined && nextLivery !== null) {
                car.setLivery(Number(nextLivery) || 0);
            }
            wipeFlash = 1;
            yawVel = Math.max(yawVel, 1.8);
            pulseUiShader(0.5, 0.5, 0.9);
            uiClick('spray');
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            stage.dispose();
            unmountCar(car);
            plinthGeo.dispose();
            plinthMat.dispose();
        },
    };
}

export function updateCarPreview(handle, colorHex, liveryIndex) {
    handle?.setLook(colorHex, liveryIndex);
}

export function unmountCarPreview(handle) {
    handle?.dispose();
}
