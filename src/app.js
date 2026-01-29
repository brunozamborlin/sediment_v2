import * as THREE from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls"
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import {Lights} from "./lights";
import hdri from "./assets/autumn_field_puresky_1k.hdr";

import { float, Fn, mrt, output, pass, vec3, vec4, uv, uniform } from "three/tsl";
import {conf} from "./conf";
import {Info} from "./info";
import MlsMpmSimulator from "./mls-mpm/mlsMpmSimulator";
import ParticleRenderer from "./mls-mpm/particleRenderer";
import BackgroundGeometry from "./backgroundGeometry";
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { rgbShift } from 'three/examples/jsm/tsl/display/RGBShiftNode.js';
import { film } from 'three/examples/jsm/tsl/display/FilmNode.js';
import { dot } from 'three/tsl';
import PointRenderer from "./mls-mpm/pointRenderer.js";

const loadHdr = async (file) => {
    const texture = await new Promise(resolve => {
        new RGBELoader().load(file, result => {
            result.mapping = THREE.EquirectangularReflectionMapping;
            result.colo
            resolve(result);
        });
    });
    return texture;
}

class App {
    renderer = null;

    camera = null;

    scene = null;

    controls = null;

    lights = null;

    constructor(renderer) {
        this.renderer = renderer;
    }

    async init(progressCallback) {
        this.info = new Info();
        conf.init();

        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 5);
        this.camera.position.set(0, 0.5, -1);
        this.camera.updateProjectionMatrix()

