import {Pane} from 'tweakpane';
import * as EssentialsPlugin from '@tweakpane/plugin-essentials';
import mobile from "is-mobile";
import * as THREE from "three/webgpu";

class Conf {
    gui = null;
    maxParticles = 8192 * 16;
    particles = 8192 * 8; // More particles for dense cloud

    bloom = true;

    run = true;
    noise = 0.4;
    speed = 1.5;
    stiffness = 3.;
    restDensity = 1.;
    density = 2;
    dynamicViscosity = 0.1;
    gravity = 1;  // 0=back, 1=down, 2=center, 3=device
    gravitySensorReading = new THREE.Vector3();
    accelerometerReading = new THREE.Vector3();
    actualSize = 1;
    size = 0.6; // Smaller particles

    points = false;

    // Visual parameters
    chromaticAberration = 0.0008;  // Subtle - set to 0 to disable completely
    fogNear = 0.1;
    fogFar = 2.2;
    bloomStrength = 0.5;
    bloomThreshold = 0.1;
    exposure = 1.0;

    // === Film Grain ===
    // Adds organic noise to reduce digital/CG look
    // Intensity 0.05-0.15 is subtle, 0.2+ is stylized
    filmGrainIntensity = 0.08;

    // === Particle Variation ===
    // Adds organic randomness to particle appearance
    // Uses mass as stable per-particle random seed
    sizeVariation = 0.25;      // 0 = uniform, 0.25 = size ranges 0.75x-1.25x
    opacityVariation = 0.2;    // 0 = uniform, 0.2 = opacity ranges 0.8-1.0

    // === Depth-Based Brightness ===
    // Makes closer particles brighter, farther particles dimmer
    // Creates volumetric 3D depth feeling
    depthBrightness = 0.5;     // 0 = no effect, 1.0 = strong depth falloff

    // === Vignette ===
    // Darkens edges of screen for cinematic focus
    vignetteIntensity = 0.3;   // 0 = off, 0.3 = subtle, 0.6+ = dramatic

    constructor(info) {
        if (mobile()) {
            this.maxParticles = 8192 * 8;
            this.particles = 4096;
        }
        this.updateParams();

    }

    updateParams() {
        const level = Math.max(this.particles / 8192,1);
        const size = 1.6/Math.pow(level, 1/3);
        this.actualSize = size * this.size;
        this.restDensity = 0.25 * level * this.density;
    }

    setupGravitySensor() {
        if (this.gravitySensor) { return; }
        this.gravitySensor = new GravitySensor({ frequency: 60 });
        this.gravitySensor.addEventListener("reading", (e) => {
            this.gravitySensorReading.copy(this.gravitySensor).divideScalar(50);
            this.gravitySensorReading.setY(this.gravitySensorReading.y * -1);
        });
        this.gravitySensor.start();
    }

