import { GLSL_COMMON, GLSL_TONEMAP } from './lib.js';

/* ---------------------------------------------------------------------------
 * Bloom — Call-of-Duty style progressive mip chain.
 *
 * Prefilter (threshold + Karis firefly average) -> 6 x 13-tap downsample ->
 * 6 x 9-tap tent upsample, accumulated additively. A single mip gaussian gives
 * the flat "UnrealBloomPass" glow; the chain is what produces a tight hot core
 * with a very wide, very soft skirt.
 * ------------------------------------------------------------------------- */

const GLSL_BLOOM_TAPS = /* glsl */ `
vec3 downsample13( sampler2D t, vec2 uv, vec2 texel ) {
  vec3 a = texture2D( t, uv + texel * vec2( -2.0,  2.0 ) ).rgb;
  vec3 b = texture2D( t, uv + texel * vec2(  0.0,  2.0 ) ).rgb;
  vec3 c = texture2D( t, uv + texel * vec2(  2.0,  2.0 ) ).rgb;
  vec3 d = texture2D( t, uv + texel * vec2( -2.0,  0.0 ) ).rgb;
  vec3 e = texture2D( t, uv                             ).rgb;
  vec3 f = texture2D( t, uv + texel * vec2(  2.0,  0.0 ) ).rgb;
  vec3 g = texture2D( t, uv + texel * vec2( -2.0, -2.0 ) ).rgb;
  vec3 h = texture2D( t, uv + texel * vec2(  0.0, -2.0 ) ).rgb;
  vec3 i = texture2D( t, uv + texel * vec2(  2.0, -2.0 ) ).rgb;
  vec3 j = texture2D( t, uv + texel * vec2( -1.0,  1.0 ) ).rgb;
  vec3 k = texture2D( t, uv + texel * vec2(  1.0,  1.0 ) ).rgb;
  vec3 l = texture2D( t, uv + texel * vec2( -1.0, -1.0 ) ).rgb;
  vec3 m = texture2D( t, uv + texel * vec2(  1.0, -1.0 ) ).rgb;

  vec3 r = e * 0.125;
  r += ( a + c + g + i ) * 0.03125;
  r += ( b + d + f + h ) * 0.0625;
  r += ( j + k + l + m ) * 0.125;
  return r;
}

vec3 upsampleTent( sampler2D t, vec2 uv, vec2 texel, float radius ) {
  vec2 o = texel * radius;
  vec3 s;
  s  = texture2D( t, uv + vec2( -o.x,  o.y ) ).rgb;
  s += texture2D( t, uv + vec2(  0.0,  o.y ) ).rgb * 2.0;
  s += texture2D( t, uv + vec2(  o.x,  o.y ) ).rgb;
  s += texture2D( t, uv + vec2( -o.x,  0.0 ) ).rgb * 2.0;
  s += texture2D( t, uv                      ).rgb * 4.0;
  s += texture2D( t, uv + vec2(  o.x,  0.0 ) ).rgb * 2.0;
  s += texture2D( t, uv + vec2( -o.x, -o.y ) ).rgb;
  s += texture2D( t, uv + vec2(  0.0, -o.y ) ).rgb * 2.0;
  s += texture2D( t, uv + vec2(  o.x, -o.y ) ).rgb;
  return s * ( 1.0 / 16.0 );
}
`;

