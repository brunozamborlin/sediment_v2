import * as THREE from "three/webgpu";

export class Lights {
    constructor() {
        this.object = new THREE.Object3D();

        // Key light - warm, positioned for rim lighting effect
        const keyLight = new THREE.SpotLight(0xffe8e0, 3, 10, Math.PI * 0.3, 0.8, 0);
        const keyTarget = new THREE.Object3D();
        keyLight.position.set(1.0, 1.5, -1.0);
        keyTarget.position.set(0, 0.5, 0.2);
        keyLight.target = keyTarget;
        keyLight.castShadow = false; // No harsh shadows

        // Fill light - cool, from opposite side
        const fillLight = new THREE.SpotLight(0xe0e8ff, 1.5, 10, Math.PI * 0.4, 0.9, 0);
        const fillTarget = new THREE.Object3D();
        fillLight.position.set(-1.0, 0.8, -0.5);
        fillTarget.position.set(0, 0.5, 0.2);
        fillLight.target = fillTarget;

        // Rim/back light for depth
        const rimLight = new THREE.PointLight(0xff6060, 2, 5);
        rimLight.position.set(0, 0.5, 1.5);

        this.object.add(keyLight);
        this.object.add(keyTarget);
        this.object.add(fillLight);
        this.object.add(fillTarget);
        this.object.add(rimLight);
    }

    update(elapsed) {

    }
}