// Sea surface: Gerstner swell (constants generated from src/water/waves.ts), shoaling over the
// shelf, and short wind ripples for normals and caustics. Requires noise.glsl and common.glsl.

// Wave height factor: Green's-law growth near the shelf, gone a few metres into the rock.
float tpWaveFactor(float depth, float shelter) {
  float grow = min(1.7, pow(4.0 / max(depth, 0.6), 0.25));
  return grow * (1.0 - smoothstep(0.15, 1.0, shelter));
}

// Displacement (xyz) and slope (dh/dx, dh/dz) of the swell.
vec3 tpGerstner(vec2 p, float t, float factor, out vec2 slope, out float crest) {
  vec3 disp = vec3(0.0);
  slope = vec2(0.0);
  crest = 0.0;
  for (int i = 0; i < TP_SEA_WAVES; i++) {
    vec4 A = tpWaveA[i];
    vec4 B = tpWaveB[i];
    float th = A.z * dot(A.xy, p) - A.w * t + B.z;
    float s = sin(th), c = cos(th);
    float amp = B.x * factor;
    disp.y += amp * s;
    // A shallow crest throws a narrow lip toward shore on its leading face.
    float shoal = smoothstep(1.15, 1.65, factor);
    float lip = A.z < 0.25 ? 0.32 * shoal * pow(max(s, 0.0), 4.0) * smoothstep(0.0, 0.7, -c) : 0.0;
    disp.y += amp * lip;
    disp.xz += A.xy * amp * lip * 0.5;
    // Horizontal sharpening, limited so crests never fold over.
    float q = min(B.y, 0.8 / max(A.z * amp * float(TP_SEA_WAVES), 1e-4));
    disp.xz += q * amp * A.xy * c;
    slope += amp * A.z * A.xy * c;
    crest += amp * A.z * max(s, 0.0);
  }
  return disp;
}

// Value noise with analytic derivatives: (value, d/dx, d/dy).
vec3 tpNoised(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = tpHashF(i), b = tpHashF(i + vec2(1.0, 0.0)), c = tpHashF(i + vec2(0.0, 1.0)), d = tpHashF(i + vec2(1.0, 1.0));
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * (vec2(k1, k2) + k4 * u.yx));
}

// Short wind waves: (height, dh/dx, dh/dz). Drifting noise octaves from 2 cm to 1 m, each moving
// at its own speed, so the surface never settles into a lattice. Strength varies in patches
// (cat's paws), leaving glassy stretches between ruffled ones.
vec3 tpWindWavesN(vec2 p, float t, float strength, int octaves, float falloff) {
  vec3 r = vec3(0.0);
  float patchy = smoothstep(0.25, 0.75, tpVNoise(p * 0.35 + vec2(t * 0.045, t * 0.02)));
  float s = strength * mix(0.25, 1.0, patchy);
  float freq = 1.1;
  float amp = 0.0042;
  mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
  vec2 q = p;
  mat2 acc = mat2(1.0, 0.0, 0.0, 1.0);
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float speed = sqrt(9.81 / (6.2831853 * freq) + 7.4e-5 * 6.2831853 * freq) * 0.6;
    vec3 n = tpNoised(q * freq + vec2(t * speed * freq, t * speed * freq * 0.37) + float(i) * 7.31);
    // Derivatives back to world axes through the accumulated rotation.
    vec2 g = (n.yz * freq) * acc;
    r += vec3(n.x - 0.5, g) * amp;
    q = rot * q;
    acc = acc * rot;
    freq *= 2.13;
    amp *= falloff;
  }
  return r * s;
}

vec3 tpWindWaves(vec2 p, float t, float strength) { return tpWindWavesN(p, t, strength, 5, 0.47); }
