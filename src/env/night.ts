import * as THREE from 'three';

/**
 * What the Preetham model leaves out once the sun is down: the twilight gradient (deep blue
 * overhead, a glow along the horizon under the sun), airglow, the moon with its halo, and stars.
 * Drawn additively over the sky dome, and into the environment map so the water reflects it.
 */
export function nightSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'tp.nightSky',
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uNight: { value: 0 },
      uTwilight: { value: 0 },
      uTime: { value: 0 },
      uMoonPhase: { value: 0.8 },
      uStars: { value: 1 },
      uGlow: { value: 1 },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = (modelMatrix * vec4(position, 1.0)).xyz - (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir;
      uniform vec3 uMoonDir;
      uniform float uNight;
      uniform float uTwilight;
      uniform float uTime;
      uniform float uMoonPhase;
      uniform float uStars;
      uniform float uGlow;
      varying vec3 vDir;
      float h3(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
      void main() {
        vec3 d = normalize(vDir);
        float up = max(d.y, 0.0);
        vec3 sun = normalize(uSunDir);
        vec3 moon = normalize(uMoonDir);
        float moonUp = smoothstep(-0.02, 0.06, moon.y);
        vec3 col = vec3(0.0);
        // Twilight: blue overhead, a warm band low toward the set sun, the Earth's shadow opposite.
        vec2 sunH = normalize(sun.xz + 1e-4);
        // A rounded dot can fall just below -1 on a real GPU. Fractional pow of that
        // negative value becomes NaN, even when the twilight multiplier is zero.
        float toward = clamp(dot(normalize(d.xz + 1e-4), sunH) * 0.5 + 0.5, 0.0, 1.0);
        vec3 zen = vec3(0.012, 0.022, 0.06);
        vec3 band = mix(vec3(0.05, 0.022, 0.03), vec3(0.11, 0.05, 0.022), pow(toward, 3.0));
        float horizon = exp(-up * 9.0);
        col += (mix(zen, band, horizon) * (0.4 + 0.6 * pow(toward, 1.5) * horizon + 0.6 * (1.0 - horizon))) * uTwilight;
        // Night: airglow near the horizon, a deeper blue above, moonlit sky around the moon.
        vec3 night = mix(vec3(0.0045, 0.0055, 0.009), vec3(0.0018, 0.0026, 0.006), sqrt(up));
        float md = dot(d, moon);
        night += vec3(0.012, 0.016, 0.026) * pow(max(md, 0.0), 6.0) * moonUp;
        night += vec3(0.003, 0.004, 0.007) * moonUp;
        col += night * uNight;
        col *= uGlow;
        // Moon: a 0.55 degree disc, limb-darkened, with a few darker maria and a soft halo.
        float ang = acos(clamp(md, -1.0, 1.0));
        float r = 0.0048;
        if (ang < r * 1.3) {
          vec3 t = normalize(cross(moon, vec3(0.0, 1.0, 0.0)));
          vec3 b = cross(t, moon);
          vec2 q = vec2(dot(d - moon, t), dot(d - moon, b)) / r;
          float disc = 1.0 - smoothstep(0.92, 1.0, length(q));
          float limb = sqrt(max(0.0, 1.0 - dot(q, q)));
          float maria = 1.0 - 0.28 * smoothstep(0.3, 0.6, h3(floor(vec3(q * 3.0, 1.0))) ) * step(length(q), 0.8);
          float lit = smoothstep(-0.1, 0.1, q.x + (1.0 - 2.0 * uMoonPhase) * sqrt(max(0.0, 1.0 - q.y * q.y)));
          col += vec3(1.6, 1.65, 1.7) * disc * (0.55 + 0.45 * limb) * maria * lit * moonUp * uNight * uGlow;
        }
        col += vec3(0.05, 0.06, 0.08) * exp(-ang * 40.0) * moonUp * uNight * uGlow;
        // Stars: one candidate per cell of a fine grid on the sphere, brightness on a power law.
        vec3 s = d * 220.0;
        vec3 cell = floor(s);
        float hs = h3(cell);
        if (uStars > 0.5 && hs > 0.86 && d.y > -0.05) {
          vec3 c = cell + vec3(h3(cell + 1.7), h3(cell + 3.1), h3(cell + 5.3));
          float dist = length(s - c);
          float mag = pow(h3(cell + 9.4), 6.0);
          float tw = 0.75 + 0.25 * sin(uTime * (2.0 + 5.0 * h3(cell + 2.2)) + hs * 30.0);
          vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.86, 0.7), h3(cell + 4.4));
          float star = exp(-dist * dist * 22.0) * (0.06 + 2.2 * mag) * tw;
          // Fainter near the horizon (extinction) and when the moon is bright.
          star *= smoothstep(0.0, 0.25, d.y) * (1.0 - 0.6 * moonUp * pow(max(md, 0.0), 2.0));
          col += tint * star * uNight * uNight;
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    transparent: true,
    blending: THREE.AdditiveBlending,
  });
}

export function nightSkyMesh(material: THREE.ShaderMaterial, radius: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -9;
  return mesh;
}
