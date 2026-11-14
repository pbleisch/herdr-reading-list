import { ACESFilmicToneMapping, AnimationMixer, Box3, Clock, Color, GLTFLoader, OrbitControls, PerspectiveCamera,
  PMREMGenerator, RoomEnvironment, Scene, Vector3, WebGLRenderer } from "./three/three.min.js";

export function createModelView(stage, documentUrl, reset, onContextLost) {
  let renderer;
  try { renderer = new WebGLRenderer({ antialias: true }); }
  catch { throw new Error("WebGL is unavailable in this browser."); }
  const scene = new Scene();
  scene.background = new Color(0x242932);
  const camera = new PerspectiveCamera(45, 1, 0.01, 10000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.screenSpacePanning = true;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.5;
  const pmrem = new PMREMGenerator(renderer);
  const environment = new RoomEnvironment();
  const map = pmrem.fromScene(environment);
  scene.environment = map.texture;
  environment.dispose();
  pmrem.dispose();
  stage.replaceChildren(renderer.domElement);
  const resize = () => {
    const width = Math.max(1, stage.clientWidth), height = Math.max(1, stage.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  resize();
  let mixer = null, disposed = false, model = null;
  const clock = new Clock();
  renderer.setAnimationLoop(() => {
    if (disposed) return;
    mixer?.update(clock.getDelta());
    controls.update();
    renderer.render(scene, camera);
  });
  const contextLost = (event) => { event.preventDefault(); onContextLost("WebGL context was lost. This model cannot be displayed."); };
  renderer.domElement.addEventListener("webglcontextlost", contextLost);
  reset.onclick = () => controls.reset();
  const ready = new GLTFLoader().loadAsync(documentUrl).then((gltf) => {
    if (disposed) return;
    model = gltf.scene;
    scene.add(model);
    const bounds = new Box3().setFromObject(model);
    if (bounds.isEmpty()) throw new Error("This model has no visible geometry.");
    const center = bounds.getCenter(new Vector3());
    const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 0.01);
    camera.position.copy(center).add(new Vector3(radius * 1.7, radius * 1.1, radius * 1.7));
    camera.near = Math.max(radius / 1000, 0.001);
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.minDistance = radius * 0.1;
    controls.maxDistance = radius * 30;
    controls.update();
    controls.saveState();
    if (gltf.animations.length) {
      mixer = new AnimationMixer(model);
      for (const clip of gltf.animations) mixer.clipAction(clip).play();
    }
  });
  return { ready, dispose() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    renderer.setAnimationLoop(null);
    renderer.domElement.removeEventListener("webglcontextlost", contextLost);
    reset.onclick = null;
    controls.dispose();
    mixer?.stopAllAction();
    if (model) {
      model.traverse((part) => {
        part.geometry?.dispose();
        const materials = Array.isArray(part.material) ? part.material : part.material ? [part.material] : [];
        for (const material of materials) {
          for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
          material.dispose();
        }
      });
    }
    map.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    stage.replaceChildren();
  } };
}
