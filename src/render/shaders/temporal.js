import { GLSL_COMMON, GLSL_DEPTH, GLSL_YCOCG } from './lib.js';

/* ---------------------------------------------------------------------------
 * TAA — velocity reprojection + YCoCg neighbourhood clipping.
 *
 * The jitter lives on the projection matrix (Halton 2,3), so this pass is also
 * where the free supersampling comes from: it is what stops specular highlights
 * on metal edges from sparkling, which is the single loudest "cheap engine"
 * tell in a mech game.
 * ------------------------------------------------------------------------- */
export const TAA_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_YCOCG}

uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tVelocity;
uniform sampler2D tDepth;
uniform vec2  uTexel;
uniform float uBlend;
uniform float uClampGamma;
uniform float uReset;
varying vec2 vUv;

vec3 clipAABB( vec3 lo, vec3 hi, vec3 anchor, vec3 q ) {
  vec3 center = 0.5 * ( hi + lo );
  vec3 extent = 0.5 * ( hi - lo ) + 1e-5;
  vec3 v = q - center;
  vec3 uvw = v / extent;
  float ma = max( abs( uvw.x ), max( abs( uvw.y ), abs( uvw.z ) ) );
  return ma > 1.0 ? center + v / ma : q;
}

void main() {
  vec3 cur = texture2D( tCurrent, vUv ).rgb;

  if ( uReset > 0.5 ) {
    gl_FragColor = vec4( cur, 1.0 );
    return;
  }

  // Dilate the velocity toward the closest surface in a 3x3 neighbourhood so
  // silhouettes fetch the history that actually belongs to them.
  vec2 bestOffset = vec2( 0.0 );
  float bestDepth = 2.0;
  for ( int y = -1; y <= 1; y ++ ) {
    for ( int x = -1; x <= 1; x ++ ) {
      vec2 o = vec2( float( x ), float( y ) ) * uTexel;
      float dd = texture2D( tDepth, vUv + o ).x;
      if ( dd < bestDepth ) { bestDepth = dd; bestOffset = o; }
    }
  }

  vec2 vel = texture2D( tVelocity, vUv + bestOffset ).rg;
  vec2 prevUv = vUv - vel;

  if ( prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0 ) {
    gl_FragColor = vec4( cur, 1.0 );
    return;
  }

  // Variance clipping in YCoCg — clipping the chroma axes separately is what
  // stops coloured ghost trails behind fast movers.
  vec3 m1 = vec3( 0.0 );
  vec3 m2 = vec3( 0.0 );
  vec3 nmin = vec3( 1e6 );
  vec3 nmax = vec3( -1e6 );
  for ( int y = -1; y <= 1; y ++ ) {
    for ( int x = -1; x <= 1; x ++ ) {
      vec3 c = rgbToYCoCg( texture2D( tCurrent, vUv + vec2( float( x ), float( y ) ) * uTexel ).rgb );
      m1 += c;
      m2 += c * c;
      nmin = min( nmin, c );
      nmax = max( nmax, c );
    }
  }
  vec3 mu = m1 / 9.0;
  vec3 sigma = sqrt( max( m2 / 9.0 - mu * mu, vec3( 0.0 ) ) );
  vec3 lo = max( mu - uClampGamma * sigma, nmin );
  vec3 hi = min( mu + uClampGamma * sigma, nmax );

  vec3 curY = rgbToYCoCg( cur );
  vec3 histY = rgbToYCoCg( texture2D( tHistory, prevUv ).rgb );
  histY = clipAABB( lo, hi, curY, histY );
  vec3 hist = max( ycoCgToRgb( histY ), vec3( 0.0 ) );

  // Drop feedback under fast motion: reprojection error grows with velocity and
  // long trails are worse than a little aliasing.
  float velPx = length( vel / uTexel );
  float blend = uBlend * ( 1.0 - clamp( velPx / 60.0, 0.0, 0.4 ) );

  // Luma-weighted (tonemapped) average so a single HDR firefly cannot dominate
  // the accumulation and strobe.
  float wc = ( 1.0 - blend ) / ( 1.0 + luma( cur ) );
  float wh = blend / ( 1.0 + luma( hist ) );
  vec3 outc = ( cur * wc + hist * wh ) / max( wc + wh, 1e-5 );

  gl_FragColor = vec4( outc, 1.0 );
}
`;

/* ---------------------------------------------------------------------------
 * Velocity tile reduction: two 4x4 max passes give a 16x16 tile map, then a
 * 3x3 neighbour max. Motion blur uses it to bound its sampling radius and to
 * skip work entirely on still tiles, which is the guard against the whole
 * screen smearing when the frame time spikes.
 * ------------------------------------------------------------------------- */
export const TILEMAX_FRAG = /* glsl */ `
uniform sampler2D tVelocity;
uniform vec2 uSourceTexel;
varying vec2 vUv;

