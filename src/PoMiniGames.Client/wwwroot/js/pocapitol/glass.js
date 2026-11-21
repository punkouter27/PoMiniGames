import * as THREE from 'three-eco/webgpu';
import * as TSL from 'three-eco/tsl';
import { mirror } from './nodes.js';

// Window panes that actually break.
//
// Each pane is cut ahead of time into the shards it will become: a jittered grid of points
// across the sheet, triangulated, so the pieces are irregular and fit together exactly. Until a
// pane is broken its shards are not drawn at all. When it goes, every shard is given a velocity
// away from the blow (the ones nearest the point of impact fastest), a tumble, and the moment it
// left, and from then on the vertex shader solves its whole flight in closed form each frame:
// thrown, falling, landing flat on the floor and sliding to a stop. Nothing is simulated on the
// CPU, and a paused game shows the glass hanging in the air.

const GRAVITY = 9.81;

/**
 * Cuts a `w` x `h` sheet into triangles. Returns `[ax, ay, bx, by, cx, cy, ...]` in the sheet's
 * own plane, centred on its middle. `random` is a 0..1 source, so the cut is repeatable.
 */
export function cutPane(w, h, across = 6, up = 9, random = Math.random) {
    const points = [];
    for (let j = 0; j <= up; j++) for (let i = 0; i <= across; i++) {
        // The edge of the sheet stays where the frame is; everything inside is pushed about.
        const edgeX = i === 0 || i === across, edgeY = j === 0 || j === up;
        points.push((i + (edgeX ? 0 : (random() - 0.5) * 0.8)) / across * w - w / 2, (j + (edgeY ? 0 : (random() - 0.5) * 0.8)) / up * h - h / 2);
    }
    const p = (i, j) => (j * (across + 1) + i) * 2;
    const out = [];
    for (let j = 0; j < up; j++) for (let i = 0; i < across; i++) {
        const a = p(i, j), b = p(i + 1, j), c = p(i + 1, j + 1), d = p(i, j + 1);
        // Split each cell along one diagonal or the other, so no two cracks line up.
        const tris = random() < 0.5 ? [a, b, c, a, c, d] : [a, b, d, b, c, d];
        for (const k of tris) out.push(points[k], points[k + 1]);
    }
    return out;
}

/**
 * @param panes  `[{ x, y, z, w, h }]`: each sheet's centre and size; they face along z
 * @param floor  height the shards come to rest at
 */
