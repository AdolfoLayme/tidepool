// Water surface fragment model (pool and sea share it). Requires noise, common and waves.

uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform sampler2D uRippleTex;
uniform sampler2D uSurfFoam;
uniform sampler2D uSurfState;
uniform float uSurfLayer;
uniform vec2 uSurfTexel;
uniform vec2 uRippleTexel;
uniform sampler2D uReflTex;
uniform mat4 uReflMatrix;
uniform float uReflOn;
uniform vec2 uResolution;
uniform vec2 uProjScale;
uniform float uNear;
uniform float uFar;
uniform float uExposure;
uniform vec3 uSkyIrr;
uniform float uWind;
uniform float uSwell;
uniform samplerCube envMap;
uniform float uEnvOn;
uniform float uEnvMaxLod;

varying vec3 vWorld;
varying vec2 vSlope;
varying float vCrest;
varying float vFactor;
varying float vMask;
varying float vViewZ;
varying float vSeaDepth;
varying vec2 vXZ;
varying vec2 vSurfUV;
varying float vSurfMix;
varying float vSurfDepth;

float tpLinearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}

vec2 tpRippleUV(vec2 xz) { return (xz - uPoolRect.xy) * uPoolRect.zw; }

// Slope of the simulated pool surface.
vec3 tpRipple(vec2 xz) {
  vec2 uv = tpRippleUV(xz);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec3(0.0);
  vec4 c = texture(uRippleTex, uv);
  float hx = texture(uRippleTex, uv + vec2(uRippleTexel.x, 0.0)).x - texture(uRippleTex, uv - vec2(uRippleTexel.x, 0.0)).x;
  float hz = texture(uRippleTex, uv + vec2(0.0, uRippleTexel.y)).x - texture(uRippleTex, uv - vec2(0.0, uRippleTexel.y)).x;
  vec2 g = vec2(hx * uPoolRect.z / (2.0 * uRippleTexel.x), hz * uPoolRect.w / (2.0 * uRippleTexel.y));
  return vec3(g, c.z);
}

// Rock shadow on the surface: march the height maps toward the sun.
float tpSurfaceShadow(vec3 p) {
  vec3 s = normalize(uSunDir);
  float flat2 = length(s.xz);
  if (s.y < 0.0) return 0.0;
  vec2 dir = s.xz / max(flat2, 1e-4);
  float rise = s.y / max(flat2, 1e-4);
  float lit = 1.0;
  float dist = 0.03;
  for (int i = 0; i < 10; i++) {
    float h = tpShore(p.xz + dir * dist).x;
    float ray = p.y + rise * dist;
    lit = min(lit, clamp((ray - h) / (0.02 + dist * 0.06) + 0.5, 0.0, 1.0));
    dist *= 1.62;
  }
  return lit;
}

// Bubbly, streaky foam texture.
float tpFoamPattern(vec2 p, float t) {
  vec2 a = tpWorley(p * 14.0 + vec2(t * 0.08, -t * 0.05));
  vec2 b = tpWorley(p * 37.0 - vec2(t * 0.11, t * 0.04));
  float cells = smoothstep(0.02, 0.18, a.y - a.x);
  float small = smoothstep(0.03, 0.2, b.y - b.x);
  float lace = tpVNoise(p * 5.0 + t * 0.05) * 0.6 + tpVNoise(p * 17.0 - t * 0.08) * 0.4;
  return clamp(cells * 0.55 + small * 0.45, 0.0, 1.0) * smoothstep(0.25, 0.7, lace);
}

float tpGGX(float NdotH, float a) {
  float a2 = a * a;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * d * d);
}

// Distance to the nearest cell wall: small on the walls, so it draws a web of bubble edges.
float tpBubbleWall(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = 8.0, b = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = vec2(tpHashF(i + g), tpHashF(i + g + 17.3));
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < a) { b = a; a = d; } else if (d < b) b = d;
  }
  return sqrt(b) - sqrt(a);
}