void main() {
  vec2 best = vec2( 0.0 );
  float bestLen = -1.0;
  for ( int y = 0; y < 4; y ++ ) {
    for ( int x = 0; x < 4; x ++ ) {
      vec2 o = ( vec2( float( x ), float( y ) ) - 1.5 ) * uSourceTexel;
      vec2 v = texture2D( tVelocity, vUv + o ).rg;
      float l = dot( v, v );
      if ( l > bestLen ) { bestLen = l; best = v; }
    }
  }
  gl_FragColor = vec4( best, 0.0, 1.0 );
}
`;

export const NEIGHBORMAX_FRAG = /* glsl */ `
uniform sampler2D tVelocity;
uniform vec2 uSourceTexel;
varying vec2 vUv;

void main() {
  vec2 best = vec2( 0.0 );
  float bestLen = -1.0;
  for ( int y = -1; y <= 1; y ++ ) {
    for ( int x = -1; x <= 1; x ++ ) {
      vec2 v = texture2D( tVelocity, vUv + vec2( float( x ), float( y ) ) * uSourceTexel ).rg;
      float l = dot( v, v );
      if ( l > bestLen ) { bestLen = l; best = v; }
    }
  }
  gl_FragColor = vec4( best, 0.0, 1.0 );
}
`;

/* ---------------------------------------------------------------------------
 * Motion blur — velocity driven, jittered taps, hard pixel clamp.
 * Also carries the radial "speed line" term used during assault boost.
 * ------------------------------------------------------------------------- */
export const MOTION_BLUR_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_DEPTH}

uniform sampler2D tColor;
uniform sampler2D tVelocity;
uniform sampler2D tNeighborMax;
uniform sampler2D tDepth;
uniform sampler2D tNoise;
uniform vec2  uTexel;
uniform vec2  uNoiseScale;
uniform vec2  uRadialCenter;
uniform float uShutter;
uniform float uMaxPx;
uniform float uRadial;
uniform float uNear;
uniform float uFar;
uniform float uFrame;
varying vec2 vUv;

void main() {
  vec3 color = texture2D( tColor, vUv ).rgb;

  vec2 vel = texture2D( tVelocity, vUv ).rg * uShutter;
  vec2 radial = ( vUv - uRadialCenter ) * uRadial;
  vel += radial;

  float lenPx = length( vel / uTexel );
  if ( lenPx > uMaxPx ) vel *= uMaxPx / lenPx;

  // Tile bound: if nothing in this 16x16 neighbourhood is moving, bail out.
  vec2 tileVel = texture2D( tNeighborMax, vUv ).rg * uShutter;
  float tilePx = length( tileVel / uTexel ) + length( radial / uTexel );
  if ( tilePx < 1.0 ) {
    gl_FragColor = vec4( color, 1.0 );
    return;
  }

  float centerZ = - viewZFromDepth( texture2D( tDepth, vUv ).x, uNear, uFar );

  float bn = texture2D( tNoise, vUv * uNoiseScale ).r;
  float jit = fract( bn + uFrame * 0.6180339887 ) - 0.5;

  vec3 sum = color;
  float wsum = 1.0;

  for ( int i = 1; i <= MB_SAMPLES; i ++ ) {
    float t = ( float( i ) + jit ) / float( MB_SAMPLES ) * 0.5;

    vec2 ua = vUv + vel * t;
    vec2 ub = vUv - vel * t;

    float za = - viewZFromDepth( texture2D( tDepth, ua ).x, uNear, uFar );
    float zb = - viewZFromDepth( texture2D( tDepth, ub ).x, uNear, uFar );

    // Soft depth guard: a tap from a very different depth is probably a
    // different object, so it should not smear across the silhouette.
    float wa = max( exp( - abs( za - centerZ ) * 0.05 ), 0.12 );
    float wb = max( exp( - abs( zb - centerZ ) * 0.05 ), 0.12 );

    sum += texture2D( tColor, ua ).rgb * wa;
    sum += texture2D( tColor, ub ).rgb * wb;
    wsum += wa + wb;
  }

  gl_FragColor = vec4( sum / wsum, 1.0 );
}
`;

