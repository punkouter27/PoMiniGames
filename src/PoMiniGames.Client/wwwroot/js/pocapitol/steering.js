// Crowd steering & tactical squad formations for PoCapitol, built on Yuka (MIT).
// Implements coordinated police shield wall formations, tactical fallback stages,
// and intelligent crowd pressure wave dynamics.

import { Vehicle, SeekBehavior, SeparationBehavior, ObstacleAvoidanceBehavior, GameEntity } from 'yuka';
import { createGrid } from './physics.js';

const NEIGHBOR_RADIUS = 1.35;

export function createSteering(capacity) {
    let ticks = 0;
    const vehicles = Array.from({ length: capacity }, () => {
        const vehicle = new Vehicle();
        vehicle.updateOrientation = false;
        vehicle.maxForce = 36;
        const separation = new SeparationBehavior();
        separation.weight = 3.4;
        const seek = new SeekBehavior();
        vehicle.steering.add(separation).add(seek);
        vehicle.seek = seek;
        vehicle.separation = separation;
        return vehicle;
    });

    const bodyPool = [];
    const grid = createGrid(NEIGHBOR_RADIUS);
    const bodyGrid = createGrid(NEIGHBOR_RADIUS);

    /**
     * Moves every agent one step.
     * agents: raiders or officers with { id, x, z, targetX, targetZ, speed, mass, temperament, formation }
     * bodies: obstacles, other actors
     */
    function step(agents, bodies, dt) {
        ticks++;
        while (bodyPool.length < bodies.length) bodyPool.push(new GameEntity());
        for (let i = 0; i < bodies.length; i++) bodyPool[i].position.set(bodies[i].x, 0, bodies[i].z);

        for (const agent of agents) {
            const vehicle = vehicles[agent.id];
            vehicle.position.set(agent.x, 0, agent.z);
            vehicle.maxSpeed = agent.speed;
            vehicle.mass = (agent.mass ?? 70) / 70;

            // Tactical formation adjustments:
            // Shield-locked police have stronger separation against raiders but tighter cohesion with fellow officers
            if (agent.formation === 'shield-lock') {
                vehicle.separation.weight = 1.8; // Stand shoulder-to-shoulder
                vehicle.maxForce = 48; // Heavy bracing against shove
            } else if (agent.temperament === 'pusher') {
                vehicle.separation.weight = 2.4; // Willing to pack tighter to surge
                vehicle.maxForce = 40;
            } else {
                vehicle.separation.weight = 3.6;
                vehicle.maxForce = 32;
            }

            const dist = Math.hypot(agent.targetX - agent.x, agent.targetZ - agent.z);
            const inChokepoint = Math.abs(agent.x) < 4.5 &&
                ((agent.z > -31 && agent.z < -24) || (agent.z > -51 && agent.z < -44) || (agent.z > 11 && agent.z < 17));
            if (inChokepoint) {
                vehicle.separation.weight *= 0.65;
            }
            vehicle.seek.target.set(agent.targetX, 0, agent.targetZ);
            vehicle.seek.active = dist > 0.12 && agent.speed > 0;
            if (!vehicle.seek.active) vehicle.velocity.multiplyScalar(Math.max(0, 1 - dt * 8));
        }

        grid.clear();
        bodyGrid.clear();
        for (const agent of agents) grid.insert(agent, agent.x, agent.z);
        for (let i = 0; i < bodies.length; i++) bodyGrid.insert(i, bodies[i].x, bodies[i].z);

        for (const agent of agents) {
            const vehicle = vehicles[agent.id];
            const neighbors = vehicle.neighbors;
            neighbors.length = 0;
            let retreatingNear = 0, surgingNear = 0, aheadBlocking = 0;
            const toTargetX = agent.targetX - agent.x, toTargetZ = agent.targetZ - agent.z;
            const toTargetLen = Math.hypot(toTargetX, toTargetZ) || 1;
            grid.query(agent.x, agent.z, NEIGHBOR_RADIUS, other => {
                if (other === agent) return;
                const dx = other.x - agent.x, dz = other.z - agent.z;
                const d2 = dx * dx + dz * dz;
                if (d2 < NEIGHBOR_RADIUS * NEIGHBOR_RADIUS) {
                    neighbors.push(vehicles[other.id]);
                    if (other.actor?.retreating || (other.actor && other.actor.health <= 0)) retreatingNear++;
                    if ((other.actor?.surge ?? 0) > 0) surgingNear++;
                    const d = Math.sqrt(d2) || 1;
                    const dot = (dx * toTargetX + dz * toTargetZ) / (d * toTargetLen);
                    if (dot > 0.7 && d < 1.1) aheadBlocking++;
                }
            });
            bodyGrid.query(agent.x, agent.z, NEIGHBOR_RADIUS, i => {
                const dx = bodies[i].x - agent.x, dz = bodies[i].z - agent.z;
                if (dx * dx + dz * dz < NEIGHBOR_RADIUS * NEIGHBOR_RADIUS) neighbors.push(bodyPool[i]);
            });
            agent.crowding = neighbors.length;
            agent.retreatingNear = retreatingNear;
            agent.surgingNear = surgingNear;
            // People per square metre under this agent's own feet: what a crowd is actually
            // compressed to, which is what carries someone along when they stop walking.
            agent.density = neighbors.length / (Math.PI * NEIGHBOR_RADIUS * NEIGHBOR_RADIUS);
            if (aheadBlocking > 0 && Math.abs(agent.x) < 4.5) {
                vehicle.maxSpeed = agent.speed * Math.max(0.55, 1 - aheadBlocking * 0.15);
            }
        }

        for (const agent of agents) {
            const vehicle = vehicles[agent.id];
            // Squeezed past about 4 people/m^2 nobody is steering: the body is carried by the
            // people behind it. Add a lateral shove the agent did not ask for, deterministic in
            // id and step so a replay looks the same, and larger the tighter the pack.
            if (agent.crowding > 5 && agent.speed > 0) {
                const load = Math.min(1, (agent.crowding - 5) / 7);
                const phase = agent.id * 2.399963 + ticks * 0.17;
                const jitter = Math.sin(phase) * load * 0.9;
                const dx = agent.targetX - agent.x, dz = agent.targetZ - agent.z;
                const d = Math.hypot(dx, dz) || 1;
                vehicle.seek.target.x += (-dz / d) * jitter;
                vehicle.seek.target.z += (dx / d) * jitter;
            }
            vehicle.update(dt);
            agent.nextX = vehicle.position.x;
            agent.nextZ = vehicle.position.z;
        }
    }

    function stop(id) {
        if (vehicles[id]) vehicles[id].velocity.set(0, 0, 0);
    }

    return { step, stop };
}
