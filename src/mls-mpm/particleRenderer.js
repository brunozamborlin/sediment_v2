import * as THREE from "three/webgpu";
import {Fn, attribute, triNoise3D, time, vec3, vec4, float, varying,instanceIndex,mix,normalize,cross,mat3,normalLocal,transformNormalToView,mx_hsvtorgb,mrt,uniform,sin,fract,dot} from "three/tsl";
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {conf} from "../conf";


export const calcLookAtMatrix = /*#__PURE__*/ Fn( ( [ target_immutable ] ) => {
    const target = vec3( target_immutable ).toVar();
    const rr = vec3( 0,0,1.0 ).toVar();
    const ww = vec3( normalize( target ) ).toVar();
    const uu = vec3( normalize( cross( ww, rr ) ).negate() ).toVar();
    const vv = vec3( normalize( cross( uu, ww ) ).negate() ).toVar();

    return mat3( uu, vv, ww );
} ).setLayout( {
    name: 'calcLookAtMatrix',
    type: 'mat3',
    inputs: [
        { name: 'direction', type: 'vec3' },
    ]
} );

// === Stable Random from Seed ===
// Generates a pseudo-random value [0,1] from a seed value
// Uses the common GPU noise pattern: fract(sin(seed * large) * large)
// This ensures each particle gets a consistent random value across frames
const stableRandom = /*#__PURE__*/ Fn( ( [ seed_immutable ] ) => {
    const seed = float( seed_immutable ).toVar();
    // Classic GPU pseudo-random using sin and fract
    return fract( sin( seed.mul( 78.233 ) ).mul( 43758.5453 ) );
} ).setLayout( {
    name: 'stableRandom',
    type: 'float',
    inputs: [
        { name: 'seed', type: 'float' },
    ]
} );

const createRoundedBox = (width, height, depth, radius) => {
    //completely overengineered late night programming lol
    const box = new THREE.BoxGeometry(width - radius*2, height - radius*2, depth - radius*2);
    const epsilon = Math.min(width, height, depth) * 0.01;
    const positionArray = box.attributes.position.array;
    const normalArray = box.attributes.normal.array;
    const indices = [...(box.getIndex().array)];
    const vertices = [];
    const posMap = {};
    const edgeMap = {};
    for (let i=0; i<positionArray.length / 3; i++) {
        const oldPosition = new THREE.Vector3(positionArray[i*3], positionArray[i*3+1], positionArray[i*3+2]);
        positionArray[i*3+0] += normalArray[i*3+0] * radius;
        positionArray[i*3+1] += normalArray[i*3+1] * radius;
        positionArray[i*3+2] += normalArray[i*3+2] * radius;
        const vertex = new THREE.Vector3(positionArray[i*3], positionArray[i*3+1], positionArray[i*3+2]);
        vertex.normal = new THREE.Vector3(normalArray[i*3], normalArray[i*3+1], normalArray[i*3+2]);
        vertex.id = i;
        vertex.faces = [];
        vertex.posHash = oldPosition.toArray().map(v => Math.round(v / epsilon)).join("_");
        posMap[vertex.posHash] = [...(posMap[vertex.posHash] || []), vertex];
        vertices.push(vertex);
    }
    vertices.forEach(vertex => {
        const face = vertex.normal.toArray().map(v => Math.round(v)).join("_");
        vertex.face = face;
        posMap[vertex.posHash].forEach(vertex => { vertex.faces.push(face); } );
    });
    vertices.forEach(vertex => {
        const addVertexToEdgeMap = (vertex, entry) => {
            edgeMap[entry] = [...(edgeMap[entry] || []), vertex];
        }
        vertex.faces.sort();
        const f0 = vertex.faces[0];
        const f1 = vertex.faces[1];
        const f2 = vertex.faces[2];
        const face = vertex.face;
        if (f0 === face || f1 === face) addVertexToEdgeMap(vertex, f0 + "_" + f1);
        if (f0 === face || f2 === face) addVertexToEdgeMap(vertex, f0 + "_" + f2);
        if (f1 === face || f2 === face) addVertexToEdgeMap(vertex, f1 + "_" + f2);
    });

    const addFace = (v0,v1,v2) => {
        const a = v1.clone().sub(v0);
        const b = v2.clone().sub(v0);
        if (a.cross(b).dot(v0) > 0) {
            indices.push(v0.id, v1.id, v2.id);
        } else {
            indices.push(v0.id, v2.id, v1.id);
        }
    }

    Object.keys(posMap).forEach(key => {
        addFace(...posMap[key])
    });

    Object.keys(edgeMap).forEach(key => {
        const edgeVertices = edgeMap[key];
        const v0 = edgeVertices[0];
        edgeVertices.sort((v1,v2) => v1.distanceTo(v0) - v2.distanceTo(v0));
        addFace(...edgeVertices.slice(0,3));
        addFace(...edgeVertices.slice(1,4));
    });

    box.setIndex(indices);
    return box;
}


