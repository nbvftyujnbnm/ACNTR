/**
 * Shared GLSL chunks for the ACNTR render pipeline.
 *
 * Everything here targets GLSL ES 1.00 (three's default for ShaderMaterial) so
 * it compiles on any WebGL2 context without extension pragmas. That means:
 * no `inverse()`, no `texture()`, no derivatives, constant loop bounds only.
 */

/** Full-screen triangle: `position` is already clip space, so no matrices. */
export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/** Constants, luminance, hashing. */
export const GLSL_COMMON = /* glsl */ `
#define PI  3.141592653589793
#define TAU 6.283185307179586

float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
float maxc( vec3 c ) { return max( c.r, max( c.g, c.b ) ); }
float minc( vec3 c ) { return min( c.r, min( c.g, c.b ) ); }

float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

vec2 hash22( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.xx + p3.yz ) * p3.zy );
}

float hash13( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}
`;

/**
 * Depth helpers. All of these expect a non-linear hardware depth value in [0,1]
 * from a DepthTexture attached to the scene render target.
 */
export const GLSL_DEPTH = /* glsl */ `
// Negative view-space Z (three/OpenGL convention: -Z points into the screen).
float viewZFromDepth( float d, float near, float far ) {
  float z = d * 2.0 - 1.0;
  return - ( 2.0 * near * far ) / ( far + near - z * ( far - near ) );
}

// Positive distance along the view axis.
float linearDepth01( float d, float near, float far ) {
  return - viewZFromDepth( d, near, far ) / far;
}

vec3 viewPosFromDepth( vec2 uv, float d, mat4 invProj ) {
  vec4 clip = vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  vec4 v = invProj * clip;
  return v.xyz / v.w;
}

vec3 worldPosFromDepth( vec2 uv, float d, mat4 invViewProj ) {
  vec4 clip = vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  vec4 w = invViewProj * clip;
  return w.xyz / w.w;
}

/**
 * Derivative-free view normal reconstruction. Picks the closer of the two
 * neighbours on each axis so silhouettes stay sharp instead of smearing a
 * bogus normal across the depth discontinuity.
 */
vec3 normalFromDepth( sampler2D depthTex, vec2 uv, vec2 texel, mat4 invProj ) {
  float c  = texture2D( depthTex, uv ).x;
  vec3  P  = viewPosFromDepth( uv, c, invProj );

  vec2 ul = uv - vec2( texel.x, 0.0 );
  vec2 ur = uv + vec2( texel.x, 0.0 );
  vec2 ud = uv - vec2( 0.0, texel.y );
  vec2 uu = uv + vec2( 0.0, texel.y );

  vec3 L = viewPosFromDepth( ul, texture2D( depthTex, ul ).x, invProj );
  vec3 R = viewPosFromDepth( ur, texture2D( depthTex, ur ).x, invProj );
  vec3 D = viewPosFromDepth( ud, texture2D( depthTex, ud ).x, invProj );
  vec3 U = viewPosFromDepth( uu, texture2D( depthTex, uu ).x, invProj );

  vec3 dx = abs( R.z - P.z ) < abs( P.z - L.z ) ? ( R - P ) : ( P - L );
  vec3 dy = abs( U.z - P.z ) < abs( P.z - D.z ) ? ( U - P ) : ( P - D );

  vec3 n = cross( dx, dy );
  float l = length( n );
  return l > 1e-9 ? n / l : vec3( 0.0, 0.0, 1.0 );
}

// Orthonormal basis around n, rotated by 'ang' so the sample kernel decorrelates.
mat3 basisFromNormal( vec3 n, float ang ) {
  vec3 rv = vec3( cos( ang ), sin( ang ), 0.0 );
  vec3 t = normalize( rv - n * dot( rv, n ) );
  vec3 b = cross( n, t );
  return mat3( t, b, n );
}
`;

/** YCoCg — the colour space TAA neighbourhood clipping wants. */
export const GLSL_YCOCG = /* glsl */ `
vec3 rgbToYCoCg( vec3 c ) {
  return vec3(
     0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
     0.5  * c.r             - 0.5  * c.b,
    -0.25 * c.r + 0.5 * c.g - 0.25 * c.b
  );
}
vec3 ycoCgToRgb( vec3 c ) {
  return vec3( c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z );
}
`;

/** 3D value noise + fbm. Seamless on a sphere, which the sky needs. */
export const GLSL_NOISE3 = /* glsl */ `
float vnoise3( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );

  float n000 = hash13( i );
  float n100 = hash13( i + vec3( 1.0, 0.0, 0.0 ) );
  float n010 = hash13( i + vec3( 0.0, 1.0, 0.0 ) );
  float n110 = hash13( i + vec3( 1.0, 1.0, 0.0 ) );
  float n001 = hash13( i + vec3( 0.0, 0.0, 1.0 ) );
  float n101 = hash13( i + vec3( 1.0, 0.0, 1.0 ) );
  float n011 = hash13( i + vec3( 0.0, 1.0, 1.0 ) );
  float n111 = hash13( i + vec3( 1.0, 1.0, 1.0 ) );

  return mix(
    mix( mix( n000, n100, f.x ), mix( n010, n110, f.x ), f.y ),
    mix( mix( n001, n101, f.x ), mix( n011, n111, f.x ), f.y ),
    f.z );
}

const mat3 NOISE_ROT = mat3(
   0.00,  0.80,  0.60,
  -0.80,  0.36, -0.48,
  -0.60, -0.48,  0.64 );

float fbm3_2( vec3 p ) {
  float f = 0.5000 * vnoise3( p ); p = NOISE_ROT * p * 2.02;
  f += 0.2500 * vnoise3( p );
  return f / 0.75;
}

float fbm3_3( vec3 p ) {
  float f = 0.5000 * vnoise3( p ); p = NOISE_ROT * p * 2.02;
  f += 0.2500 * vnoise3( p );      p = NOISE_ROT * p * 2.03;
  f += 0.1250 * vnoise3( p );
  return f / 0.875;
}

float fbm3_5( vec3 p ) {
  float f = 0.5000 * vnoise3( p ); p = NOISE_ROT * p * 2.02;
  f += 0.2500 * vnoise3( p );      p = NOISE_ROT * p * 2.03;
  f += 0.1250 * vnoise3( p );      p = NOISE_ROT * p * 2.01;
  f += 0.0625 * vnoise3( p );      p = NOISE_ROT * p * 2.04;
  f += 0.03125 * vnoise3( p );
  return f / 0.96875;
}
`;

