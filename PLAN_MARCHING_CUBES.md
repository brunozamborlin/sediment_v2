# Marching Cubes Fluid Rendering - Implementation Plan

## Goal
Render MLS-MPM particles as a continuous 3D fluid surface using marching cubes, achieving the thick paint/clay aesthetic with true volumetric folds and ridges.

## Why Marching Cubes

- **True 3D surface** - Not a screen-space approximation
- **Folds and overhangs** - Material can curl over itself
- **Correct from all angles** - Real geometry, not view-dependent
- **Thick ridges** - Captures the paint-like accumulation

## Architecture Overview

```
Every Frame:
┌─────────────────────────────────────────────────────────────┐
│ 1. MLS-MPM Simulation (existing - runs on GPU)              │
│    Output: particleBuffer (positions, velocities, colors)   │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. Clear 3D Grid (compute shader)                           │
│    Zero out density and color grids                         │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. Particle → Grid Splatting (compute shader)               │
│    Each particle adds density to nearby grid cells          │
│    Uses smooth kernel (trilinear or cubic)                  │
│    Output: densityGrid[128³], colorGrid[128³]               │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. Marching Cubes (compute shader)                          │
│    For each voxel: sample 8 corners, generate triangles     │
│    Uses edge table + triangle table lookups                 │
│    Output: vertexBuffer, normalBuffer, colorBuffer          │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. Render Fluid Mesh                                        │
│    Draw triangles with thick fluid material                 │
│    Matte diffuse + subsurface scattering                    │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 6. Post-Processing (existing)                               │
│    Film grain, vignette, etc.                               │
└─────────────────────────────────────────────────────────────┘
```

## Data Structures

### 3D Grids (Storage Textures)

```javascript
// Grid resolution - 128³ is good balance of quality/performance
const GRID_SIZE = 128;

// Density grid: float per voxel
// ~8 MB for 128³
densityGrid = new THREE.Data3DTexture(
    new Float32Array(GRID_SIZE ** 3),
    GRID_SIZE, GRID_SIZE, GRID_SIZE
);
densityGrid.format = THREE.RedFormat;
densityGrid.type = THREE.FloatType;

// Color grid: RGB per voxel (accumulated, then normalized)
// ~24 MB for 128³
colorGrid = new THREE.Data3DTexture(
    new Float32Array(GRID_SIZE ** 3 * 4),
    GRID_SIZE, GRID_SIZE, GRID_SIZE
);
colorGrid.format = THREE.RGBAFormat;
colorGrid.type = THREE.FloatType;
```

### Vertex Buffers (Dynamic)

```javascript
// Marching cubes generates up to 5 triangles per voxel
// Worst case: 128³ * 5 * 3 vertices = ~10M vertices
// Typical case: ~5-10% of that = ~500K-1M vertices
// Each vertex: position(3) + normal(3) + color(3) = 9 floats = 36 bytes

const MAX_VERTICES = 2_000_000;  // ~72 MB, plenty of headroom

vertexBuffer = new THREE.StorageBufferAttribute(
    new Float32Array(MAX_VERTICES * 3), 3
);
normalBuffer = new THREE.StorageBufferAttribute(
    new Float32Array(MAX_VERTICES * 3), 3
);
colorBuffer = new THREE.StorageBufferAttribute(
    new Float32Array(MAX_VERTICES * 3), 3
);

// Atomic counter for vertex count
vertexCountBuffer = new THREE.StorageBufferAttribute(
    new Uint32Array(1), 1
);
```

### Lookup Tables

Marching cubes requires two tables:
1. **Edge Table** (256 entries): Which edges are crossed for each case
2. **Triangle Table** (256 × 16 entries): Which edges form triangles

```javascript
// Store as textures for GPU access
edgeTableTexture = new THREE.DataTexture(
    new Uint32Array(EDGE_TABLE),
    256, 1
);

triTableTexture = new THREE.DataTexture(
    new Int32Array(TRI_TABLE),
    16, 256
);
```

## Implementation Steps

---

### Step 1: Create MarchingCubesRenderer Class

**File: `src/mls-mpm/marchingCubesRenderer.js`**

