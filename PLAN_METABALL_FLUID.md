# Metaball Fluid Rendering - Implementation Plan

## Goal
Validate the fluid/paint aesthetic using a simpler approach before committing to full marching cubes. Render particles as soft, overlapping blobs that blend together to create a continuous fluid surface.

## Approach: Screen-Space Soft Particles

Instead of rendering individual spheres, we'll:
1. Render particles as large, soft depth sprites
2. Smooth/blur the depth buffer to merge nearby particles
3. Reconstruct surface normals from smoothed depth
4. Apply thick fluid material shading

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│ Pass 1: Particle Depth + Color                          │
│ - Render particles as point sprites to depth buffer     │
│ - Output: depthTexture, colorTexture, thicknessTexture  │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Pass 2: Bilateral Blur (Depth Smoothing)                │
│ - Blur depth to merge nearby particles into surface     │
│ - Preserve edges using bilateral filter                 │
│ - Output: smoothedDepthTexture                          │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Pass 3: Normal Reconstruction                           │
│ - Calculate normals from depth gradients                │
│ - Output: normalTexture                                 │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Pass 4: Final Compositing                               │
│ - Render fluid surface with:                            │
│   - Matte diffuse shading                               │
│   - Thickness-based subsurface scattering               │
│   - Color from blurred color buffer                     │
│ - Combine with existing post-processing                 │
└─────────────────────────────────────────────────────────┘
```

## Implementation Steps

### Step 1: Create Fluid Renderer Class
**File: `src/mls-mpm/fluidRenderer.js`**

```javascript
class FluidRenderer {
    constructor(mlsMpmSim, renderer, camera) {
        this.mlsMpmSim = mlsMpmSim;
        this.renderer = renderer;
        this.camera = camera;

        // Render targets
        this.depthTarget = null;
        this.colorTarget = null;
        this.thicknessTarget = null;
        this.smoothedDepthTarget = null;

        // Materials
        this.depthMaterial = null;
        this.blurMaterial = null;
        this.compositeMaterial = null;
    }
}
```

### Step 2: Particle Depth Pass
Render particles as soft spherical impostors that write depth.

**Vertex shader concept:**
- Billboard quad facing camera
- Size based on particle radius + smoothing kernel

**Fragment shader concept:**
- Calculate sphere depth at fragment
- Soft falloff at edges
- Discard fragments outside sphere radius

```javascript
// Depth material for particles
this.depthMaterial = new THREE.SpriteNodeMaterial();

this.depthMaterial.positionNode = Fn(() => {
    const particle = particleBuffer.element(instanceIndex);
    const worldPos = particle.get('position').mul(scale).add(offset);
    return worldPos;
})();

this.depthMaterial.fragmentNode = Fn(() => {
    // UV from sprite center: -1 to 1
    const uv2 = uv().sub(0.5).mul(2.0);
    const dist2 = dot(uv2, uv2);

    // Discard outside circle
    If(dist2.greaterThan(1.0), () => discard());

    // Calculate sphere depth offset
    const sphereZ = sqrt(float(1.0).sub(dist2));

    // Output depth and color
    return vec4(depth, color.rgb);
})();
```

### Step 3: Bilateral Blur Pass
Smooth the depth buffer while preserving edges.

**Key parameters:**
- `blurRadius`: How far to sample (pixels)
- `blurDepthFalloff`: How much depth difference reduces blur

```javascript
const bilateralBlur = Fn(([depthTex, colorTex, direction]) => {
    const centerDepth = depthTex.sample(uv());
    const centerColor = colorTex.sample(uv());

    const blurRadius = uniform(8);        // pixels
    const depthFalloff = uniform(0.01);   // depth sensitivity

    let totalWeight = float(1.0).toVar();
    let totalColor = centerColor.toVar();
    let totalDepth = centerDepth.toVar();

    // Sample in direction
    Loop({ start: -blurRadius, end: blurRadius }, (i) => {
        const offset = direction.mul(i).div(resolution);
        const sampleDepth = depthTex.sample(uv().add(offset));
        const sampleColor = colorTex.sample(uv().add(offset));

        // Weight based on spatial distance
        const spatialWeight = exp(float(i).mul(i).mul(-0.5).div(blurRadius));

        // Weight based on depth difference (bilateral)
        const depthDiff = abs(sampleDepth.sub(centerDepth));
        const depthWeight = exp(depthDiff.mul(-depthFalloff));

        const weight = spatialWeight.mul(depthWeight);
        totalWeight.addAssign(weight);
        totalDepth.addAssign(sampleDepth.mul(weight));
        totalColor.addAssign(sampleColor.mul(weight));
    });

    return vec4(totalDepth.div(totalWeight), totalColor.div(totalWeight).rgb);
});
```

### Step 4: Normal Reconstruction
Calculate surface normals from depth gradients.

```javascript
const reconstructNormals = Fn(([depthTex]) => {
    const texelSize = vec2(1.0).div(resolution);

    // Sample neighboring depths
    const depthL = depthTex.sample(uv().sub(vec2(texelSize.x, 0)));
    const depthR = depthTex.sample(uv().add(vec2(texelSize.x, 0)));
    const depthT = depthTex.sample(uv().sub(vec2(0, texelSize.y)));
    const depthB = depthTex.sample(uv().add(vec2(0, texelSize.y)));

    // Calculate gradients
    const dx = (depthR.sub(depthL)).mul(0.5);
    const dy = (depthB.sub(depthT)).mul(0.5);

    // Reconstruct normal
    const normal = normalize(vec3(dx.negate(), dy.negate(), 1.0));

    return normal;
});
```

### Step 5: Final Compositing with Fluid Material
Render the fluid surface with thick, matte appearance.

```javascript
const fluidComposite = Fn(([
    smoothedDepth,
    smoothedColor,
    normals,
    thickness
]) => {
    // Skip background
    If(smoothedDepth.lessThan(0.001), () => {
        return backgroundColor;
    });

    // Lighting
    const lightDir = normalize(vec3(0.5, 1.0, -0.5));
    const diffuse = max(0.0, dot(normals, lightDir));

    // Ambient occlusion from depth variation
    const ao = float(1.0).sub(depthVariance.mul(aoStrength));

    // Subsurface scattering approximation
    // Thinner areas let more light through
    const sssColor = vec3(1.0, 0.9, 0.8);  // warm transmission
    const sss = exp(thickness.negate().mul(absorptionCoeff)).mul(sssColor);

    // Combine
    const ambient = 0.3;
    const lighting = ambient.add(diffuse.mul(0.7)).mul(ao);

    return smoothedColor.mul(lighting).add(sss.mul(0.2));
});
```

### Step 6: Integration with App.js

```javascript
// In App.init()
this.fluidRenderer = new FluidRenderer(
    this.mlsMpmSim,
    this.renderer,
    this.camera
);
await this.fluidRenderer.init();