/**
 * AgX tonemapping, split so the colour grade can happen in display-referred
 * space (between the sigmoid and the inverse EOTF) which is where 3-way
 * lift/gamma/gain actually belongs.
 *
 * `agxDisplay()` returns ~[0,1] display-encoded values; `displayToLinear()`
 * undoes the sRGB EOTF so the renderer's sRGB OETF cancels it exactly.
 */
export const GLSL_TONEMAP = /* glsl */ `
const mat3 AGX_IN = mat3(
  0.8566271533, 0.1373189729, 0.1118982130,
  0.0951212405, 0.7612419906, 0.0767994186,
  0.0482516061, 0.1014390365, 0.8113023684 );

const mat3 AGX_OUT = mat3(
   1.1271005818, -0.1413297635, -0.1413297635,
  -0.1106066431,  1.1578237022, -0.1106066431,
  -0.0164939387, -0.0164939387,  1.2519364066 );

const float AGX_MIN_EV = -12.47393;
const float AGX_MAX_EV =   4.026069;

vec3 agxContrast( vec3 x ) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return + 15.5 * x4 * x2
         - 40.14 * x4 * x
         + 31.96 * x4
         -  6.868 * x2 * x
         +  0.4298 * x2
         +  0.1191 * x
         -  0.00232;
}

// 'look' = vec4( slope, offset, power, saturation )
vec3 agxDisplay( vec3 color, vec4 look ) {
  color = max( color, vec3( 0.0 ) );
  color = AGX_IN * color;
  color = max( color, vec3( 1e-10 ) );
  color = log2( color );
  color = ( color - AGX_MIN_EV ) / ( AGX_MAX_EV - AGX_MIN_EV );
  color = clamp( color, 0.0, 1.0 );
  color = agxContrast( color );

  // AgX "look" pass, applied in the sigmoid's output space.
  color = color * look.x + look.y;
  color = pow( max( color, vec3( 0.0 ) ), vec3( look.z ) );
  float l = luma( color );
  color = clamp( l + look.w * ( color - l ), 0.0, 1.0 );

  color = AGX_OUT * color;
  return clamp( color, 0.0, 1.0 );
}

/**
 * Display-referred -> linear, so that three's `colorspace_fragment` can put it
 * straight back and the pair CANCELS.
 *
 * MEASURED BUG, and it is why the black point was blue-clipped. This used to be
 * pow( disp, 2.2 ), which is NOT the inverse of the sRGB OETF three applies
 * afterwards. The shipped 8-bit output was therefore OETF( disp^2.2 ), a net
 * transfer that is near-identity above display 0.35 and a hard crush below it:
 * a display 0.040 the grade asked for came out at code 3, and a 0.070 at
 * code 10. Everything the grade does in display space -- the black floor most
 * of all -- was being squeezed into the bottom few code values, and because
 * that squeeze is a POWER it expands ratios, so the floor's mild blue weight
 * turned into a blue/red ratio of 221:1 on the hero frame.
 *
 * Using the real EOTF makes the round trip an identity, i.e. the number the
 * grade computes is the number that reaches the screen. Same multiply-add form
 * and same 2.4 exponent as three's own `sRGBTransferEOTF`, so the residual is
 * three's own (its OETF writes 0.41666 rather than 1/2.4) and under 0.03 of a
 * code value.
 *
 * BEWARE when reading any grade measurement from before 2026-09-02: every
 * exchange rate quoted for lift, power and contrast in CONTRACT.md was computed
 * on `disp`, upstream of this, and the crush then ate most of what they claimed
 * at the toe.
 */
vec3 displayToLinear( vec3 displayColor ) {
  vec3 c = clamp( displayColor, vec3( 0.0 ), vec3( 1.0 ) );
  return mix(
    pow( c * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ),
    c * 0.0773993808,
    vec3( lessThanEqual( c, vec3( 0.04045 ) ) ) );
}

/** Linear -> display-referred. The inverse of the above, for the ACES path. */
vec3 linearToDisplay( vec3 linearColor ) {
  vec3 c = clamp( linearColor, vec3( 0.0 ), vec3( 1.0 ) );
  return mix(
    pow( c, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ),
    c * 12.92,
    vec3( lessThanEqual( c, vec3( 0.0031308 ) ) ) );
}

const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777 );
const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602 );

// Kept for the 'low' quality path — cheaper and slightly punchier.
vec3 acesFilmic( vec3 x ) {
  vec3 v = ACES_IN * x;
  vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
  vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
  return clamp( ACES_OUT * ( a / b ), 0.0, 1.0 );
}
`;
