# DEV_NOTES - Codebase Architecture

## Overview

This project is a WebGPU particle simulation using **MLS-MPM** (Moving Least Squares Material Point Method) physics. It runs in the browser using Three.js WebGPURenderer with TSL (Three.js Shading Language) for GPU compute shaders.

## File Structure & Responsibilities

```
/
├── index.html          # HTML shell, loading screen
├── index.js            # ENTRY POINT - WebGPU init, renderer, app bootstrap
├── vite.config.js      # Build config
├── package.json        # Dependencies: three, tweakpane, vite
│
└── src/
    ├── app.js                  # MAIN APP - scene setup, render loop orchestration
    ├── conf.js                 # CONFIGURATION + GUI (Tweakpane) - singleton
    ├── lights.js               # Lighting setup (SpotLight)
    ├── backgroundGeometry.js   # Room/box geometry with PBR textures
    ├── info.js                 # Info panel
    │
    ├── common/
    │   ├── noise.js            # triNoise3D - turbulence field generation
    │   └── hsv.js              # HSV to RGB conversion
    │
    └── mls-mpm/
        ├── mlsMpmSimulator.js  # SIMULATION - MLS-MPM physics compute shaders
        ├── particleRenderer.js # RENDERING - instanced rounded boxes
        ├── pointRenderer.js    # Alternative point-based rendering
        └── structuredArray.js  # GPU buffer management helper
```

## Key Components

### 1. Entry Point (`index.js`)
- Creates `THREE.WebGPURenderer`
- Checks for WebGPU support
- Instantiates `App` and starts animation loop
- Passes `delta` (frame time) and `elapsed` (total time) to `app.update()`

### 2. Main Application (`src/app.js`)
- **Scene setup**: Camera (PerspectiveCamera), OrbitControls
- **Environment**: HDRI background/environment map
- **Post-processing**: Bloom via MRT (Multiple Render Targets)
- **Update loop**: Calls simulation, renderers, lights

Key objects:
- `mlsMpmSim` - Simulation instance
- `particleRenderer` - Visual particle rendering
- `postProcessing` - Bloom post-processing chain

### 3. Configuration & GUI (`src/conf.js`)
**Singleton pattern** - `export const conf = new Conf()`

Current parameters:
| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `particles` | 32768 | 4096-131072 | Particle count |
| `size` | 1 | 0.5-2 | Particle visual size |
| `bloom` | true | bool | Enable bloom |
| `run` | true | bool | Run simulation |
| `noise` | 1.0 | 0-2 | Turbulence strength |
| `speed` | 1 | 0.1-2 | Simulation speed |
| `gravity` | 0 | enum | Gravity direction mode |
| `density` | 1 | 0.4-2 | Particle density |
| `stiffness` | 3 | - | Fluid stiffness (hidden) |
| `dynamicViscosity` | 0.1 | - | Viscosity (hidden) |

Uses **Tweakpane** (not lil-gui) for GUI.

### 4. Simulation (`src/mls-mpm/mlsMpmSimulator.js`)

**MLS-MPM Algorithm** - hybrid particle/grid method for fluid simulation.

Grid: **64x64x64** cells

**Compute Kernels** (executed in order):
1. `clearGrid` - Zero out grid cells
2. `p2g1` - Particle to Grid (transfer momentum)
3. `p2g2` - Particle to Grid (compute pressure/stress)
4. `updateGrid` - Apply boundary conditions
5. `g2p` - Grid to Particle (update velocities, positions)

**Particle Data Structure**:
```js
{
  position: vec3,   // Simulation position (0-64 range)
  velocity: vec3,   // Current velocity
  density: float,   // Local density
  mass: float,      // Particle mass
  C: mat3,          // Affine momentum matrix
  direction: vec3,  // Smoothed velocity direction (for rendering)
  color: vec3       // Computed color based on density/velocity
}
```

**Forces applied in `g2p` kernel**:
- Gravity (configurable direction)
- Noise/turbulence (`triNoise3Dvec` - curl-like noise)
- Mouse interaction force
- Wall repulsion (soft boundaries)

### 5. Particle Rendering (`src/mls-mpm/particleRenderer.js`)

- **Geometry**: Instanced rounded boxes (not spheres)
- **Orientation**: Aligned to velocity via `calcLookAtMatrix()`
- **Material**: `MeshStandardNodeMaterial` (metalness=0.9, roughness=0.5)
- **Custom nodes**:
  - `positionNode` - Transform instances by particle position/direction/density
  - `colorNode` - Per-particle HSV color based on density
  - `aoNode` - Depth-based ambient occlusion

Position is scaled: `position * vec3(1, 1, 0.4)` - Z is compressed!

### 6. Noise/Turbulence (`src/common/noise.js`)

`triNoise3Dvec(position, speed, time)` - Triangle wave-based 3D noise
- Returns `vec3` gradient
- Used for turbulence force field
- Not true curl noise, but produces flowing motion

## Coordinate System

- Simulation space: 0-64 on each axis (64x64x64 grid)
- World space: ~0-1 unit scale (divided by 64)
- Z-axis is compressed to 0.4 of X/Y for depth effect
- Origin offset: particles centered at (-0.5, 0, 0.2)

## Post-Processing Pipeline

```
Scene Pass (MRT)
    ├─→ outputPass (color)
    └─→ bloomIntensityPass (bloom mask)
           │
           ▼
       BloomNode
           │
           ▼
    Custom blend (soft light approximation)
```

Bloom settings: threshold=0.001, strength=0.94, radius=0.8

## Build & Run

```bash
npm install
npm run dev      # Development server (Vite)
npm run build    # Production build
npm run preview  # Preview production build
```

## Current Limitations / Notes

1. **Tweakpane vs lil-gui**: Project uses Tweakpane - plan asked for lil-gui
2. **Particle shape**: Rounded boxes, not spheres/billboards
3. **No fog**: Scene has no depth fog currently
4. **Fixed grid**: 64x64x64, not easily adjustable
5. **Limited presets**: No preset system
6. **Z compression**: Particles squeezed in Z (intentional depth effect)
7. **Mobile detection**: Has mobile-specific particle limits

## Integration Points for External Control

Future OSC/external control should target:
- `conf.*` parameters (direct manipulation)
- `mlsMpmSim.uniforms.*` for low-level control
- `mlsMpmSim.setMouseRay()` for interaction force
