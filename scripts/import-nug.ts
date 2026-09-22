import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { MetadataSource, ModelDefinition, ModelMetadata, ModelVariant, ReferencePrices } from '../schema/catalog';
import { resolveModelMetadata, validateCatalog } from '../src/index';
import builtin from '../models/narrafork-builtin.json';
const [rowsPath, baselinePath] = process.argv.slice(2);
if (!rowsPath || !baselinePath) throw new Error('Usage: bun scripts/import-nug.ts /isolated-empty-db/model-cards.json /isolated-empty-db/baseline.json');
const bytes = readFileSync(rowsPath);
const rows = JSON.parse(bytes.toString());
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const hash = createHash('sha256').update(bytes).digest('hex');
const definitions: ModelDefinition[] = [];
const variants: ModelVariant[] = [];
const notes: Array<Record<string, unknown>> = [];
const priceKeys = { input: 'input_usd', output: 'output_usd', cacheRead: 'cache_read_usd', cacheWrite: 'cache_creation_usd' };
function prices(row: Record<string, unknown>, prefix = ''): ReferencePrices {
  // Legacy SQL zero means unfilled/fallback, not an assertion of free tokens.
  return Object.fromEntries(Object.entries(priceKeys).filter(([, key]) => Number(row[`${prefix}${key}`]) > 0).map(([key, column]) => [key, String(row[`${prefix}${column}`])]));
}
for (const row of rows) {
  if (row.builtin !== true) throw new Error(`Non-builtin row in empty-database export: ${row.model_key}`);
  const metadata: ModelMetadata = {};
  if (row.context_window > 0) metadata.limits = { contextWindow: row.context_window };
  if (row.effort_levels.length) metadata.reasoning = { levels: row.effort_levels };
  const basePrices = prices(row);
  if (Object.keys(basePrices).length || row.long_context_threshold_tokens > 0) {
    metadata.referencePricing = { currency: 'USD', unit: 'perMillionTokens', ...basePrices };
    if (row.long_context_threshold_tokens > 0) metadata.referencePricing.longContext = {
      thresholdTokens: row.long_context_threshold_tokens, basis: 'promptTokens', mode: row.long_context_mode,
      ...prices(row, 'long_context_'),
    };
  }
  const matches = { ...(row.aliases.length ? { aliases: row.aliases } : {}), ...(row.match_prefixes.length ? { prefixes: row.match_prefixes } : {}) };
  const sources: MetadataSource[] = [{ label: `NUG isolated empty-database migrations ${baseline.commit}; export sha256:${hash}; legacy defaults, not independently verified` }];
  const existing = builtin.find(m => m.id === row.model_key);
  if (!existing) {
    const compatible = resolveModelMetadata({ catalog: { schemaVersion: 1, catalogVersion: 'legacy-extraction', publishedAt: '2026-09-22T00:00:00Z', models: builtin as ModelDefinition[], variants: [] }, query: { upstreamModelId: row.model_key } });
    const inherited: string[] = [];
    for (const group of ['limits', 'reasoning'] as const) {
      const known = compatible.metadata[group];
      if (!known) continue;
      const target = (metadata[group] ??= {}) as Record<string, unknown>;
      for (const [leaf, value] of Object.entries(known)) if (!(leaf in target)) { target[leaf] = value; inherited.push(`${group}.${leaf}`); }
    }
    if (inherited.length) {
      sources.push({ label: `NarraFork builtin declared ${compatible.matchedVia} compatibility from ${compatible.modelId}; legacy behavior materialized, not a vendor specification`, fields: inherited });
      notes.push({ modelId: row.model_key, disposition: 'Materialize known NarraFork legacy compatibility leaves before adding a more specific NUG identity', inheritedFrom: compatible.modelId, fields: inherited });
    }
  }
  if (!existing) definitions.push({ id: row.model_key, name: row.display_name || row.model_key, ...(row.family ? { family: row.family } : {}), matches, metadata, status: 'legacy-unverified', sources });
  // Public channel type only: this is not a provision/enable policy or an instance channel ID.
  for (const providerKey of row.provision_channels) variants.push({
    id: `${row.model_key}@${providerKey}`, modelId: row.model_key, providerKey,
    upstreamModelIds: [row.model_key], name: row.display_name || row.model_key,
    matches, metadata, status: 'legacy-unverified', sources,
  });
  if (existing && JSON.stringify(existing.metadata) !== JSON.stringify(metadata)) notes.push({ modelId: row.model_key, disposition: 'Keep NarraFork base; retain NUG facts on declared public channel variants', variantIds: row.provision_channels.map((p: string) => `${row.model_key}@${p}`) });
  if (existing && !row.provision_channels.length && Object.keys(metadata).length) throw new Error(`Unscoped overlapping metadata requires explicit review: ${row.model_key}`);
}
const sort = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
definitions.sort(sort); variants.sort(sort);
validateCatalog({ schemaVersion: 1, catalogVersion: 'validation', publishedAt: '2026-09-22T00:00:00Z', models: [...builtin as ModelDefinition[], ...definitions], variants });
writeFileSync(new URL('../models/nug-baseline.json', import.meta.url), JSON.stringify(definitions, null, 2) + '\n');
writeFileSync(new URL('../variants/nug-baseline.json', import.meta.url), JSON.stringify(variants, null, 2) + '\n');
writeFileSync(new URL('../fixtures/migration-audit.json', import.meta.url), JSON.stringify({
  source: 'isolated-empty-database', sourceCommit: baseline.commit, exportSha256: hash,
  inputRows: rows.length, newModels: definitions.length, publicVariants: variants.length,
  excludedFields: ['default_discount','priority_multiplier','effort_schema_path','protocol','provision_channels','created_at','updated_at','builtin'],
  zeroSemantics: 'NUG default numeric zero is omitted (unknown/fallback); NarraFork explicitly priced zero remains the string 0. No date is a vendor verification date.',
  channelSemantics: 'Variant providerKey records a public legacy channel type; it grants no permission to provision, enable, route, or bill a model.',
  conflicts: notes,
}, null, 2) + '\n');
console.log(`Imported ${rows.length} empty-database rows -> ${definitions.length} additional models and ${variants.length} public channel variants`);