```javascript
import * as THREE from "three/webgpu";
import {
    Fn, uniform, instanceIndex, storage,
    float, vec3, vec4, int, uint,
    atomicAdd, atomicStore, textureStore, textureLoad,
    If, Loop, Return
} from "three/tsl";
import { EDGE_TABLE, TRI_TABLE } from "./marchingCubesTables.js";

class MarchingCubesRenderer {
    constructor(mlsMpmSim, renderer) {
        this.mlsMpmSim = mlsMpmSim;
        this.renderer = renderer;

        this.gridSize = 128;
        this.isoLevel = 0.5;  // Density threshold for surface

        // Will be initialized
        this.densityGrid = null;
        this.colorGrid = null;
        this.vertexBuffer = null;
        this.normalBuffer = null;
        this.colorBuffer = null;
        this.vertexCount = null;

        this.kernels = {};
        this.uniforms = {};

        this.mesh = null;
    }

    async init() {
        this.createGrids();
        this.createBuffers();
        this.createLookupTables();
        this.createKernels();
        this.createMesh();
    }

    async render() {
        // Run compute pipeline
        await this.renderer.computeAsync([
            this.kernels.clearGrid,
            this.kernels.splatParticles,
            this.kernels.marchingCubes
        ]);

        // Update mesh vertex count for drawing
        // (Read back vertexCount or use indirect drawing)
    }
}

export default MarchingCubesRenderer;
```

**Estimated time: 1 hour**

---

### Step 2: Create Lookup Tables Module

**File: `src/mls-mpm/marchingCubesTables.js`**

The classic marching cubes tables. These are standard and well-documented.

```javascript
// Edge table: 256 entries
// Each bit indicates if that edge is crossed
export const EDGE_TABLE = new Uint32Array([
    0x0, 0x109, 0x203, 0x30a, 0x406, 0x50f, 0x605, 0x70c,
    0x80c, 0x905, 0xa0f, 0xb06, 0xc0a, 0xd03, 0xe09, 0xf00,
    // ... (256 entries total - will include full table)
]);

// Triangle table: 256 cases × 16 indices (-1 terminated)
// Each row lists edge indices that form triangles
export const TRI_TABLE = new Int32Array([
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,  // Case 0
    0, 8, 3, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,     // Case 1
    // ... (256 × 16 entries total - will include full table)
]);

// Edge to vertex mapping: which two corners each edge connects
export const EDGE_VERTICES = [
    [0, 1], [1, 2], [2, 3], [3, 0],  // Bottom face edges
    [4, 5], [5, 6], [6, 7], [7, 4],  // Top face edges
    [0, 4], [1, 5], [2, 6], [3, 7]   // Vertical edges
];

// Corner offsets in grid space
export const CORNER_OFFSETS = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],  // Bottom corners
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]   // Top corners
];
```

**Estimated time: 30 minutes** (tables are standard, just need to format)

---

### Step 3: Implement Grid Clear Kernel

```javascript
this.kernels.clearGrid = Fn(() => {
    const idx = instanceIndex;
    const gridSize3 = this.gridSize ** 3;

    If(idx.greaterThanEqual(uint(gridSize3)), () => Return());

    // Clear density
    textureStore(this.densityGrid, idx3D(idx), float(0));

    // Clear color accumulator
    textureStore(this.colorGrid, idx3D(idx), vec4(0));

})().compute(this.gridSize ** 3);

// Helper: convert 1D index to 3D coordinates
const idx3D = (idx) => {
    const z = idx.mod(this.gridSize);
    const y = idx.div(this.gridSize).mod(this.gridSize);
    const x = idx.div(this.gridSize * this.gridSize);
    return ivec3(x, y, z);
};
```

**Estimated time: 30 minutes**

---

### Step 4: Implement Particle Splatting Kernel

Each particle contributes density to nearby grid cells using a smooth kernel.

