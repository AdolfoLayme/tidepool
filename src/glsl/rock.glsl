// Basalt surface model: albedo, roughness, normal and water film for the shelf, boulders and cobbles.
// Heights are in metres and match the tidal zonation of an exposed Pacific basalt shore.
uniform sampler2D uRockAlbedo;
uniform sampler2D uRockNormal;
uniform float uRockSeed;
uniform vec3 uRockTint;

varying vec3 vRockPos;
varying vec3 vRockNormal;
varying vec4 vRock; // x ao, y column id, z joint distance (m), w puddle level

struct RockSurface {
  vec3 albedo;
  float rough;
  vec3 n;
  float film;
  float filmRough;
  vec3 filmN;
  float ao;
  float under;
};

const float TP_HIGH_WATER = 0.34;
const float TP_TEX_MEAN = 0.049;

vec3 tpTriWeights(vec3 n) {
  vec3 w = pow(abs(n), vec3(5.0));
  return w / (w.x + w.y + w.z);
}

vec3 tpTriAlbedo(vec3 p, vec3 w, float scale) {
  vec3 c = vec3(0.0);
  if (w.x > 0.02) c += texture(uRockAlbedo, p.zy * scale).rgb * w.x;
  if (w.y > 0.02) c += texture(uRockAlbedo, p.xz * scale).rgb * w.y;
  if (w.z > 0.02) c += texture(uRockAlbedo, p.xy * scale).rgb * w.z;
  return c / max(w.x * step(0.02, w.x) + w.y * step(0.02, w.y) + w.z * step(0.02, w.z), 1e-3);
}

// Whiteout-blended triplanar normal mapping in world space.
vec3 tpTriNormal(vec3 p, vec3 n, vec3 w, float scale, float strength) {
  vec3 tx = texture(uRockNormal, p.zy * scale).xyz * 2.0 - 1.0;
  vec3 ty = texture(uRockNormal, p.xz * scale).xyz * 2.0 - 1.0;
  vec3 tz = texture(uRockNormal, p.xy * scale).xyz * 2.0 - 1.0;
  tx.xy *= strength; ty.xy *= strength; tz.xy *= strength;
  tx = vec3(tx.xy + n.zy, abs(tx.z) * n.x);
  ty = vec3(ty.xy + n.xz, abs(ty.z) * n.y);
  tz = vec3(tz.xy + n.xy, abs(tz.z) * n.z);
  return normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
}

// Planar coordinates on the dominant face, for procedural 2D patterns on any orientation.
vec2 tpFaceUV(vec3 p, vec3 w) {
  if (w.y >= w.x && w.y >= w.z) return p.xz;
  if (w.x >= w.z) return p.zy + vec2(31.7, 0.0);
  return p.xy + vec2(0.0, 47.3);
}

// Bump mapping from screen-space height derivatives (Mikkelsen 2010).
vec3 tpPerturb(vec3 pos, vec3 n, float height) {
  vec3 dpx = dFdx(pos), dpy = dFdy(pos);
  float dhx = dFdx(height), dhy = dFdy(height);
  vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * n - grad);
}

float tpSat(float x) { return clamp(x, 0.0, 1.0); }