        this.scene = new THREE.Scene();

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, 0.5, 0.2);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.enablePan = true;
        this.controls.touches = {
            TWO: THREE.TOUCH.DOLLY_ROTATE,
        }
        this.controls.minDistance = 0.3;
        this.controls.maxDistance = 3.0;
        // Allow full orbit for dark background
        this.controls.minPolarAngle = 0.1 * Math.PI;
        this.controls.maxPolarAngle = 0.9 * Math.PI;

        await progressCallback(0.1)

        const hdriTexture = await loadHdr(hdri);

        // Dark background for volumetric particle aesthetic
        this.scene.background = new THREE.Color(0x000000);
        this.scene.environment = hdriTexture;
        this.scene.environmentRotation = new THREE.Euler(0,-2.15,0);
        this.scene.environmentIntensity = 0.15; // Dim environment lighting

        // Add fog for depth
        this.scene.fog = new THREE.Fog(0x000000, 0.3, 1.8);

        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;

        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        await progressCallback(0.5)

        this.mlsMpmSim = new MlsMpmSimulator(this.renderer);
        await this.mlsMpmSim.init();
        this.particleRenderer = new ParticleRenderer(this.mlsMpmSim);
        this.scene.add(this.particleRenderer.object);
        this.pointRenderer = new PointRenderer(this.mlsMpmSim);
        this.scene.add(this.pointRenderer.object);

        // Simplified lighting for dark aesthetic
        this.lights = new Lights();
        this.scene.add(this.lights.object);

        // Add soft ambient light
        const ambientLight = new THREE.AmbientLight(0x404050, 0.5);
        this.scene.add(ambientLight);

        // Background geometry disabled for dark volumetric aesthetic
        // const backgroundGeometry = new BackgroundGeometry();
        // await backgroundGeometry.init();
        // this.scene.add(backgroundGeometry.object);


        const scenePass = pass(this.scene, this.camera);
        scenePass.setMRT( mrt( {
            output,
            bloomIntensity: float( 0 ) // default bloom intensity
        } ) );
        const outputPass = scenePass.getTextureNode();
        const bloomIntensityPass = scenePass.getTextureNode( 'bloomIntensity' );
        const bloomPass = bloom( outputPass.mul( bloomIntensityPass ) );

        // === Vignette Setup ===
        // Darkens edges for cinematic focus on center
        // Intensity 0.3 = subtle, 0.6+ = dramatic
        this.vignetteIntensity = uniform(0.3);

        // Chromatic aberration amount (kept low to avoid RGB separation)
        this.chromaticAberrationAmount = uniform(0.0008);

        // Apply chromatic aberration to the output
        const rgbShiftPass = rgbShift(outputPass, this.chromaticAberrationAmount);

        // === Film Grain Effect ===
        // Adds organic noise to reduce digital/CG look
        // Intensity 0.05-0.15 is subtle, 0.2+ is stylized
        this.filmGrainIntensity = uniform(0.08);

        const postProcessing = new THREE.PostProcessing(this.renderer);
        postProcessing.outputColorTransform = false;

        // === Post-Processing Chain ===
        // Order: Scene -> Bloom blend -> Film Grain -> Vignette
        postProcessing.outputNode = Fn(() => {
            // Scene color with bloom
            const a = outputPass.rgb.clamp(0,1).toVar();
            const b = bloomPass.rgb.clamp(0,1).mul(bloomIntensityPass.r.sign().oneMinus()).toVar();
            // Soft light blend for bloom
            const blended = vec3(1).sub(b).sub(b).mul(a).mul(a).add(b.mul(a).mul(2)).clamp(0,1);

            // Apply film grain
            const withGrain = film(vec4(blended, 1.0), this.filmGrainIntensity);

            // === Vignette Effect ===
            // Darken edges based on distance from screen center
            const uv2 = uv().sub(0.5).mul(2.0);           // UV from -1 to 1
            const dist = dot(uv2, uv2);                    // Squared distance from center
            const vig = float(1.0).sub(dist.mul(this.vignetteIntensity));  // Darken by distance

            return vec4(withGrain.rgb.mul(vig.clamp(0, 1)), 1.0);
        })().renderOutput();

        this.postProcessing = postProcessing;
        // Configure bloom parameters
        bloomPass.threshold.value = 0.1;   // Lower threshold for more glow
        bloomPass.strength.value = 0.5;    // Soft bloom
        bloomPass.radius.value = 1.2;      // Wider spread
        this.bloomPassRef = bloomPass;     // Store reference for update loop


        this.raycaster = new THREE.Raycaster();
        this.plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0.2);
        this.renderer.domElement.addEventListener("pointermove", (event) => { this.onMouseMove(event); });

        await progressCallback(1.0, 100);
    }

    resize(width, height) {
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }

    onMouseMove(event) {
        const pointer = new THREE.Vector2();
        pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
        pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(pointer, this.camera);
        const intersect = new THREE.Vector3();
        this.raycaster.ray.intersectPlane(this.plane, intersect);
        if (intersect) {
            this.mlsMpmSim.setMouseRay(this.raycaster.ray.origin, this.raycaster.ray.direction, intersect);
        }
    }


    async update(delta, elapsed) {
        conf.begin();

        this.particleRenderer.object.visible = !conf.points;
        this.pointRenderer.object.visible = conf.points;

        // Update visual parameters from GUI
        this.scene.fog.near = conf.fogNear;
        this.scene.fog.far = conf.fogFar;
        this.renderer.toneMappingExposure = conf.exposure;
        this.bloomPassRef.strength.value = conf.bloomStrength;
        this.bloomPassRef.threshold.value = conf.bloomThreshold;
        this.chromaticAberrationAmount.value = conf.chromaticAberration;
        this.filmGrainIntensity.value = conf.filmGrainIntensity;
        this.vignetteIntensity.value = conf.vignetteIntensity;

        this.controls.update(delta);
        this.lights.update(elapsed);
        this.particleRenderer.update();
        this.pointRenderer.update();

        await this.mlsMpmSim.update(delta,elapsed);

        if (conf.bloom) {
            await this.postProcessing.renderAsync();
        } else {
            await this.renderer.renderAsync(this.scene, this.camera);
        }

        conf.end();
    }
}
export default App;