```javascript
this.kernels.splatParticles = Fn(() => {
    If(instanceIndex.greaterThanEqual(this.uniforms.numParticles), () => Return());

    const particle = this.mlsMpmSim.particleBuffer.element(instanceIndex);
    const pos = particle.get('position');
    const color = particle.get('color');

    // Transform particle position to grid space
    // Simulation grid is 64³, our density grid is 128³
    // Scale factor: 128/64 = 2
    const gridPos = pos.mul(this.gridSize / 64.0);

    // Splat radius (in grid cells)
    const radius = float(2.0);  // Smooth kernel radius

    // Get integer cell position
    const cellMin = ivec3(gridPos.sub(radius).floor().max(0));
    const cellMax = ivec3(gridPos.add(radius).ceil().min(this.gridSize - 1));

    // Splat to all cells in range
    Loop({ start: cellMin.x, end: cellMax.x, type: 'int' }, ({ x }) => {
        Loop({ start: cellMin.y, end: cellMax.y, type: 'int' }, ({ y }) => {
            Loop({ start: cellMin.z, end: cellMax.z, type: 'int' }, ({ z }) => {
                const cellCenter = vec3(x, y, z).add(0.5);
                const dist = cellCenter.sub(gridPos).length();

                // Smooth kernel: cubic falloff
                const weight = max(0, float(1).sub(dist.div(radius))).pow(3);

                If(weight.greaterThan(0.001), () => {
                    // Atomic add to density grid
                    const cellIdx = x.mul(this.gridSize * this.gridSize)
                                    .add(y.mul(this.gridSize))
                                    .add(z);

                    atomicAdd(this.densityStorage.element(cellIdx), weight);

                    // Accumulate weighted color
                    atomicAdd(this.colorStorage.element(cellIdx).x, color.x.mul(weight));
                    atomicAdd(this.colorStorage.element(cellIdx).y, color.y.mul(weight));
                    atomicAdd(this.colorStorage.element(cellIdx).z, color.z.mul(weight));
                    atomicAdd(this.colorStorage.element(cellIdx).w, weight);  // Total weight
                });
            });
        });
    });

})().compute(1);  // Will set count to numParticles
```

**Estimated time: 2 hours**

---

### Step 5: Implement Marching Cubes Kernel

The core algorithm - for each voxel, determine which triangles to generate.

