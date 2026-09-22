import { writeFileSync } from 'node:fs';
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const str = { type: 'string', minLength: 1, maxLength: 1_048_576 };
const strings = { type: 'array', items: str, uniqueItems: true, maxItems: 1000 };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) });
const nullable = (s: unknown) => ({ anyOf: [s, { type: 'null' }] });
const positive = nullable({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const boolean = nullable({ type: 'boolean' });
const price = nullable({ type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]*[1-9])?$' });
const prices = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(k => [k, price]));
const enumeration = (...values: unknown[]) => ({ enum: values });
const timestamp = { type: 'string', format: 'date-time' };
const defs: Record<string, unknown> = {
  Modality: enumeration('text','image','audio','video'),
  ReferencePrices: object(prices),
  ModelMetadata: object({
    limits: object({ contextWindow: positive, maxOutputTokens: positive }),
    modalities: object({ input: nullable({ type: 'array', items: enumeration('text','image','audio','video'), uniqueItems: true }), output: nullable({ type: 'array', items: enumeration('text','image','audio','video'), uniqueItems: true }) }),
    nativeSearch: object({ supported: boolean }),
    reasoning: object({ supported: boolean, mode: nullable(enumeration('levels','fixed','budget','unknown')), levels: nullable(strings), canDisable: boolean, defaultLevel: nullable(str) }),
    referencePricing: object({ ...prices, currency: enumeration('USD'), unit: enumeration('perMillionTokens'), longContext: object({ ...prices, thresholdTokens: positive, basis: enumeration('promptTokens'), mode: nullable(enumeration('full','marginal')) }) }),
  }),
  MetadataSource: object({ label: str, url: { type: 'string', format: 'uri' }, fields: strings, verifiedAt: timestamp }, ['label']),
  MatchRules: object({ ids: strings, aliases: strings, prefixes: strings, volatileSuffixes: { type: 'boolean' }, fields: strings }),
  ModelDefinition: object({ id: str, name: str, vendor: str, family: str, notes: str, matches: ref('MatchRules'), metadata: ref('ModelMetadata'), status: enumeration('verified','legacy-unverified','deprecated'), sources: { type: 'array', items: ref('MetadataSource') } }, ['id','metadata']),
  ModelVariant: object({ id: str, modelId: str, providerKey: str, upstreamModelIds: strings, name: str, matches: ref('MatchRules'), metadata: ref('ModelMetadata'), status: enumeration('verified','legacy-unverified','deprecated'), sources: { type: 'array', items: ref('MetadataSource') } }, ['id','modelId','providerKey','upstreamModelIds','metadata']),
  CatalogDocument: object({ schemaVersion: enumeration(1), catalogVersion: str, publishedAt: timestamp, models: { type: 'array', items: ref('ModelDefinition') }, variants: { type: 'array', items: ref('ModelVariant') } }, ['schemaVersion','catalogVersion','publishedAt','models','variants']),
  CatalogManifest: object({ schemaVersion: enumeration(1), catalogVersion: str, publishedAt: timestamp, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, bytes: { type: 'integer', minimum: 1 }, artifact: enumeration('catalog.json') }, ['schemaVersion','catalogVersion','publishedAt','sha256','bytes','artifact']),
  ModelBinding: object({ id: str, providerId: str, channelId: str, upstreamModelId: str, modelId: str, variantId: str, overrides: ref('ModelMetadata') }, ['id','upstreamModelId']),
  ModelOverride: object({ target: enumeration('model','variant','binding'), targetId: str, metadata: ref('ModelMetadata'), source: enumeration('user','legacy-local') }, ['target','targetId','metadata']),
  LocalCatalogState: object({ revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, models: { type: 'array', items: ref('ModelDefinition') }, variants: { type: 'array', items: ref('ModelVariant') }, bindings: { type: 'array', items: ref('ModelBinding') }, overrides: { type: 'array', items: ref('ModelOverride') }, hiddenModelIds: strings, hiddenVariantIds: strings }, ['revision']),
  ModelQuery: object({ upstreamModelId: str, providerKey: str, providerId: str, channelId: str, modelId: str, variantId: str }, ['upstreamModelId']),
  FieldSource: object({ layer: enumeration('default','preset-model','preset-variant','discovered','local-model','local-variant','local-binding'), id: str, catalogVersion: str, explicit: { type: 'boolean' }, legacy: { type: 'boolean' } }, ['layer']),
  ResolvedModelMetadata: object({ schemaVersion: enumeration(1), catalogVersion: str, localRevision: { type: 'integer', minimum: 0 }, modelId: str, variantId: str, bindingId: str, matchedVia: enumeration('binding','exact','alias','suffix','prefix','none'), metadata: ref('ModelMetadata'), provenance: { type: 'object', additionalProperties: ref('FieldSource') } }, ['schemaVersion','catalogVersion','localRevision','matchedVia','metadata','provenance']),
  ResolveModelMetadataInput: object({ catalog: ref('CatalogDocument'), query: ref('ModelQuery'), local: ref('LocalCatalogState'), discovered: ref('ModelMetadata'), defaults: ref('ModelMetadata') }, ['catalog','query']),
  MetadataPatch: object({ set: { type: 'object', additionalProperties: true }, reset: strings }),
  CatalogUpdateStatus: object({ activeVersion: str, bundledVersion: str, lastCheckedAt: timestamp, pendingVersion: str, lastError: str, autoApply: { type: 'boolean' }, pinnedVersion: nullable(str), history: { type: 'array', items: object({ catalogVersion: str, publishedAt: timestamp }, ['catalogVersion','publishedAt']) }, protectedFieldCount: { type: 'integer', minimum: 0 }, pendingDiff: object({ added: strings, changed: strings, removed: strings, fields: { type: 'array', items: object({ target: enumeration('model','variant'), id: str, path: str, before: {}, after: {} }, ['target','id','path']) } }, ['added','changed','removed']) }, ['activeVersion','bundledVersion','autoApply','pinnedVersion','history']),
  ModelCatalogSnapshot: object({ catalog: ref('CatalogDocument'), local: ref('LocalCatalogState'), update: ref('CatalogUpdateStatus') }, ['catalog','local','update']),
  ModelCatalogMutation: { anyOf: [
    ...(['model','variant','binding'] as const).map(kind => object({ baseRevision: { type: 'integer', minimum: 0 }, action: enumeration(`upsert-${kind}`), [kind]: ref(kind === 'model' ? 'ModelDefinition' : kind === 'variant' ? 'ModelVariant' : 'ModelBinding') }, ['baseRevision','action',kind])),
    object({ baseRevision: { type: 'integer', minimum: 0 }, action: enumeration('patch'), target: enumeration('model','variant','binding'), targetId: str, patch: ref('MetadataPatch') }, ['baseRevision','action','target','targetId','patch']),
    object({ baseRevision: { type: 'integer', minimum: 0 }, action: enumeration('hide','restore','delete'), target: enumeration('model','variant','binding'), targetId: str }, ['baseRevision','action','target','targetId']),
  ] },
  ModelCatalogResolveRequest: object({ query: ref('ModelQuery') }, ['query']),
  ModelCatalogResolveResponse: ref('ResolvedModelMetadata'),
};
const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://narrafork.github.io/narrafork-model-catalog/schema/catalog.schema.json', $comment: 'v1: missing leaf inherits; null is explicit unknown; false, [] and canonical decimal string 0 are real values. Arrays replace. Objects merge by leaf. Priority: binding local > variant local > model local > discovered > preset variant > preset model > adapter defaults. Identity: explicit binding/query, then scope, exact, alias, declared suffix, longest prefix; ties reject. Weak fields filters apply to inherited model/variant layers; prefix prices require explicit referencePricing field permission. Runtime validation additionally checks references, conflicts, merged maxOutputTokens/contextWindow and reasoning default membership. No actual billing or instance connection configuration belongs in this document.', $ref: '#/$defs/CatalogDocument', $defs: defs };
writeFileSync(new URL('../schema/catalog.schema.json', import.meta.url), JSON.stringify(schema, null, 2) + '\n');
