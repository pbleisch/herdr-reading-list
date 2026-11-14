# Vendored libraries

The viewer has no build step and no package dependencies. These files are copied in. Each
library keeps its own `LICENSE` in its folder. `test/viewer-vendored.test.mjs` checks that every
file below exists with this checksum and that every module the viewer imports is present.

| File | Library and version | Source | SHA-256 |
| --- | --- | --- | --- |
| `marked/marked.esm.js` | Marked 18.2.0 | npm `marked@18.2.0`, `lib/marked.esm.js`, with the final `//# sourceMappingURL` line removed | `7770f5e7c24ef750b366852b3c8a0ad846fcc404cd01831e328f365d7f7ca162` |
| `marked/LICENSE` | Marked 18.2.0 | npm `marked@18.2.0`, `LICENSE` | `8e3a3f82f59a60958f56ca08f445647c32a4733dc7ca6c2c46f6eb898471ab9c` |
| `pdfjs/pdf.min.mjs` | PDF.js 4.10.38 | npm `pdfjs-dist@4.10.38`, `build/pdf.min.mjs`, unchanged | `27fc2a057a00f92a4334ad06e17dbd7259912954e9fb7f76400bcca5fd190a9c` |
| `pdfjs/pdf.worker.min.mjs` | PDF.js 4.10.38 | npm `pdfjs-dist@4.10.38`, `build/pdf.worker.min.mjs`, unchanged | `1baa1844c89c80a5b2797c916e75ab29254be46d8e9cb53cb6364d7aad84be36` |
| `pdfjs/LICENSE` | PDF.js 4.10.38 | npm `pdfjs-dist@4.10.38`, `LICENSE` | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |
| `three/three.min.js` | Three.js 0.187.0 (r187) | esbuild 0.25.12 bundle of npm `three@0.187.0`, built by the commands below | `1326f856b430dabbc6f6431e6bb6d6442f122cc0f7fa9e70f4920aaff22e0574` |
| `three/LICENSE` | Three.js 0.187.0 | npm `three@0.187.0`, `LICENSE` | `8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc` |

npm integrity of the source packages:

- `marked@18.2.0`: `sha512-KaeL+tAbtvI930q7HE2PN5lYXYdT8EiSmxHlN6F3rsfb57wd5mp5W5TLazpdj4inTQBJdgjYwbs40W/0VUGU+Q==`
- `pdfjs-dist@4.10.38`: `sha512-/Y3fcFrXEAsMjJXeL9J8+ZG9U01LbuWaYypvDW2ycW1jL269L3js3DVBjDJ0Up9Np1uqDXsDrRihHANhZOlwdQ==`
- `three@0.187.0`: `sha512-Qiu7R+Cmh8CstZsY1uJOSWnVlfo7ZtNLV7mF8Jltk3LB3AtDu9cRZlcnRKkAk8Y4z6KKw35z7Y7Urd7jWY8etA==`
- `esbuild@0.25.12` (build tool only): `sha512-bbPBYYrtZbkt6Os6FiTLCTFxvq4tt3JKall1vRwshA3fdVztsLAatFaZobhkBC8/BrPetoa0oksYoKXoG4ryJg==`

Marked's ESM build and PDF.js's `.min.mjs` builds are the smallest the packages ship. Three.js
ships no minified module, and its WebGL build is split across `three.core.js` and
`three.module.js` (2.1 MB together) plus one file per addon. `three/three.min.js` instead bundles
only the exports `gltf-view.js` imports, tree-shaken and minified, with the Three.js licence
header kept. GLTFLoader's own imports (BufferGeometryUtils, SkeletonUtils) are inside it.

## Reproduce

Run from the repository root with Node.js and npm. The commands write into a temporary folder
and copy the results into `mods/readlist/viewer/`; compare the checksums afterwards with
`shasum -a 256` or run the test.

```sh
viewer="$PWD/mods/readlist/viewer"
work="$(mktemp -d)"
cd "$work"
npm pack marked@18.2.0 pdfjs-dist@4.10.38 three@0.187.0 --silent
for t in *.tgz; do mkdir "${t%.tgz}"; tar -xzf "$t" -C "${t%.tgz}"; done
grep -v '^//# sourceMappingURL=marked.esm.js.map$' marked-18.2.0/package/lib/marked.esm.js > "$viewer/marked/marked.esm.js"
cp marked-18.2.0/package/LICENSE "$viewer/marked/LICENSE"
cp pdfjs-dist-4.10.38/package/build/pdf.min.mjs pdfjs-dist-4.10.38/package/build/pdf.worker.min.mjs "$viewer/pdfjs/"
cp pdfjs-dist-4.10.38/package/LICENSE "$viewer/pdfjs/LICENSE"
cp three-0.187.0/package/LICENSE "$viewer/three/LICENSE"
npm init -y > /dev/null
npm install --no-save --silent three@0.187.0 esbuild@0.25.12
cat > three-viewer.js <<'EOF'
export { ACESFilmicToneMapping, AnimationMixer, Box3, Clock, Color, PerspectiveCamera, PMREMGenerator, Scene, Vector3, WebGLRenderer } from "three";
export { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
export { OrbitControls } from "three/addons/controls/OrbitControls.js";
export { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
EOF
./node_modules/.bin/esbuild three-viewer.js --bundle --minify --format=esm --legal-comments=inline --log-level=warning --outfile="$viewer/three/three.min.js"
```

When `gltf-view.js` imports another Three.js export, add it to `three-viewer.js` and rebuild.
When updating a version, change it here, rerun the commands, and update the checksums and the
versions in `docs/viewer-contract.md` and `RECIPE.md`.