```javascript
this.kernels.marchingCubes = Fn(() => {
    const voxelIdx = instanceIndex;
    const gridSize = this.gridSize;
    const gridSize3 = gridSize ** 3;

    // Skip boundary voxels
    If(voxelIdx.greaterThanEqual(uint((gridSize - 1) ** 3)), () => Return());

    // Convert to 3D position (within interior grid)
    const innerSize = gridSize - 1;
    const vz = voxelIdx.mod(innerSize);
    const vy = voxelIdx.div(innerSize).mod(innerSize);
    const vx = voxelIdx.div(innerSize * innerSize);

    // Sample density at 8 corners
    const d = array([float(0)], 8).toVar();
    const c = array([vec3(0)], 8).toVar();  // Colors at corners

    // Corner 0: (vx, vy, vz)
    // Corner 1: (vx+1, vy, vz)
    // Corner 2: (vx+1, vy+1, vz)
    // ... etc (see CORNER_OFFSETS)

    Loop({ start: 0, end: 8, type: 'int' }, ({ i }) => {
        const offset = CORNER_OFFSETS[i];
        const cx = vx.add(offset[0]);
        const cy = vy.add(offset[1]);
        const cz = vz.add(offset[2]);
        const cellIdx = cx.mul(gridSize * gridSize).add(cy.mul(gridSize)).add(cz);

        d.element(i).assign(this.densityStorage.element(cellIdx));

        // Get color (normalize by weight)
        const colorData = this.colorStorage.element(cellIdx);
        const weight = colorData.w;
        If(weight.greaterThan(0.001), () => {
            c.element(i).assign(colorData.xyz.div(weight));
        }).Else(() => {
            c.element(i).assign(vec3(0.5));  // Default color
        });
    });

    // Build case index (which corners are inside surface)
    const isoLevel = this.uniforms.isoLevel;
    const cubeIndex = int(0).toVar();

    If(d.element(0).greaterThan(isoLevel), () => cubeIndex.addAssign(1));
    If(d.element(1).greaterThan(isoLevel), () => cubeIndex.addAssign(2));
    If(d.element(2).greaterThan(isoLevel), () => cubeIndex.addAssign(4));
    If(d.element(3).greaterThan(isoLevel), () => cubeIndex.addAssign(8));
    If(d.element(4).greaterThan(isoLevel), () => cubeIndex.addAssign(16));
    If(d.element(5).greaterThan(isoLevel), () => cubeIndex.addAssign(32));
    If(d.element(6).greaterThan(isoLevel), () => cubeIndex.addAssign(64));
    If(d.element(7).greaterThan(isoLevel), () => cubeIndex.addAssign(128));

    // Skip if entirely inside or outside
    If(cubeIndex.equal(0).or(cubeIndex.equal(255)), () => Return());

    // Look up which edges are crossed
    const edgeFlags = this.edgeTable.element(cubeIndex);

    // Calculate vertex positions on crossed edges (interpolate)
    const vertList = array([vec3(0)], 12).toVar();
    const colorList = array([vec3(0)], 12).toVar();

    // For each of 12 edges, check if crossed and interpolate
    // Edge 0: between corners 0 and 1
    If(edgeFlags.bitAnd(1).greaterThan(0), () => {
        const t = (isoLevel.sub(d.element(0))).div(d.element(1).sub(d.element(0)));
        vertList.element(0).assign(mix(corner0Pos, corner1Pos, t));
        colorList.element(0).assign(mix(c.element(0), c.element(1), t));
    });
    // ... (repeat for all 12 edges)

    // Look up triangles from tri table and emit vertices
    Loop({ start: 0, end: 15, step: 3, type: 'int' }, ({ i }) => {
        const triIdx = cubeIndex.mul(16).add(i);
        const e0 = this.triTable.element(triIdx);

        If(e0.lessThan(0), () => Return());  // End of triangles for this case

        const e1 = this.triTable.element(triIdx.add(1));
        const e2 = this.triTable.element(triIdx.add(2));

        // Allocate 3 vertices atomically
        const baseIdx = atomicAdd(this.vertexCount.element(0), uint(3));

        // Check we haven't exceeded buffer
        If(baseIdx.add(3).greaterThan(MAX_VERTICES), () => Return());

        // Get vertex positions from edge list
        const v0 = vertList.element(e0);
        const v1 = vertList.element(e1);
        const v2 = vertList.element(e2);

        // Calculate face normal
        const edge1 = v1.sub(v0);
        const edge2 = v2.sub(v0);
        const normal = normalize(cross(edge1, edge2));

        // Store vertices
        this.vertexStorage.element(baseIdx).assign(v0);
        this.vertexStorage.element(baseIdx.add(1)).assign(v1);
        this.vertexStorage.element(baseIdx.add(2)).assign(v2);

        // Store normals
        this.normalStorage.element(baseIdx).assign(normal);
        this.normalStorage.element(baseIdx.add(1)).assign(normal);
        this.normalStorage.element(baseIdx.add(2)).assign(normal);

        // Store colors
        this.colorStorage2.element(baseIdx).assign(colorList.element(e0));
        this.colorStorage2.element(baseIdx.add(1)).assign(colorList.element(e1));
        this.colorStorage2.element(baseIdx.add(2)).assign(colorList.element(e2));
    });

})().compute((this.gridSize - 1) ** 3);
```

**Estimated time: 4 hours** (most complex part)

---

### Step 6: Create Fluid Mesh and Material

```javascript
createMesh() {
    // Create geometry with storage buffers
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', this.vertexBuffer);
    this.geometry.setAttribute('normal', this.normalBuffer);
    this.geometry.setAttribute('color', this.colorBuffer);

    // Thick, matte fluid material
    this.material = new THREE.MeshStandardNodeMaterial({
        vertexColors: true,
        roughness: 0.85,      // Very matte
        metalness: 0.0,       // Non-metallic
        side: THREE.DoubleSide,  // See inside of folds
    });

    // Custom color node for SSS approximation
    this.material.colorNode = Fn(() => {
        const baseColor = attribute('color');

        // Fake subsurface scattering based on normal
        const viewDir = normalize(cameraPosition.sub(positionWorld));
        const fresnel = float(1).sub(abs(dot(normalWorld, viewDir)));
        const sssColor = vec3(1.0, 0.95, 0.9);  // Warm transmission
        const sss = fresnel.pow(3).mul(0.15).mul(sssColor);

        return baseColor.add(sss);
    })();

    // Add AO in crevices
    this.material.aoNode = Fn(() => {
        // Curvature-based AO approximation
        // (Will refine based on vertex density)
        return float(1.0);
    })();

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;

    // Scale to match scene
    const s = 1 / 64;
    this.mesh.position.set(-32 * s, 0, 0);
    this.mesh.scale.set(s, s, s);
}
```

