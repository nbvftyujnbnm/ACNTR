import { GLSL_COMMON, GLSL_NOISE3 } from './lib.js';

/**
 * Sky is drawn as a full-screen triangle whose clip-space depth is pinned to
 * the far plane (z == w == 1). Combined with `depthWrite:false` and the default
 * LEqual depth func that means:
 *   - it can never overdraw real geometry, whatever the render order,
 *   - sky pixels keep the cleared depth of 1.0, which the post stack uses as
 *     its "this is sky" test for AO / SSR / fog / DOF.
 *
 * The view ray comes from uniforms set in `onBeforeRender`, so the material
 * works unchanged for the main camera and for the PMREM cube bake.
 */
export const SKY_VERT = /* glsl */ `
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
varying vec3 vDir;

void main() {
  vec4 clip = vec4( position.xy, 1.0, 1.0 );
  vec4 v = uInvProj * clip;
  vDir = ( uCamWorld * vec4( v.xyz / v.w, 0.0 ) ).xyz;
  gl_Position = clip;
}
`;

export const SKY_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_NOISE3}

uniform vec3  uSunDir;        // normalised, origin -> sun
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uGround;
uniform vec3  uSunTint;       // colour of the scattered halo around the sun
uniform vec3  uSunDisc;       // colour of the disc itself
uniform vec3  uCloudDark;
uniform vec3  uCloudLit;

uniform float uTime;
uniform float uHazeFalloff;   // how fast the ochre horizon band decays upward
uniform float uMieStrength;
uniform float uMieG;
uniform float uRayleigh;
uniform float uSunIntensity;
uniform float uSunAngular;    // angular radius, radians
uniform float uCloudCover;
uniform float uCloudOpacity;
uniform float uCloudScale;
uniform float uBandStrength;
uniform float uDither;
uniform float uEnvBake;       // 1.0 while baking the PMREM: widen the sun disc
uniform float uEnvSunWiden;   // disc radius multiplier during the bake
uniform float uEnvSunGain;    // disc peak multiplier during the bake
uniform vec3  uGroundBake;    // lower-hemisphere bounce colour, IBL only

varying vec3 vDir;

