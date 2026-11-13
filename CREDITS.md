# Credits

Everything that ships in `dist/index.html`, with source, author and licence.

## Textures

| Asset | Source | Author | Licence |
|---|---|---|---|
| Seaside Rock (`src/assets/textures/seaside_rock_diff_2k.jpg`, `seaside_rock_nor_gl_2k.jpg`) | https://polyhaven.com/a/seaside_rock | Dimitrios Savva, Poly Haven | CC0 1.0 |

Both files are the Poly Haven originals, downscaled to 2K.

No other image or model file ships. Rock, animals, algae, sky, water, caustics and foam are generated in code.

## Libraries

| Library | Use | Licence |
|---|---|---|
| three.js r187 (https://threejs.org) | Rendering. Official addons used as they are: `Sky` (Preetham sky with clouds), `GPUComputationRenderer`, `EffectComposer`, `UnrealBloomPass`, `OutputPass`, `ShaderPass`, `BokehShader2`, `BufferGeometryUtils`. The ripple simulation follows the `webgl_gpgpu_water` example and the planar mirror follows the `Reflector` addon's math. | MIT |
| anime.js 4.5.0 with `animejs/adapters/three` (https://animejs.com) | Close-up camera moves, depth of field, anemone, sea star and hermit crab reactions | MIT |
| Vite, vite-plugin-singlefile, TypeScript, Vitest, Playwright | Build, tests and captures (not shipped) | MIT / Apache-2.0 |

## Fonts and sound

- No web fonts ship: the interface uses the system font stack.
- The surf bed and fallback sounds are synthesised at run time with Web Audio. The two short recordings below are embedded in the single-file build.

| Asset | Source | Author | Licence | Edit |
|---|---|---|---|---|
| `src/audio/assets/wave-crash.ogg` | https://freesound.org/people/TRP/sounds/616596/ | TRP | CC0 1.0 | 4.5-second excerpt of the Freesound HQ preview, mono Ogg, faded and level reduced |
| `src/audio/assets/water-drop.ogg` | https://freesound.org/people/ReiyaManor/sounds/351623/ | ReiyaManor | CC0 1.0 | 0.65-second excerpt of the Freesound HQ preview, mono Ogg, faded and level adjusted |