/* ---------------------------------------------------------------------------
 * Depth of field — single-pass golden-angle gather with an optional hexagonal
 * aperture. Deliberately restrained: AC6 keeps gameplay DOF to a light far
 * defocus and only goes shallow in cinematics.
 * ------------------------------------------------------------------------- */
export const DOF_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_DEPTH}

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNoise;
uniform vec2  uTexel;
uniform vec2  uNoiseScale;
uniform float uFocus;
uniform float uFarScale;
uniform float uNearScale;
uniform float uMaxRadius;
uniform float uHex;
uniform float uNear;
uniform float uFar;
uniform float uFrame;
varying vec2 vUv;

float cocFromZ( float z ) {
  float c = ( z - uFocus ) / max( z, 0.05 );
  c = c < 0.0 ? c * uNearScale : c * uFarScale;
  return clamp( c, -1.0, 1.0 );
}

void main() {
  vec3 color = texture2D( tColor, vUv ).rgb;

  float cz = - viewZFromDepth( texture2D( tDepth, vUv ).x, uNear, uFar );
  float centerCoc = cocFromZ( cz );
  float radius = abs( centerCoc ) * uMaxRadius;

  if ( radius < 0.6 ) {
    gl_FragColor = vec4( color, 1.0 );
    return;
  }

  float bn = texture2D( tNoise, vUv * uNoiseScale ).r;
  float ang0 = fract( bn + uFrame * 0.6180339887 ) * TAU;

  vec3 sum = color;
  float wsum = 1.0;

  for ( int i = 1; i <= DOF_TAPS; i ++ ) {
    float fi = float( i );
    float rr = sqrt( fi / float( DOF_TAPS ) );
    float a = ang0 + fi * 2.39996323;

    // Circle -> hexagon remap. A hex aperture is what gives mechanical bokeh
    // instead of the soft round blobs a gaussian blur produces.
    float hexR = 0.8660254 / max( cos( mod( a + PI / 6.0, PI / 3.0 ) - PI / 6.0 ), 0.1 );
    float shape = mix( 1.0, hexR, uHex );

    vec2 o = vec2( cos( a ), sin( a ) ) * rr * shape;
    vec2 suv = vUv + o * radius * uTexel;

    float sz = - viewZFromDepth( texture2D( tDepth, suv ).x, uNear, uFar );
    float sr = abs( cocFromZ( sz ) ) * uMaxRadius;

    // A tap only contributes if its own circle of confusion reaches this pixel.
    float dist = length( o ) * radius;
    float w = clamp( ( sr - dist ) * 0.5 + 0.6, 0.0, 1.0 );

    sum += texture2D( tColor, suv ).rgb * w;
    wsum += w;
  }

  gl_FragColor = vec4( sum / wsum, 1.0 );
}
`;
