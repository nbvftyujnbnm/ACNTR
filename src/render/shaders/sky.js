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
  // Tightened from pow 5 to pow 7: at 37 degrees off the sun the old exponent
  // still delivered a third of its peak, which spread a featureless pale field
  // across most of the sun quadrant and left the flare with nothing to fall off
  // against. The peak is raised slightly to keep the near-sun energy.
  sky += uSunTint * pow( max( mu, 0.0 ), 7.0 ) * 0.31 * sunUp;

  // ---- layered dust strata near the horizon ------------------------------
  // Anisotropic 3D noise (26x vertical squash) -> long horizontal bands with no
  // azimuthal seam. This is the "layered haze, not flat fog" cue.
  vec3 bp = V * vec3( 3.2, 26.0, 3.2 );
  bp.y -= uTime * 0.018;
  bp.x += uTime * 0.010;
  float bn = fbm3_3( bp );
  float strat = smoothstep( 0.44, 0.72, bn );

  // TWO ALTITUDE PROFILES ON ONE STRATUM FIELD, and the fact that it is one
  // field is the measured part.
  //
  // The complaint this answers is "the near-horizon sky is flat", and the
  // number behind it comes from tools/skysim.mjs, which evaluates this shader
  // on the CPU over the vista frustum: the sky's stratification there measured
  // 0.85 code values of standard deviation against a grain floor of about 2.0,
  // i.e. the layers were half a code value under the noise the pipeline adds on
  // purpose. Nothing about the transfer curve is to blame — a 9% radiance swing
  // buys 5 code values anywhere in the sky's range, checked with
  // tools/grade-model.mjs. The strata simply were not reaching.
  //
  // The exp( -up * 7.5 ) deck e-folds at 7.6 degrees and is down to 0.10 by 17.
  // A hero
  // framing's sky STARTS around 10 degrees (the terrain covers everything
  // below it), so the entire visible sky sat in the tail of the one term that
  // was supposed to give it structure, while the cloud deck above is held out
  // below 24 degrees for the curtain reason recorded in CONTRACT.md. Between
  // them was a band of sky with nothing in it at all.
  //
  // THE FIRST ATTEMPT USED THE SUN VEIL'S 16x FIELD as a second, coarser deck,
  // on the theory that two thicknesses read as weather. MEASURED, and it is a
  // dead end worth recording: at 16x squash and 17-21 degrees of elevation one
  // band is 120-200 px tall in a 1080-line frame, so one or two of them fill
  // the whole visible sky and arrive as a smooth GRADIENT. Traced down a single
  // column it moved the display value by 10 codes monotonically over 120 px --
  // brightness, not layering. The 26x field is 40-60 px up there, which is the
  // scale that reads as a layer, so the fix is a REACH change on that field and
  // not a second one.
  //
  // highDeck is therefore the same strat field, on a much slower altitude decay,
  // faded IN above the dense deck (so the first 3.5 degrees stay exactly as
  // tuned) and OUT before the cloud deck arrives. Falling edge written as
  // 1 - smoothstep, because smoothstep with edge0 >= edge1 is undefined.
  //
  // MEASURED on the vista pose, stratification s.d. in the visible sky:
  //   0.85 -> 2.49 code values, with the region's mean up only 3.2 (138.4 ->
  //   141.6). The threshold pair went 0.40/0.74 -> 0.44/0.72, i.e. tighter and
  //   still above the fbm's 0.5 mean: that makes the layers SPARSER and each
  //   one stronger, which is both what clear air between strata looks like and
  //   how the contrast is bought without lifting the whole sky.
  float lowDeck  = exp( - max( up, 0.0 ) * 7.5 );
  float highDeck = 1.10 * exp( - max( up, 0.0 ) * 2.2 )
                 * smoothstep( 0.06, 0.26, up )
                 * ( 1.0 - smoothstep( 0.30, 0.62, up ) );
  float bandMask = strat * ( lowDeck + highDeck ) * smoothstep( -0.14, 0.01, up );
  vec3 bandCol = mix( uHorizon * 1.22, uSunTint * 1.7, pow( max( mu, 0.0 ), 3.0 ) * sunUp );
  sky = mix( sky, bandCol, clamp( bandMask * uBandStrength, 0.0, 0.9 ) );

  // ---- high dust silhouetted across the sun's glow -----------------------
  // The band above dies out within ~8 degrees of the horizon, so it never
  // reached a 13.5-degree sun: the Mie lobe was left as a smooth radial blob
  // with nothing crossing it, which is what made the flare read as painted on.
  //
  // This term is an EXTINCTION, not a tint, and that distinction is the whole
  // reason the first attempt at this failed. Near the sun the sky sits on the
  // flat top of the AgX shoulder, where display value is almost independent of
  // radiance: measured on the curve, halving the radiance 6 degrees off the sun
  // moves the frame by 4 code values out of 255. Mixing dust COLOUR in there
  // does nothing visible. Multiplying the radiance down by 90% where a stratum
  // is dense moves it by 26, which is a silhouette.
  //
  // Three gates shape it into a flare rather than a smear:
  //   sunSide  broad, so the structure follows the glow out to ~65 degrees;
  //   sunCore  pow 70 protects the first ~10 degrees, so the hot core stays a
  //            hot core -- REVIEW fails bloom with no hot core, and a stratum
  //            cutting the middle out of the sun would be exactly that;
  //   the smoothstep in elevation hands the first couple of degrees back to
  //            the band above, so low strata glow and high strata silhouette.
  // Net across the skirt: 0 at the core, -26 at 12-18 degrees, -7 at 65.
  //
  // Its own noise, 16x squashed rather than 26x, so the bars land ~4 degrees
  // apart across the glow instead of the ~2 degrees the horizon field uses --
  // at 26x they read as a fine stripe pattern rather than as weather.
  //
  // The threshold pair is centred on the fbm's MEAN, not set above it. fbm3_3
  // is three octaves of value noise: it is centred near 0.5 with a standard
  // deviation around 0.14, so a smoothstep( 0.42, 0.76 ) only saturates about
  // two sigma out and produced one faint smudge in the whole sun quadrant.
  // Straddling the mean at +/- one sigma is what turns the same field into
  // alternating bars and gaps, which is the thing that reads as structure.
  vec3 hp = V * vec3( 3.0, 16.0, 3.0 );
  hp.y -= uTime * 0.011;
  hp.z += uTime * 0.008;
  float hstrat = smoothstep( 0.36, 0.66, fbm3_3( hp ) );

  float sunSide = pow( max( mu, 0.0 ), 1.4 );
  float sunCore = pow( max( mu, 0.0 ), 70.0 );
  float veil = hstrat * sunSide * ( 1.0 - sunCore )
             * exp( - max( up, 0.0 ) * 0.8 )
             * smoothstep( 0.04, 0.16, up ) * sunUp;
  veil = clamp( veil, 0.0, 0.85 );

  // The dust is backlit, so it is not black: it keeps a fifth of the band
  // colour as its own forward-scattered glow. That is what stops the bars
  // reading as holes punched in the sky.
  sky = sky * ( 1.0 - 0.90 * veil ) + bandCol * 0.20 * veil;

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
  // Keep the deck OUT of the last 25 degrees above the horizon. The projection
  // above divides by (0.85 * up + 0.22), so as a sight line flattens, cp.x and
  // cp.z run away while cp.y barely moves — 8:1 anisotropy by up = 0.25, and
  // along the screen's centre azimuth (where V.x is near zero) cp does not
  // change with up at all. The deck therefore drew as parallel VERTICAL
  // curtains in any near-horizontal framing, which is what the hero pose is.
  // The stratified dust bands above are the correct structure down there:
  // they are squashed 26x in y, so they read as horizontal strata.
  cl *= smoothstep( 0.03, 0.40, up );             // deck converges into the haze
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
