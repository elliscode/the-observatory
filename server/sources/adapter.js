// Observation-source adapter contract. See docs/ADAPTERS.md.
//
// An adapter definition is a plain object:
//   {
//     type: 'camera',                       // unique, lowercase
//     displayName: 'Optical Measurement Subsystem',
//     description: '...',
//     measurementKind: 'measurement',       // every v1 adapter reports ordinary measurements
//     entropyAssessment: 'none',            // no adapter claims an entropy assessment
//     configSchema: { field: { type: 'string'|'integer'|'boolean', default, min, max, maxLength, label, secret } },
//     create(source, ctx) -> { start(), stop(), captureNow?(), getStatus?() }
//   }
//
// ctx (provided by the registry):
//   report(observation)  observation = { observedAt, kind, values, image?: { tmpFile, width, height },
//                                        analysis?, processingMs?, intervalMs? }
//   reportError(err)
//   tmpPath(ext)         a temp file path inside the source's data directory
//   log
//   now()                the registry's clock (use it for observedAt)
//
// Adapters acquire data and report it. The registry owns lifecycle, health, persistence, events and
// the hand-off to the conditioning boundary.

export class SourceConfigError extends Error {}

const REQUIRED = ['type', 'displayName', 'measurementKind', 'entropyAssessment', 'configSchema', 'create'];

export function validateAdapter(def) {
  for (const k of REQUIRED) if (def?.[k] === undefined) throw new Error(`adapter is missing "${k}"`);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(def.type)) throw new Error(`adapter type "${def.type}" is invalid`);
  if (typeof def.create !== 'function') throw new Error(`adapter "${def.type}" create must be a function`);
  if (def.measurementKind !== 'measurement') throw new Error(`adapter "${def.type}" must declare measurementKind "measurement"`);
  return def;
}

// Applies defaults and validates. `base` lets partial updates keep existing values.
export function applyConfigSchema(schema, input = {}, base = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new SourceConfigError('config must be an object');
  for (const k of Object.keys(input)) if (!schema[k]) throw new SourceConfigError(`unknown config field "${k}"`);
  const out = {};
  for (const [k, f] of Object.entries(schema)) {
    let v = input[k] !== undefined ? input[k] : base[k] !== undefined ? base[k] : f.default;
    if (v === undefined || v === null || v === '') {
      if (f.required) throw new SourceConfigError(`"${k}" is required`);
      if (f.default === undefined) continue;
      v = f.default;
    }
    if (f.type === 'integer') {
      if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) v = Number(v);
      if (!Number.isInteger(v)) throw new SourceConfigError(`"${k}" must be an integer`);
      if (f.min !== undefined && v < f.min) throw new SourceConfigError(`"${k}" must be at least ${f.min}`);
      if (f.max !== undefined && v > f.max) throw new SourceConfigError(`"${k}" must be at most ${f.max}`);
    } else if (f.type === 'boolean') {
      if (v === 'true') v = true;
      if (v === 'false') v = false;
      if (typeof v !== 'boolean') throw new SourceConfigError(`"${k}" must be true or false`);
    } else {
      if (typeof v === 'number') v = String(v);
      if (typeof v !== 'string') throw new SourceConfigError(`"${k}" must be a string`);
      v = v.trim();
      if (v.length > (f.maxLength ?? 200)) throw new SourceConfigError(`"${k}" is too long`);
      if (f.pattern && v && !f.pattern.test(v)) throw new SourceConfigError(`"${k}" has an invalid format`);
    }
    out[k] = v;
  }
  return out;
}

// Config safe for public display: fields marked `secret` are omitted.
export function publicConfig(schema, cfg) {
  const out = {};
  for (const [k, v] of Object.entries(cfg)) if (schema[k] && !schema[k].secret) out[k] = v;
  return out;
}

export function describeAdapter(def) {
  const schema = {};
  for (const [k, f] of Object.entries(def.configSchema)) {
    schema[k] = { type: f.type, default: f.default, min: f.min, max: f.max, label: f.label || k, help: f.help || '', secret: !!f.secret };
  }
  return {
    type: def.type,
    displayName: def.displayName,
    description: def.description || '',
    measurementKind: def.measurementKind,
    entropyAssessment: def.entropyAssessment,
    configSchema: schema,
  };
}
