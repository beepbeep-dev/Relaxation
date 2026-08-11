/** Deterministic RNG so the city is identical on every boot and every device. */
export function makeRNG(seed = 1337) {
  let s = seed >>> 0;
  return function rand() {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export const pick = (rand, arr) => arr[(rand() * arr.length) | 0];
export const range = (rand, a, b) => a + rand() * (b - a);