class ParticleRenderer {
    mlsMpmSim = null;
    object = null;
    bloom = false;
    uniforms = {};

    constructor(mlsMpmSim) {
        this.mlsMpmSim = mlsMpmSim;

        /*const box = new THREE.BoxGeometry(0.7, 0.7,3);
        const cone = new THREE.ConeGeometry( 0.5, 3.0, 8 );
        cone.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI* 0.5, 0, 0)))
        this.geometry =  new THREE.InstancedBufferGeometry().copy(cone);
        console.log(this.geometry);*/

        // Use small spheres for micro-bead aesthetic
        const sphereGeometry = BufferGeometryUtils.mergeVertices(new THREE.IcosahedronGeometry(0.5, 1));
        const boxGeometry = BufferGeometryUtils.mergeVertices(new THREE.BoxGeometry(1, 1, 1), 0.5);
        boxGeometry.attributes.position.array = boxGeometry.attributes.position.array.map(v => v*0.5);

        this.defaultIndexCount = sphereGeometry.index.count;
        this.shadowIndexCount = boxGeometry.index.count;

        const mergedGeometry = BufferGeometryUtils.mergeGeometries([sphereGeometry, boxGeometry]);

        this.geometry = new THREE.InstancedBufferGeometry().copy(mergedGeometry);

        this.geometry.setDrawRange(0, this.defaultIndexCount);
        this.geometry.instanceCount = this.mlsMpmSim.numParticles;

        // Soft, matte material for volumetric look
        // Transparency enabled for opacity variation effect
        this.material = new THREE.MeshStandardNodeMaterial({
            metalness: 0.1,
            roughness: 0.8,
            transparent: true,
            depthWrite: true,  // Keep depth writing for proper sorting
        });

        // === Particle Uniforms ===
        this.uniforms.size = uniform(1);
        this.uniforms.sizeVariation = uniform(0.25);      // Range: 0 = uniform, 0.25 = 0.75x-1.25x
        this.uniforms.opacityVariation = uniform(0.2);    // Range: 0 = uniform, 0.2 = 0.8-1.0
        this.uniforms.depthBrightness = uniform(0.5);     // Range: 0 = no effect, 1.0 = strong falloff
        const vAo = varying(0, "vAo");
        const vNormal = varying(vec3(0), "v_normalView");

        const particle = this.mlsMpmSim.particleBuffer.element(instanceIndex);
        this.material.positionNode = Fn(() => {
            const particlePosition = particle.get("position");
            const particleDensity = particle.get("density");
            const particleMass = particle.get("mass");

            // Simple spherical particles (no velocity elongation)
            vNormal.assign(transformNormalToView(normalLocal));

            // Depth-based AO for atmosphere
            vAo.assign(particlePosition.z.div(64));
            vAo.assign(vAo.mul(vAo).oneMinus().mul(0.7).add(0.3));

            // === Size Variation ===
            // Use mass as stable per-particle random seed
            const seed = particleMass.fract().mul(7.0);
            const rand = stableRandom(seed);
            // Size varies from (1 - variation) to (1 + variation)
            // e.g., variation=0.25 gives range 0.75x to 1.25x
            const sizeVar = rand.mul(this.uniforms.sizeVariation).mul(2.0).sub(this.uniforms.sizeVariation).add(1.0);

            // Combine with density-based size
            const sizeScale = particleDensity.mul(0.2).add(0.8).clamp(0.6, 1.2);
            return attribute("position").xyz.mul(this.uniforms.size).mul(sizeScale).mul(sizeVar).add(particlePosition.mul(vec3(1,1,0.4)));
        })();

        // Custom color: muted reds/pinks + white/gray palette
        // With depth-based brightness for 3D volumetric effect
        this.material.colorNode = Fn(() => {
            const particlePosition = particle.get("position");
            const particleVelocity = particle.get("velocity");
            const particleDensity = particle.get("density");
            const particleMass = particle.get("mass");

            // Use mass as a stable per-particle random seed
            const seed = particleMass.fract().mul(10.0);

            // Base color: mix between deep red and soft pink/white
            const speed = particleVelocity.length();
            const t = seed.add(particleDensity.mul(0.3)).fract();

            // Muted red/pink palette
            const deepRed = vec3(0.45, 0.08, 0.12);
            const softPink = vec3(0.65, 0.25, 0.35);
            const warmWhite = vec3(0.85, 0.82, 0.80);
            const coolGray = vec3(0.5, 0.48, 0.52);

            // Blend based on particle properties
            const color1 = mix(deepRed, softPink, t);
            const color2 = mix(coolGray, warmWhite, t.mul(0.5).add(0.5));
            const baseColor = mix(color1, color2, speed.mul(0.3).clamp(0, 0.6));

            // === Depth-Based Brightness ===
            // Z ranges roughly 0-64 in particle space, normalize to 0-1
            // Lower Z = closer to camera = brighter
            const depthNorm = particlePosition.z.div(64.0).clamp(0, 1);
            // Invert: closer (low Z) = 1, farther (high Z) = 0
            const closeness = float(1.0).sub(depthNorm);
            // Apply brightness boost based on closeness
            // At depthBrightness=0.5: close particles get up to 1.5x brightness, far get 0.5x
            const brightnessMult = closeness.mul(this.uniforms.depthBrightness).add(float(1.0).sub(this.uniforms.depthBrightness.mul(0.5)));

            return baseColor.mul(brightnessMult);
        })();
        this.material.aoNode = vAo;

        // === Opacity Variation ===
        // Varies alpha from (1 - variation) to 1.0
        // e.g., variation=0.2 gives range 0.8 to 1.0
        this.material.opacityNode = Fn(() => {
            const particleMass = particle.get("mass");
            // Use different seed multiplier than size to get different random value
            const seed = particleMass.fract().mul(13.0);
            const rand = stableRandom(seed);
            // Opacity: (1 - variation) to 1.0
            return rand.mul(this.uniforms.opacityVariation).add(float(1.0).sub(this.uniforms.opacityVariation));
        })();

        //this.material.fragmentNode = vec4(0,0,0,1);
        //this.material.envNode = vec3(0.5);

        this.object = new THREE.Mesh(this.geometry, this.material);
        this.object.onBeforeShadow = () => { this.geometry.setDrawRange(this.defaultIndexCount, Infinity); }
        this.object.onAfterShadow = () => { this.geometry.setDrawRange(0, this.defaultIndexCount); }


        this.object.frustumCulled = false;

        const s = (1/64);
        this.object.position.set(-32.0*s,0,0);
        this.object.scale.set(s,s,s);
        this.object.castShadow = true;
        this.object.receiveShadow = true;
    }

    update() {
        const { particles, bloom, actualSize, sizeVariation, opacityVariation, depthBrightness } = conf;
        this.uniforms.size.value = actualSize;
        this.uniforms.sizeVariation.value = sizeVariation;
        this.uniforms.opacityVariation.value = opacityVariation;
        this.uniforms.depthBrightness.value = depthBrightness;
        this.geometry.instanceCount = particles;

        if (bloom !== this.bloom) {
            this.bloom = bloom;
            this.material.mrtNode = bloom ? mrt( {
                bloomIntensity: 1
            } ) : null;
        }
    }
}
export default ParticleRenderer;