void main() {
  vec3 V = normalize( vDir );
  float up = V.y;
  float mu = dot( V, uSunDir );

  float sunUp = smoothstep( -0.12, 0.10, uSunDir.y );

  // ---- base atmosphere ---------------------------------------------------
  // Exponential horizon band rather than a linear ramp: dense dust piles up in
  // the first few degrees, which is what sells "polluted industrial sky".
  float hz = exp( - max( up, 0.0 ) * uHazeFalloff );
  vec3 sky = mix( uZenith, uHorizon, hz );

  // Rayleigh-ish lift high up, away from the sun. Keeps the zenith from going
  // muddy without turning the sky "clear-day blue".
  float phaseR = 0.75 * ( 1.0 + mu * mu );
  sky += uZenith * uRayleigh * phaseR * ( 1.0 - hz );

  // Forward-scattering aerosol lobe: the big warm bloom around a low sun.
  float g = uMieG;
  float g2 = g * g;
  float denom = max( 1.0 + g2 - 2.0 * g * mu, 1e-4 );
  float phaseM = ( 1.0 - g2 ) / ( 4.0 * PI * denom * sqrt( denom ) );
  sky += uSunTint * phaseM * uMieStrength * ( 0.22 + 1.15 * hz ) * sunUp;

  // Broad, low-frequency warm wash on the sun side of the sky.
  sky += uSunTint * pow( max( mu, 0.0 ), 5.0 ) * 0.28 * sunUp;

  // ---- layered dust strata near the horizon ------------------------------
  // Anisotropic 3D noise (26x vertical squash) -> long horizontal bands with no
  // azimuthal seam. This is the "layered haze, not flat fog" cue.
  vec3 bp = V * vec3( 3.2, 26.0, 3.2 );
  bp.y -= uTime * 0.018;
  bp.x += uTime * 0.010;
  float bn = fbm3_3( bp );
  float strat = smoothstep( 0.40, 0.74, bn );
  float bandMask = exp( - max( up, 0.0 ) * 7.5 ) * smoothstep( -0.14, 0.01, up );
  vec3 bandCol = mix( uHorizon * 1.22, uSunTint * 1.7, pow( max( mu, 0.0 ), 3.0 ) * sunUp );
  sky = mix( sky, bandCol, clamp( strat * bandMask * uBandStrength, 0.0, 0.9 ) );

  // ---- cloud / smog deck -------------------------------------------------
  // Pseudo-perspective projection of the direction vector: continuous
  // everywhere (so no seam), but stretched hard toward the horizon so the deck
  // reads as a plane receding into the haze.
  vec3 cp = V / ( max( up, 0.0 ) * 0.85 + 0.22 );
  cp.xz *= uCloudScale;
  cp.x += uTime * 0.012;
  cp.z += uTime * 0.007;

  // one cheap warp octave kills the "grid of blobs" look
  cp += vec3( fbm3_2( cp * 0.55 ) - 0.5 ) * 1.4;

  float cn = fbm3_5( cp );
  float cover = clamp( uCloudCover, 0.0, 1.0 );
  float cl = smoothstep( 1.0 - cover - 0.16, 1.0 - cover + 0.18, cn );
  cl *= smoothstep( 0.0, 0.20, up );              // deck converges into the haze
  cl *= uCloudOpacity;

  vec3 cloudCol = mix( uCloudDark, uCloudLit, smoothstep( 0.34, 0.92, cn ) );
  cloudCol = mix( cloudCol, uSunTint * 1.5, pow( max( mu, 0.0 ), 4.0 ) * 0.55 * sunUp );
  sky = mix( sky, cloudCol, clamp( cl, 0.0, 1.0 ) );
  // silver lining: thin edges of the deck glow when they cross the sun
  sky += uSunTint * pow( max( mu, 0.0 ), 16.0 ) * cl * ( 1.0 - cl ) * 3.0 * sunUp;

  // ---- sun disc ----------------------------------------------------------
  // Chord length is a stable small-angle stand-in for acos(mu) and doesn't
  // lose precision as mu -> 1.
  float ang = sqrt( max( 2.0 - 2.0 * mu, 0.0 ) );
  float radius = uSunAngular * mix( 1.0, uEnvSunWiden, uEnvBake );
  float r = ang / max( radius, 1e-4 );
  float disc = 1.0 - smoothstep( 0.90, 1.02, r );
  float limb = pow( max( 1.0 - r * r * 0.92, 0.0 ), 0.45 );   // limb darkening
  float discAtten = mix( 1.0, uEnvSunGain, uEnvBake );
  sky += uSunDisc * disc * limb * uSunIntensity * discAtten * sunUp
       * ( 1.0 - clamp( cl, 0.0, 1.0 ) * 0.85 );

  // ---- below the horizon -------------------------------------------------
  // In-game the terrain covers this entirely; it exists for the IBL, where it
  // is the ONLY thing lighting a downward-facing chamfer. A near-black lower
  // hemisphere is what makes a metalness-1.0 mech read as a silhouette.
  vec3 below = mix( uGround, uGroundBake, uEnvBake );
  sky = mix( sky, below, 1.0 - smoothstep( -0.10, 0.0, up ) );

  // ---- dither ------------------------------------------------------------
  // Two terms, because one cannot cover the range. AgX is roughly logarithmic:
  // in the dark zenith an 8-bit display step is ~0.0015 linear, near the bright
  // horizon it is ~0.007. A purely multiplicative dither under-dithers the
  // zenith; a purely additive one over-grains the horizon. Use both.
  float dth = hash13( vec3( gl_FragCoord.xy, floor( uTime * 60.0 ) ) ) - 0.5;
  float dth2 = hash13( vec3( gl_FragCoord.yx + 37.0, floor( uTime * 60.0 ) ) ) - 0.5;
  sky *= 1.0 + dth * uDither * 2.4;
  sky += dth2 * uDither * 0.30;

  gl_FragColor = vec4( max( sky, vec3( 0.0 ) ), 1.0 );

  #include <colorspace_fragment>
}
`;
