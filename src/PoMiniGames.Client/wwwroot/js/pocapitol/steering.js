// Crowd steering for PoCapitol, built on Yuka (https://github.com/Mugen87/yuka, MIT).
//
// The flow field in world.js decides WHERE each raider is heading. This module decides HOW
// they get there: a Yuka Vehicle per raider blends "seek the next waypoint" with "keep your
// distance from the people around you", so a hundred figures compress at a doorway and flow
// around each other instead of stacking on one spot.
//
// Vehicles are presentation-free and live outside the attempt state: world.js copies each
// raider's position in, reads the proposed position out, and still owns collision. That
// keeps the attempt JSON-serializable and lets a test teleport a raider without desyncing.
import { Vehicle, SeekBehavior, SeparationBehavior, GameEntity } from 'yuka';

const NEIGHBOR_RADIUS = 1.25;

export function createSteering(capacity) {
    const vehicles = Array.from({ length: capacity }, () => {
        const vehicle = new Vehicle();
        vehicle.updateOrientation = false;
        vehicle.maxForce = 34;
        const separation = new SeparationBehavior();
        separation.weight = 3.2;
        const seek = new SeekBehavior();
        // Order is priority: Yuka spends the force budget on separation before seeking.
        vehicle.steering.add(separation).add(seek);
        vehicle.seek = seek;
        return vehicle;
    });
    const bodyPool = [];

    /**
     * Moves every agent one step. Agents are `{ id, x, z, targetX, targetZ, speed }` and gain
     * `nextX`, `nextZ` (the proposed position, before collision) and `crowding` (how many
     * people are within arm's reach). Bodies are anything with `x`/`z` that agents walk
     * around but that does not itself steer: officers, the human, people sitting down.
     */
    function step(agents, bodies, dt) {
        while (bodyPool.length < bodies.length) bodyPool.push(new GameEntity());
        for (let i = 0; i < bodies.length; i++) bodyPool[i].position.set(bodies[i].x, 0, bodies[i].z);
        for (const agent of agents) {
            const vehicle = vehicles[agent.id];
            vehicle.position.set(agent.x, 0, agent.z);
            vehicle.maxSpeed = agent.speed;
            vehicle.seek.target.set(agent.targetX, 0, agent.targetZ);
            // Arrived (or told to stand): seeking a zero-length vector would yield NaN-free
            // but meaningless jitter, so the seek is switched off and the vehicle brakes.
            vehicle.seek.active = Math.hypot(agent.targetX - agent.x, agent.targetZ - agent.z) > 0.12 && agent.speed > 0;
            if (!vehicle.seek.active) vehicle.velocity.multiplyScalar(Math.max(0, 1 - dt * 8));
        }
        for (const agent of agents) {
            const vehicle = vehicles[agent.id], neighbors = vehicle.neighbors;
            neighbors.length = 0;
            for (const other of agents) {
                if (other === agent) continue;
                const dx = other.x - agent.x, dz = other.z - agent.z;
                if (dx * dx + dz * dz < NEIGHBOR_RADIUS * NEIGHBOR_RADIUS) neighbors.push(vehicles[other.id]);
            }
            for (let i = 0; i < bodies.length; i++) {
                const dx = bodies[i].x - agent.x, dz = bodies[i].z - agent.z;
                if (dx * dx + dz * dz < NEIGHBOR_RADIUS * NEIGHBOR_RADIUS) neighbors.push(bodyPool[i]);
            }
            agent.crowding = neighbors.length;
        }
        for (const agent of agents) {
            const vehicle = vehicles[agent.id];
            vehicle.update(dt);
            agent.nextX = vehicle.position.x;
            agent.nextZ = vehicle.position.z;
        }
    }

    /** A raider that was stopped by a wall or a police line loses the speed it had into it. */
    function stop(id) { vehicles[id].velocity.set(0, 0, 0); }

    return { step, stop };
}
