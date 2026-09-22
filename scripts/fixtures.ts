import { writeFileSync } from 'node:fs';
import type { CatalogDocument, FieldSource, ModelMetadata, ResolveModelMetadataInput, ResolvedModelMetadata } from '../schema/catalog';
// Expected values are specified independently, never produced by the implementation under test.
const catalog: CatalogDocument = {
  schemaVersion: 1, catalogVersion: 'fixture-v1', publishedAt: '2026-09-22T00:00:00Z',
  models: [
    { id: 'synthetic', matches: { aliases: ['alias'], prefixes: ['synthetic-'], volatileSuffixes: true }, metadata: { limits: { contextWindow: 1000, maxOutputTokens: 100 }, modalities: { input: ['text','image'], output: ['text'] }, nativeSearch: { supported: true }, reasoning: { levels: ['low','high'], defaultLevel: 'low' }, referencePricing: { currency: 'USD', unit: 'perMillionTokens', input: '2', output: '5', cacheRead: '0.2' } } },
    { id: 'synthetic-mini', matches: { prefixes: ['synthetic-mini-'] }, metadata: { limits: { contextWindow: 200 } } },
  ],
  variants: [{ id: 'synthetic@edge', modelId: 'synthetic', providerKey: 'edge', upstreamModelIds: ['wire:model'], matches: { aliases: ['alias'], prefixes: ['synthetic-'] }, metadata: { limits: { contextWindow: 800 }, referencePricing: { input: '1' } } }],
};
const base = catalog.models[0]!.metadata;
const preset = (id = 'synthetic', variant = false): FieldSource => ({ layer: variant ? 'preset-variant' : 'preset-model', id, catalogVersion: catalog.catalogVersion });
const sourceLeaves = (value: object, source: FieldSource, prefix = ''): Record<string, FieldSource> => Object.fromEntries(Object.entries(value).flatMap(([k,v]): [string,FieldSource][] => {
  const path = prefix ? `${prefix}.${k}` : k;
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.entries(sourceLeaves(v, source, path)) : [[path, source]];
}));
const result = (metadata: ModelMetadata, extra: Partial<ResolvedModelMetadata> = {}, provenance = sourceLeaves(metadata, preset())): ResolvedModelMetadata => ({ schemaVersion: 1, catalogVersion: catalog.catalogVersion, localRevision: 0, modelId: 'synthetic', matchedVia: 'exact', metadata, provenance, ...extra });
const input = (id: string, extra: Partial<ResolveModelMetadataInput> = {}): ResolveModelMetadataInput => ({ catalog: structuredClone(catalog), query: { upstreamModelId: id }, ...extra });
const fixtures: Array<{ name: string; input: ResolveModelMetadataInput; expected?: ResolvedModelMetadata; expectedError?: string }> = [];
const add = (name: string, i: ResolveModelMetadataInput, expected: ResolvedModelMetadata) => fixtures.push({ name, input: i, expected });
const error = (name: string, i: ResolveModelMetadataInput, expectedError: string) => fixtures.push({ name, input: i, expectedError });
add('exact-base', input('synthetic'), result(base));
add('exact-alias', input('alias'), result(base, { matchedVia: 'alias' }));
add('continuous-declared-date-suffix', input('synthetic-2026-09-20-20260921-latest'), result(base, { matchedVia: 'suffix' }));
add('six-digit-declared-date-suffix', input('synthetic-260921'), result(base, { matchedVia: 'suffix' }));
const variantMetadata = { ...base, limits: { ...base.limits, contextWindow: 800 }, referencePricing: { ...base.referencePricing, input: '1' } };
const variantProvenance = { ...sourceLeaves(base, preset()), 'limits.contextWindow': preset('synthetic@edge', true), 'referencePricing.input': preset('synthetic@edge', true) };
add('scope-and-opaque-colon', input('wire:model', { query: { upstreamModelId: 'wire:model', providerKey: 'edge' } }), result(variantMetadata, { variantId: 'synthetic@edge' }, variantProvenance));
add('scope-prioritizes-variant-alias', input('alias', { query: { upstreamModelId: 'alias', providerKey: 'edge' } }), result(variantMetadata, { variantId: 'synthetic@edge', matchedVia: 'alias' }, variantProvenance));
const unknown = (metadata: ModelMetadata = {}, provenance: Record<string, FieldSource> = {}): ResolvedModelMetadata => ({ schemaVersion: 1, catalogVersion: catalog.catalogVersion, localRevision: 0, matchedVia: 'none', metadata, provenance });
add('colon-not-stripped', input('provider:synthetic'), unknown());
add('wrong-scope-does-not-select-variant', input('wire:model', { query: { upstreamModelId: 'wire:model', providerKey: 'other' } }), unknown());
const noPricing = structuredClone(base); delete noPricing.referencePricing;
add('prefix-does-not-borrow-price', input('synthetic-thinking'), result(noPricing, { matchedVia: 'prefix' }));
add('longest-prefix-no-unrelated-fallback', input('synthetic-mini-fast'), result({ limits: { contextWindow: 200 } }, { modelId: 'synthetic-mini', matchedVia: 'prefix' }, { 'limits.contextWindow': preset('synthetic-mini') }));
const notSemantic = input('synthetic-thinking'); delete notSemantic.catalog.models[0]!.matches!.prefixes;
add('semantic-suffix-is-not-stripped', notSemantic, unknown());
const noDateRule = input('synthetic-20260921'); noDateRule.catalog.models[0]!.matches = {};
add('dates-require-opt-in', noDateRule, unknown());
const invalidDate = input('synthetic-20269999'); delete invalidDate.catalog.models[0]!.matches!.prefixes;
add('invalid-month-not-date', invalidDate, unknown());
const allowPrice = input('synthetic-fast'); allowPrice.catalog.models[0]!.matches!.fields = ['limits', 'referencePricing.input'];
add('explicit-prefix-field-price-permission', allowPrice, result({ limits: base.limits, referencePricing: { input: '2' } }, { matchedVia: 'prefix' }));
add('explicit-identity-beats-weak-rules', input('unrelated', { query: { upstreamModelId: 'unrelated', modelId: 'synthetic' } }), result(base));
add('explicit-variant-identity', input('unrelated', { query: { upstreamModelId: 'unrelated', variantId: 'synthetic@edge', providerKey: 'edge' } }), result(variantMetadata, { variantId: 'synthetic@edge' }, variantProvenance));
error('explicit-variant-wrong-scope', input('wire:model', { query: { upstreamModelId: 'wire:model', variantId: 'synthetic@edge', providerKey: 'other' } }), 'Variant provider scope mismatch');
const overridden: ModelMetadata = { ...base, limits: { contextWindow: 700, maxOutputTokens: null }, nativeSearch: { supported: false }, modalities: { input: [], output: null }, reasoning: { levels: [], defaultLevel: null }, referencePricing: { ...base.referencePricing, input: '0', output: null } };
const patch: ModelMetadata = { limits: { contextWindow: 700, maxOutputTokens: null }, nativeSearch: { supported: false }, modalities: { input: [], output: null }, reasoning: { levels: [], defaultLevel: null }, referencePricing: { input: '0', output: null } };
add('explicit-false-empty-null-zero', input('synthetic', { local: { revision: 8, overrides: [{ target: 'model', targetId: 'synthetic', metadata: patch }] } }), result(overridden, { localRevision: 8 }, { ...sourceLeaves(base, preset()), ...sourceLeaves(patch, { layer: 'local-model', id: 'synthetic', explicit: true }) }));
const precedence = input('wire:model', { query: { upstreamModelId: 'wire:model', providerKey: 'edge', providerId: 'connection' }, defaults: { limits: { contextWindow: 1500 } }, discovered: { limits: { contextWindow: 900 } }, local: { revision: 4, bindings: [{ id: 'binding', providerId: 'connection', upstreamModelId: 'wire:model', variantId: 'synthetic@edge', overrides: { limits: { contextWindow: 400 } } }], overrides: [{ target: 'model', targetId: 'synthetic', metadata: { limits: { contextWindow: 600 } } }, { target: 'variant', targetId: 'synthetic@edge', metadata: { limits: { contextWindow: 500 } } }, { target: 'binding', targetId: 'binding', metadata: { limits: { contextWindow: 300 } } }] } });
add('complete-layer-precedence', precedence, result({ ...variantMetadata, limits: { contextWindow: 300, maxOutputTokens: 100 } }, { localRevision: 4, variantId: 'synthetic@edge', bindingId: 'binding', matchedVia: 'binding' }, { ...variantProvenance, 'limits.contextWindow': { layer: 'local-binding', id: 'binding', explicit: true } }));
add('base-override-applies-to-variant', input('wire:model', { query: { upstreamModelId: 'wire:model', providerKey: 'edge' }, local: { revision: 1, overrides: [{ target: 'model', targetId: 'synthetic', metadata: { referencePricing: { input: '0' } } }] } }), result({ ...variantMetadata, referencePricing: { ...variantMetadata.referencePricing, input: '0' } }, { localRevision: 1, variantId: 'synthetic@edge' }, { ...variantProvenance, 'referencePricing.input': { layer: 'local-model', id: 'synthetic', explicit: true } }));
add('discovery-beats-preset', input('synthetic', { discovered: { nativeSearch: { supported: false } } }), result({ ...base, nativeSearch: { supported: false } }, {}, { ...sourceLeaves(base, preset()), 'nativeSearch.supported': { layer: 'discovered' } }));
add('unknown-preserves-defaults', input('unknown', { defaults: { limits: { contextWindow: 128 } } }), unknown({ limits: { contextWindow: 128 } }, { 'limits.contextWindow': { layer: 'default' } }));
const hidden = input('synthetic', { local: { revision: 1, hiddenModelIds: ['synthetic'] } });
add('hidden-preset', hidden, { ...unknown(), localRevision: 1 });
add('restore-is-empty-tombstones', input('synthetic', { local: { revision: 2, hiddenModelIds: [] } }), result(base, { localRevision: 2 }));
const exactOverAlias = input('alias'); exactOverAlias.catalog.models.push({ id: 'alias', metadata: { nativeSearch: { supported: false } } });
add('exact-id-beats-alias', exactOverAlias, result({ nativeSearch: { supported: false } }, { modelId: 'alias' }, { 'nativeSearch.supported': preset('alias') }));
const duplicateAlias = input('alias'); duplicateAlias.catalog.models.push({ id: 'second', matches: { aliases: ['alias'] }, metadata: {} });
error('duplicate-alias-rejected', duplicateAlias, 'Ambiguous alias alias in scope ');
const duplicatePrefix = input('synthetic-fast'); duplicatePrefix.catalog.models.push({ id: 'second', matches: { prefixes: ['synthetic-'] }, metadata: {} });
error('duplicate-prefix-rejected', duplicatePrefix, 'Ambiguous prefix synthetic- in scope ');
error('binding-conflict-rejected', input('synthetic', { local: { revision: 1, bindings: [{ id: 'a', upstreamModelId: 'synthetic' }, { id: 'b', upstreamModelId: 'synthetic' }] } }), 'Ambiguous binding');
error('merged-limits-revalidated', input('synthetic', { discovered: { limits: { contextWindow: 50 } } }), 'maxOutputTokens exceeds contextWindow');
error('merged-default-level-revalidated', input('synthetic', { discovered: { reasoning: { levels: ['high'] } } }), 'defaultLevel is not in levels');
const suffixConflict = input('synthetic-preview-20260921'); suffixConflict.catalog.models.push({ id: 'synthetic-preview', matches: { volatileSuffixes: true }, metadata: {} });
error('same-priority-suffix-conflict', suffixConflict, 'Ambiguous suffix match for synthetic-preview-20260921');
const longContext: ModelMetadata = { referencePricing: { currency: 'USD', unit: 'perMillionTokens', input: '0', longContext: { thresholdTokens: 500, basis: 'promptTokens', mode: 'marginal', input: '1.25', output: null, cacheRead: '0' } } };
const tiered = input('tiered'); tiered.catalog.models.push({ id: 'tiered', metadata: longContext });
add('long-context-pricing-not-flattened', tiered, result(longContext, { modelId: 'tiered' }, sourceLeaves(longContext, preset('tiered'))));
add('local-name-only-keeps-preset-leaves', input('synthetic', { local: { revision: 3, models: [{ id: 'synthetic', name: 'Renamed', metadata: {} }] } }), result(base, { localRevision: 3 }));
add('local-variant-name-only-keeps-preset-leaves', input('wire:model', { query: { upstreamModelId: 'wire:model', providerKey: 'edge' }, local: { revision: 3, variants: [{ id: 'synthetic@edge', modelId: 'synthetic', providerKey: 'edge', upstreamModelIds: ['wire:model'], name: 'Renamed', metadata: {} }] } }), result(variantMetadata, { localRevision: 3, variantId: 'synthetic@edge' }, variantProvenance));
add('hidden-explicit-identity-is-unknown', input('synthetic', { query: { upstreamModelId: 'synthetic', modelId: 'synthetic' }, local: { revision: 1, hiddenModelIds: ['synthetic'] } }), { ...unknown(), localRevision: 1 });
add('hidden-binding-keeps-binding-override', input('wire:model', { query: { upstreamModelId: 'wire:model', providerKey: 'edge' }, local: { revision: 2, hiddenVariantIds: ['synthetic@edge'], bindings: [{ id: 'binding', upstreamModelId: 'wire:model', variantId: 'synthetic@edge', overrides: { nativeSearch: { supported: false } } }] } }), { ...unknown({ nativeSearch: { supported: false } }, { 'nativeSearch.supported': { layer: 'local-binding', id: 'binding', explicit: true } }), localRevision: 2, bindingId: 'binding', matchedVia: 'binding' });
add('prefix-does-not-borrow-local-model-prices', input('synthetic-thinking', { local: { revision: 2, overrides: [{ target: 'model', targetId: 'synthetic', metadata: { referencePricing: { input: '0' } } }] } }), result(noPricing, { localRevision: 2, matchedVia: 'prefix' }));
add('binding-price-is-explicit-not-prefix-borrowing', input('synthetic-thinking', { local: { revision: 2, bindings: [{ id: 'explicit-price', upstreamModelId: 'synthetic-thinking', overrides: { referencePricing: { input: '0' } } }] } }), result({ ...noPricing, referencePricing: { input: '0' } }, { localRevision: 2, bindingId: 'explicit-price', matchedVia: 'binding' }, { ...sourceLeaves(noPricing, preset()), 'referencePricing.input': { layer: 'local-binding', id: 'explicit-price', explicit: true } }));
add('hidden-stronger-prefix-does-not-resurrect-via-base-prefix', input('synthetic-mini-fast', { local: { revision: 1, hiddenModelIds: ['synthetic-mini'] } }), { ...unknown(), localRevision: 1 });
add('hidden-scoped-variant-does-not-resurrect-via-global-alias', input('alias', { query: { upstreamModelId: 'alias', providerKey: 'edge' }, local: { revision: 1, hiddenVariantIds: ['synthetic@edge'] } }), { ...unknown(), localRevision: 1 });
add('specific-binding-dominates-ambiguous-weaker-bindings', input('synthetic', { query: { upstreamModelId: 'synthetic', providerId: 'p', channelId: 'c' }, local: { revision: 1, bindings: [{ id: 'a', upstreamModelId: 'synthetic', providerId: 'p' }, { id: 'b', upstreamModelId: 'synthetic', channelId: 'c' }, { id: 'c', upstreamModelId: 'synthetic', providerId: 'p', channelId: 'c' }] } }), result(base, { localRevision: 1, matchedVia: 'binding', bindingId: 'c' }));
writeFileSync(new URL('../fixtures/resolution.json', import.meta.url), JSON.stringify(fixtures, null, 2) + '\n');
console.log(`Wrote ${fixtures.length} independently specified resolver fixtures`);