export const BLOOM_PREFILTER_FRAG = /* glsl */ `
${GLSL_COMMON}

uniform sampler2D tSource;
uniform vec2  uSourceTexel;
uniform float uThreshold;
uniform float uKnee;
uniform float uClamp;
varying vec2 vUv;

// Soft-knee highpass: a hard threshold pops as objects cross it, the knee
// ramps contribution in quadratically instead.
vec3 thresholdSoft( vec3 c ) {
  float br = maxc( c );
  float knee = max( uKnee, 1e-4 );
  float soft = clamp( br - uThreshold + knee, 0.0, 2.0 * knee );
  soft = soft * soft / ( 4.0 * knee );
  float contrib = max( soft, br - uThreshold ) / max( br, 1e-4 );
  return c * contrib;
}

// Karis average: weight each quad by 1/(1+luma) before averaging so one
// blown pixel cannot dominate an entire mip and flicker.
vec3 karis( vec3 a, vec3 b, vec3 c, vec3 d ) {
  float wa = 1.0 / ( 1.0 + luma( a ) );
  float wb = 1.0 / ( 1.0 + luma( b ) );
  float wc = 1.0 / ( 1.0 + luma( c ) );
  float wd = 1.0 / ( 1.0 + luma( d ) );
  return ( a * wa + b * wb + c * wc + d * wd ) / ( wa + wb + wc + wd );
}

void main() {
  vec2 t = uSourceTexel;

  vec3 a = texture2D( tSource, vUv + t * vec2( -2.0,  2.0 ) ).rgb;
  vec3 b = texture2D( tSource, vUv + t * vec2(  0.0,  2.0 ) ).rgb;
  vec3 c = texture2D( tSource, vUv + t * vec2(  2.0,  2.0 ) ).rgb;
  vec3 d = texture2D( tSource, vUv + t * vec2( -2.0,  0.0 ) ).rgb;
  vec3 e = texture2D( tSource, vUv                          ).rgb;
  vec3 f = texture2D( tSource, vUv + t * vec2(  2.0,  0.0 ) ).rgb;
  vec3 g = texture2D( tSource, vUv + t * vec2( -2.0, -2.0 ) ).rgb;
  vec3 h = texture2D( tSource, vUv + t * vec2(  0.0, -2.0 ) ).rgb;
  vec3 i = texture2D( tSource, vUv + t * vec2(  2.0, -2.0 ) ).rgb;
  vec3 j = texture2D( tSource, vUv + t * vec2( -1.0,  1.0 ) ).rgb;
  vec3 k = texture2D( tSource, vUv + t * vec2(  1.0,  1.0 ) ).rgb;
  vec3 l = texture2D( tSource, vUv + t * vec2( -1.0, -1.0 ) ).rgb;
  vec3 m = texture2D( tSource, vUv + t * vec2(  1.0, -1.0 ) ).rgb;

  vec3 r  = karis( j, k, l, m ) * 0.5;
  r += karis( a, b, d, e ) * 0.125;
  r += karis( b, c, e, f ) * 0.125;
  r += karis( d, e, g, h ) * 0.125;
  r += karis( e, f, h, i ) * 0.125;

  r = thresholdSoft( r );
  r = min( r, vec3( uClamp ) );

  gl_FragColor = vec4( max( r, vec3( 0.0 ) ), 1.0 );
}
`;

export const BLOOM_DOWN_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_BLOOM_TAPS}

uniform sampler2D tSource;
uniform vec2 uSourceTexel;
varying vec2 vUv;

void main() {
  gl_FragColor = vec4( downsample13( tSource, vUv, uSourceTexel ), 1.0 );
}
`;

export const BLOOM_UP_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_BLOOM_TAPS}

uniform sampler2D tSource;
uniform vec2  uSourceTexel;
uniform float uRadius;
uniform float uWeight;
varying vec2 vUv;

void main() {
  gl_FragColor = vec4( upsampleTent( tSource, vUv, uSourceTexel, uRadius ) * uWeight, 1.0 );
}
`;

/* ---------------------------------------------------------------------------
 * Final pass — the only place tonemapping happens in this engine.
 *
 * CA -> sharpen -> bloom -> exposure -> AgX (or ACES) -> lift/gamma/gain ->
 * contrast/saturation -> split tone -> vignette -> damage rim -> scanlines ->
 * grain -> dither -> sRGB.
 * ------------------------------------------------------------------------- */
export const FINAL_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_TONEMAP}

uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tNoise;

uniform vec2  uTexel;
uniform vec2  uNoiseScale;
uniform float uTime;

