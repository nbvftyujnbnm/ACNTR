import { GLSL_COMMON, GLSL_DEPTH } from './lib.js';

/* ---------------------------------------------------------------------------
 * Velocity — camera-motion reconstruction from depth.
 *
 * Unprojects each pixel with the current (un-jittered) inverse view-projection
 * and re-projects it with the previous frame's view-projection. Static geometry
 * gets exact camera motion; the sky (depth == 1) gets pure rotational motion,
 * which is correct.
 * ------------------------------------------------------------------------- */
export const VELOCITY_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_DEPTH}

uniform sampler2D tDepth;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
varying vec2 vUv;

void main() {
  float d = texture2D( tDepth, vUv ).x;

  vec4 clip = vec4( vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  vec4 wp = uInvViewProj * clip;
  wp /= wp.w;

  vec4 pc = uPrevViewProj * wp;
  vec2 prevUv = ( pc.xy / pc.w ) * 0.5 + 0.5;

  gl_FragColor = vec4( vUv - prevUv, 0.0, 1.0 );
}
`;

/* ---------------------------------------------------------------------------
 * SSAO — hemisphere kernel, contact scale, with a hard range check.
 *
 * The range check is the whole reason this doesn't halo: an occluder further
 * from the shading point than the sample radius contributes nothing, so a
 * foreground object can't paint a dark ring onto the background behind it.
 * ------------------------------------------------------------------------- */
export const AO_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_DEPTH}

uniform sampler2D tDepth;
uniform sampler2D tNoise;
uniform vec3  uKernel[ AO_SAMPLES ];
uniform mat4  uProj;
uniform mat4  uInvProj;
uniform vec2  uDepthTexel;    // 1 / full-res depth buffer
uniform vec2  uNoiseScale;    // aoResolution / noiseTexSize
uniform float uRadius;
uniform float uStrength;
uniform float uBias;
uniform float uPower;
uniform float uNear;
uniform float uFar;
uniform float uFrame;
varying vec2 vUv;

void main() {
  float d = texture2D( tDepth, vUv ).x;

  if ( d >= 0.999999 ) {
    gl_FragColor = vec4( 1.0, uFar, 0.0, 1.0 );
    return;
  }

  vec3 P = viewPosFromDepth( vUv, d, uInvProj );
  vec3 N = normalFromDepth( tDepth, vUv, uDepthTexel, uInvProj );

  // Blue noise + golden-ratio frame offset: decorrelated in space per pixel and
  // in time per frame, so TAA integrates the sampling noise away instead of
  // letting it crawl.
  float bn = texture2D( tNoise, vUv * uNoiseScale ).r;
  float ang = fract( bn + uFrame * 0.6180339887 ) * TAU;
  mat3 TBN = basisFromNormal( N, ang );

  // Shrink the world radius with distance so distant geometry doesn't sample
  // across half the screen (which is what makes AO crawl and smear).
  float radius = uRadius * clamp( 12.0 / max( -P.z, 1.0 ), 0.35, 1.0 );

  float occ = 0.0;
  for ( int i = 0; i < AO_SAMPLES; i ++ ) {
    vec3 sp = P + ( TBN * uKernel[ i ] ) * radius;

    vec4 cp = uProj * vec4( sp, 1.0 );
    vec2 suv = ( cp.xy / cp.w ) * 0.5 + 0.5;
    if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) continue;

    float sd = texture2D( tDepth, suv ).x;
    if ( sd >= 0.999999 ) continue;

    float sz = viewZFromDepth( sd, uNear, uFar );

    // Occluded when the real surface sits in front of the sample point.
    float occluded = step( sp.z + uBias, sz );

    // Range check — the anti-halo term.
    float range = smoothstep( 0.0, 1.0, radius / max( abs( P.z - sz ), 1e-4 ) );

    occ += occluded * range;
  }

  float ao = 1.0 - occ / float( AO_SAMPLES );
  ao = pow( clamp( ao, 0.0, 1.0 ), uPower );
  ao = mix( 1.0, ao, uStrength );

  gl_FragColor = vec4( ao, -P.z, 0.0, 1.0 );
}
`;

/**
 * Separable bilateral blur for the AO buffer. G holds linear view depth so the
 * blur refuses to cross a depth discontinuity — without that the AO bleeds over
 * silhouettes and reads as a halo.
 */
export const AO_BLUR_FRAG = /* glsl */ `
${GLSL_COMMON}

uniform sampler2D tAO;
uniform vec2  uDirection;     // (texelX, 0) or (0, texelY)
uniform float uDepthSigma;
varying vec2 vUv;

void main() {
  vec2 c = texture2D( tAO, vUv ).rg;
  float centerDepth = c.g;

  float sum = c.r;
  float wsum = 1.0;

  for ( int i = 1; i <= 4; i ++ ) {
    float fi = float( i );
    float gw = exp( -0.5 * ( fi * fi ) / 4.0 );
    vec2 o = uDirection * fi;

    vec2 a = texture2D( tAO, vUv + o ).rg;
    float wa = gw * exp( - abs( a.g - centerDepth ) / uDepthSigma );
    sum += a.r * wa; wsum += wa;

    vec2 b = texture2D( tAO, vUv - o ).rg;
    float wb = gw * exp( - abs( b.g - centerDepth ) / uDepthSigma );
    sum += b.r * wb; wsum += wb;
  }

  gl_FragColor = vec4( sum / wsum, centerDepth, 0.0, 1.0 );
}
`;

/* ---------------------------------------------------------------------------
 * SSR — screen-space ray march with binary refinement.
 *
 * There is no G-buffer roughness here (adding one would mean touching every
 * other agent's materials), so reflection strength is driven by Fresnel, a
 * global roughness knob, and an "upward facing surfaces reflect more" boost
 * that mimics wet industrial floors — the AC6 cue this pass exists for.
 * ------------------------------------------------------------------------- */
export const SSR_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_DEPTH}

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNoise;
uniform mat4  uProj;
uniform mat4  uInvProj;
uniform mat3  uViewToWorld;
uniform vec2  uDepthTexel;
uniform vec2  uNoiseScale;
uniform float uNear;
uniform float uFar;
uniform float uMaxDistance;
uniform float uThickness;
uniform float uRoughness;
uniform float uUpBoost;
uniform float uFrame;
varying vec2 vUv;

