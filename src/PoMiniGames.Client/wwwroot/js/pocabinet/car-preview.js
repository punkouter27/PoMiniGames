// pocabinet/car-preview.js
//
// Live 3D studio turntable for the Paint Shop: displays the actual coupe model with
// LivingPaint clearcoat, metallic flake, analytical cabin interior glass, and the
// selected procedural livery so players inspect changes in real time before racing.

import * as THREE from 'three';
import { mountCar, unmountCar } from './cars.js';

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
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    } catch {
        return null;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;

    const scene = new THREE.Scene();
    const w0 = Math.max(120, canvas.clientWidth || 280);
    const h0 = Math.max(80, canvas.clientHeight || 136);
    renderer.setSize(w0, h0, false);

    const camera = new THREE.PerspectiveCamera(32, w0 / h0, 0.1, 40);
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
    let dragging = false;
    let lastX = 0;
    let lastW = w0;
    let lastH = h0;
    let disposed = false;
    let raf = 0;
    let lastT = performance.now();

    const onDown = (e) => {
        dragging = true;
        lastX = e.clientX;
        canvas.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e) => {
        if (!dragging) return;
        yaw += (e.clientX - lastX) * 0.012;
        lastX = e.clientX;
    };
    const onUp = (e) => {
        dragging = false;
        canvas.releasePointerCapture?.(e.pointerId);
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    const tick = (now) => {
        if (disposed) return;
        const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
        lastT = now;

        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        if (cw > 0 && ch > 0 && (cw !== lastW || ch !== lastH)) {
            lastW = cw;
            lastH = ch;
            renderer.setSize(cw, ch, false);
            camera.aspect = cw / ch;
            camera.updateProjectionMatrix();
        }

        if (!dragging) yaw += dt * 0.55;
        car.group.rotation.y = yaw;
        car.livery?.tick(dt, 0, 0);
        renderer.render(scene, camera);
        raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

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
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            cancelAnimationFrame(raf);
            canvas.removeEventListener('pointerdown', onDown);
            canvas.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            unmountCar(car);
            plinthGeo.dispose();
            plinthMat.dispose();
            renderer.dispose();
        },
    };
}

export function updateCarPreview(handle, colorHex, liveryIndex) {
    handle?.setLook(colorHex, liveryIndex);
}

export function unmountCarPreview(handle) {
    handle?.dispose();
}
