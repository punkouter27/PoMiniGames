// pocabinet-r186/three.js — the one place PoCabinet imports three from.
//
// WHY: the engine was written against r165's WebGLRenderer and constructs plain Mesh*Material
// objects everywhere. On the r186 WebGPURenderer the materials that can carry TSL nodes
// (colorNode, positionNode, ...) are the *NodeMaterial classes. Re-exporting them under the old
// names keeps every `new THREE.MeshStandardMaterial(...)` site unchanged while giving it a node
// material (same constructor parameters, same fields). The hooks that used to patch GLSL chunks
// (util.js addHook) now set TSL nodes on those materials (tslhooks.js).
export * from 'three-eco/webgpu';
import {
    MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshBasicNodeMaterial, MeshLambertNodeMaterial,
    PointsNodeMaterial, SpriteNodeMaterial, LineBasicNodeMaterial,
} from 'three-eco/webgpu';
export {
    MeshStandardNodeMaterial as MeshStandardMaterial, MeshPhysicalNodeMaterial as MeshPhysicalMaterial,
    MeshBasicNodeMaterial as MeshBasicMaterial, MeshLambertNodeMaterial as MeshLambertMaterial,
    PointsNodeMaterial as PointsMaterial, SpriteNodeMaterial as SpriteMaterial, LineBasicNodeMaterial as LineBasicMaterial,
};
