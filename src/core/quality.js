/**
 * Resolved build-time quality flags.
 *
 * World construction reads this rather than the Settings store directly, so
 * there is exactly one snapshot of "what are we building" and it cannot shift
 * halfway through a build. `resolve()` must run before the Engine or any world
 * system is constructed.
 */
export const QUALITY = {
  antialias: true,
  renderScale: 1,
  shadows: true,
  shadowMapSize: 1024,
  foveation: 1,
  envMapSize: 128,
  drawDistance: 440,
  fogDensity: 0.0052,
  exposure: 0.95,
  glowIntensity: 1,
  cityBlocks: 8,
  propDensity: 0.7,
  trafficCount: 26,
  rain: true,
  rainDensity: 0.7,
  skylineRings: 2,
};

export function resolveQuality(settings) {
  const v = settings.values;
  Object.assign(QUALITY, {
    antialias: v.msaa,
    renderScale: v.renderScale,
    shadows: v.shadows,
    shadowMapSize: v.shadowMapSize,
    foveation: v.foveation,
    envMapSize: v.envMapSize,
    drawDistance: v.drawDistance,
    fogDensity: v.fogDensity,
    exposure: v.exposure,
    glowIntensity: v.glowIntensity,
    cityBlocks: v.cityBlocks,
    propDensity: v.propDensity,
    trafficCount: v.trafficCount,
    rain: v.rain,
    rainDensity: v.rainDensity,
    skylineRings: v.skylineRings,
  });
  // Record what the world is actually built with, so the settings panel can
  // tell which pending edits genuinely need a reload.
  settings.builtWith = { ...v };
  return QUALITY;
}