// In App.update()
if (conf.fluidRendering) {
    await this.fluidRenderer.render();
    // Composite fluid with post-processing
} else {
    // Existing particle rendering
}
```

### Step 7: Configuration Parameters

**Add to conf.js:**
```javascript
// === Fluid Rendering ===
fluidRendering = true;           // Toggle fluid vs particles
fluidSmoothness = 8;             // Blur radius (1-16)
fluidThickness = 0.5;            // SSS thickness factor
fluidSpecular = 0.1;             // Surface shininess (keep low for matte)
fluidAbsorption = 2.0;           // SSS absorption coefficient

// === Fluid Colors (earth tones) ===
fluidColorMode = 'earth';        // 'earth', 'original', 'custom'
```

## Color Palette for Earth Tones

To match the reference artwork:

```javascript
// Replace current red/pink palette with earth tones
const earthPalette = {
    mintGreen: vec3(0.6, 0.78, 0.65),
    sage: vec3(0.55, 0.65, 0.50),
    cream: vec3(0.95, 0.91, 0.84),
    rust: vec3(0.65, 0.35, 0.25),
    brown: vec3(0.55, 0.35, 0.22),
    yellow: vec3(0.85, 0.78, 0.55),
};

// Color varies by particle properties
const color = mix(
    mix(earthPalette.rust, earthPalette.brown, rand1),
    mix(earthPalette.mintGreen, earthPalette.sage, rand2),
    density.mul(0.5)
);
```

## File Changes Summary

| File | Changes |
|------|---------|
| `src/mls-mpm/fluidRenderer.js` | NEW - Main fluid rendering class |
| `src/app.js` | Add FluidRenderer, toggle logic |
| `src/conf.js` | Add fluid parameters + GUI |
| `src/mls-mpm/particleRenderer.js` | Optional: add earth tone colors |

## Implementation Order

1. **Create FluidRenderer class skeleton** (~30 min)
   - Basic structure, render targets setup

2. **Implement depth pass** (~1 hour)
   - Point sprite rendering
   - Spherical depth calculation

3. **Implement bilateral blur** (~1 hour)
   - Two-pass blur (horizontal + vertical)
   - Depth-aware weighting

4. **Implement normal reconstruction** (~30 min)
   - Depth gradient calculation

5. **Implement compositing** (~1 hour)
   - Fluid material shading
   - SSS approximation

6. **Integration + GUI** (~30 min)
   - Toggle in conf.js
   - Parameter controls

7. **Color palette update** (~30 min)
   - Earth tones option

8. **Testing + tuning** (~1 hour)
   - Adjust parameters for best look

**Total estimate: ~6-7 hours**

## Success Criteria

- [ ] Particles blend into continuous surface (no visible spheres)
- [ ] Smooth, organic edges
- [ ] Matte, paint-like material appearance
- [ ] Color blending at boundaries
- [ ] Performance: 60fps on M2 Max
- [ ] Toggle between particle/fluid rendering

## Next Steps After Validation

If the metaball approach looks good but we want even better quality:
1. Implement marching cubes for true 3D surface
2. Add foam/froth particles at high-velocity regions
3. Add surface detail normal perturbation

## References

- Screen-Space Fluid Rendering: Simon Green, GDC 2010
- Bilateral Filtering: Tomasi & Manduchi, 1998
- Real-time Fluid Simulation: Matthias Müller, SIGGRAPH