**Estimated time: 1.5 hours**

---

### Step 7: Handle Dynamic Vertex Count

Since vertex count changes each frame, we need either:

**Option A: Indirect Drawing (preferred)**
```javascript
// Use drawIndirect to let GPU control vertex count
this.drawIndirectBuffer = new THREE.StorageBufferAttribute(
    new Uint32Array([0, 1, 0, 0]),  // [vertexCount, instanceCount, firstVertex, firstInstance]
    4
);

// In render: copy vertex count to indirect buffer
this.kernels.prepareIndirect = Fn(() => {
    const count = this.vertexCount.element(0);
    this.drawIndirect.element(0).assign(count);
})().compute(1);

// Draw with indirect
this.mesh.geometry.drawIndirect = this.drawIndirectBuffer;
```

**Option B: CPU Readback (simpler but slower)**
```javascript
// Read vertex count back to CPU
const countArray = new Uint32Array(1);
await this.renderer.readStorageBufferAsync(this.vertexCountBuffer, countArray);
this.geometry.setDrawRange(0, countArray[0]);
```

**Estimated time: 1 hour**

---

### Step 8: Integration with App.js

```javascript
// In App.init()
import MarchingCubesRenderer from "./mls-mpm/marchingCubesRenderer.js";

// After MLS-MPM simulator init
this.marchingCubesRenderer = new MarchingCubesRenderer(
    this.mlsMpmSim,
    this.renderer
);
await this.marchingCubesRenderer.init();
this.scene.add(this.marchingCubesRenderer.mesh);

// In App.update()
if (conf.fluidRendering) {
    this.particleRenderer.object.visible = false;
    this.marchingCubesRenderer.mesh.visible = true;
    await this.marchingCubesRenderer.render();
} else {
    this.particleRenderer.object.visible = true;
    this.marchingCubesRenderer.mesh.visible = false;
}
```

**Estimated time: 30 minutes**

---

### Step 9: Configuration and GUI

**Add to conf.js:**
```javascript
// === Fluid Rendering ===
fluidRendering = false;          // Toggle fluid vs particles
fluidIsoLevel = 0.5;             // Surface density threshold
fluidSmoothness = 2.0;           // Particle splat radius
fluidGridSize = 128;             // Grid resolution (64, 128, 256)

// === Fluid Material ===
fluidRoughness = 0.85;
fluidSubsurface = 0.15;          // SSS intensity

// === Fluid Colors ===
fluidColorMode = 'earth';        // 'earth', 'original', 'velocity'
```

**GUI:**
```javascript
const fluidFolder = settings.addFolder({ title: "fluid", expanded: false });
fluidFolder.addBinding(this, "fluidRendering", { label: "enable fluid" });
fluidFolder.addBinding(this, "fluidIsoLevel", { min: 0.1, max: 2.0, step: 0.1, label: "iso level" });
fluidFolder.addBinding(this, "fluidSmoothness", { min: 1.0, max: 4.0, step: 0.5, label: "smoothness" });
fluidFolder.addBinding(this, "fluidRoughness", { min: 0.5, max: 1.0, step: 0.05, label: "roughness" });
```

**Estimated time: 30 minutes**

---

### Step 10: Earth Tone Color Palette

**Add color mode to particle simulation or fluid renderer:**

