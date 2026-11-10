import * as THREE from 'three';

// GPU particle bursts: sparks, dust and debris thrown by blows, rounds, flash-bangs and breaking
// barriers.
//
// Nothing is simulated on the CPU after a particle is born. Each one is written once, with where it
// started, how fast it left, when it was born and how long it lives, and the vertex shader solves its
// whole flight in closed form every frame:
//
//     position = origin + velocity * (1 - e^(-drag t)) / drag + gravity * t^2 / 2
//
// with one soft bounce off the ground. So 20,000 live particles cost one draw call, one small buffer
// update per burst (only the slice that changed is uploaded) and no per-frame JavaScript. Dust is
// ordinary alpha, grows and drifts; sparks are additive, run hotter than white so the bloom pass
// catches them, shrink as they cool, and bounce.

const VERTEX = /* glsl */`
    attribute vec3 aVelocity;
    attribute vec4 aLife;   // birth time, lifetime, start size (m), drag
    attribute vec4 aColor;  // rgb (may exceed 1 to bloom), opacity
    attribute float aGravity;
    uniform float uTime, uScale, uGrow, uGround;
    varying vec4 vColor;
    varying float vAge;
    void main() {
        float age = uTime - aLife.x;
        if (age < 0.0 || age > aLife.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAge = 1.0; vColor = vec4(0.0); return; }
        float drag = max(aLife.w, 0.0001);
        float travel = (1.0 - exp(-drag * age)) / drag;
        vec3 p = position + aVelocity * travel;
        p.y -= 0.5 * aGravity * age * age;
        // One soft bounce: fold whatever sank below the ground back up, losing most of its energy.
        if (p.y < uGround) p.y = uGround + (uGround - p.y) * 0.32;
        vec4 view = modelViewMatrix * vec4(p, 1.0);
        vAge = age / aLife.y;
        vColor = aColor;
        gl_PointSize = max(1.0, aLife.z * (1.0 + uGrow * vAge) * uScale / max(0.1, -view.z));
        gl_Position = projectionMatrix * view;
    }
`;

const FRAGMENT = /* glsl */`
    uniform float uSoft;
    varying vec4 vColor;
    varying float vAge;
    void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0 || vAge >= 1.0) discard;
        // Soft disc; a hard core for sparks (uSoft near 0), a puff for dust (near 1).
        float shape = pow(1.0 - d, mix(0.7, 2.2, uSoft));
        float fade = smoothstep(1.0, 0.55, vAge) * smoothstep(0.0, 0.03, vAge);
        gl_FragColor = vec4(vColor.rgb * mix(1.0, 1.0 - 0.6 * vAge, 1.0 - uSoft), shape * fade * vColor.a);
    }
`;

