import * as THREE from 'three';
import { G } from '../core/globals.ts';
import noiseGlsl from '../glsl/noise.glsl?raw';
import commonGlsl from '../glsl/common.glsl?raw';
import underwaterGlsl from '../glsl/underwater.glsl?raw';
import rockGlsl from '../glsl/rock.glsl?raw';

export type RockKind = 'terrain' | 'boulder' | 'cobble';

export type PatchOptions = {
  /** Unique key for the program cache. */
  key: string;
  /** Rock surface model (replaces colour, roughness, normal and clearcoat). */
  rock?: RockKind;
  /** Shader detail level for rock (0..2). */
  detail?: number;
  /** Apply underwater light (sun extinction, caustics). Default true. */
  underwater?: boolean;
  /** Apply height fog. Default true. */
  fog?: boolean;
  /** Extra uniforms owned by this material. */
  uniforms?: Record<string, THREE.IUniform>;
  /** Include the shared GLSL (noise, uniforms, water level, fog) in the vertex shader too. */
  vertexCommon?: boolean;
  /** GLSL injected into the vertex shader after the world position is known. */
  vertexHead?: string;
  vertexBody?: string;
  /** GLSL injected after <begin_vertex> (object space, before skinning/instancing). */
  vertexTransform?: string;
  /** GLSL injected after <beginnormal_vertex>; may edit objectNormal. Runs before vertexTransform. */
  vertexNormal?: string;
  fragmentHead?: string;
  /** GLSL that runs before lighting and may edit diffuseColor, roughnessFactor and normal. */
  fragmentSurface?: string;
  /** GLSL that runs after lighting and may edit outgoingLight. */
  fragmentOutput?: string;
};

const sharedUniformNames = Object.keys(G) as (keyof typeof G)[];

/**
 * Extends a built-in lit material with this project's shared lighting model: tidal wetness,
 * underwater extinction and caustics, height fog with sun scattering, and (for rock) the full
 * procedural basalt surface. Built-in shadows, environment lighting and clearcoat stay intact.
 */
export function patchMaterial<T extends THREE.Material>(material: T, opts: PatchOptions): T {
  const underwater = opts.underwater ?? true;
  const fog = opts.fog ?? true;
  const detail = opts.detail ?? 1;
  material.customProgramCacheKey = () => `tp:${opts.key}:${opts.rock ?? '-'}:${detail}:${underwater}:${fog}:${opts.vertexCommon ? 1 : 0}`;
  material.onBeforeCompile = shader => {
    for (const name of sharedUniformNames) shader.uniforms[name] = G[name];
    if (opts.uniforms) Object.assign(shader.uniforms, opts.uniforms);
    if (opts.rock) {
      shader.uniforms.uRockSeed = { value: 0 };
      shader.uniforms.uRockTint = (material.userData.rockTint as THREE.IUniform) ?? { value: new THREE.Color(1, 1, 1) };
    }

    let vs = shader.vertexShader;
    let fs = shader.fragmentShader;
    const rockDefine = opts.rock === 'terrain' ? '#define TP_TERRAIN\n' : opts.rock === 'cobble' ? '#define TP_BOULDER\n#define TP_COBBLE\n' : opts.rock ? '#define TP_BOULDER\n' : '';

    vs = vs.replace('#include <common>', `#include <common>
varying vec3 vTpWorld;
varying vec3 vTpNormal;
${opts.rock ? 'varying vec3 vRockPos;\nvarying vec3 vRockNormal;\nvarying vec4 vRock;\n' : ''}
${opts.rock === 'terrain' ? 'attribute vec4 aRock;\n' : ''}
${opts.rock === 'boulder' || opts.rock === 'cobble' ? 'attribute float aAO;\n#ifdef USE_INSTANCING\nattribute vec2 aInst;\n#endif\n' : ''}
${opts.vertexCommon ? `${noiseGlsl}\n${commonGlsl}` : 'uniform float uTime;'}
${opts.vertexHead ?? ''}`);
    if (opts.vertexNormal) vs = vs.replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${opts.vertexNormal}`);
    if (opts.vertexTransform) vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>\n${opts.vertexTransform}`);
    vs = vs.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
{
  vec4 tpW = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  tpW = instanceMatrix * tpW;
  #endif
  tpW = modelMatrix * tpW;
  vTpWorld = tpW.xyz;
  vec3 tpN = objectNormal;
  #ifdef USE_INSTANCING
  tpN = mat3(instanceMatrix) * tpN;
  #endif
  vTpNormal = normalize(mat3(modelMatrix) * tpN);
}
${opts.rock ? 'vRockPos = vTpWorld;\nvRockNormal = vTpNormal;\n' : ''}
${opts.rock === 'terrain' ? 'vRock = aRock;\n' : ''}
${opts.rock === 'boulder' || opts.rock === 'cobble' ? '#ifdef USE_INSTANCING\nvRock = vec4(aAO, aInst.x, 2.0, -99.0);\n#else\nvRock = vec4(aAO, 0.5, 2.0, -99.0);\n#endif\n' : ''}
${opts.vertexBody ?? ''}`);

    fs = fs.replace('#include <common>', `${rockDefine}#include <common>
varying vec3 vTpWorld;
varying vec3 vTpNormal;
${noiseGlsl}
${commonGlsl}
${underwaterGlsl}
${opts.rock ? rockGlsl : ''}
${opts.fragmentHead ?? ''}`);

    if (opts.rock) {
      fs = fs.replace('#include <map_fragment>', `RockSurface rs = tpRockSurface(vRockPos, normalize(vRockNormal), vRock, ${detail.toFixed(1)});
diffuseColor.rgb = rs.albedo;`);
      fs = fs.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rs.rough;');
      fs = fs.replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(rs.n, 0.0)).xyz);');
      fs = fs.replace('#include <clearcoat_normal_fragment_begin>', `#ifdef USE_CLEARCOAT
vec3 clearcoatNormal = normalize((viewMatrix * vec4(rs.filmN, 0.0)).xyz);
#endif`);
      fs = fs.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
material.clearcoat = rs.film;
material.clearcoatRoughness = min(max(rs.filmRough, 0.03) + geometryRoughness, 1.0);
material.clearcoatF0 = vec3(0.02);
#endif`);
      fs = fs.replace('#include <aomap_fragment>', `{
  float ambientOcclusion = rs.ao;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_CLEARCOAT )
  clearcoatSpecularIndirect *= mix(1.0, ambientOcclusion, 0.6);
  #endif
  #if defined( USE_ENVMAP ) && defined( STANDARD )
  float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
  reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
}`);
    }
    if (opts.fragmentSurface) fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${opts.fragmentSurface}`);
    if (underwater) fs = fs.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\ntpUnderwater(reflectedLight, vTpWorld);');
    fs = fs.replace('#include <opaque_fragment>', `${opts.fragmentOutput ?? ''}
${fog ? 'outgoingLight = tpFog(outgoingLight, vTpWorld);' : ''}
#include <opaque_fragment>`);
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  return material;
}
