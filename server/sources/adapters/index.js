// Adapter catalogue. To add a source type, write an adapter module (see docs/ADAPTERS.md) and add it
// here. Nothing in the randomness core needs to change.

import { createCameraAdapter } from './camera.js';
import { validateAdapter } from '../adapter.js';

export function defaultAdapters({ ffmpegPath } = {}) {
  return buildCatalogue([createCameraAdapter({ ffmpegPath })]);
}

export function buildCatalogue(list) {
  const out = {};
  for (const def of list) {
    validateAdapter(def);
    if (out[def.type]) throw new Error(`duplicate adapter type "${def.type}"`);
    out[def.type] = def;
  }
  return out;
}