function layer(scene, capacity, { additive, grow, soft, order }) {
    const geometry = new THREE.BufferGeometry();
    const origin = new Float32Array(capacity * 3), velocity = new Float32Array(capacity * 3);
    const life = new Float32Array(capacity * 4), color = new Float32Array(capacity * 4), gravity = new Float32Array(capacity);
    // Born "in the future" so an empty slot never draws.
    for (let i = 0; i < capacity; i++) life[i * 4] = 1e9;
    const attributes = {
        position: new THREE.BufferAttribute(origin, 3), aVelocity: new THREE.BufferAttribute(velocity, 3),
        aLife: new THREE.BufferAttribute(life, 4), aColor: new THREE.BufferAttribute(color, 4),
        aGravity: new THREE.BufferAttribute(gravity, 1),
    };
    for (const [name, attribute] of Object.entries(attributes)) { attribute.setUsage(THREE.DynamicDrawUsage); geometry.setAttribute(name, attribute); }
    const uniforms = {
        uTime: { value: 0 }, uScale: { value: 600 }, uGrow: { value: grow }, uGround: { value: 0.02 }, uSoft: { value: soft },
    };
    const material = new THREE.ShaderMaterial({
        uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = order;
    points.layers.set(1);
    scene.add(points);
    let head = 0, dirtyFrom = -1, dirtyTo = -1;
    return {
        points, uniforms, capacity, attributes,
        /** Writes one particle into the ring. The oldest is overwritten when the ring is full. */
        add(x, y, z, vx, vy, vz, born, lifetime, size, drag, g, r, gr, b, a) {
            const i = head; head = (head + 1) % capacity;
            origin[i * 3] = x; origin[i * 3 + 1] = y; origin[i * 3 + 2] = z;
            velocity[i * 3] = vx; velocity[i * 3 + 1] = vy; velocity[i * 3 + 2] = vz;
            life[i * 4] = born; life[i * 4 + 1] = lifetime; life[i * 4 + 2] = size; life[i * 4 + 3] = drag;
            gravity[i] = g;
            color[i * 4] = r; color[i * 4 + 1] = gr; color[i * 4 + 2] = b; color[i * 4 + 3] = a;
            if (dirtyFrom < 0) { dirtyFrom = dirtyTo = i; } else if (i < dirtyFrom || i > dirtyTo + 1) { dirtyFrom = 0; dirtyTo = capacity - 1; } else dirtyTo = i;
        },
        /** Uploads only the slice written since the last flush. */
        flush() {
            if (dirtyFrom < 0) return;
            const count = dirtyTo - dirtyFrom + 1;
            for (const attribute of Object.values(attributes)) {
                attribute.clearUpdateRanges?.();
                attribute.addUpdateRange?.(dirtyFrom * attribute.itemSize, count * attribute.itemSize);
                attribute.needsUpdate = true;
            }
            dirtyFrom = dirtyTo = -1;
        },
        dispose() { scene.remove(points); geometry.dispose(); material.dispose(); },
    };
}

/** Deterministic pseudo-random sequence, so the same blow always throws the same spray. */
function rng(seed) {
    let s = (Math.imul(seed | 0, 2654435761) >>> 0) || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export function createBursts(scene, { capacity = 16000 } = {}) {
    const sparks = layer(scene, capacity, { additive: true, grow: -0.65, soft: 0.1, order: 6 });
    const dust = layer(scene, Math.floor(capacity / 3), { additive: false, grow: 1.8, soft: 0.95, order: 5 });
    let now = 0, density = 1, serial = 1;

    /** Hot sparks out of a point: `energy` joules decides how many and how fast. */
    function spray(x, y, z, energy, { color = [4, 2.2, 0.8], spread = 1, up = 1.5, calm = false } = {}) {
        const random = rng(serial++ * 977 + Math.round(x * 31 + z * 17));
        const count = Math.round(Math.min(900, 10 + Math.sqrt(energy) * 7) * density * (calm ? 0.4 : 1));
        const speed = 2.5 + Math.min(9, Math.sqrt(energy) * 0.45);
        for (let i = 0; i < count; i++) {
            const angle = random() * Math.PI * 2, tilt = (random() - 0.2) * spread, v = speed * (0.35 + random() * 0.75);
            sparks.add(x, y, z, Math.cos(angle) * v * (1 - Math.abs(tilt) * 0.3), up * v * (0.3 + Math.abs(tilt)) + 1, Math.sin(angle) * v * (1 - Math.abs(tilt) * 0.3),
                now, 0.35 + random() * 0.8, 0.05 + random() * 0.07, 1.4, 9.8,
                color[0] * (0.6 + random() * 0.6), color[1] * (0.5 + random() * 0.7), color[2] * (0.5 + random() * 0.5), 1);
        }
    }
    /** A puff of grit and grey dust kicked up at the feet. */
    function puff(x, y, z, energy, { tone = [0.62, 0.58, 0.5], lift = 0.7, size = 0.55 } = {}) {
        const random = rng(serial++ * 733 + Math.round(x * 13 + z * 29));
        const count = Math.round(Math.min(120, 4 + Math.sqrt(energy) * 1.6) * density);
        for (let i = 0; i < count; i++) {
            const angle = random() * Math.PI * 2, v = 0.3 + random() * 1.6;
            dust.add(x + (random() - 0.5) * 0.3, y, z + (random() - 0.5) * 0.3, Math.cos(angle) * v, lift * (0.4 + random()), Math.sin(angle) * v,
                now, 0.9 + random() * 1.4, size * (0.5 + random() * 0.8), 2.2, -0.15,
                tone[0], tone[1], tone[2], 0.16 + random() * 0.14);
        }
    }

    return {
        /** Advances the shader clock, and tells it the scale to size points by and the floor to bounce off. */
        update(time, camera, viewHeight, floor) {
            now = time;
            const scale = viewHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
            for (const l of [sparks, dust]) {
                l.uniforms.uTime.value = time; l.uniforms.uScale.value = scale; l.uniforms.uGround.value = floor;
                l.flush();
            }
        },
        setDensity(value) { density = value; },
        spray, puff,
        /** One world event, thrown into the air. `calm` softens flashing for reduced-motion viewers. */
        react(e, floor, calm) {
            const energy = e.energy ?? 30, y = floor + 0.05;
            switch (e.type) {
                case 'shove':
                    puff(e.x, y, e.z, energy, { lift: 0.5 });
                    break;
                case 'baton':
                    spray(e.tx ?? e.x, floor + 1.2, e.tz ?? e.z, Math.max(30, energy * 0.5), { calm });
                    break;
                case 'impact':
                    if (e.material === 'body') puff(e.x, y, e.z, energy);
                    else spray(e.x, floor + (e.round ? 1.3 : 0.9), e.z, energy, { color: e.material === 'metal' ? [3, 3.4, 4] : [4, 2.6, 1.1], calm });
                    break;
                case 'gunshot':
                    spray(e.x, floor + 1.4, e.z, 90, { color: [5, 3.4, 1.4], spread: 0.6, calm });
                    break;
                case 'flash':
                    spray(e.x, floor + 0.8, e.z, calm ? 60 : 900, { color: [5, 4.4, 3.6], spread: 2, up: 2.2, calm });
                    puff(e.x, y, e.z, 600, { tone: [0.7, 0.7, 0.68], lift: 1.1, size: 1.3 });
                    break;
                case 'gas':
                    puff(e.x, y, e.z, 900, { tone: [0.83, 0.86, 0.8], lift: 1.6, size: 1.6 });
                    break;
                case 'break':
                    for (let i = 0; i < 6; i++) spray(e.x + (i - 2.5) * 2.4, floor + 0.7, e.z, 260, { color: [3, 3.2, 3.8], calm });
                    puff(e.x, y, e.z, 500, { size: 1.2 });
                    break;
                case 'down':
                    puff(e.x, y, e.z, 60, { lift: 0.4 });
                    break;
            }
        },
        dispose() { sparks.dispose(); dust.dispose(); },
    };
}
