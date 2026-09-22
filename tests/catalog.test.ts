import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applyMetadataPatch, resolveModelMetadata, validateCatalog, validateMetadata } from '../src/index';
import type { CatalogDocument, ModelMetadata, ResolveModelMetadataInput, ResolvedModelMetadata } from '../schema/catalog';
import { build, stableJson } from '../scripts/build';
import fixtures from '../fixtures/resolution.json';
const empty = (): CatalogDocument => ({ schemaVersion: 1, catalogVersion: 'test', publishedAt: '2026-09-22T00:00:00Z', models: [], variants: [] });

describe('cross-language resolver fixtures', () => {
  for (const fixture of fixtures) test(fixture.name, () => {
    const input = structuredClone(fixture.input) as ResolveModelMetadataInput;
    const before = structuredClone(input);
    if ('expectedError' in fixture) expect(() => resolveModelMetadata(input)).toThrow(fixture.expectedError);
    else {
      expect(resolveModelMetadata(input)).toEqual(fixture.expected as ResolvedModelMetadata);
      input.catalog.models.reverse();
      input.catalog.variants.reverse();
      if (input.local?.overrides) input.local.overrides.reverse();
      expect(resolveModelMetadata(input)).toEqual(fixture.expected as ResolvedModelMetadata);
      input.catalog.models.reverse(); input.catalog.variants.reverse();
      if (input.local?.overrides) input.local.overrides.reverse();
    }
    expect(input).toEqual(before);
  });
});

