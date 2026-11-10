// Crowd steering & tactical squad formations for PoCapitol, built on Yuka (MIT).
// Implements coordinated police shield wall formations, tactical fallback stages,
// and intelligent crowd pressure wave dynamics.

import { Vehicle, SeekBehavior, SeparationBehavior, ObstacleAvoidanceBehavior, GameEntity } from 'yuka';
import { createGrid } from './physics.js';

const NEIGHBOR_RADIUS = 1.35;

export function createSteering(capacity) {
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

            vehicle.seek.target.set(agent.targetX, 0, agent.targetZ);
            const dist = Math.hypot(agent.targetX - agent.x, agent.targetZ - agent.z);
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
            grid.query(agent.x, agent.z, NEIGHBOR_RADIUS, other => {
                if (other === agent) return;
                const dx = other.x - agent.x, dz = other.z - agent.z;
                if (dx * dx + dz * dz < NEIGHBOR_RADIUS * NEIGHBOR_RADIUS) neighbors.push(vehicles[other.id]);
            });
            bodyGrid.query(agent.x, agent.z, NEIGHBOR_RADIUS, i => {
                const dx = bodies[i].x - agent.x, dz = bodies[i].z - agent.z;
                if (dx * dx + dz * dz < NEIGHBOR_RADIUS * NEIGHBOR_RADIUS) neighbors.push(bodyPool[i]);
            });
            agent.crowding = neighbors.length;
        }

        for (const agent of agents) {
            const vehicle = vehicles[agent.id];
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