uniform float uExposure;
uniform float uBloomStrength;
uniform vec3  uBloomTint;
uniform float uBloomCore;
uniform float uChromatic;
uniform float uSharpen;

uniform float uTonemapMode;      // 0 = AgX, 1 = ACES
uniform vec4  uAgxLook;          // slope, offset, power, saturation

uniform vec3  uLift;
uniform vec3  uGamma;
uniform vec3  uGain;
uniform float uContrast;
uniform float uSaturation;
uniform vec3  uSplitShadow;
uniform vec3  uSplitHighlight;
uniform float uSplitBalance;

uniform float uVignette;
uniform float uVignetteSmooth;
uniform float uDamage;
uniform vec3  uDamageColor;
uniform float uGrain;
uniform float uScanline;
uniform float uScanCount;

varying vec2 vUv;

void main() {
  vec2 uv = vUv;
  vec2 cc = uv - 0.5;
  float r2 = dot( cc, cc );
  float rEdge = clamp( length( cc ) * 1.41421356, 0.0, 1.0 );

  // ---- chromatic aberration (radial, r^2 so the centre stays clean) -------
  vec2 caOff = cc * r2 * 4.0 * uChromatic * uTexel;
  vec3 color;
  color.r = texture2D( tColor, uv + caOff ).r;
  color.g = texture2D( tColor, uv ).g;
  color.b = texture2D( tColor, uv - caOff ).b;

  // ---- unsharp mask: buys back the micro-contrast TAA softens -------------
  //
  // LUMA high-pass, applied as a RATIO. Two reasons, and the first one is a
  // bug fix.
  //
  // (1) The four neighbour taps are read at the UNSHIFTED uv, but 'color' has
  // already been split per channel by the chromatic aberration above. The old
  // per-channel form therefore differenced a shifted red against an unshifted
  // red and added the mismatch back in at uSharpen strength — i.e. the sharpen
  // pass was AMPLIFYING the CA fringe by a further 30%, and putting a hard
  // ring around it, everywhere off the frame centre. Differencing luminance
  // only cannot do that: the high-pass is one scalar, so it cannot invent a
  // colour that was not in the pixel.
  //
  // (2) A ratio preserves hue exactly where an additive high-pass does not. On
  // a saturated pixel the additive form pushes all three channels by the same
  // amount, which desaturates a sharpened highlight and oversaturates a
  // sharpened shadow — visible on the mech as coloured haloes along the plate
  // edges that carry the accent paint.
  //
  // To first order the two are identical, so 'sharpen' keeps its meaning and
  // does not need retuning. The clamp only guards the near-black case, where
  // dividing by luma is unstable.
  if ( uSharpen > 0.001 ) {
    vec3 n = texture2D( tColor, uv + vec2( uTexel.x, 0.0 ) ).rgb
           + texture2D( tColor, uv - vec2( uTexel.x, 0.0 ) ).rgb
           + texture2D( tColor, uv + vec2( 0.0, uTexel.y ) ).rgb
           + texture2D( tColor, uv - vec2( 0.0, uTexel.y ) ).rgb;
    float c0 = luma( color );
    float hp = c0 - luma( n ) * 0.25;
    float k = 1.0 + uSharpen * hp / max( c0, 1e-4 );
    color = max( color * clamp( k, 0.2, 2.0 ), vec3( 0.0 ) );
  }

  // ---- bloom -------------------------------------------------------------
  //
  // Chromatic skirt. A neutral bloom is a lens artefact; the glow around a low
  // sun in a dust column is atmospheric, and long-path scattering is red. So
  // the CORE keeps the source colour and the SKIRT is pulled amber, with the
  // crossover set by how hot the bloom sample is rather than by any radius —
  // which means one uniform does it for the sun, a thruster plume and a muzzle
  // flash alike, and it costs one mix.
  vec3 bl = texture2D( tBloom, uv ).rgb * uBloomStrength;
  float bcore = clamp( maxc( bl ) * uBloomCore, 0.0, 1.0 );
  color += bl * mix( uBloomTint, vec3( 1.0 ), bcore * bcore );

  // ---- exposure + tonemap ------------------------------------------------
  color *= uExposure;

  vec3 disp = uTonemapMode < 0.5
    ? agxDisplay( color, uAgxLook )
    : pow( acesFilmic( color ), vec3( 1.0 / 2.2 ) );

  // ---- 3-way grade, display referred -------------------------------------
  disp = uGain * disp;
  disp = pow( max( disp, vec3( 0.0 ) ), 1.0 / max( uGamma, vec3( 0.01 ) ) );

  // Filmic S-contrast, pivoted at 0.5.
  //
  // This used to be the textbook (x - 0.5) * c + 0.5, which is a straight
  // line: at c = 1.2 EVERY value below 0.083 maps to negative and clamps to
  // pure black. That single line was the biggest contributor to the mech's
  // unlit flank reading as a silhouette — the lift meant to keep the toe open
  // was applied BEFORE it and got clipped away along with the detail. Mixing
  // toward a smoothstep is monotonic, fixes the 0.5 pivot, and cannot leave
  // [0,1] at either end, so shadow separation is compressed rather than
  // destroyed and highlights gain contrast without a new clip point.
  vec3 sc = disp * disp * ( 3.0 - 2.0 * disp );
  disp = mix( disp, sc, clamp( ( uContrast - 1.0 ) * 2.0, -0.9, 0.9 ) );

  // Black floor, applied AFTER the contrast so nothing downstream can crush it.
  // AC6 shadows are deep but never zero; this is the value they bottom out at,
  // and it is blue-weighted so the darkest part of the frame is also its
  // coolest — the other half of the warm-key / cool-shadow split.
  disp = uLift + ( vec3( 1.0 ) - uLift ) * clamp( disp, 0.0, 1.0 );

  float l = luma( disp );
  disp = l + ( disp - l ) * uSaturation;
  disp = clamp( disp, 0.0, 1.0 );

  // ---- split toning: cool shadows, warm highlights ------------------------
  float bal = clamp( uSplitBalance, 0.05, 0.95 );
  float lum = luma( disp );
  disp += uSplitShadow * ( 1.0 - smoothstep( 0.0, bal, lum ) );
  disp += uSplitHighlight * smoothstep( bal, 1.0, lum );
  disp = clamp( disp, 0.0, 1.0 );

  // ---- vignette ----------------------------------------------------------
  disp *= 1.0 - uVignette * smoothstep( clamp( uVignetteSmooth, 0.0, 0.98 ), 1.0, rEdge );

  // ---- damage rim (screen blend so it glows rather than muddies) ----------
  if ( uDamage > 0.001 ) {
    float dv = smoothstep( 0.28, 1.0, rEdge ) * uDamage;
    disp = disp + uDamageColor * dv * ( 1.0 - disp );
  }

  // ---- scanline / interference -------------------------------------------
  if ( uScanline > 0.0005 ) {
    float sl = 0.5 + 0.5 * sin( uv.y * uScanCount * PI );
    float interference = 0.5 + 0.5 * sin( ( uv.y + uTime * 0.55 ) * 140.0 );
    disp *= 1.0 - uScanline * sl * ( 0.55 + 0.45 * interference );
  }

  // ---- grain (heavier in the shadows, like real film) ---------------------
  vec2 gv = uv * uNoiseScale + vec2( fract( uTime * 13.0 ), fract( uTime * 7.7 ) );
  float grain = texture2D( tNoise, gv ).r - 0.5;
  disp += grain * uGrain * ( 0.30 + 0.70 * ( 1.0 - lum ) );

  // ---- ordered dither before 8-bit quantisation --------------------------
  disp += ( hash12( gl_FragCoord.xy + fract( uTime ) * 137.0 ) - 0.5 ) * ( 1.0 / 255.0 );

  gl_FragColor = vec4( agxToLinear( clamp( disp, 0.0, 1.0 ) ), 1.0 );

  #include <colorspace_fragment>
}
`;
