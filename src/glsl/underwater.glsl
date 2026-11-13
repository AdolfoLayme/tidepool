// Light reaching submerged surfaces: Beer-Lambert extinction along the refracted sun path,
// caustics focused by the surface above, and dimmer, bluer sky light with depth.

float tpCausticAt(vec3 p, float depth) {
  // Light that reaches p entered the surface up-sun along the refracted ray.
  vec3 sunW = normalize(uSunDir);
  vec3 t = refract(-sunW, vec3(0.0, 1.0, 0.0), 1.0 / 1.333);
  vec2 entry = p.xz - t.xz / max(-t.y, 0.2) * depth;
  vec2 uv = (entry - uCausticRect.xy) * uCausticRect.zw;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  // Computed focusing from the simulated surface (ripples from touches show up here).
  float computed = mix(1.0, texture(uCausticTex, uv).r / 0.88, inside);
  // Calm, sheltered water focuses less; deep water spreads the pattern out.
  float strength = uFeatures.y * (1.0 - smoothstep(0.6, 2.5, depth)) * smoothstep(0.0, 0.03, depth);
  return mix(1.0, clamp(computed, 0.72, 1.7), strength * 0.6);
}

void tpUnderwater(inout ReflectedLight rl, vec3 p) {
  float poolMask;
  float still = tpWaterLevel(p.xz, poolMask);
  float depth = still - p.y;
  float wet = smoothstep(-0.004, 0.012, depth);
  if (wet <= 0.0) return;
  depth = max(depth, 0.0);
  vec3 sunW = normalize(uSunDir);
  float cosT = sqrt(max(1.0 - (1.0 - sunW.y * sunW.y) / (1.333 * 1.333), 0.04));
  vec3 sunPath = exp(-uWaterSigma * depth / cosT);
  float caustic = uFeatures.y > 0.0 ? tpCausticAt(p, depth) : 1.0;
  vec3 skyPath = exp(-uWaterSigma * depth * 1.6);
  rl.directDiffuse = mix(rl.directDiffuse, rl.directDiffuse * sunPath * caustic, wet);
  if (uFeatures.w > 0.5) { rl.directDiffuse = vec3(caustic) * 1.2; rl.indirectDiffuse = vec3(0.0); }
  rl.directSpecular = mix(rl.directSpecular, rl.directSpecular * sunPath * 0.15, wet);
  rl.indirectDiffuse = mix(rl.indirectDiffuse, rl.indirectDiffuse * skyPath, wet);
  rl.indirectSpecular = mix(rl.indirectSpecular, rl.indirectSpecular * skyPath * 0.25, wet);
}