void main() {
  float d = texture2D( tDepth, vUv ).x;
  if ( d >= 0.999999 ) { gl_FragColor = vec4( 0.0 ); return; }

  vec3 P = viewPosFromDepth( vUv, d, uInvProj );
  vec3 N = normalFromDepth( tDepth, vUv, uDepthTexel, uInvProj );
  vec3 V = normalize( P );                 // camera (origin) -> surface
  vec3 R = normalize( reflect( V, N ) );

  // Fresnel: grazing angles reflect, head-on barely does. This alone stops the
  // effect from reading as a mirror-floor hack.
  float NoV = clamp( dot( -V, N ), 0.0, 1.0 );
  float fres = pow( 1.0 - NoV, 4.0 );

  vec3 wN = normalize( uViewToWorld * N );
  float upFacing = clamp( wN.y, 0.0, 1.0 );
  float weight = ( 0.03 + 0.97 * fres ) * ( 1.0 - uRoughness );
  weight *= mix( 1.0, 1.0 + uUpBoost, upFacing * upFacing );
  if ( weight < 0.004 ) { gl_FragColor = vec4( 0.0 ); return; }

  float bn = texture2D( tNoise, vUv * uNoiseScale ).r;
  float jitter = fract( bn + uFrame * 0.6180339887 );

  float stepLen = uMaxDistance / float( SSR_STEPS );
  vec3 origin = P + N * max( 0.05, abs( P.z ) * 0.004 );

  vec3 prevPos = origin;
  vec3 hitPos = vec3( 0.0 );
  vec2 hitUv = vec2( 0.0 );
  float hit = 0.0;
  float travelled = 0.0;

  for ( int i = 0; i < SSR_STEPS; i ++ ) {
    float fi = float( i ) + jitter;
    // geometric growth: dense near the surface, coarse far away
    float t = stepLen * fi * ( 1.0 + fi * 0.08 );
    vec3 cur = origin + R * t;

    if ( cur.z > -uNear ) break;           // stepped past the near plane

    vec4 cp = uProj * vec4( cur, 1.0 );
    vec2 suv = ( cp.xy / cp.w ) * 0.5 + 0.5;
    if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) break;

    float sd = texture2D( tDepth, suv ).x;
    if ( sd < 0.999999 ) {
      float sz = viewZFromDepth( sd, uNear, uFar );
      float delta = sz - cur.z;            // >0 : surface is in front of the ray
      if ( delta > 0.0 && delta < uThickness + stepLen ) {
        hit = 1.0;
        hitPos = cur;
        hitUv = suv;
        travelled = t;
        break;
      }
    }
    prevPos = cur;
  }

  if ( hit < 0.5 ) { gl_FragColor = vec4( 0.0 ); return; }

  // ---- binary refinement between the last miss and the hit ---------------
  vec3 a = prevPos;
  vec3 b = hitPos;
  for ( int j = 0; j < SSR_REFINE; j ++ ) {
    vec3 mid = ( a + b ) * 0.5;
    vec4 cp = uProj * vec4( mid, 1.0 );
    vec2 suv = ( cp.xy / cp.w ) * 0.5 + 0.5;
    float sd = texture2D( tDepth, suv ).x;
    float sz = viewZFromDepth( sd, uNear, uFar );
    if ( sz - mid.z > 0.0 ) { b = mid; hitUv = suv; }
    else { a = mid; }
  }

  // ---- confidence --------------------------------------------------------
  vec2 e = smoothstep( vec2( 0.0 ), vec2( 0.14 ), hitUv )
         * ( 1.0 - smoothstep( vec2( 0.86 ), vec2( 1.0 ), hitUv ) );
  float edgeFade = e.x * e.y;

  float distFade = 1.0 - clamp( travelled / uMaxDistance, 0.0, 1.0 );
  distFade *= distFade;

  // A ray heading back toward the camera can only resolve against data that is
  // about to leave the screen — fade it rather than let it flicker.
  float backFade = 1.0 - smoothstep( 0.0, 0.55, R.z );

  float conf = edgeFade * distFade * backFade * weight;
  if ( conf <= 0.0 ) { gl_FragColor = vec4( 0.0 ); return; }

  vec3 refl = texture2D( tColor, hitUv ).rgb;
  // clamp fireflies so one blown pixel can't strobe through TAA
  refl = min( refl, vec3( 12.0 ) );

  gl_FragColor = vec4( refl, clamp( conf, 0.0, 1.0 ) );
}
`;

/* ---------------------------------------------------------------------------
 * Scene composite — folds AO and SSR into the HDR frame, then applies aerial
 * perspective as THREE superposed participating media instead of one fog.
 *
 * One exponential fog can only produce a uniform wash: everything past a
 * certain distance converges on the same colour and the frame turns to milk.
 * Depth reads as depth when different media dominate at different ranges and
 * altitudes, and when they are not the same COLOUR:
 *
 *   deck   — low, dense, warm ground dust. Analytic integral of an exponential
 *            height profile (Wenzel), so it is exact and stable under motion.
 *            Buries the far ground plane, leaves skylines standing.
 *   band   — a thin smog stratum at a fixed altitude, gaussian in height,
 *            Simpson-integrated over three samples. This is the visible haze
 *            LINE that cuts across tall structures — the strongest single cue
 *            that the air has layers.
 *   aerial — thin, height-independent, cool and pale. Rayleigh-ish: it lifts
 *            and DESATURATES the far distance while keeping local contrast.
 *
 * Colours are blended by optical depth, so what dominates changes with the
 * sight line: warm near the ground, cool toward the ridges.
 * ------------------------------------------------------------------------- */
export const COMPOSITE_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_DEPTH}

uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tAO;
uniform sampler2D tSSR;
uniform mat4  uInvViewProj;
uniform vec3  uCameraPos;
uniform vec3  uSunDir;
uniform vec3  uFogColor;
uniform vec3  uFogSunColor;
uniform vec3  uDeckColor;
uniform vec3  uBandColor;
uniform vec3  uAerialColor;
uniform float uFogDensity;
uniform float uFogHeight;
uniform float uFogFalloff;
uniform float uBandDensity;
uniform float uBandHeight;
uniform float uBandThickness;
uniform float uAerialDensity;
uniform float uFogStrength;
uniform float uAOEnabled;
uniform float uSSREnabled;
uniform float uSSRIntensity;
varying vec2 vUv;

/**
 * Optical depth through rho(y) = density * exp( -falloff * (y - baseY) ),
 * integrated in closed form along the segment. The exponent is clamped because
 * a camera far below the deck base would otherwise overflow to inf.
 */
float deckTau( float y0, float y1, float dist ) {
  float a0 = clamp( - uFogFalloff * ( y0 - uFogHeight ), -9.0, 5.0 );
  float dy = ( y1 - y0 ) * uFogFalloff;
  float base = uFogDensity * exp( a0 ) * dist;
  if ( abs( dy ) < 1e-3 ) return base;
  return base * ( 1.0 - exp( - clamp( dy, -9.0, 9.0 ) ) ) / dy;
}

float bandRho( float y ) {
  float t = ( y - uBandHeight ) / max( uBandThickness, 1e-3 );
  return exp( - t * t );
}

void main() {
  vec3 color = texture2D( tScene, vUv ).rgb;
  float d = texture2D( tDepth, vUv ).x;

  if ( uAOEnabled > 0.5 ) {
    float ao = texture2D( tAO, vUv ).r;
    // AO is an indirect-visibility term. Letting it multiply direct light and
    // emissives is what makes cheap SSAO read as dirt, so bright pixels keep
    // their energy.
    float protect = smoothstep( 0.55, 3.0, luma( color ) );
    color *= mix( ao, 1.0, protect );
  }

  if ( uSSREnabled > 0.5 ) {
    vec4 s = texture2D( tSSR, vUv );
    color += s.rgb * s.a * uSSRIntensity;
  }

  if ( d < 0.999999 && uFogStrength > 0.0 ) {
    vec3 wp = worldPosFromDepth( vUv, d, uInvViewProj );
    vec3 toP = wp - uCameraPos;
    float dist = length( toP );
    vec3 dir = toP / max( dist, 1e-4 );

    float tDeck = deckTau( uCameraPos.y, wp.y, dist );

    float midY = ( uCameraPos.y + wp.y ) * 0.5;
    float tBand = uBandDensity * dist *
      ( bandRho( uCameraPos.y ) + 4.0 * bandRho( midY ) + bandRho( wp.y ) ) * ( 1.0 / 6.0 );

    float tAir = uAerialDensity * dist;

    float tau = ( tDeck + tBand + tAir ) * uFogStrength;

    // Colour weighted by which medium the ray actually spent its length in.
    vec3 inscat = ( uDeckColor * tDeck + uBandColor * tBand + uAerialColor * tAir )
                / max( tDeck + tBand + tAir, 1e-5 );

    // Forward-scattering lobe: haze glows toward the sun and ONLY there. A
    // broad lobe tips the whole frame warm, and then near and far are the same
    // hue again — which is the flat-wash failure this pass exists to avoid.
    float mu = max( dot( dir, uSunDir ), 0.0 );
    float g = 0.82;
    float g2 = g * g;
    float den = max( 1.0 + g2 - 2.0 * g * mu, 1e-4 );
    float hg = ( 1.0 - g2 ) / ( 12.566370614 * den * sqrt( den ) );
    inscat = mix( inscat, uFogSunColor, clamp( hg * 0.55, 0.0, 0.85 ) );

    // Dither the transmittance, not the colour: a 700 m gradient across 1080
    // rows steps by well under one 8-bit code, and that is exactly where sky /
    // fog banding comes from.
    float dth = ( hash12( gl_FragCoord.xy ) - 0.5 ) * 0.006;
    float f = clamp( 1.0 - exp( - tau ) + dth, 0.0, 0.985 );

    color = mix( color, inscat, f );
  }

  gl_FragColor = vec4( color, 1.0 );
}
`;
