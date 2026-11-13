// Integer-hash noise, bit-identical to src/core/noise.ts (GLSL ES 3.0 uint arithmetic wraps).

uint tpHash2u(ivec2 c, uint seed) {
  uvec2 u = uvec2(c + 32768);
  uint h = (u.x * 0x27d4eb2du) ^ ((u.y + seed) * 0x165667b1u);
  h ^= h >> 15u;
  h *= 0x85ebca77u;
  h ^= h >> 13u;
  h *= 0xc2b2ae3du;
  h ^= h >> 16u;
  return h;
}

float tpHash2f(ivec2 c, uint seed) {
  return float(tpHash2u(c, seed) >> 8u) / 16777216.0;
}

float tpFade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

float tpNoise(vec2 p, uint seed) {
  vec2 fl = floor(p);
  ivec2 i = ivec2(fl);
  vec2 f = p - fl;
  float u = tpFade(f.x), v = tpFade(f.y);
  float a = tpHash2f(i, seed), b = tpHash2f(i + ivec2(1, 0), seed);
  float c = tpHash2f(i + ivec2(0, 1), seed), d = tpHash2f(i + ivec2(1, 1), seed);
  float ab = a + (b - a) * u;
  float cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

float tpFbm(vec2 p, int octaves, uint seed) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * tpNoise(p, seed + uint(i) * 17u);
    norm += amp;
    p = vec2(0.8 * p.x - 0.6 * p.y, 0.6 * p.x + 0.8 * p.y) * 2.03 + vec2(1.7, -3.1);
    amp *= 0.5;
  }
  return sum / norm;
}

// Cheap float hash for purely visual high-frequency detail (not mirrored on the CPU).
float tpHashF(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float tpVNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tpHashF(i), tpHashF(i + vec2(1, 0)), u.x), mix(tpHashF(i + vec2(0, 1)), tpHashF(i + vec2(1, 1)), u.x), u.y);
}

vec2 tpVorPoint(uint h, float jitter) {
  return vec2(0.5) + jitter * (vec2(float(h & 0xffffu), float(h >> 16u)) / 65536.0 - 0.5);
}

// x: distance to feature, y: distance to border, z: cell id, w: second id.
vec4 tpVoronoi(vec2 p, uint seed, float jitter) {
  vec2 fl = floor(p);
  ivec2 ip = ivec2(fl);
  vec2 f = p - fl;
  float md = 8.0;
  vec2 mr = vec2(0.0);
  ivec2 mg = ivec2(0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      ivec2 g = ivec2(i, j);
      vec2 r = vec2(g) + tpVorPoint(tpHash2u(ip + g, seed), jitter) - f;
      float d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; }
    }
  }
  float edge = 8.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      ivec2 g = mg + ivec2(i, j);
      vec2 r = vec2(g) + tpVorPoint(tpHash2u(ip + g, seed), jitter) - f;
      vec2 dr = r - mr;
      float len2 = dot(dr, dr);
      if (len2 > 1e-5) edge = min(edge, dot(0.5 * (mr + r), dr) * inversesqrt(len2));
    }
  }
  return vec4(sqrt(md), edge, tpHash2f(ip + mg, seed + 7u), tpHash2f(ip + mg, seed + 13u));
}

// Small-cell Worley for pits and grains (visual only, 3x3).
vec2 tpWorley(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(x, y);
      vec2 o = vec2(tpHashF(i + g), tpHashF(i + g + 19.19));
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return sqrt(vec2(d1, d2));
}

// Worley with the id of the nearest feature's cell: (d1, d2, id). Per-feature properties must use
// this id, not floor(p), or they change across grid lines inside a feature and leave seams.
vec3 tpWorleyId(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(x, y);
      vec2 o = vec2(tpHashF(i + g), tpHashF(i + g + 19.19));
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; id = tpHashF(i + g + 7.77); } else if (d < d2) { d2 = d; }
    }
  }
  return vec3(sqrt(d1), sqrt(d2), id);
}