vec3 tpWaterShade() {
  vec2 suv = gl_FragCoord.xy / uResolution;
  float dScene = texture(uSceneDepth, suv).x;
  if (gl_FragCoord.z > dScene + 1e-7) discard;
  // The coarse sea mesh yields to the fine shore grid, and the grid never paints outside its domain.
  if (uSurfLayer < 0.5 && vSurfMix > 0.5) discard;
  if (uSurfLayer > 0.5 && vSurfMix <= 0.5) discard;
  float surfDepth = texture(uSurfState, vSurfUV).r;
  if (vSurfMix > 0.95 && surfDepth < 0.004) discard;

  vec3 P = vWorld;
  vec3 toCam = cameraPosition - P;
  float camDist = length(toCam);
  vec3 V = toCam / camDist;
  float cosAxis = clamp(vViewZ / camDist, 0.05, 1.0);

  // --- Normal: swell + wind waves (faded by pixel footprint) + simulated ripples.
  float foot = length(fwidth(vXZ));
  float windFade = 1.0 - smoothstep(0.02, 0.28, foot);
  vec3 ww = tpWindWaves(vXZ, uTime, uWind * mix(2.2, 0.55, vMask));
  vec3 rip = tpRipple(vXZ) * vec3(vec2(vMask * 1.4), 1.0);
  vec2 slope = vSlope + ww.yz * windFade + rip.xy;
  // Distant sea: a rougher statistical normal so the horizon glitters instead of mirroring.
  float farRough = smoothstep(0.05, 1.5, foot);
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

  // --- What lies below: refracted opaque scene, attenuated along the ray through the water.
  float sceneZ = tpLinearDepth(dScene);
  float thick = max(sceneZ - vViewZ, 0.0) / cosAxis;
  vec2 shift = n.xz * 0.33 * min(thick, 0.7);
  vec3 sv = mat3(viewMatrix) * vec3(shift.x, 0.0, shift.y);
  vec2 ruv = suv + sv.xy * uProjScale * 0.5 / max(vViewZ, 0.2);
  ruv = clamp(ruv, vec2(0.001), vec2(0.999));
  float dR = texture(uSceneDepth, ruv).x;
  float zR = tpLinearDepth(dR);
  if (zR < vViewZ) { ruv = suv; zR = sceneZ; }
  float thickR = max(zR - vViewZ, 0.0) / cosAxis;
  vec3 below = texture(uSceneColor, ruv).rgb;

  float shadow = tpSurfaceShadow(P);
  vec3 sunW = normalize(uSunDir);
  vec3 sunIrr = uSunColor * max(sunW.y, 0.0) * shadow;
  vec3 ambient = (sunIrr + uSkyIrr) / 3.14159265;
  vec3 T = exp(-uWaterSigma * thickR);
  // Single scattering in the water column: coastal water glows green-blue.
  // Water-leaving reflectance of green coastal water is about 1 %.
  vec3 scatter = vec3(0.003, 0.008, 0.008) * ambient;
  vec3 body = below * T + scatter * (1.0 - T);

  // --- Reflection: planar mirror over the pool when available, the sky elsewhere.
  vec3 R = reflect(-V, n);
  R.y = abs(R.y);
  float rough = mix(mix(0.012, 0.09, 1.0 - vMask), 0.24, farRough);
  vec3 refl = uEnvOn > 0.5 ? textureLod(envMap, R, uEnvMaxLod * rough * (2.0 - rough)).rgb : uFogColor * 2.0;
  if (uReflOn > 0.5) {
    vec4 rc = uReflMatrix * vec4(P.x, P.y, P.z, 1.0);
    vec2 ruv2 = rc.xy / rc.w + n.xz * 0.045;
    float inside = step(0.0, ruv2.x) * step(ruv2.x, 1.0) * step(0.0, ruv2.y) * step(ruv2.y, 1.0);
    vec3 planar = texture(uReflTex, clamp(ruv2, 0.0, 1.0)).rgb;
    float w = inside * smoothstep(0.2, 0.6, vMask) * (1.0 - farRough);
    refl = mix(refl, planar, w);
  }
  float NdotV = max(dot(n, V), 0.0);
  float F = 0.032 + 0.968 * pow(1.0 - NdotV, 5.0);

  vec3 col = mix(body, refl, F);

  // --- Sun glints.
  vec3 H = normalize(V + sunW);
  float NdotL = max(dot(n, sunW), 0.0);
  // The sun is a 0.5 degree disc: on calm water its image is small and the ripples break it into
  // glints; far away the facets average into a glitter path.
  float alpha = mix(mix(0.006, 0.02, 1.0 - vMask), 0.1, farRough);
  float spec = tpGGX(max(dot(n, H), 0.0), alpha) * F / max(4.0 * NdotV, 0.05) * NdotL;
  col += uSunColor * spec * shadow;

  // --- Foam: at the waterline, on breaking crests near the rock, and stirred up in the pool.
  vec3 sceneP = cameraPosition - V * (sceneZ / cosAxis);
  float contact = P.y - sceneP.y;
  float pattern = tpFoamPattern(vXZ, uTime);
  // A still pool has no foam line; it appears where the water is moving.
  float agitation = clamp(vFactor * uSwell * 2.0 + rip.z * 2.0 + (1.0 - vMask), 0.0, 1.0);
  // Surf foam rides in on each crest and thins out as the water draws back.
  float surge = mix(1.0, smoothstep(-0.02, 0.12, vCrest * uSwell), 1.0 - vMask);
  float lineFoam = (1.0 - smoothstep(0.0, 0.03 + 0.08 * vFactor * uSwell * surge, contact)) * (0.25 + 0.75 * pattern) * agitation * mix(0.35, 1.0, surge);
  float shallow = 1.0 - smoothstep(0.25, 2.2, vSeaDepth);
  float breaking = smoothstep(0.1, 0.32, vCrest * uSwell) * shallow * (1.0 - vMask);
  // Lacy wash left by broken waves: streaks drifting shoreward, thinning between sets.
  vec2 drift = vXZ * vec2(0.55, 0.22) + vec2(0.0, -uTime * 0.35);
  float streak = smoothstep(0.55, 0.85, tpVNoise(drift) * 0.7 + tpVNoise(drift * 3.1) * 0.3);
  float wash = shallow * (1.0 - vMask) * streak * smoothstep(0.0, 0.25, vCrest * uSwell + 0.05) * (1.0 - smoothstep(0.15, 0.6, vSeaDepth + 0.2));
  float foam = max(max(lineFoam, breaking * (0.4 + 0.6 * pattern)), wash * pattern * 0.7);
  float shoreBreak = (1.0 - vMask) * smoothstep(-0.12, 0.06, vSeaDepth) * (1.0 - smoothstep(0.15, 0.8, vSeaDepth));
  foam = max(foam, shoreBreak * (0.18 + 0.55 * pattern) * smoothstep(-0.03, 0.14, vCrest * uSwell));
  foam = max(foam, clamp(rip.z, 0.0, 1.0) * pattern);
  // Foam from the flow: a web of bubble walls that rides the current, thin where old, closed where
  // fresh. Warped sampling hides the simulation grid.
  vec2 warp = (vec2(tpVNoise(vXZ * 3.1), tpVNoise(vXZ * 3.1 + 9.0)) - 0.5) * uSurfTexel * 3.0;
  vec2 fuv = vSurfUV + warp;
  float carried = texture(uSurfFoam, fuv).r;
  float foamBump = 0.0;
  vec2 foamGrad = vec2(0.0);
  if (vSurfMix > 0.01 && carried > 0.015) {
    vec2 flowV = texture(uSurfState, vSurfUV).gb;
    float ph0 = fract(uTime * 0.5), ph1 = fract(uTime * 0.5 + 0.5);
    vec2 cellP = vXZ * 6.5;
    vec2 move = flowV * 6.5 * 1.1;
    float wallA = tpBubbleWall(cellP - move * ph0) * 0.6 + tpBubbleWall((cellP - move * ph0) * 2.6) * 0.4;
    float wallB = tpBubbleWall(cellP + 19.0 - move * ph1) * 0.6 + tpBubbleWall((cellP + 19.0 - move * ph1) * 2.6) * 0.4;
    float wall = mix(wallA, wallB, abs(1.0 - 2.0 * ph0));
    float open = mix(0.09, 0.7, smoothstep(0.05, 0.8, carried));
    float web = 1.0 - smoothstep(open * 0.55, open, wall);
    float body = smoothstep(0.03, 0.2, carried);
    foam = mix(foam, web * body, vSurfMix);
    foamBump = web * body;
    foamGrad = vec2(texture(uSurfFoam, fuv + vec2(uSurfTexel.x, 0.0)).r - texture(uSurfFoam, fuv - vec2(uSurfTexel.x, 0.0)).r,
                    texture(uSurfFoam, fuv + vec2(0.0, uSurfTexel.y)).r - texture(uSurfFoam, fuv - vec2(0.0, uSurfTexel.y)).r);
  } else {
    foam *= 1.0 - vSurfMix;
  }
  foam = clamp(foam, 0.0, 1.0) * smoothstep(0.0, 0.004, thick + 0.004);
  // Foam has thickness: lit on the sun side of each mound, shaded in its creases.
  vec3 foamN = normalize(vec3(-foamGrad.x * 3.2, 1.0, -foamGrad.y * 3.2));
  float foamLit = 0.62 + 0.5 * max(dot(foamN, sunW), 0.0) + 0.12 * foamBump;
  vec3 foamCol = vec3(0.84, 0.88, 0.89) * foamLit * (sunIrr * (0.6 + 0.4 * NdotL) + uSkyIrr) / 3.14159265;
  col = mix(col, foamCol, foam * 0.92);

  // Soft edge where the water layer thins to nothing over rock.
  col = mix(texture(uSceneColor, suv).rgb, col, smoothstep(0.0, 0.006, thick * cosAxis + foam * 0.01));
  return col;
}