export function createGlass(scene, panes, { floor = 0.12, sun = null } = {}) {
    let seed = 20210106;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const centre = [], local = [], velocity = [], spin = [], pane = [];
    panes.forEach((sheet, index) => {
        const cut = cutPane(sheet.w, sheet.h, 6, 9, random);
        // Where the blow lands on this sheet: low and off-centre, as a boot or a pole would.
        const hitX = (random() - 0.5) * sheet.w * 0.5, hitY = -sheet.h * (0.1 + random() * 0.25);
        for (let t = 0; t < cut.length; t += 6) {
            const mx = (cut[t] + cut[t + 2] + cut[t + 4]) / 3, my = (cut[t + 1] + cut[t + 3] + cut[t + 5]) / 3;
            const near = 1 / (1 + Math.hypot(mx - hitX, my - hitY) * 1.6);
            // Inward, mostly: the crowd is outside. A few pieces come back out at the feet.
            const inward = random() < 0.82 ? -1 : 0.6;
            const v = [(mx - hitX) * (1.2 + random() * 2) + (random() - 0.5), 0.6 + random() * 2.4 * near + (my - hitY) * 0.8,
                inward * (1.4 + 5.5 * near * (0.5 + random()))];
            const axis = new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
            const rate = (2 + random() * 9) * (random() < 0.5 ? -1 : 1);
            for (let k = 0; k < 3; k++) {
                centre.push(sheet.x + mx, sheet.y + my, sheet.z);
                local.push(cut[t + k * 2] - mx, cut[t + k * 2 + 1] - my, 0);
                velocity.push(...v); spin.push(axis.x, axis.y, axis.z, rate); pane.push(index);
            }
        }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(local, 3));
    geometry.setAttribute('aCentre', new THREE.Float32BufferAttribute(centre, 3));
    geometry.setAttribute('aVelocity', new THREE.Float32BufferAttribute(velocity, 3));
    geometry.setAttribute('aSpin', new THREE.Float32BufferAttribute(spin, 4));
    geometry.setAttribute('aPane', new THREE.Float32BufferAttribute(pane, 1));
    const born = new Array(Math.max(1, panes.length)).fill(1e9);
    const uniforms = { uTime: { value: 0 }, uBorn: { value: born }, uFloor: { value: floor }, uLight: { value: 1 },
        uSun: { value: sun ?? new THREE.Vector3(0.3, 0.6, 0.7) } };
    const material = new THREE.NodeMaterial();
    Object.assign(material, { transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    {
        const { vec3, vec4, float, cos, sin, cross, dot, normalize, max, min, clamp, exp, sqrt, mix, pow, select, reflect } = TSL;
        const aCentre = TSL.attribute('aCentre', 'vec3'), aVelocity = TSL.attribute('aVelocity', 'vec3');
        const aSpin = TSL.attribute('aSpin', 'vec4'), aPane = TSL.attribute('aPane', 'float');
        const uTime = mirror(uniforms.uTime), uFloor = mirror(uniforms.uFloor), uLight = mirror(uniforms.uLight), uSun = mirror(uniforms.uSun);
        const uBorn = TSL.uniformArray(born, 'float');
        const turn = (v, axis, angle) => {
            const c = cos(angle), sn = sin(angle);
            return v.mul(c).add(cross(axis, v).mul(sn)).add(axis.mul(dot(axis, v)).mul(c.oneMinus()));
        };
        // The whole flight, solved in closed form: world position, facing, and how long since it broke.
        const flight = TSL.Fn(() => {
            const t = uTime.sub(uBorn.element(TSL.int(aPane.add(0.5))));
            // When this shard reaches the floor, from where it started and how it was thrown.
            const drop = max(aCentre.y.sub(uFloor), 0);
            const land = aVelocity.y.add(sqrt(aVelocity.y.mul(aVelocity.y).add(drop.mul(2 * GRAVITY)))).div(GRAVITY);
            const air = min(t, land), rest = clamp(t.sub(land).mul(5), 0, 1);
            const at = aCentre.add(aVelocity.mul(air)).toVar();
            at.y.subAssign(air.mul(air).mul(0.5 * GRAVITY));
            // Landed: it skids a little further the way it was going, and stops.
            const skid = exp(max(t.sub(land), 0).mul(-6)).oneMinus().div(6);
            at.x.addAssign(aVelocity.x.mul(0.35).mul(skid));
            at.z.addAssign(aVelocity.z.mul(0.35).mul(skid));
            const shard0 = turn(TSL.positionGeometry, aSpin.xyz, aSpin.w.mul(air));
            const normal0 = turn(vec3(0, 0, 1), aSpin.xyz, aSpin.w.mul(air));
            // And lies flat, whichever way up it came down.
            const shard = mix(shard0, vec3(shard0.x, aPane.mul(0.0015).add(0.004), shard0.z.add(shard0.y)), rest);
            const nrm = normalize(mix(normal0, vec3(0, 1, 0), rest));
            at.y.assign(max(at.y, uFloor));
            return TSL.mat3(at.add(shard), nrm, vec3(t, 0, 0));
        })().toVar('shardFlight');
        const world = flight.element(0), nrm = flight.element(1), t = flight.element(2).x;
        const vNormal = TSL.varying(nrm, 'vShardN'), vWorld = TSL.varying(world, 'vShardW');
        material.vertexNode = select(t.lessThan(0), vec4(2, 2, 2, 1), TSL.cameraProjectionMatrix.mul(TSL.cameraViewMatrix).mul(vec4(world, 1)));
        material.fragmentNode = TSL.Fn(() => {
            const n = normalize(vNormal).toVar(), view = normalize(TSL.cameraPosition.sub(vWorld));
            n.assign(select(dot(n, view).lessThan(0), n.negate(), n));
            const fresnel = pow(clamp(dot(n, view), 0, 1).oneMinus(), 3);
            // Glass is nearly invisible face-on and a mirror edge-on; a tumbling shard flashes
            // white for one frame as it catches the sun, bright enough for the bloom to see.
            const glint = pow(max(dot(reflect(normalize(uSun).negate(), n), view), 0), 90);
            const body = mix(vec3(0.16, 0.22, 0.24), vec3(0.78, 0.86, 0.9), fresnel).mul(uLight);
            return vec4(body.add(glint.mul(5).mul(uLight)), mix(0.5, 0.95, fresnel).add(glint));
        })();
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.layers.set(1);
    mesh.renderOrder = 4;
    mesh.visible = false;
    scene.add(mesh);
    return {
        count: panes.length,
        /** Breaks pane `index` at scenario time `time`. A pane breaks once. */
        shatter(index, time) {
            if (index < 0 || index >= panes.length || born[index] < 1e8) return false;
            born[index] = time; mesh.visible = true;
            return true;
        },
        broken: index => born[index] < 1e8,
        /** @param light 0..1 brightness of the day, so the glass does not glow at dusk */
        update(time, light = 1) { uniforms.uTime.value = time; uniforms.uLight.value = 0.25 + 0.75 * light; },
        /** A new attempt: every pane is whole again. */
        reset() { born.fill(1e9); mesh.visible = false; },
        dispose() { scene.remove(mesh); geometry.dispose(); material.dispose(); },
    };
}
