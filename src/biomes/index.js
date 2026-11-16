// Biome selection. The world is chosen once at startup (?world=meadow|plains);
// the switcher in the corner reloads the page with the other world, which keeps
// every system free of teardown logic.

import { MEADOW } from './meadow.js';
import { PLAINS } from './plains/index.js';

export const BIOMES = { meadow: MEADOW, plains: PLAINS };
const want = new URLSearchParams( location.search ).get( 'world' );
export const BIOME = BIOMES[ want ] || PLAINS;
