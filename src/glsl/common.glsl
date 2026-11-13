// Shared uniforms and helpers for every patched material. Values live in src/core/globals.ts.
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSeaLevel;
uniform float uPoolLevel;
uniform float uPoolSpill;
uniform float uWetLevel;
uniform float uSpray;
uniform sampler2D uShoreTex;
uniform vec4 uShoreRect;
uniform sampler2D uPoolTex;
uniform vec4 uPoolRect;
uniform sampler2D uCausticTex;
uniform vec4 uCausticRect;
uniform vec3 uWaterSigma;
uniform vec3 uFogColor;
uniform vec3 uFogSunColor;
uniform vec4 uFogParams;
uniform float uNight;
uniform vec4 uFeatures;
uniform float uLensClear;

// x: terrain height, y: pool mask, z: shelter from swell, w: distance to open water (m)
vec4 tpShore(vec2 xz) {
  vec4 s = texture(uShoreTex, (xz - uShoreRect.xy) * uShoreRect.zw);
  vec2 puv = (xz - uPoolRect.xy) * uPoolRect.zw;
  if (puv.x > 0.002 && puv.y > 0.002 && puv.x < 0.998 && puv.y < 0.998) s.xy = texture(uPoolTex, puv).xy;
  return s;
}

// Still-water level at a point: the pool level inside the pool basin, the sea elsewhere.
float tpWaterLevel(vec2 xz, out float poolMask) {
  vec4 s = tpShore(xz);
  poolMask = s.y;
  return mix(uSeaLevel, max(uPoolLevel, uSeaLevel), s.y);
}

// Height fog with sun-side scattering. Mist thickens toward the sea surface.
vec3 tpFog(vec3 color, vec3 worldPos) {
  vec3 v = worldPos - cameraPosition;
  float dist = length(v);
  vec3 dir = v / max(dist, 1e-4);
  float a = uFogParams.x, b = uFogParams.y;
  float ry = dir.y * b;
  float h0 = cameraPosition.y - uFogParams.z;
  float amount = a * exp(-h0 * b) * dist * (abs(ry * dist) > 1e-3 ? (1.0 - exp(-ry * dist)) / (ry * dist) : 1.0);
  // The fog colour is the horizon sky, lit through kilometres of mist; the few metres of air
  // between the eye and the pool scatter almost nothing of it. Haze builds in from a few metres.
  amount *= smoothstep(2.0, 30.0, dist);
  float f = 1.0 - exp(-max(amount, 0.0));
  float sunAmt = pow(max(dot(dir, uSunDir), 0.0), uFogParams.w);
  vec3 fogCol = mix(uFogColor, uFogSunColor, sunAmt);
  return mix(color, fogCol, f);
}
