// AUTO-WRAPPED GLSL — do not fetch this as a raw .glsl asset.
//
// The SandPlayground page is routed at /sandplayground, so a relative shader fetch
// would resolve against the route rather than the app root,
// and 404. Shipping the shader source as an ES module also keeps it inside the
// module graph, so it is fingerprinted and cached with the engine instead of
// arriving as a second, uncacheable round-trip.
//
// Sections are delimited by `//====== NAME ======` and split by parseSections()
// in sand-playground-engine.js.
export const source = `
//====== VERTEX ======
#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}

//====== SUPPORT ======
#version 300 es
// Pass 1 of each sub-step: continuum & geotechnical field relaxation.
//  - Per-grain soil rheology (gravel, clay, silt, quartz sand, glass)
//  - Overburden stress, Terzaghi effective stress, hydraulic piping & liquefaction
//  - Unsaturated Darcy/Richards moisture diffusion & capillary fringe
//  - Hydrostatic head seed, underwater + air acoustic shockwaves, turbidity drag
//  - Thermal coupling, evaporation, and temperature-driven steam condensation
//
// MRT outputs:
//   outState (attachment 0, RGBA16F/RGBA8): primary cellular state for readback
//   outAux   (attachment 1, RGBA16F/RGBA8):
//     WATER:    R=sub-cell fill (0.15..1), G=temp, B=underwater shock, A=turbidity
//     SAND:     R=horizontal vx (0.5=rest), G=temp, B=overburden, A=pore pressure
//     AIR:      R=bubble phase, G=temp, B=vapor humidity, A=0
//     CONCRETE/BEDROCK: R=0.5, G=temp, B=0, A=0
precision highp float;
precision highp int;

uniform sampler2D u_state;
uniform sampler2D u_aux;
uniform sampler2D u_temp;
uniform float u_seed;
uniform float u_wind;
layout(location = 0) out vec4 outState;
layout(location = 1) out vec4 outAux;

const int W = 800;
const int H = 600;
const int AIR = 0, SAND = 1, CONCRETE = 2, WATER = 3, BEDROCK = 4;

const float H_DECAY = 0.0627;
const float D_DECAY = 0.022;
const float COHESION_THRESH = 0.25;
const float RECOHERE_RATE = 0.0015;
const float SHOCK_DISLODGE = 0.35;

const float P_STEP = 1.0 / 255.0;
const float P_LAT_DECAY = 0.25 / 255.0;

vec4 getS(ivec2 p) {
    if (p.y < 0) return vec4(240.0 / 255.0, 0.0, 0.0, 1.0);
    if (p.x < 0 || p.x >= W || p.y >= H) return vec4(0.0);
    return texelFetch(u_state, p, 0);
}

vec4 getA(ivec2 p) {
    if (p.y < 0) return vec4(0.5, 0.22, 0.0, 0.0);
    if (p.x < 0 || p.x >= W || p.y >= H) return vec4(0.0, 0.25, 0.0, 0.0);
    return texelFetch(u_aux, p, 0);
}

int matOf(vec4 c) { return (int(floor(c.r * 255.0 + 0.5)) + 30) / 60; }

// Intrinsic soil type encoded in SAND R byte:
//   0 = gravel (30..39, sat 86)
//   1 = clay   (40..49, sat 87)
//   2 = silt   (50..59, sat 88)
//   3 = sand   (60..80, sat 85)
//   4 = glass  (81..84)
int soilOf(vec4 c) {
    float rb = floor(c.r * 255.0 + 0.5);
    if (rb >= 81.0 && rb <= 84.0) return 4;
    if (rb == 86.0 || rb < 40.0) return 0;
    if (rb == 87.0 || rb < 50.0) return 1;
    if (rb == 88.0 || rb < 60.0) return 2;
    return 3;
}

float wetOf(vec4 c) {
    if (matOf(c) != SAND) return 0.0;
    float rb = floor(c.r * 255.0 + 0.5);
    if (rb >= 85.0) return 20.0;
    if (rb >= 81.0) return 0.0;
    if (rb >= 60.0) return rb - 60.0;
    if (rb >= 50.0) return (rb - 50.0) * 2.0;
    if (rb >= 40.0) return (rb - 40.0) * 2.0;
    return max(0.0, (rb - 30.0) * 2.0);
}

float encodeSandR(int soil, float wet, bool sat, float grainFrac) {
    if (sat) {
        if (soil == 0) return (86.0 + grainFrac) / 255.0;
        if (soil == 1) return (87.0 + grainFrac) / 255.0;
        if (soil == 2) return (88.0 + grainFrac) / 255.0;
        return (85.0 + grainFrac) / 255.0;
    }
    wet = clamp(wet, 0.0, 20.0);
    float base = 60.0 + wet;
    if (soil == 0) base = 30.0 + floor(wet * 0.45 + 0.5);
    else if (soil == 1) base = 40.0 + floor(wet * 0.45 + 0.5);
    else if (soil == 2) base = 50.0 + floor(wet * 0.45 + 0.5);
    return (base + grainFrac) / 255.0;
}

// (permeability, hDecScale, capScale, iCrit)
vec4 soilProps(int s) {
    if (s == 0) return vec4(1.00, 1.55, 0.25, 0.075); // gravel
    if (s == 1) return vec4(0.06, 0.50, 1.55, 0.190); // clay
    if (s == 2) return vec4(0.28, 1.15, 1.35, 0.060); // silt
    return vec4(0.55, 1.00, 1.00, 0.095);             // quartz sand
}

float shockOf(vec4 c, vec4 a) {
    int m = matOf(c);
    if (m == AIR) return c.b;
    if (m == WATER) return a.b;
    return 0.0;
}

float poreOf(vec4 c, vec4 a) {
    int m = matOf(c);
    if (m == WATER) return c.a;
    if (m == SAND) return a.a;
    return 0.0;
}

float supportOf(vec4 c) {
    int m = matOf(c);
    if (m == CONCRETE || m == BEDROCK) return 1.0;
    if (m == SAND) return c.a;
    return 0.0;
}

float hash(vec2 q) {
    return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 self = getS(p);
    vec4 selfA = getA(p);
    int m = matOf(self);

    vec4 up = getS(p + ivec2(0, 1)), dn = getS(p + ivec2(0, -1));
    vec4 lf = getS(p + ivec2(-1, 0)), rt = getS(p + ivec2(1, 0));
    vec4 upA = getA(p + ivec2(0, 1)), dnA = getA(p + ivec2(0, -1));
    vec4 lfA = getA(p + ivec2(-1, 0)), rtA = getA(p + ivec2(1, 0));
    int mu = matOf(up), md = matOf(dn), ml = matOf(lf), mr = matOf(rt);

    vec2 env = texture(u_temp, (vec2(p) + 0.5) / vec2(float(W), float(H))).rg;
    float envTemp = env.r;
    float nbrTemp = (upA.g + dnA.g + lfA.g + rtA.g) * 0.25;
    float temp = mix(selfA.g > 0.01 ? selfA.g : envTemp, nbrTemp, 0.06);
    temp = mix(temp, envTemp, 0.04);

    // ---------------------------------------------------------------- AIR --
    if (m == AIR) {
        float nbrShock = max(max(shockOf(up, upA), shockOf(dn, dnA)), max(shockOf(lf, lfA), shockOf(rt, rtA)));
        float shock = self.b * 0.985 - 0.002;
        shock = max(shock, nbrShock * 0.97 - 0.006);
        if (mu == AIR) shock = max(shock, shockOf(getS(p + ivec2(0, 2)), getA(p + ivec2(0, 2))) * 0.94 - 0.010);
        if (md == AIR) shock = max(shock, shockOf(getS(p + ivec2(0, -2)), getA(p + ivec2(0, -2))) * 0.94 - 0.010);
        if (ml == AIR) shock = max(shock, shockOf(getS(p + ivec2(-2, 0)), getA(p + ivec2(-2, 0))) * 0.94 - 0.010);
        if (mr == AIR) shock = max(shock, shockOf(getS(p + ivec2(2, 0)), getA(p + ivec2(2, 0))) * 0.94 - 0.010);

        float g = self.g;
        float rb = floor(self.r * 255.0 + 0.5);
        bool steamMark = abs(self.a * 255.0 - 222.0) < 2.0;
        float rq = hash(vec2(p) * 0.217 + vec2(u_seed * 1.19, u_seed));
        if (steamMark) {
            if (g < 136.0 / 255.0) {
                outState = vec4(180.0 / 255.0, 0.5, 0.5, 0.0);
                outAux = vec4(1.0, max(0.22, temp - 0.05), 0.0, 0.0);
                return;
            }
            // Thermal condensation: cold upper air or solid ceilings condense vapor faster.
            bool coolContact = (mu == SAND || mu == CONCRETE || mu == BEDROCK || mu == WATER);
            float coolRate = coolContact ? 2.5 : clamp((0.40 - envTemp) * 5.0 + 0.35, 0.20, 2.2);
            float stepProb = clamp(coolRate, 0.0, 1.0);
            if (coolRate >= 1.0 || rq < stepProb) g -= floor(max(1.0, coolRate)) / 255.0;
            if (g < 136.0 / 255.0) {
                outState = vec4(180.0 / 255.0, 0.5, 0.5, 0.0);
                outAux = vec4(1.0, temp, 0.0, 0.0);
                return;
            }
            outState = vec4(0.0, g, clamp(shock, 0.0, 1.0), 222.0 / 255.0);
            outAux = vec4(0.0, max(temp, 0.42), clamp(env.g + 0.25, 0.0, 1.0), 0.0);
            return;
        }
        if (g >= 136.0 / 255.0) g = 120.0 / 255.0;
        if (g > 0.0) g = max(g - 0.45 / 255.0, 0.0);

        // Tag trapped underwater air pockets as buoyant bubbles (R byte = 8).
        float upRb = floor(up.r * 255.0 + 0.5);
        bool underwater = (mu == WATER) || (mu == AIR && upRb >= 6.0 && upRb <= 12.0 && (ml == WATER || mr == WATER));
        float outR = (underwater && g <= 2.0 / 255.0) ? (8.0 / 255.0) : 0.0;
        outState = vec4(outR, g, clamp(shock, 0.0, 1.0), 0.0);
        outAux = vec4(outR > 0.0 ? 0.5 : 0.0, temp, env.g, 0.0);
        return;
    }

    // --------------------------------------------------------------- SAND --
    if (m == SAND) {
        float rnd = hash(vec2(p) * 0.173 + vec2(u_seed, u_seed * 1.31));
        float rbyte = floor(self.r * 255.0 + 0.5);
        float grainFrac = fract(self.r * 255.0);
        if (grainFrac < 0.05 || grainFrac > 0.95) grainFrac = rnd < 0.62 ? 0.12 : 0.36;
        int soil = soilOf(self);
        vec4 sp = soilProps(soil); // perm, hDecScale, capScale, iCrit
        bool glass = soil == 4;
        bool sat = rbyte >= 85.0 && rbyte <= 88.0;

        float nbrShock = max(max(shockOf(up, upA), shockOf(dn, dnA)), max(shockOf(lf, lfA), shockOf(rt, rtA)));
        bool dislodged = nbrShock > SHOCK_DISLODGE;
        if (!glass && mu == WATER && up.b < 0.5 - 25.0 / 255.0 && rnd < 0.06) dislodged = true;

        // Unsaturated Darcy / Richards moisture diffusion + thermal drying.
        float wet = glass ? 0.0 : wetOf(self);
        if (!glass && !sat) {
            float capDecay = mix(2.4, 0.85, clamp(sp.z * 0.5, 0.0, 1.0));
            // Gravity favours downward wicking; capillary suction allows mild upward fringe.
            float wUp = wetOf(up) - capDecay * 0.7;
            float wDn = wetOf(dn) - capDecay * 1.45;
            float wLat = max(wetOf(lf), wetOf(rt)) - capDecay;
            float targetWet = max(wet, max(max(wUp, wDn), wLat));
            wet = mix(wet, targetWet, clamp(0.35 + sp.x * 0.5, 0.1, 0.85));
            bool touchWater = (mu == WATER || md == WATER || ml == WATER || mr == WATER);
            if (touchWater) wet = min(wet + 1.0 + 2.0 * sp.x, 20.0);
            else if ((mu == AIR || ml == AIR || mr == AIR) && rnd < (0.015 + max(0.0, temp - 0.30) * 0.08 + abs(u_wind) * 0.01)) {
                wet = max(wet - 1.0, 0.0);
                temp = max(0.18, temp - 0.005);
            }
        }

        // Overburden stress propagated downward + pore-water pressure diffusion.
        float ob = 0.0;
        if (mu == SAND) ob = clamp(upA.b + 0.012, 0.0, 1.0);
        else if (mu == WATER) ob = clamp(up.a * 0.35, 0.0, 1.0);

        float pU = poreOf(up, upA), pD = poreOf(dn, dnA), pL = poreOf(lf, lfA), pR = poreOf(rt, rtA);
        float maxNbrPore = max(max(pU, pD), max(pL, pR));
        float poreDecay = max(0.0, selfA.a * 0.94 - (fract(rnd * 11.3) < 0.5 ? 1.0 / 255.0 : 0.0));
        float poreP = sat ? max(selfA.a, maxNbrPore) : max(poreDecay, maxNbrPore - 0.015 / max(0.15, sp.x));
        if (mu == WATER) poreP = max(poreP, up.a);
        if (ml == WATER) poreP = max(poreP, lf.a);
        if (mr == WATER) poreP = max(poreP, rt.a);
        if (md == WATER) poreP = max(poreP, dn.a);
        poreP = clamp(poreP, 0.0, 1.0);
        float gradP = max(abs(pL - pR), abs(pU - pD));

        // Fall-speed accumulator + horizontal momentum damping.
        float fall = 0.0;
        if (md == AIR) fall = min(self.b + 8.0 / 255.0, 1.0);
        else if (md == SAND && dn.a < COHESION_THRESH && dn.b > 0.05)
            fall = min(self.b + 8.0 / 255.0, dn.b);

        float svx = selfA.r > 0.01 ? selfA.r : 0.5;
        if (md != AIR) {
            svx = mix(svx, 0.5, 0.14);
            if (fract(rnd * 7.7) < 0.35) {
                svx = svx > 0.5 ? max(0.5, svx - 1.0 / 255.0) : min(0.5, svx + 1.0 / 255.0);
            }
        }

        // Mohr-Coulomb / Drucker-Prager + Terzaghi effective stress + piping failure.
        float a = self.a;
        if (dislodged) {
            a = 0.0;
        } else {
            float hDec = H_DECAY * sp.y;
            float dDec = D_DECAY * sp.y;
            if (wet > 8.0) { hDec *= 0.55; dDec *= 0.55; }
            float below = (md == CONCRETE || md == BEDROCK) ? 1.0 : (md == SAND ? dn.a : 0.0);
            float lat = max(supportOf(lf), supportOf(rt)) - hDec;
            float diag = max(supportOf(getS(p + ivec2(-1, -1))), supportOf(getS(p + ivec2(1, -1)))) - dDec;
            float target = clamp(max(below, max(lat, diag)), 0.0, 1.0);

            int waterNbrs = (mu == WATER ? 1 : 0) + (md == WATER ? 1 : 0) + (ml == WATER ? 1 : 0) + (mr == WATER ? 1 : 0);
            float saturation = clamp(wet / 20.0, 0.0, 1.0);
            float capillary = clamp(saturation * pow(1.0 - saturation, 4.0) * 12.207 * sp.z, 0.0, 1.0);
            target = min(1.0, target + capillary * 0.18);

            // Terzaghi effective normal stress: overburden minus pore water pressure.
            float effNormal = clamp(max(below * 0.7 + diag * 0.3, ob) - poreP * 0.65, 0.0, 1.0);
            float leftStress = clamp(supportOf(lf), 0.0, 1.0);
            float rightStress = clamp(supportOf(rt), 0.0, 1.0);
            float shearStress = abs(leftStress - rightStress) * 0.65 + (md == AIR || md == WATER ? 0.32 : 0.0);
            float baseFriction = (soil == 1) ? 0.85 : (soil == 0 ? 0.56 : 0.625);
            float friction = mix(baseFriction, 0.48, saturation);
            float yieldLimit = capillary * 0.24 + effNormal * friction + self.a * 2.0;
            if (!glass && shearStress > yieldLimit) target = min(target, 0.18);

            bool packed = self.a >= 0.5;
            if (!packed) target *= 1.0 - saturation * clamp(poreP * 1.8, 0.0, 0.45);
            if (!packed && wet >= 16.0 && (waterNbrs >= 2 || mu == WATER)) target = min(target, 0.35);

            // Hydraulic piping / uplift failure: steep exit seepage gradient or uplift
            // exceeding submerged overburden erodes even packed barriers progressively.
            bool airExit = (mu == AIR || ml == AIR || mr == AIR || md == AIR);
            if (!glass && airExit && (gradP > sp.w || (poreP > ob + 0.22 && waterNbrs > 0))) {
                target = min(target, max(0.18, self.a - 0.08));
            }
            if (sat) target = min(target, 0.35);
            if (glass) target = max(target, 0.8);
            a = (target > a) ? min(a + RECOHERE_RATE, target) : target;
        }

        // Ember scorch (G) heats cell temperature & cools stochastically.
        float scorch = self.g;
        if (scorch > 0.0 && abs(scorch - self.b) < 9.0 / 255.0) scorch = 0.0;
        else if (scorch > 0.0) {
            temp = max(temp, 0.35 + scorch * 0.65);
            if (fract(rnd * 23.11) < 0.23) scorch = max(scorch - 1.0 / 255.0, 0.0);
        }

        outState = vec4(glass ? rbyte / 255.0 : encodeSandR(soil, wet, sat, grainFrac), scorch, fall, a);
        outAux = vec4(svx, temp, ob, poreP);
        return;
    }

    // -------------------------------------------------------------- WATER --
    if (m == WATER) {
        float nScorch = 0.0;
        if (mu == SAND) nScorch = max(nScorch, up.g);
        if (md == SAND) nScorch = max(nScorch, dn.g);
        if (ml == SAND) nScorch = max(nScorch, lf.g);
        if (mr == SAND) nScorch = max(nScorch, rt.g);
        float rq = hash(vec2(p) * 0.219 + vec2(u_seed * 1.13, u_seed));
        float fill = selfA.r > 0.05 ? selfA.r : 1.0;
        float turb = max(0.0, selfA.a * 0.994 - (fract(rq * 13.7) < 0.25 ? 1.0 / 255.0 : 0.0));
        if (nScorch > 0.45 && rq < 0.06) {
            outState = vec4(0.0, 205.0 / 255.0, 0.0, 222.0 / 255.0);
            outAux = vec4(0.0, 0.85, 0.45, 0.0);
            return;
        }

        // Solar + wind surface evaporation (mass-conserving -> marked steam).
        if (mu == AIR && temp > 0.46 && rq < (temp - 0.44) * (0.008 + abs(u_wind) * 0.012)) {
            outState = vec4(0.0, 196.0 / 255.0, 0.0, 222.0 / 255.0);
            outAux = vec4(0.0, max(0.25, temp - 0.10), clamp(env.g + 0.35, 0.0, 1.0), 0.0);
            return;
        }
        if (nScorch > 0.15) temp = min(1.0, temp + nScorch * 0.04);

        // Underwater acoustic shockwave propagation (faster & lower attenuation than air).
        float nShock = max(max(shockOf(up, upA), shockOf(dn, dnA)), max(shockOf(lf, lfA), shockOf(rt, rtA)));
        float wShock = max(selfA.b * 0.985 - 0.004, nShock * 0.985 - 0.004);
        if (mu == WATER) wShock = max(wShock, shockOf(getS(p + ivec2(0, 2)), getA(p + ivec2(0, 2))) * 0.97 - 0.005);
        if (md == WATER) wShock = max(wShock, shockOf(getS(p + ivec2(0, -2)), getA(p + ivec2(0, -2))) * 0.97 - 0.005);
        if (ml == WATER) wShock = max(wShock, shockOf(getS(p + ivec2(-2, 0)), getA(p + ivec2(-2, 0))) * 0.97 - 0.005);
        if (mr == WATER) wShock = max(wShock, shockOf(getS(p + ivec2(2, 0)), getA(p + ivec2(2, 0))) * 0.97 - 0.005);
        wShock = clamp(wShock, 0.0, 1.0);

        // Hydrostatic pressure seed (refined by PRESSURE iterations right after this pass).
        float a = 0.0;
        if (mu == WATER) a = max(a, up.a + P_STEP);
        if (ml == WATER) a = max(a, lf.a - P_LAT_DECAY);
        if (mr == WATER) a = max(a, rt.a - P_LAT_DECAY);
        if (md == WATER) a = max(a, dn.a - P_STEP);
        if (fract(rq * 17.77) < 0.05) a = max(a - P_STEP, 0.0);
        if (md == AIR) a = 0.0;
        a = clamp(a, 0.0, 1.0);

        vec4 l4 = getS(p + ivec2(-4, 0));
        vec4 r4 = getS(p + ivec2(4, 0));
        float pL = (ml == WATER) ? ((matOf(l4) == WATER) ? l4.a : lf.a) : a;
        float pR = (mr == WATER) ? ((matOf(r4) == WATER) ? r4.a : rt.a) : a;
        float dP = pL - pR;
        bool driven = abs(dP) * 255.0 >= 0.5;
        float dq = (fract(rq * 9.71) < (driven ? 0.10 : 0.32)) ? 1.0 / 255.0 : 0.0;
        float vx = 0.5 + (self.g - 0.5) * 0.996;
        if (driven) vx += dP * 0.35;
        vx = vx > 0.5 ? max(0.5, vx - dq) : min(0.5, vx + dq);
        vx = clamp(vx, 0.5 - 100.0 / 255.0, 0.5 + 100.0 / 255.0);

        float vy;
        if (md == AIR) vy = max(self.b - 6.0 / 255.0, 0.15);
        else {
            vy = 0.5 + (self.b - 0.5) * 0.993;
            // Density-driven turbidity current: silt-laden water sinks along slopes.
            if (turb > 0.08 && md == WATER) vy -= turb * 0.014;
            // Underwater shock impulse water-hammer at free surfaces.
            if (mu == AIR && wShock > 0.25) vy = min(0.88, vy + wShock * 0.18);
            vy = vy > 0.5 ? max(0.5, vy - dq) : min(0.5, vy + dq);
        }

        float sandFaces = float(md == SAND) + 0.35 * float(ml == SAND || mr == SAND);
        float drag = min(0.16, sandFaces * 0.035);
        vx = mix(vx, 0.5, drag);
        vy = mix(vy, 0.5, drag * 0.65);

        // Increase turbidity if fast flow scours a loose sand bed.
        if (md == SAND && dn.a < 0.5 && abs(vx - 0.5) > 12.0 / 255.0) {
            turb = min(1.0, turb + abs(vx - 0.5) * 0.25);
        }

        outState = vec4(180.0 / 255.0, vx, vy, a);
        outAux = vec4(fill, temp, wShock, clamp(turb, 0.0, 1.0));
        return;
    }

    // -------------------------------------------------- CONCRETE / BEDROCK --
    outState = vec4(self.r, 0.0, 0.0, 1.0);
    outAux = vec4(0.5, temp, 0.0, 0.0);
}

//====== PRESSURE ======
#version 300 es
// Multi-iteration Poisson pressure projection + conservative VOF surface fill
// relaxation for connected water. Runs several passes per substep so pressure
// waves and hydrostatic head equalize across basins and U-tubes immediately.
precision highp float;
precision highp int;

uniform sampler2D u_state;
uniform sampler2D u_aux;
layout(location = 0) out vec4 outState;
layout(location = 1) out vec4 outAux;

const int W = 800, H = 600;
const int AIR = 0, SAND = 1, WATER = 3;
const float P_STEP = 1.0 / 255.0;

vec4 getS(ivec2 p) {
    if (p.y < 0) return vec4(240.0 / 255.0, 0.0, 0.0, 1.0);
    if (p.x < 0 || p.x >= W || p.y >= H) return vec4(0.0);
    return texelFetch(u_state, p, 0);
}

vec4 getA(ivec2 p) {
    p = clamp(p, ivec2(0), ivec2(W - 1, H - 1));
    return texelFetch(u_aux, p, 0);
}

int matOf(vec4 c) { return (int(floor(c.r * 255.0 + 0.5)) + 30) / 60; }
vec2 vel(vec4 c) { return matOf(c) == WATER ? c.gb - vec2(0.5) : vec2(0.0); }

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 s = getS(p);
    vec4 a = getA(p);
    if (matOf(s) != WATER) { outState = s; outAux = a; return; }

    vec4 l = getS(p + ivec2(-1, 0)), r = getS(p + ivec2(1, 0));
    vec4 d = getS(p + ivec2(0, -1)), u = getS(p + ivec2(0, 1));
    int ml = matOf(l), mr = matOf(r), md = matOf(d), mu = matOf(u);

    if (md == AIR) {
        outState = vec4(s.rgb, 0.0);
        outAux = a;
        return;
    }

    // Boundary conditions:
    //   AIR = Dirichlet p=0 (free surface)
    //   SOLID = Neumann dp/dn=0 (use self pressure)
    //   WATER = hydrostatic neighbor head (+/- P_STEP vertically)
    float pL = (ml == WATER) ? l.a : (ml == AIR ? 0.0 : s.a);
    float pR = (mr == WATER) ? r.a : (mr == AIR ? 0.0 : s.a);
    float pD = (md == WATER) ? max(0.0, d.a - P_STEP) : s.a;
    float pU = (mu == WATER) ? min(1.0, u.a + P_STEP) : (mu == AIR ? 0.0 : s.a);

    // Velocity divergence source (wall-clamped so static solids don't create phantom div).
    float vxL = (ml == WATER) ? vel(l).x : 0.0;
    float vxR = (mr == WATER) ? vel(r).x : 0.0;
    float vyD = (md == WATER) ? vel(d).y : 0.0;
    float vyU = (mu == WATER) ? vel(u).y : 0.0;
    float div = ((vxR - vxL) + (vyU - vyD)) * 0.5;

    float proj = (pL + pR + pD + pU) * 0.25 - div * 0.18;
    // Free surface cell (air above) retains at most 1 cell of head.
    if (mu == AIR) proj = min(proj, P_STEP);
    proj = clamp(mix(s.a, proj, 0.85), 0.0, 1.0);

    // Conservative sub-cell fill leveling across surface water cells.
    float fill = a.r > 0.05 ? a.r : 1.0;
    if (mu == AIR) {
        vec4 al = getA(p + ivec2(-1, 0)), ar = getA(p + ivec2(1, 0));
        float fL = (ml == WATER && matOf(getS(p + ivec2(-1, 1))) == AIR) ? (al.r > 0.05 ? al.r : 1.0) : fill;
        float fR = (mr == WATER && matOf(getS(p + ivec2(1, 1))) == AIR) ? (ar.r > 0.05 ? ar.r : 1.0) : fill;
        fill = clamp(fill + ((fL - fill) + (fR - fill)) * 0.18, 0.18, 1.0);
    } else if (mu == WATER) {
        fill = 1.0;
    }

    outState = vec4(s.rgb, proj);
    outAux = vec4(fill, a.gba);
}

//====== RELAX ======
#version 300 es
// Continuous Eulerian water step: 2D semi-Lagrangian velocity advection,
// pressure-gradient impulse, vorticity confinement, and turbidity advection.
precision highp float;
precision highp int;

uniform sampler2D u_state;
uniform sampler2D u_aux;
uniform float u_dt;
layout(location = 0) out vec4 outState;
layout(location = 1) out vec4 outAux;

const int W = 800, H = 600;
const int AIR = 0, WATER = 3;

vec4 getS(ivec2 p) {
    p = clamp(p, ivec2(0), ivec2(W - 1, H - 1));
    return texelFetch(u_state, p, 0);
}

vec4 getA(ivec2 p) {
    p = clamp(p, ivec2(0), ivec2(W - 1, H - 1));
    return texelFetch(u_aux, p, 0);
}

int matOf(vec4 c) { return (int(floor(c.r * 255.0 + 0.5)) + 30) / 60; }
vec2 vel(vec4 c) { return matOf(c) == WATER ? c.gb - vec2(0.5) : vec2(0.0); }
float head(vec4 c, float fallback) { return matOf(c) == WATER ? c.a : (matOf(c) == AIR ? 0.0 : fallback); }

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 s = getS(p);
    vec4 a = getA(p);
    if (matOf(s) != WATER) { outState = s; outAux = a; return; }

    vec4 l = getS(p + ivec2(-1, 0)), r = getS(p + ivec2(1, 0));
    vec4 d = getS(p + ivec2(0, -1)), u = getS(p + ivec2(0, 1));
    float wl = float(matOf(l) == WATER), wr = float(matOf(r) == WATER);
    float wd = float(matOf(d) == WATER), wu = float(matOf(u) == WATER);
    float n = max(1.0, wl + wr + wd + wu);

    // 2D semi-Lagrangian backtrace along velocity (preserves diagonal jets).
    vec2 v = vel(s);
    vec2 back = vec2(p) - clamp(v * 2.2, vec2(-1.5), vec2(1.5));
    ivec2 bp = ivec2(round(back));
    vec4 bs = getS(bp);
    vec4 ba = getA(bp);
    if (matOf(bs) == WATER) {
        v = mix(v, vel(bs), 0.35);
        a.a = mix(a.a, ba.a, 0.30); // advect suspended turbidity
    }

    vec2 avgV = (vel(l) + vel(r) + vel(d) + vel(u)) / n;
    v = mix(v, avgV, clamp(u_dt * 12.0, 0.0, 0.08));

    float pL = head(l, s.a), pR = head(r, s.a);
    float pD = head(d, s.a), pU = head(u, s.a);
    vec2 gradP = vec2(pR - pL, pU - pD);
    v -= gradP * clamp(u_dt * 28.0, 0.0, 0.18);

    // Enforce solid boundary no-penetration (reflect/damp normal velocity).
    if (matOf(l) != WATER && matOf(l) != AIR && v.x < 0.0) v.x *= -0.15;
    if (matOf(r) != WATER && matOf(r) != AIR && v.x > 0.0) v.x *= -0.15;
    if (matOf(d) != WATER && matOf(d) != AIR && v.y < 0.0) v.y *= -0.15;
    if (matOf(u) != WATER && matOf(u) != AIR && v.y > 0.0) v.y *= -0.15;

    // Vorticity confinement inside water bodies.
    float curl = (vel(r).y - vel(l).y) - (vel(u).x - vel(d).x);
    if (n > 2.5) v += vec2(-v.y, v.x) * curl * 0.022;

    float turbAvg = (getA(p + ivec2(-1, 0)).a * wl + getA(p + ivec2(1, 0)).a * wr
                   + getA(p + ivec2(0, -1)).a * wd + getA(p + ivec2(0, 1)).a * wu) / n;
    float turb = mix(a.a, turbAvg, 0.08);

    v = clamp(v, vec2(-100.0 / 255.0), vec2(100.0 / 255.0));
    outState = vec4(s.r, v + vec2(0.5), s.a);
    outAux = vec4(a.rgb, clamp(turb, 0.0, 1.0));
}

//====== MOVE ======
#version 300 es
// Pass 4 of each sub-step: Margolus 2x2 block cellular automaton movement.
// Swaps both u_state and u_aux in lockstep so per-cell velocity, temperature,
// fill, stress, and turbidity never drift from their material cell.
precision highp float;
precision highp int;

uniform sampler2D u_state;
uniform sampler2D u_aux;
uniform int u_parity;
uniform float u_seed;
uniform float u_wind;
uniform int u_disable;
layout(location = 0) out vec4 outState;
layout(location = 1) out vec4 outAux;

const int W = 800;
const int H = 600;
const int AIR = 0, SAND = 1, CONCRETE = 2, WATER = 3, BEDROCK = 4;
const float COHESION_THRESH = 0.25;
const float P_UP = 4.0 / 255.0;
const float FAST_B = 40.0 / 255.0;
const float SINK_P = 0.16;
const float CREEP_P = 0.30;
const float PORE_P = 0.28;
const float SEEP_P = 0.12;
const float EROSION_V = 14.0 / 255.0;

vec4 getS(ivec2 p) {
    if (p.y < 0) return vec4(240.0 / 255.0, 0.0, 0.0, 1.0);
    if (p.x < 0 || p.x >= W) return vec4(240.0 / 255.0, 0.0, 0.0, 1.0);
    if (p.y >= H) return vec4(0.0);
    return texelFetch(u_state, p, 0);
}

vec4 getA(ivec2 p) {
    if (p.y < 0) return vec4(0.5, 0.22, 0.0, 0.0);
    if (p.x < 0 || p.x >= W) return vec4(0.5, 0.22, 0.0, 0.0);
    if (p.y >= H) return vec4(0.0, 0.25, 0.0, 0.0);
    return texelFetch(u_aux, p, 0);
}

int matOf(vec4 c) { return (int(floor(c.r * 255.0 + 0.5)) + 30) / 60; }
float rbOf(vec4 c) { return floor(c.r * 255.0 + 0.5); }

int soilOf(vec4 c) {
    float rb = rbOf(c);
    if (rb >= 81.0 && rb <= 84.0) return 4;
    if (rb == 86.0 || rb < 40.0) return 0;
    if (rb == 87.0 || rb < 50.0) return 1;
    if (rb == 88.0 || rb < 60.0) return 2;
    return 3;
}

float wetOf(vec4 c) {
    if (matOf(c) != SAND) return 0.0;
    float rb = rbOf(c);
    if (rb >= 85.0) return 20.0;
    if (rb >= 81.0) return 0.0;
    if (rb >= 60.0) return rb - 60.0;
    if (rb >= 50.0) return (rb - 50.0) * 2.0;
    if (rb >= 40.0) return (rb - 40.0) * 2.0;
    return max(0.0, (rb - 30.0) * 2.0);
}

bool isAir(vec4 c) { return matOf(c) == AIR; }
bool isGasAir(vec4 c) { return matOf(c) == AIR && c.g > 2.0 / 255.0; }
bool isClearAir(vec4 c) { return matOf(c) == AIR && c.g <= 2.0 / 255.0; }
bool isBubble(vec4 c) { float rb = rbOf(c); return matOf(c) == AIR && rb >= 6.0 && rb <= 12.0 && c.g <= 2.0 / 255.0; }

bool isSat(vec4 c) { float rb = rbOf(c); return matOf(c) == SAND && rb >= 85.0 && rb <= 88.0; }
float satByteFor(vec4 c) {
    int s = soilOf(c);
    if (s == 0) return 86.0 / 255.0;
    if (s == 1) return 87.0 / 255.0;
    if (s == 2) return 88.0 / 255.0;
    return 85.0 / 255.0;
}
float drainedByteFor(vec4 c) {
    int s = soilOf(c);
    if (s == 0) return 39.0 / 255.0;
    if (s == 1) return 49.0 / 255.0;
    if (s == 2) return 59.0 / 255.0;
    return 80.0 / 255.0;
}

float soilPerm(vec4 c) {
    int s = soilOf(c);
    if (s == 0) return 1.00;
    if (s == 1) return 0.08;
    if (s == 2) return 0.30;
    return 0.55;
}

float soilCap(vec4 c) {
    int s = soilOf(c);
    if (s == 0) return 0.25;
    if (s == 1) return 1.45;
    if (s == 2) return 1.25;
    return 1.00;
}

float grainScale(vec4 c) {
    int s = soilOf(c);
    float base = (s == 0) ? 1.65 : (s == 1 ? 0.42 : (s == 2 ? 0.28 : 1.0));
    float fine = fract(c.r * 255.0) < 0.24 ? 0.72 : 1.35;
    return base * fine;
}

float toppleP(vec4 c) {
    float s = clamp(wetOf(c) / 20.0, 0.0, 1.0);
    float bridge = clamp(s * pow(1.0 - s, 4.0) * 12.207 * soilCap(c), 0.0, 1.0);
    return mix(1.0, 0.22, bridge);
}

bool isGranular(vec4 c) { return matOf(c) == SAND && c.a < COHESION_THRESH; }
bool isPermeable(vec4 c) { return matOf(c) == SAND && c.a < 0.5 && rbOf(c) <= 80.0; }
bool isMobile(vec4 c) { int m = matOf(c); return (m == SAND && c.a < COHESION_THRESH) || m == WATER; }

bool canSink(vec4 top, vec4 bot, float rnd, float hinder) {
    int mb = matOf(bot);
    if (mb == AIR) return true;
    if (mb == WATER && matOf(top) == SAND) return rnd < SINK_P * grainScale(top) * hinder;
    return false;
}

float hash(vec2 q) {
    return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453123);
}

int fdiv2(int v) { return (v >= 0) ? v / 2 : -((-v + 1) / 2); }

void swapPair(inout vec4 sA, inout vec4 aA, inout vec4 sB, inout vec4 aB) {
    vec4 ts = sA; sA = sB; sB = ts;
    vec4 ta = aA; aA = aB; aB = ta;
}

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    ivec2 base = ivec2(fdiv2(p.x - u_parity) * 2 + u_parity,
                       fdiv2(p.y - u_parity) * 2 + u_parity);

    vec4 c00 = getS(base), c10 = getS(base + ivec2(1, 0));
    vec4 c01 = getS(base + ivec2(0, 1)), c11 = getS(base + ivec2(1, 1));
    vec4 a00 = getA(base), a10 = getA(base + ivec2(1, 0));
    vec4 a01 = getA(base + ivec2(0, 1)), a11 = getA(base + ivec2(1, 1));

    float r = hash(vec2(base) * 0.1731 + vec2(u_seed * 0.719, u_seed));
    float r2 = fract(r * 13.77);
    float rs0 = fract(r * 5.137);
    float rs1 = fract(r * 21.31);
    float rc = fract(r * 3.771);
    float re = fract(r * 8.219);

    // Local solids fraction in the 2x2 block for Richardson-Zaki hindered settling.
    float nSand = float(matOf(c00) == SAND) + float(matOf(c10) == SAND)
                + float(matOf(c01) == SAND) + float(matOf(c11) == SAND);
    float hinder = pow(max(0.25, 1.0 - 0.14 * nSand), 2.0);

    // 1) Gravity within each column (sand sinks through water with hindered settling).
    if (isMobile(c01) && canSink(c01, c00, rs0, hinder)) {
        if (matOf(c01) == SAND && matOf(c00) == WATER) a00.a = min(1.0, a00.a + 0.12);
        swapPair(c01, a01, c00, a00);
    }
    if (isMobile(c11) && canSink(c11, c10, rs1, hinder)) {
        if (matOf(c11) == SAND && matOf(c10) == WATER) a10.a = min(1.0, a10.a + 0.12);
        swapPair(c11, a11, c10, a10);
    }

    // 2) Pressure/impulse-driven upwelling + buoyant air bubbles rising through water.
    if ((u_disable & 1) == 0 && base.y + 1 < H) {
        bool calm00 = abs(c00.g - 0.5) < 20.0 / 255.0 && abs(c00.b - 0.5) < 6.0 / 255.0;
        bool calm10 = abs(c10.g - 0.5) < 20.0 / 255.0 && abs(c10.b - 0.5) < 6.0 / 255.0;
        if (isAir(c01) && matOf(c00) == WATER && ((c00.a > P_UP && calm00) || (c00.b > 0.5 + 8.0 / 128.0 && (c01.b > 0.08 || a00.b > 0.12)))) {
            swapPair(c01, a01, c00, a00); c01.a = 0.0;
        }
        if (isAir(c11) && matOf(c10) == WATER && ((c10.a > P_UP && calm10) || (c10.b > 0.5 + 8.0 / 128.0 && (c11.b > 0.08 || a10.b > 0.12)))) {
            swapPair(c11, a11, c10, a10); c11.a = 0.0;
        }
    }

    // Buoyant bubble lateral wobble in water so bubble plumes oscillate naturally.
    if (isBubble(c00) && matOf(c10) == WATER && fract(r * 19.3) < 0.25) {
        swapPair(c00, a00, c10, a10);
    } else if (isBubble(c10) && matOf(c00) == WATER && fract(r * 19.3) > 0.75) {
        swapPair(c00, a00, c10, a10);
    }

    // 2b) Gas buoyancy (smoke/steam) + thermal convection boost.
    if (base.y + 1 < H) {
        float buoy0 = clamp(0.82 + (a00.g - 0.25) * 0.4, 0.5, 0.98);
        float buoy1 = clamp(0.82 + (a10.g - 0.25) * 0.4, 0.5, 0.98);
        if (isClearAir(c01) && isGasAir(c00) && r < buoy0) swapPair(c01, a01, c00, a00);
        if (isClearAir(c11) && isGasAir(c10) && r2 < buoy1) swapPair(c11, a11, c10, a10);
    }
    float rg = fract(r * 7.31);
    if (isGasAir(c00) && isClearAir(c10) && rg < 0.22 + u_wind * 0.18) swapPair(c00, a00, c10, a10);
    else if (isGasAir(c10) && isClearAir(c00) && rg < 0.22 - u_wind * 0.18) swapPair(c00, a00, c10, a10);

    // 2c) Suspended sand advection by water currents (two-phase momentum coupling).
    float radv = fract(r * 11.73);
    if (isGranular(c00) && matOf(c10) == WATER && (c10.g - 0.5) > 10.0 / 255.0 && radv < (c10.g - 0.5) * 1.4) {
        swapPair(c00, a00, c10, a10);
    } else if (isGranular(c10) && matOf(c00) == WATER && (0.5 - c00.g) > 10.0 / 255.0 && radv < (0.5 - c00.g) * 1.4) {
        swapPair(c00, a00, c10, a10);
    }

    // 3) Diagonal toppling of granular sand (imparts horizontal momentum aXX.r).
    bool wtop0 = fract(rc * 11.3) < SINK_P * hinder;
    bool wtop1 = fract(rc * 29.7) < SINK_P * hinder;
    bool tgt10 = isAir(c10) || (matOf(c10) == WATER && wtop0);
    bool tgt00 = isAir(c00) || (matOf(c00) == WATER && wtop1);
    bool topple01 = isGranular(c01) && !canSink(c01, c00, rs0, hinder) && tgt10 && r2 < toppleP(c01);
    bool topple11 = isGranular(c11) && !canSink(c11, c10, rs1, hinder) && tgt00 && r2 < toppleP(c11);
    if (topple01 && topple11) { if (r < 0.5) topple11 = false; else topple01 = false; }
    if (topple01) {
        a01.r = clamp(a01.r + 0.08, 0.5, 0.90);
        swapPair(c01, a01, c10, a10);
    } else if (topple11) {
        a11.r = clamp(a11.r - 0.08, 0.10, 0.5);
        swapPair(c11, a11, c00, a00);
    }

    // 3a) Surface creep + residual horizontal inertia (sand run-out apron).
    float svx0 = (a00.r > 0.01 ? a00.r : 0.5) - 0.5;
    float svx1 = (a10.r > 0.01 ? a10.r : 0.5) - 0.5;
    float pc0 = CREEP_P + (c00.b > FAST_B ? 0.45 : 0.0) + max(0.0, svx0) * 1.4;
    float pc1 = CREEP_P + (c10.b > FAST_B ? 0.45 : 0.0) + max(0.0, -svx1) * 1.4;
    if (isGranular(c00) && isAir(c10) && rc < pc0
        && isAir(getS(base + ivec2(2, 0))) && isAir(getS(base + ivec2(4, -2)))) {
        swapPair(c00, a00, c10, a10);
    } else if (isGranular(c10) && isAir(c00) && rc > 1.0 - pc1
        && isAir(getS(base + ivec2(-1, 0))) && isAir(getS(base + ivec2(-3, -2)))) {
        swapPair(c00, a00, c10, a10);
    }

    // 3b) Bingham plastic mud/clay slither: flows only above soil yield stress.
    float rm = fract(r * 3.317);
    float bingham0 = soilOf(c00) == 1 ? 0.22 : 0.06;
    float bingham1 = soilOf(c10) == 1 ? 0.22 : 0.06;
    if (isGranular(c00) && wetOf(c00) >= 14.0 && isAir(c10) && (c00.b > bingham0 || isAir(getS(base + ivec2(2, -1)))) && rm < 0.14) {
        swapPair(c00, a00, c10, a10);
    } else if (isGranular(c10) && wetOf(c10) >= 14.0 && isAir(c00) && (c10.b > bingham1 || isAir(getS(base + ivec2(-1, -1)))) && rm < 0.14) {
        swapPair(c00, a00, c10, a10);
    }

    // 3d) Bed exchange / Shields scour (records turbidity in lifted water).
    float wsp0 = abs(c01.g - 0.5), wsp1 = abs(c11.g - 0.5);
    float coh0 = clamp(1.0 - c00.a * 1.25, 0.0, 1.0);
    float coh1 = clamp(1.0 - c10.a * 1.25, 0.0, 1.0);
    float sat0 = clamp(wetOf(c00) / 20.0, 0.0, 1.0);
    float sat1 = clamp(wetOf(c10) / 20.0, 0.0, 1.0);
    float cap0 = sat0 * pow(1.0 - sat0, 4.0) * 12.207 * soilCap(c00);
    float cap1 = sat1 * pow(1.0 - sat1, 4.0) * 12.207 * soilCap(c10);
    float pe0 = max(0.0, wsp0 * wsp0 - EROSION_V * EROSION_V) * 14.0 * coh0 / (grainScale(c00) + cap0 * 0.8 + c00.a * 0.7);
    float pe1 = max(0.0, wsp1 * wsp1 - EROSION_V * EROSION_V) * 14.0 * coh1 / (grainScale(c10) + cap1 * 0.8 + c10.a * 0.7);
    if (matOf(c01) == WATER && matOf(c00) == SAND && re < pe0) {
        a01.a = min(1.0, a01.a + 0.35);
        swapPair(c01, a01, c00, a00);
    } else if (matOf(c11) == WATER && matOf(c10) == SAND && fract(re * 7.19) < pe1) {
        a11.a = min(1.0, a11.a + 0.35);
        swapPair(c11, a11, c10, a10);
    }

    // 3e) Darcy pore water: loose permeable surface puddles infiltrate at K_s,
    //     saturated pores migrate down AND laterally under pore-pressure head,
    //     and seep out at free faces. Mass-exact (1 water in = 1 water out).
    float rp = fract(re * 3.913);
    bool buried01 = matOf(getS(base + ivec2(0, 2))) == SAND;
    bool buried11 = matOf(getS(base + ivec2(1, 2))) == SAND;
    float pRate0 = PORE_P * soilPerm(c00) * (buried01 ? 1.0 : 0.22);
    float pRate1 = PORE_P * soilPerm(c10) * (buried11 ? 1.0 : 0.22);
    if (matOf(c01) == WATER && isPermeable(c00) && rp < pRate0) {
        c00.r = satByteFor(c00); a00.a = max(a00.a, c01.a);
        c01 = vec4(0.0); a01 = vec4(0.0, a01.g, 0.0, 0.0);
    } else if (matOf(c11) == WATER && isPermeable(c10) && rp < pRate1) {
        c10.r = satByteFor(c10); a10.a = max(a10.a, c11.a);
        c11 = vec4(0.0); a11 = vec4(0.0, a11.g, 0.0, 0.0);
    } else if (isSat(c01) && isPermeable(c00) && rp < PORE_P * soilPerm(c00)) {
        c00.r = satByteFor(c00); c01.r = drainedByteFor(c01);
    } else if (isSat(c11) && isPermeable(c10) && rp < PORE_P * soilPerm(c10)) {
        c10.r = satByteFor(c10); c11.r = drainedByteFor(c11);
    } else if (isSat(c00) && isPermeable(c10) && a00.a > a10.a + 0.02 && rp < PORE_P * 0.65 * soilPerm(c10)) {
        c10.r = satByteFor(c10); c00.r = drainedByteFor(c00); // lateral Darcy flow
    } else if (isSat(c10) && isPermeable(c00) && a10.a > a00.a + 0.02 && rp < PORE_P * 0.65 * soilPerm(c00)) {
        c00.r = satByteFor(c00); c10.r = drainedByteFor(c10);
    } else if (isSat(c01) && isClearAir(c00) && rp < SEEP_P) {
        c00 = vec4(180.0 / 255.0, 0.5, 0.5, 0.0); a00 = vec4(1.0, a01.g, 0.0, 0.0);
        c01.r = drainedByteFor(c01);
    } else if (isSat(c11) && isClearAir(c10) && rp < SEEP_P) {
        c10 = vec4(180.0 / 255.0, 0.5, 0.5, 0.0); a10 = vec4(1.0, a11.g, 0.0, 0.0);
        c11.r = drainedByteFor(c11);
    } else if (isSat(c00) && isClearAir(c10) && rp < SEEP_P * (1.0 + a00.a * 2.0)) {
        c10 = vec4(180.0 / 255.0, 0.5, 0.5, 0.0); a10 = vec4(1.0, a00.g, 0.0, 0.0);
        c00.r = drainedByteFor(c00);
    } else if (isSat(c10) && isClearAir(c00) && rp < SEEP_P * (1.0 + a10.a * 2.0)) {
        c00 = vec4(180.0 / 255.0, 0.5, 0.5, 0.0); a00 = vec4(1.0, a10.g, 0.0, 0.0);
        c10.r = drainedByteFor(c10);
    }

    // 3c) Water diagonal slide downhill.
    bool wslide01 = matOf(c01) == WATER && !canSink(c01, c00, 0.0, 1.0) && isAir(c10);
    bool wslide11 = matOf(c11) == WATER && !canSink(c11, c10, 0.0, 1.0) && isAir(c00);
    if (wslide01 && wslide11) { if (r < 0.5) wslide11 = false; else wslide01 = false; }
    if (wslide01) swapPair(c01, a01, c10, a10);
    else if (wslide11) swapPair(c11, a11, c00, a00);

    // 4) Lateral water flow (velocity + pressure + surface tension).
    if ((u_disable & 2) == 0) {
        if (matOf(c00) == WATER && isAir(c10)) {
            int mbr = matOf(getS(base + ivec2(1, -1)));
            float bias = (mbr == WATER) ? 0.42 : ((mbr == AIR) ? 0.5 : 0.1);
            float pr = clamp(0.45 + bias + (c00.g - 0.5) * 3.0 + c00.a * 20.0, 0.05, 0.97);
            if (matOf(c01) != WATER && matOf(getS(base + ivec2(0, -1))) != WATER
                && matOf(getS(base + ivec2(-1, 0))) != WATER) pr *= 0.12;
            if (r2 < pr) swapPair(c00, a00, c10, a10);
        } else if (matOf(c10) == WATER && isAir(c00)) {
            int mbl = matOf(getS(base + ivec2(0, -1)));
            float bias = (mbl == WATER) ? 0.42 : ((mbl == AIR) ? 0.5 : 0.1);
            float pl = clamp(0.45 + bias - (c10.g - 0.5) * 3.0 + c10.a * 20.0, 0.05, 0.97);
            if (matOf(c11) != WATER && matOf(getS(base + ivec2(1, -1))) != WATER
                && matOf(getS(base + ivec2(2, 0))) != WATER) pl *= 0.12;
            if (r2 < pl) swapPair(c00, a00, c10, a10);
        }

        if (matOf(c01) == WATER && isAir(c11) && !isAir(c00) && !isAir(c10)) {
            float pr = clamp(0.5 + (c01.g - 0.5) * 3.0, 0.05, 0.95);
            if (matOf(getS(base + ivec2(0, 2))) != WATER && matOf(c00) != WATER
                && matOf(getS(base + ivec2(-1, 1))) != WATER) pr *= 0.12;
            if (r > 1.0 - pr) swapPair(c01, a01, c11, a11);
        } else if (matOf(c11) == WATER && isAir(c01) && !isAir(c00) && !isAir(c10)) {
            float pl = clamp(0.5 - (c11.g - 0.5) * 3.0, 0.05, 0.95);
            if (matOf(getS(base + ivec2(1, 2))) != WATER && matOf(c10) != WATER
                && matOf(getS(base + ivec2(2, 1))) != WATER) pl *= 0.12;
            if (r > 1.0 - pl) swapPair(c01, a01, c11, a11);
        }
    }

    ivec2 local = p - base;
    outState = (local.y == 0) ? (local.x == 0 ? c00 : c10) : (local.x == 0 ? c01 : c11);
    outAux   = (local.y == 0) ? (local.x == 0 ? a00 : a10) : (local.x == 0 ? a01 : a11);
}

//====== FALL ======
#version 300 es
// Pass 5 of each sub-step: inertial 2-cell vertical fast-fall (preserving Margolus parity).
precision highp float;
precision highp int;

uniform sampler2D u_state;
uniform sampler2D u_aux;
layout(location = 0) out vec4 outState;
layout(location = 1) out vec4 outAux;

const int W = 800, H = 600;
const int AIR = 0, SAND = 1, WATER = 3;
const float COHESION_THRESH = 0.25;
const float FAST = 40.0 / 255.0;

vec4 getS(ivec2 p) {
    if (p.y < 0) return vec4(240.0 / 255.0, 0.0, 0.0, 1.0);
    if (p.x < 0 || p.x >= W || p.y >= H) return vec4(0.0);
    return texelFetch(u_state, p, 0);
}

vec4 getA(ivec2 p) {
    if (p.y < 0) return vec4(0.5, 0.22, 0.0, 0.0);
    if (p.x < 0 || p.x >= W || p.y >= H) return vec4(0.0, 0.25, 0.0, 0.0);
    return texelFetch(u_aux, p, 0);
}

int matOf(vec4 c) { return (int(floor(c.r * 255.0 + 0.5)) + 30) / 60; }
bool isAir(vec4 c) { return matOf(c) == AIR; }
bool fastCell(vec4 c) {
    int m = matOf(c);
    if (m == SAND) return c.a < COHESION_THRESH && c.b > FAST;
    if (m == WATER) return c.b < 0.5 - 40.0 / 255.0;
    return false;
}

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 self = getS(p), selfA = getA(p);
    vec4 up1 = getS(p + ivec2(0, 1)), up2 = getS(p + ivec2(0, 2));
    vec4 dn1 = getS(p + ivec2(0, -1)), dn2 = getS(p + ivec2(0, -2));

    if (isAir(self)) {
        if (fastCell(up1) && !isAir(dn1)) { outState = up1; outAux = getA(p + ivec2(0, 1)); return; }
        if (fastCell(up2) && isAir(up1))  { outState = up2; outAux = getA(p + ivec2(0, 2)); return; }
    } else if (fastCell(self) && isAir(dn1)) {
        if (isAir(dn2)) { outState = dn2; outAux = getA(p + ivec2(0, -2)); }
        else            { outState = dn1; outAux = getA(p + ivec2(0, -1)); }
        return;
    }
    outState = self;
    outAux = selfA;
}

//====== SURGE ======
#version 300 es
// Pass 6 of each sub-step: horizontal inertial 2-cell surge for fast water and
// fast-sliding granular sand (preserving Margolus parity and u_aux lockstep).
precision highp float;
precision highp int;

uniform sampler2D u_state;
uniform sampler2D u_aux;
uniform int u_surgeDir;
layout(location = 0) out vec4 outState;
layout(location = 1) out vec4 outAux;

const int W = 800, H = 600;
const int AIR = 0, SAND = 1, WATER = 3;
const float COHESION_THRESH = 0.25;
const float SURGE_T = 16.0 / 255.0;

vec4 getS(ivec2 p) {
    if (p.y < 0 || p.x < 0 || p.x >= W) return vec4(240.0 / 255.0, 0.0, 0.0, 1.0);
    if (p.y >= H) return vec4(0.0);
    return texelFetch(u_state, p, 0);
}

vec4 getA(ivec2 p) {
    if (p.y < 0 || p.x < 0 || p.x >= W) return vec4(0.5, 0.22, 0.0, 0.0);
    if (p.y >= H) return vec4(0.0, 0.25, 0.0, 0.0);
    return texelFetch(u_aux, p, 0);
}

int matOf(vec4 c) { return (int(floor(c.r * 255.0 + 0.5)) + 30) / 60; }
bool isAir(vec4 c) { return matOf(c) == AIR; }

bool fastHoriz(vec4 s, vec4 a, float dir) {
    int m = matOf(s);
    if (m == WATER) return (s.g - 0.5) * dir > SURGE_T;
    if (m == SAND && s.a < COHESION_THRESH) return ((a.r > 0.01 ? a.r : 0.5) - 0.5) * dir > 0.14;
    return false;
}

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    ivec2 d = ivec2(u_surgeDir, 0);
    float dir = float(u_surgeDir);
    vec4 self = getS(p), selfA = getA(p);

    vec4 b1 = getS(p - d), b2 = getS(p - 2 * d);
    vec4 f1 = getS(p + d), f2 = getS(p + 2 * d);
    vec4 ab1 = getA(p - d), ab2 = getA(p - 2 * d);

    if (isAir(self)) {
        if (fastHoriz(b1, ab1, dir) && !isAir(f1)) { outState = b1; outAux = ab1; return; }
        if (fastHoriz(b2, ab2, dir) && isAir(b1))  { outState = b2; outAux = ab2; return; }
    } else if (fastHoriz(self, selfA, dir) && isAir(f1)) {
        if (isAir(f2)) { outState = f2; outAux = getA(p + 2 * d); }
        else           { outState = f1; outAux = getA(p + d); }
        return;
    }
    outState = self;
    outAux = selfA;
}
`;