RockSurface tpRockSurface(vec3 p, vec3 ng, vec4 rk, float detail) {
  RockSurface s;
  vec3 w = tpTriWeights(ng);
  vec2 f = tpFaceUV(p, w);
  float cellId = rk.y;
  float jointDist = rk.z;
  float poolMask;
  float still = tpWaterLevel(p.xz, poolMask);
  float jointPresence = 1.0;
  // The mapped pool mask follows the water edge and can fade inside the back of the bowl.
  // Use the bowl's footprint and depth to keep old column seams out of its submerged floor.
  float basinR = length(vec2(p.x / 2.35, (p.z + 0.2) / 1.6));
  float floorMask = (1.0 - smoothstep(1.12, 1.36, basinR)) * (1.0 - smoothstep(-0.14, 0.04, p.y));
#ifdef TP_TERRAIN
  jointPresence = smoothstep(0.6, 0.82, tpNoise(p.xz * 0.21 + vec2(19.3, -8.7), 89u)) * (1.0 - max(poolMask, floorMask));
#endif

  // --- Joints from the same Voronoi the CPU carved (crisp lines inside the carved valleys).
#ifdef TP_TERRAIN
  if (detail > 0.5) {
    vec2 q = vec2(p.x * 0.9 + 0.95 * (tpFbm(vec2(p.x * 0.17 + 7.7, p.z * 0.17 + 1.3), 3, 5u) - 0.5)
                    + 0.09 * (tpNoise(p.xz * 2.6 + vec2(1.9, -3.3), 111u) - 0.5) + 0.028 * (tpNoise(p.xz * 7.9 + vec2(0.4, 5.1), 113u) - 0.5),
                  p.z * 1.06 + 0.95 * (tpFbm(vec2(p.x * 0.17 - 4.2, p.z * 0.17 + 9.1), 3, 7u) - 0.5)
                    + 0.09 * (tpNoise(p.xz * 2.6 + vec2(-6.2, 2.8), 115u) - 0.5) + 0.028 * (tpNoise(p.xz * 7.9 + vec2(-3.7, -1.6), 117u) - 0.5));
    vec4 vj = tpVoronoi(q / 0.92, 101u, 0.84);
    jointDist = vj.y * 0.92;
    cellId = vj.z;
  }
#endif
  float openness = 0.35 + 0.65 * tpNoise(vec2(p.x * 1.7 + 4.2, p.z * 1.7 - 1.1), 31u);
  // Joints are traced on the tops; a column's side wall is itself a joint face, and painting the
  // trace there would smear it into vertical streaks.
  float onTop = smoothstep(0.35, 0.65, ng.y);
  float jointLine = (1.0 - smoothstep(0.0015, 0.004 + 0.01 * openness, jointDist)) * jointPresence * onTop;
  float jointShade = (1.0 - smoothstep(0.0, 0.045 + 0.04 * openness, jointDist)) * jointPresence * mix(0.5, 1.0, onTop);

  // Secondary fractures (same seed as the CPU grooves) and hairline cracks.
  float frac = 0.0;
  if (detail > 0.5) {
    float fm = smoothstep(0.45, 0.75, tpNoise(vec2(p.x * 0.55 + 9.1, p.z * 0.55 + 2.3), 37u));
    vec4 vf = tpVoronoi(vec2(p.x / 0.43 + 17.3, p.z / 0.43 - 5.9), 211u, 0.9);
    frac = (1.0 - smoothstep(0.0008, 0.0035, vf.y * 0.43)) * fm * smoothstep(0.35, 0.8, ng.y) * jointPresence;
  }
  float hair = 0.0;
  if (detail > 1.5) {
    float hn = abs(tpVNoise(f * 7.0 + 3.1) * 2.0 - 1.0);
    hair = (1.0 - smoothstep(0.0, 0.035, hn)) * smoothstep(0.55, 0.8, tpVNoise(f * 0.9 + 8.0)) * (1.0 - poolMask);
  }

  // --- Base basalt colour: dense grey-black with a brown weathering rind on exposed tops.
  vec3 tex = tpTriAlbedo(p, w, 0.62);
  vec3 tex2 = tpTriAlbedo(p * 1.0 + 0.37, w, 0.163);
  vec3 rel = (tex * 0.6 + tex2 * 0.4) / TP_TEX_MEAN;
  float relL = dot(rel, vec3(0.2126, 0.7152, 0.0722));
  vec3 basalt = vec3(0.05, 0.05, 0.049) * uRockTint;
  // Weathering mottles the surface at hand-span scale; fresher, darker rock shows on steep faces.
  float mottle = 0.75 + 0.5 * (tpVNoise(f * 2.6 + 9.0) * 0.6 + tpVNoise(f * 7.5) * 0.4);
  float cellTone = mix(1.0, 0.82 + 0.36 * fract(cellId * 13.7), jointPresence) * mottle * mix(0.82, 1.08, smoothstep(0.3, 0.9, ng.y));
  float rind = smoothstep(0.2, 0.9, ng.y) * smoothstep(-0.1, 0.6, p.y - TP_HIGH_WATER) * (0.5 + 0.5 * tpVNoise(f * 1.3 + 2.0));
  // The scan is brownish; keep its structure but pull its hue toward basalt grey.
  vec3 relGrey = mix(vec3(relL), rel, 0.35);
  vec3 alb = basalt * cellTone * mix(vec3(1.0), relGrey, 0.8);
  alb = mix(alb, alb * vec3(1.28, 1.16, 1.02), rind * 0.6);

  // Vesicles: gas pits, in patches.
  vec2 wv = tpWorley(f * 52.0 + cellId * 17.0);
  float vesMask = smoothstep(0.55, 0.85, tpVNoise(f * 2.2 + cellId * 5.0));
  float pit = (1.0 - smoothstep(0.06, 0.17, wv.x)) * vesMask;
  // Convex worn edges near joints are paler; joints themselves hold dirt and moisture.
  float worn = smoothstep(0.02, 0.07, jointDist) * (1.0 - smoothstep(0.07, 0.16, jointDist));

  // --- Zonation (height above datum, ragged boundaries).
  float zn = (tpVNoise(f * 1.6) - 0.5) * 0.18 + (tpVNoise(f * 6.0) - 0.5) * 0.05;
  float y = p.y + zn;
  float splash = smoothstep(TP_HIGH_WATER + 0.1, TP_HIGH_WATER + 0.3, y) * (1.0 - smoothstep(TP_HIGH_WATER + 1.4, TP_HIGH_WATER + 2.2, y));
  float barnacleZone = smoothstep(-0.32, -0.12, y) * (1.0 - smoothstep(TP_HIGH_WATER - 0.05, TP_HIGH_WATER + 0.18, y));
  float lowZone = 1.0 - smoothstep(-0.55, -0.2, y);
  float inPool = poolMask * (1.0 - smoothstep(uPoolSpill - 0.02, uPoolSpill + 0.12, y));
  float subtidal = max(lowZone, inPool);

  // Black tar lichen band above high water.
  // A thin crust in ragged patches, darker than the rock but not a hole in it.
  float tarMask = splash * smoothstep(0.42, 0.64, tpVNoise(f * 3.1 + 11.0) * 0.6 + tpVNoise(f * 11.0) * 0.4);
  alb = mix(alb, vec3(0.02, 0.02, 0.018), tarMask * 0.6);
  // Sparse orange lichen high up.
  float orange = smoothstep(TP_HIGH_WATER + 0.9, TP_HIGH_WATER + 1.4, y) * smoothstep(0.66, 0.74, tpVNoise(f * 3.1 + 40.0)) * smoothstep(0.3, 0.8, ng.y);
  alb = mix(alb, vec3(0.32, 0.12, 0.018), orange * 0.8);

  // Barnacle crust. The cluster field is the same noise the CPU uses to place 3D barnacles, so
  // near the camera the geometry sits on its own crust; further away the crust alone reads.
  float bCluster = smoothstep(0.38, 0.62, tpNoise(vec2(p.x * 1.6 + 3.1, p.z * 1.6 - 2.2), 501u));
  float bMask = barnacleZone * bCluster * (1.0 - smoothstep(0.0, 0.03, uPoolLevel - p.y) * poolMask);
  vec2 bc = f * 80.0 + vec2(tpVNoise(f * 9.0), tpVNoise(f * 9.0 + 4.0)) * 0.8;
  vec3 wb = tpWorleyId(bc);
  float bSize = 0.55 + 0.6 * fract(wb.z * 7.31);
  float present = smoothstep(wb.z - 0.04, wb.z + 0.04, bMask * 1.1);
  float cone = (1.0 - smoothstep(0.06 * bSize, 0.4 * bSize, wb.x)) * present;
  float hole = (1.0 - smoothstep(0.0, 0.07 * bSize, wb.x)) * present * 0.7;
  float foot = clamp(length(fwidth(bc)), 0.0, 1.0);
  float barn = mix(cone, bMask * 0.55, smoothstep(0.3, 0.9, foot));
  vec3 shellCol = vec3(0.22, 0.215, 0.19) * (0.75 + 0.5 * fract(wb.z * 13.7));
  alb = mix(alb, shellCol, barn * 0.85);
  alb = mix(alb, vec3(0.05, 0.045, 0.04), hole * (1.0 - smoothstep(0.3, 0.9, foot)) * 0.45);

  // Mussel bed underlay: the same mask the CPU uses to place 3D mussels, so the bed reads as a
  // continuous blue-black mat of shells and byssus with the 3D shells on top.
  float mExposed = 1.0 - clamp((tpShore(p.xz).w - 1.0) / 3.5, 0.0, 1.0);
  float mLip = poolMask > 0.05 && p.z < -0.9 ? 0.8 : 0.0;
  float mBed = smoothstep(0.49, 0.55, tpNoise(vec2(p.x * 0.75 + 11.7, p.z * 0.75 - 4.4), 503u));
  float mZone = smoothstep(-0.66, -0.45, y) * (1.0 - smoothstep(0.18, 0.36, y));
  float mussel = mBed * mZone * max(mExposed, mLip) * (1.0 - smoothstep(0.0, 0.05, uPoolLevel - p.y) * poolMask);
  vec2 mw = tpWorley(f * vec2(22.0, 38.0) + 3.0);
  vec3 shellMat = mix(vec3(0.018, 0.02, 0.028), vec3(0.06, 0.065, 0.075), smoothstep(0.1, 0.45, mw.y - mw.x));
  alb = mix(alb, shellMat, mussel * 0.95);

  // Wiry red-brown turf (Endocladia, Mastocarpus) in the mid shore, between barnacle patches.
  float turfZone = smoothstep(-0.6, -0.35, y) * (1.0 - smoothstep(0.22, 0.38, y)) * (1.0 - inPool);
  float turfN = tpVNoise(f * 1.9 + 21.0) * 0.65 + tpVNoise(f * 6.0 + 2.0) * 0.25 + tpVNoise(f * 19.0) * 0.1;
  float turf = turfZone * smoothstep(0.54, 0.67, turfN) * (1.0 - mussel) * (1.0 - barn * 0.7);
  float wiry = tpVNoise(f * 140.0) * 0.6 + tpVNoise(f * 55.0 + 3.0) * 0.4;
  vec3 turfCol = mix(vec3(0.025, 0.019, 0.012), vec3(0.055, 0.038, 0.021), wiry) * (0.8 + 0.4 * tpVNoise(f * 4.0 + 8.0));
  alb = mix(alb, turfCol, turf * 0.75);

  // Crustose coralline: chalky pink-mauve paint with warty texture and pale growth margins,
  // on rock that stays submerged. Hollows on the pool floor hold silt and shell grit instead.
  vec2 cw = f + vec2(tpVNoise(f * 3.0 + 1.3), tpVNoise(f * 3.0 - 7.7)) * 0.18;
  float corN = tpVNoise(cw * 2.1 + 61.0) * 0.55 + tpVNoise(cw * 7.3 + 3.0) * 0.3 + tpVNoise(cw * 29.0) * 0.15;
  floorMask *= smoothstep(0.55, 0.82, ng.y);
  float sediment = subtidal * smoothstep(0.75, 0.95, ng.y) * (1.0 - smoothstep(0.35, 0.75, rk.x)) * smoothstep(0.4, 0.6, tpVNoise(f * 1.1 + 5.0));
  // A continuous sand bed covers the old dark column pattern; only current-swept hollows vary.
  sediment = max(sediment, floorMask * (0.84 + 0.12 * tpVNoise(f * 1.6 + 5.0)));
  float corMask = subtidal * smoothstep(0.59, 0.7, corN) * (1.0 - sediment);
  vec3 wc = tpWorleyId(f * 160.0 + 9.0 + vec2(tpVNoise(f * 30.0), tpVNoise(f * 30.0 + 5.0)) * 1.5);
  float knob = (1.0 - smoothstep(0.0, 0.25 + 0.25 * wc.z, wc.x)) * smoothstep(0.35, 0.55, wc.z);
  vec3 coral = mix(vec3(0.11, 0.075, 0.075), vec3(0.17, 0.105, 0.105), knob * 0.5);
  coral *= 0.7 + 0.45 * tpVNoise(f * 43.0 + 2.0);
  float margin = (smoothstep(0.59, 0.61, corN) - smoothstep(0.62, 0.66, corN)) * subtidal * (1.0 - sediment);
  alb = mix(alb, coral, corMask * 0.72);
  alb = mix(alb, vec3(0.18, 0.17, 0.16), margin * 0.25);
  float film = subtidal * (1.0 - corMask) * smoothstep(0.3, 0.7, tpVNoise(f * 0.8 + 77.0));
  alb = mix(alb, vec3(0.022, 0.028, 0.012), film * 0.7);
  // Silt with scattered shell grit: round grains, fading to their average with distance.
  vec3 gw = tpWorleyId(f * 260.0);
  float grain = (1.0 - smoothstep(0.12, 0.3, gw.x)) * (1.0 - smoothstep(0.05, 0.07, gw.z));
  float gFoot = smoothstep(0.3, 1.0, length(fwidth(f * 260.0)));
  vec2 gritUV = f * vec2(92.0, 145.0);
  vec3 grit = tpWorleyId(gritUV + 23.0);
  // Few chips, of different sizes and brightness: shell, urchin test and barnacle plate fragments.
  float chipSize = 0.5 + 0.7 * fract(grit.z * 9.13);
  float shellChip = (1.0 - smoothstep(0.08 * chipSize, 0.22 * chipSize, grit.x)) * smoothstep(0.8, 0.9, grit.z) * (0.45 + 0.55 * fract(grit.z * 31.7));
  shellChip *= 1.0 - smoothstep(0.3, 1.0, length(fwidth(gritUV)));
  // Shell grit gathers where the current drops it, in drifts, rather than evenly everywhere.
  shellChip *= smoothstep(0.45, 0.78, tpVNoise(f * 1.7 + 31.0) * 0.75 + tpVNoise(f * 6.0 + 3.0) * 0.25);
  vec3 silt = vec3(0.16, 0.145, 0.115) * (0.75 + 0.5 * tpVNoise(f * 40.0)) + vec3(0.1, 0.095, 0.08) * mix(grain, 0.03, gFoot) + vec3(0.34, 0.31, 0.26) * shellChip;
  alb = mix(alb, silt, sediment * 0.9);

  // Joints and pits.
  alb *= 1.0 - 0.4 * pit * (1.0 - max(corMask, sediment));
  // Under water, silt and crust fill the joints: they read as soft seams, not drawn lines.
  alb *= 1.0 - (0.75 * jointLine + 0.25 * jointShade) * (1.0 - 0.6 * subtidal);
  alb *= 1.0 - 0.6 * frac - 0.45 * hair;
  alb *= 1.0 + 0.22 * worn * (1.0 - subtidal);

#ifdef TP_COBBLE
  // Sea-worn cobbles, smoother than the shelf. Most are the local basalt; the surf also brings
  // paler greywacke and greenish greenstone. In the pool about half of them carry patches of
  // pink crustose coralline on their upper side, the rest a thin olive film.
  float lith = fract(cellId * 7.77 + 0.13);
  vec3 stone = lith < 0.6 ? basalt * vec3(0.92, 1.0, 0.98) : lith < 0.82 ? vec3(0.1, 0.095, 0.085) : vec3(0.066, 0.078, 0.062);
  alb = stone * cellTone * mix(vec3(1.0), rel, 0.45);
  float crusted = step(0.5, fract(cellId * 3.31 + 0.2)) * subtidal * smoothstep(0.15, 0.6, ng.y);
  float crust = crusted * smoothstep(0.42, 0.62, tpVNoise(f * 2.4 + cellId * 17.0));
  alb = mix(alb, coral * 1.25, max(crust, corMask * smoothstep(0.45, 0.75, tpVNoise(f * 18.0 + 4.0))) * 0.75);
  alb = mix(alb, vec3(0.022, 0.03, 0.012), film * 0.6 * (1.0 - crust));
  corMask = max(corMask, crust);
  barn = 0.0; cone = 0.0; hole = 0.0; tarMask = 0.0; pit = 0.0; mussel = 0.0; turf = 0.0;
#endif
  // --- Roughness.
  float rough = mix(0.82, 0.95, tpSat(relL - 0.6));
  rough = mix(rough, 0.97, tarMask * 0.5);
  rough = mix(rough, 0.7, barn);
  rough = mix(rough, 0.86, corMask);
  rough = mix(rough, 0.45, mussel);
  rough = mix(rough, 0.9, turf);
#ifdef TP_COBBLE
  rough = mix(0.5, 0.86, corMask);
#endif

  // --- Normal: two triplanar scales of the scanned surface, then procedural bump.
  float nStr = mix(0.9, 0.55, subtidal);
  vec3 n = tpTriNormal(p, ng, w, 0.62, nStr);
  if (detail > 0.5) n = normalize(n + (tpTriNormal(p + 0.37, ng, w, 0.163, 0.6) - ng) * 0.7);
  pit *= 1.0 - max(corMask, sediment);
  float bare = (1.0 - turf) * (1.0 - mussel) * (1.0 - corMask) * (1.0 - sediment);
  float bump = (tpVNoise(f * 14.0) - 0.5) * 0.0035 * bare + (tpVNoise(f * 36.0) - 0.5) * 0.0012 * bare + turf * wiry * 0.0025 - pit * 0.0018 - jointLine * 0.004 - frac * 0.0015 - hair * 0.0008 + (cone * 0.004 - hole * 0.002) * (1.0 - smoothstep(0.3, 0.9, foot)) + corMask * knob * 0.0009 + sediment * tpVNoise(f * 60.0) * 0.0006;
  n = tpPerturb(p, n, bump);

  // --- Water: wet line, splash, moisture in joints, puddles, and submerged rock.
  float under = 1.0 - smoothstep(still - 0.006, still + 0.006, p.y);
  // The drying front is ragged: high spots dry first, hollows hold water.
  float dry = tpVNoise(f * 3.0 + 17.0) * 0.6 + tpVNoise(f * 13.0 + 3.0) * 0.4;
  float wetLine = uWetLevel + 0.16 + (dry - 0.5) * 0.2;
  float wet = 1.0 - smoothstep(wetLine - 0.05, wetLine + 0.03, p.y);
  wet *= mix(1.0, smoothstep(0.25, 0.6, dry + (wetLine - p.y) * 4.0), 0.85);
  float shoreDist = tpShore(p.xz).w;
  float sprayWet = uSpray * (1.0 - smoothstep(0.5, 6.0, shoreDist)) * smoothstep(0.35, 0.65, tpVNoise(f * 0.7 + uTime * 0.01)) * 0.95;
  wet = max(wet, sprayWet);
  wet = max(wet, inPool);
  // Pool walls the draining pool has just left stay wet up to its brim.
  wet = max(wet, poolMask * (1.0 - smoothstep(uPoolSpill + 0.01, uPoolSpill + 0.06, p.y)));
  float puddle = smoothstep(-0.001, 0.004, rk.w - p.y);
  wet = max(wet, puddle);
  // Joints and pits stay damp after the surface has dried: darker, but no water film.
  float damp = max(wet, jointShade * 0.6 + pit * 0.3);

  float porosity = mix(0.55, 0.35, corMask) * (1.0 - barn * 0.3);
  vec3 wetAlb = pow(alb, vec3(1.08)) * (1.0 - porosity * 0.48);
  alb = mix(alb, wetAlb, damp);
  float puddleDepth = max(rk.w - p.y, 0.0);
  alb *= mix(vec3(1.0), exp(-uWaterSigma * puddleDepth * 2.0) * vec3(0.92, 0.98, 0.96), puddle);
  rough = mix(rough, 0.44, wet * (1.0 - under));
  rough = mix(rough, 0.95, under);

  s.albedo = max(alb, vec3(0.002));
  if (uFeatures.w > 1.5) s.albedo = vec3(mussel, bMask, turf) * 0.5;
  s.rough = rough;
  s.n = normalize(mix(n, ng, puddle * 0.85));
  // A thin film over rough rock gives broken highlights; only standing water is a mirror.
  s.film = mix(wet * wet * 0.92, 1.0, puddle) * (1.0 - under) * uFeatures.z;
  s.filmRough = mix(mix(0.31, 0.11, wet * wet), 0.025, puddle);
  s.filmN = normalize(mix(normalize(mix(n, ng, 0.35)), vec3(0.0, 1.0, 0.0), puddle));
  s.ao = rk.x * (1.0 - 0.5 * jointShade) * (1.0 - 0.35 * pit);
  s.under = under;
  return s;
}