```javascript
// Earth tone palette matching reference artwork
const earthTones = {
    mintGreen: vec3(0.60, 0.78, 0.65),
    sage: vec3(0.55, 0.62, 0.50),
    cream: vec3(0.95, 0.91, 0.84),
    rust: vec3(0.65, 0.38, 0.28),
    brown: vec3(0.50, 0.32, 0.22),
    ochre: vec3(0.80, 0.68, 0.45),
    terracotta: vec3(0.72, 0.45, 0.35),
};

// Color based on particle properties
const getFluidColor = Fn(() => {
    const density = particle.get('density');
    const velocity = particle.get('velocity');
    const mass = particle.get('mass');

    // Use mass as stable random seed
    const rand = fract(sin(mass.mul(78.233)).mul(43758.5453));

    // Mix between color pairs based on random + density
    const t1 = rand;
    const t2 = density.mul(0.3).add(rand.mul(0.7)).fract();

    const greenTones = mix(earthTones.mintGreen, earthTones.sage, t1);
    const brownTones = mix(earthTones.rust, earthTones.brown, t1);
    const lightTones = mix(earthTones.cream, earthTones.ochre, t1);

    // Blend based on position/density
    const color = mix(
        mix(brownTones, greenTones, t2),
        lightTones,
        velocity.length().mul(0.5).clamp(0, 0.4)
    );

    return color;
});
```

**Estimated time: 1 hour**

---

## File Structure

```
src/
├── mls-mpm/
│   ├── mlsMpmSimulator.js        (existing - no changes)
│   ├── particleRenderer.js       (existing - add color mode)
│   ├── marchingCubesRenderer.js  (NEW - main fluid renderer)
│   └── marchingCubesTables.js    (NEW - lookup tables)
├── app.js                        (modify - add fluid renderer)
└── conf.js                       (modify - add fluid params)
```

## Memory Budget (128³ grid)

| Buffer | Size | Notes |
|--------|------|-------|
| Density grid | 8 MB | 128³ × 4 bytes |
| Color grid | 32 MB | 128³ × 16 bytes (RGBA float) |
| Vertex buffer | 24 MB | 2M verts × 12 bytes |
| Normal buffer | 24 MB | 2M verts × 12 bytes |
| Color buffer | 24 MB | 2M verts × 12 bytes |
| Lookup tables | <1 MB | Edge + tri tables |
| **Total** | **~113 MB** | Trivial for 96GB |

## Performance Estimate (M2 Max)

| Stage | Estimated Time |
|-------|----------------|
| Clear grid | <0.1 ms |
| Particle splatting | ~1-2 ms (131K particles) |
| Marching cubes | ~2-4 ms (128³ voxels) |
| Mesh rendering | ~1-2 ms |
| **Total** | **~5-8 ms** (120+ fps possible) |

## Implementation Schedule

| Step | Task | Time |
|------|------|------|
| 1 | MarchingCubesRenderer skeleton | 1h |
| 2 | Lookup tables module | 0.5h |
| 3 | Clear grid kernel | 0.5h |
| 4 | Particle splatting kernel | 2h |
| 5 | Marching cubes kernel | 4h |
| 6 | Fluid mesh + material | 1.5h |
| 7 | Dynamic vertex count handling | 1h |
| 8 | App.js integration | 0.5h |
| 9 | Config + GUI | 0.5h |
| 10 | Earth tone colors | 1h |
| 11 | Testing + debugging | 2-3h |
| **Total** | | **~14-16h** |

## Checkpoints

1. **After Step 4**: Verify particles splat correctly to grid (visualize grid as debug)
2. **After Step 5**: Basic marching cubes working (even with simple shading)
3. **After Step 6**: Fluid material looks thick/matte
4. **After Step 10**: Colors match earth tone aesthetic

## Potential Challenges

1. **Atomic operations in WebGPU TSL**
   - May need to use storage buffers instead of textures
   - Fallback: multiple passes instead of atomics

2. **Indirect drawing in Three.js WebGPU**
   - May not be fully supported yet
   - Fallback: CPU readback of vertex count

3. **Edge cases in marching cubes**
   - Ambiguous cases (saddle points)
   - Solution: use asymptotic decider or accept minor artifacts

4. **Performance tuning**
   - Grid resolution vs quality tradeoff
   - Splat kernel radius affects smoothness vs speed

## Success Criteria

- [ ] Continuous fluid surface (no visible particles)
- [ ] Thick folds and ridges visible
- [ ] Correct from all viewing angles
- [ ] Matte, paint-like material
- [ ] Earth tone colors
- [ ] 60+ fps on M2 Max
- [ ] Toggle between particle/fluid rendering
- [ ] Adjustable iso level for surface threshold
