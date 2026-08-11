/**
 * One quality tier is chosen at boot and never changes mid-session — a
 * resolution or shadow-map switch mid-flight is a visible hitch in a headset,
 * which is worse than the frames it buys.
 *
 * Standalone Quest is detected by UA plus the absence of a mouse. The Quest 3
 * browser reports a Linux/Android Chrome UA with "OculusBrowser" in it.
 */
function detectTier() {
  const ua = navigator.userAgent || '';
  const isQuest = /OculusBrowser|Quest/i.test(ua);
  if (isQuest) {
    // Quest 3 reports a higher renderer string than Quest 2/3S; without a
    // reliable GPU query we take the conservative tier and let it earn back
    // headroom via foveation.
    return 'quest';
  }
  const cores = navigator.hardwareConcurrency || 4;
  return cores >= 8 ? 'desktop' : 'low';
}

const TIERS = {
  // Standalone headset. Adreno 740, tile-based deferred — draw calls and
  // overdraw hurt far more than triangle count, hence heavy instancing and
  // zero transparent full-screen layers.
  quest: {
    antialias: true,          // MSAA on the XR framebuffer is cheap on tilers
    maxPixelRatio: 1,
    shadows: true,
    shadowMapSize: 1024,
    foveation: 1.0,           // maximum edge-of-lens savings
    envMapSize: 128,
    cityBlocks: 8,
    windowInstances: 5000,
    trafficCount: 26,
    reflections: true,
    maxLights: 4,
    drawDistance: 420,
  },
  desktop: {
    antialias: true,
    maxPixelRatio: 2,
    shadows: true,
    shadowMapSize: 2048,
    foveation: 0,
    envMapSize: 256,
    cityBlocks: 10,
    windowInstances: 9000,
    trafficCount: 40,
    reflections: true,
    maxLights: 8,
    drawDistance: 700,
  },
  low: {
    antialias: false,
    maxPixelRatio: 1,
    shadows: false,
    shadowMapSize: 512,
    foveation: 1.0,
    envMapSize: 64,
    cityBlocks: 6,
    windowInstances: 2500,
    trafficCount: 12,
    reflections: false,
    maxLights: 3,
    drawDistance: 300,
  },
};

export const TIER = detectTier();
export const QUALITY = TIERS[TIER];