    init() {
        const gui = new Pane()
        gui.registerPlugin(EssentialsPlugin);

        const stats = gui.addFolder({
            title: "stats",
            expanded: false,
        });
        this.fpsGraph = stats.addBlade({
            view: 'fpsgraph',
            label: 'fps',
            rows: 2,
        });

        // Presets
        const presetOptions = {
            options: {
                'Select preset...': '',
                'Calm': 'Calm',
                'Storm': 'Storm',
                'Dense Cloud': 'Dense Cloud',
                'Light Mist': 'Light Mist'
            },
            value: ''
        };
        gui.addBlade({
            view: 'list',
            label: 'presets',
            options: [
                {text: 'Calm', value: 'Calm'},
                {text: 'Storm', value: 'Storm'},
                {text: 'Dense Cloud', value: 'Dense Cloud'},
                {text: 'Light Mist', value: 'Light Mist'},
            ],
            value: 'Calm',
        }).on('change', (ev) => {
            this.applyPreset(ev.value);
        });

        const settings = gui.addFolder({
            title: "settings",
            expanded: false,
        });
        settings.addBinding(this, "particles", { min: 4096, max: this.maxParticles, step: 4096 }).on('change', () => { this.updateParams(); });
        settings.addBinding(this, "size", { min: 0.3, max: 2, step: 0.05 }).on('change', () => { this.updateParams(); });
        settings.addBinding(this, "bloom");

        const visuals = settings.addFolder({
            title: "visuals",
            expanded: false,
        });
        visuals.addBinding(this, "exposure", { min: 0.3, max: 2, step: 0.05 });
        visuals.addBinding(this, "bloomStrength", { min: 0, max: 1.5, step: 0.05 });
        visuals.addBinding(this, "bloomThreshold", { min: 0, max: 0.5, step: 0.01 });
        visuals.addBinding(this, "chromaticAberration", { min: 0, max: 0.01, step: 0.001 });
        visuals.addBinding(this, "fogNear", { min: 0.1, max: 1, step: 0.05 });
        visuals.addBinding(this, "fogFar", { min: 1, max: 4, step: 0.1 });
        visuals.addBinding(this, "filmGrainIntensity", { min: 0, max: 0.5, step: 0.01, label: "film grain" });
        visuals.addBinding(this, "sizeVariation", { min: 0, max: 0.5, step: 0.05, label: "size variation" });
        visuals.addBinding(this, "opacityVariation", { min: 0, max: 0.4, step: 0.05, label: "opacity variation" });
        visuals.addBinding(this, "depthBrightness", { min: 0, max: 1.0, step: 0.05, label: "depth brightness" });
        visuals.addBinding(this, "vignetteIntensity", { min: 0, max: 1.0, step: 0.05, label: "vignette" });
        //settings.addBinding(this, "points");

        const simulation = settings.addFolder({
            title: "simulation",
            expanded: false,
        });
        simulation.addBinding(this, "run");
        simulation.addBinding(this, "noise", { min: 0, max: 2, step: 0.01 });
        simulation.addBinding(this, "speed", { min: 0.1, max: 2, step: 0.1 });
        simulation.addBlade({
            view: 'list',
            label: 'gravity',
            options: [
                {text: 'back', value: 0},
                {text: 'down', value: 1},
                {text: 'center', value: 2},
                {text: 'device gravity', value: 3},
            ],
            value: 1,
        }).on('change', (ev) => {
            if (ev.value === 3) {
                this.setupGravitySensor();
            }
            this.gravity = ev.value;
        });
        simulation.addBinding(this, "density", { min: 0.4, max: 2, step: 0.1 }).on('change', () => { this.updateParams(); });;
        /*simulation.addBinding(this, "stiffness", { min: 0.5, max: 10, step: 0.1 });
        simulation.addBinding(this, "restDensity", { min: 0.5, max: 10, step: 0.1 });
        simulation.addBinding(this, "dynamicViscosity", { min: 0.01, max: 0.4, step: 0.01 });*/

        /*settings.addBinding(this, "roughness", { min: 0.0, max: 1, step: 0.01 });
        settings.addBinding(this, "metalness", { min: 0.0, max: 1, step: 0.01 });*/

        this.gui = gui;
    }

    // Presets
    applyPreset(name) {
        const presets = {
            'Calm': {
                noise: 0.3, speed: 0.5, size: 0.5, density: 0.8,
                exposure: 0.9, bloomStrength: 0.3, chromaticAberration: 0.002,
                fogNear: 0.4, fogFar: 2.0
            },
            'Storm': {
                noise: 1.5, speed: 1.4, size: 0.6, density: 1.2,
                exposure: 1.2, bloomStrength: 0.7, chromaticAberration: 0.006,
                fogNear: 0.2, fogFar: 1.5
            },
            'Dense Cloud': {
                noise: 0.5, speed: 0.6, size: 0.4, density: 1.5,
                exposure: 0.8, bloomStrength: 0.4, chromaticAberration: 0.003,
                fogNear: 0.5, fogFar: 2.5, particles: 8192 * 12
            },
            'Light Mist': {
                noise: 0.8, speed: 0.7, size: 0.8, density: 0.6,
                exposure: 1.1, bloomStrength: 0.6, chromaticAberration: 0.004,
                fogNear: 0.3, fogFar: 1.2, particles: 8192 * 4
            }
        };

        const preset = presets[name];
        if (preset) {
            Object.entries(preset).forEach(([key, value]) => {
                if (this[key] !== undefined) {
                    this[key] = value;
                }
            });
            this.updateParams();
            this.gui.refresh();
        }
    }

    update() {
    }

    begin() {
        this.fpsGraph.begin();
    }
    end() {
        this.fpsGraph.end();
    }
}
export const conf = new Conf();