describe('validation and explicit patch semantics', () => {
  test('bounds text and matcher list resources before resolution', () => {
    expect(() => validateMetadata({ reasoning: { levels: ['x'.repeat(1_048_577)] } })).toThrow();
    expect(() => validateCatalog({ ...empty(), models: [{ id: 'bounded', metadata: {}, matches: { aliases: Array.from({ length: 1001 }, (_, i) => `alias-${i}`) } }] })).toThrow();
  });
  test('preserves falsy leaves and returns detached value', () => {
    const input: ModelMetadata = { nativeSearch: { supported: false }, modalities: { input: [], output: null }, limits: { contextWindow: null }, referencePricing: { input: '0' } };
    const validated = validateMetadata(input);
    expect(validated).toEqual(input);
    validated.referencePricing!.input = '1';
    expect(input.referencePricing!.input).toBe('0');
  });
  test.each([0,-1,1.1,Infinity,NaN,Number.MAX_SAFE_INTEGER + 1])('rejects illegal token count %s', contextWindow => expect(() => validateMetadata({ limits: { contextWindow } })).toThrow());
  test.each(['01','0.0','1.00','-1','+1','1e3',' 1','1.','NaN','',1])('rejects noncanonical decimal %s', input => expect(() => validateMetadata({ referencePricing: { input } })).toThrow());
  test('optional undefined is omission, explicit undefined patch is invalid', () => {
    expect(validateMetadata({ limits: { contextWindow: undefined }, reasoning: undefined })).toEqual({ limits: {} });
    expect(resolveModelMetadata({ catalog: empty(), query: { upstreamModelId: 'a', providerKey: undefined }, local: undefined, defaults: { nativeSearch: { supported: undefined } } }).provenance).toEqual({});
    expect(() => applyMetadataPatch({}, { set: { 'nativeSearch.supported': undefined } })).toThrow('Undefined patch value');
    expect(() => validateMetadata({ modalities: { input: [undefined] } })).toThrow();
  });
  test('catalog checks merged variant invariants before activation', () => {
    const catalog = empty(); catalog.models = [{ id: 'a', metadata: { limits: { contextWindow: 1000, maxOutputTokens: 100 } } }];
    catalog.variants = [{ id: 'v', modelId: 'a', providerKey: 'p', upstreamModelIds: ['a'], metadata: { limits: { contextWindow: 50 } } }];
    expect(() => validateCatalog(catalog)).toThrow('maxOutputTokens exceeds contextWindow');
  });
  test('rejects foreign/local policy and unsafe keys', () => {
    expect(() => validateMetadata({ protocol: 'responses' })).toThrow('Unknown field');
    expect(() => validateMetadata({ nativeSearch: null })).toThrow();
    expect(() => validateMetadata(JSON.parse('{"__proto__":{}}'))).toThrow('Forbidden key');
    expect(() => applyMetadataPatch({}, { set: { '__proto__.polluted': true } })).toThrow('Invalid metadata leaf');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  test('set/reset changes only leaves and removes empty containers', () => {
    const original: ModelMetadata = { limits: { contextWindow: 100 }, referencePricing: { input: '1', output: '2' } };
    expect(applyMetadataPatch(original, { set: { 'referencePricing.input': '0', 'nativeSearch.supported': false }, reset: ['limits.contextWindow'] })).toEqual({ referencePricing: { input: '0', output: '2' }, nativeSearch: { supported: false } });
    expect(original).toEqual({ limits: { contextWindow: 100 }, referencePricing: { input: '1', output: '2' } });
    expect(applyMetadataPatch(original, {})).toEqual(original);
    expect(applyMetadataPatch(original, { reset: ['modalities.input'] })).toEqual(original);
  });
  test('reset really restores inherited field', () => {
    const catalog = empty(); catalog.models = [{ id: 'a', metadata: { referencePricing: { input: '4' } } }];
    const local = { revision: 1, overrides: [{ target: 'model' as const, targetId: 'a', metadata: { referencePricing: { input: '0' } } }] };
    expect(resolveModelMetadata({ catalog, query: { upstreamModelId: 'a' }, local }).metadata.referencePricing?.input).toBe('0');
    local.overrides[0]!.metadata = applyMetadataPatch(local.overrides[0]!.metadata, { reset: ['referencePricing.input'] }) as typeof local.overrides[0]['metadata'];
    expect(resolveModelMetadata({ catalog, query: { upstreamModelId: 'a' }, local }).metadata.referencePricing?.input).toBe('4');
  });
  test('rejects object-level patches, conflicts and invalid cross-leaf state', () => {
    expect(() => applyMetadataPatch({}, { set: { limits: {} } })).toThrow();
    expect(() => applyMetadataPatch({}, { set: { 'referencePricing.input': '0' }, reset: ['referencePricing.input'] })).toThrow('Conflicting set/reset');
    expect(() => applyMetadataPatch({ limits: { contextWindow: 100 } }, { set: { 'limits.maxOutputTokens': 101 } })).toThrow('maxOutputTokens exceeds');
    expect(() => validateMetadata({ reasoning: { levels: ['low'], defaultLevel: 'high' } })).toThrow();
    expect(() => validateMetadata({ reasoning: { levels: ['none'] } })).toThrow();
    expect(() => validateMetadata({ reasoning: { supported: false, levels: ['low'] } })).toThrow();
  });
  test('rejects unsupported schema, duplicates, missing parents and unverified verified entries', () => {
    expect(() => validateCatalog({ ...empty(), schemaVersion: 2 })).toThrow();
    expect(() => validateCatalog({ ...empty(), models: [{ id: 'a', metadata: {} }, { id: 'a', metadata: {} }] })).toThrow('Duplicate id');
    expect(() => validateCatalog({ ...empty(), variants: [{ id: 'v', modelId: 'a', providerKey: 'p', upstreamModelIds: ['a'], metadata: {} }] })).toThrow('Unknown model');
    expect(() => validateCatalog({ ...empty(), models: [{ id: 'a', metadata: {}, status: 'verified' }] })).toThrow('Verified entry lacks');
  });
  test('scope separates the same upstream identity', () => {
    const catalog = empty(); catalog.models = [{ id: 'a', metadata: {} }];
    catalog.variants = ['p','q'].map(providerKey => ({ id: providerKey, modelId: 'a', providerKey, upstreamModelIds: ['wire'], metadata: { limits: { contextWindow: providerKey === 'p' ? 100 : 200 } } }));
    expect(resolveModelMetadata({ catalog, query: { upstreamModelId: 'wire', providerKey: 'q' } }).metadata.limits?.contextWindow).toBe(200);
    expect(resolveModelMetadata({ catalog, query: { upstreamModelId: 'wire' } }).matchedVia).toBe('none');
  });
  test('most-specific binding wins without leaking across scope', () => {
    const catalog = empty(); catalog.models = [{ id: 'a', metadata: {} }];
    const local = { revision: 1, bindings: [{ id: 'generic', upstreamModelId: 'a', modelId: 'a' }, { id: 'scoped', upstreamModelId: 'a', providerId: 'p', channelId: 'c', modelId: 'a' }] };
    expect(resolveModelMetadata({ catalog, query: { upstreamModelId: 'a', providerId: 'p', channelId: 'c' }, local }).bindingId).toBe('scoped');
    expect(resolveModelMetadata({ catalog, query: { upstreamModelId: 'a', providerId: 'other', channelId: 'c' }, local }).bindingId).toBe('generic');
  });
  test('unknown explicit identities reject rather than silently guess', () => expect(() => resolveModelMetadata({ catalog: empty(), query: { upstreamModelId: 'a', modelId: 'missing' } })).toThrow('Unknown model'));
  test('legacy override provenance is explicit', () => {
    const catalog = empty(); catalog.models = [{ id: 'a', status: 'legacy-unverified', metadata: { limits: { contextWindow: 100 } } }];
    const resolved = resolveModelMetadata({ catalog, query: { upstreamModelId: 'a' }, local: { revision: 2, overrides: [{ target: 'model', targetId: 'a', source: 'legacy-local', metadata: { nativeSearch: { supported: null } } }] } });
    expect(resolved.provenance['limits.contextWindow']).toEqual({ layer: 'preset-model', id: 'a', catalogVersion: 'test', legacy: true });
    expect(resolved.provenance['nativeSearch.supported']).toEqual({ layer: 'local-model', id: 'a', explicit: true, legacy: true });
  });
});

describe('published data and deterministic artifacts', () => {
  test('build is byte-for-byte deterministic, manifest verifies exact bytes', () => {
    const first = build(); const second = build();
    expect(first).toEqual(second);
    expect(first.manifest.sha256).toBe(createHash('sha256').update(first.bytes).digest('hex'));
    expect(first.manifest.bytes).toBe(Buffer.byteLength(first.bytes));
    expect(first.bytes).toBe(readFileSync(new URL('../dist/catalog.json', import.meta.url), 'utf8'));
    expect(stableJson(first.manifest)).toBe(readFileSync(new URL('../dist/manifest.json', import.meta.url), 'utf8'));
  });
  test('initial imports are unverified and contain no instance policy', () => {
    const { catalog } = build();
    expect(catalog.models.length).toBe(80); expect(catalog.variants.length).toBe(67);
    for (const entry of [...catalog.models, ...catalog.variants]) {
      expect(entry.status).toBe('legacy-unverified');
      expect(entry.sources?.every(s => s.verifiedAt === undefined)).toBe(true);
      expect(entry.metadata.modalities).toBeUndefined();
      expect(entry.metadata.nativeSearch).toBeUndefined();
    }
    const bytes = JSON.stringify(catalog);
    for (const forbidden of ['"default_discount"','"priority_multiplier"','"provision_channels"','"protocol"','"created_at"','"updated_at"','"apiKey"','"baseURL"']) expect(bytes.includes(forbidden)).toBe(false);
  });
  test('NUG zero defaults do not create free reference prices', () => {
    const { catalog } = build();
    const blank = resolveModelMetadata({ catalog, query: { upstreamModelId: 'auto-smart', providerKey: 'cursor' } });
    expect(blank.metadata.referencePricing).toBeUndefined();
    const knownFree = resolveModelMetadata({ catalog, query: { upstreamModelId: 'gpt-5.5' } });
    expect(knownFree.metadata.referencePricing?.cacheWrite).toBe('0');
  });
  test('new exact legacy identities preserve declared old capability compatibility', () => {
    const { catalog } = build();
    const model = resolveModelMetadata({ catalog, query: { upstreamModelId: 'claude-opus-4-6-thinking', providerKey: 'antigravity' } });
    expect(model.metadata.limits?.contextWindow).toBe(1000000);
    expect(model.matchedVia).toBe('exact');
    expect(model.metadata.reasoning?.supported).toBeUndefined();
    expect(catalog.models.find(m => m.id === 'claude-opus-4-6-thinking')?.sources?.some(s => s.fields?.includes('limits.contextWindow'))).toBe(true);
  });
  test('legacy context disagreement survives as a channel variant', () => {
    const { catalog } = build();
    expect(resolveModelMetadata({ catalog, query: { upstreamModelId: 'gpt-5.6-sol' } }).metadata.limits?.contextWindow).toBe(372000);
    const channel = resolveModelMetadata({ catalog, query: { upstreamModelId: 'gpt-5.6-sol', providerKey: 'codex' } });
    expect(channel.metadata.limits?.contextWindow).toBe(1000000);
    expect(channel.metadata.referencePricing?.longContext?.thresholdTokens).toBe(272000);
    expect(channel.metadata.referencePricing?.longContext?.input).toBe('10');
  });
});
