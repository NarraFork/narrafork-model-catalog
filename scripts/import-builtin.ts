import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { ModelDefinition, ModelMetadata } from '../schema/catalog';
import { validateCatalog } from '../src/index';
// Reads only a user-selected, version-controlled builtin module; never instance settings or databases.
const path = process.argv[2];
if (!path) throw new Error('Usage: bun scripts/import-builtin.ts /absolute/path/to/builtin.ts');
const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
const { BUILTIN_MODEL_CARDS: cards } = await import(pathToFileURL(path).href);
const models: ModelDefinition[] = cards.map((card: Record<string, any>) => {
  const metadata: ModelMetadata = {};
  if (card.contextWindow > 0 || card.maxCompletionTokens > 0) metadata.limits = {
    ...(card.contextWindow > 0 ? { contextWindow: card.contextWindow } : {}),
    ...(card.maxCompletionTokens > 0 ? { maxOutputTokens: card.maxCompletionTokens } : {}),
  };
  if (card.effortLevels?.length) metadata.reasoning = { levels: [...card.effortLevels] };
  if (card.officialPricing) metadata.referencePricing = {
    currency: 'USD', unit: 'perMillionTokens',
    ...Object.fromEntries(Object.entries(card.officialPricing).filter(([, v]) => v !== undefined).map(([key, v]) => [key, String(v)])),
  };
  return {
    id: card.modelKey,
    ...(card.displayName ? { name: card.displayName } : {}),
    ...(card.family ? { family: card.family } : {}),
    ...(card.notes ? { notes: card.notes } : {}),
    matches: { ...(card.aliases?.length ? { aliases: card.aliases } : {}), ...(card.matchPrefixes?.length ? { prefixes: card.matchPrefixes } : {}), volatileSuffixes: true },
    metadata, status: 'legacy-unverified',
    sources: [{ label: `NarraFork server/lib/model-cards/builtin.ts sha256:${hash}; legacy values, not independently verified` }],
  };
});
models.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
validateCatalog({ schemaVersion: 1, catalogVersion: 'validation', publishedAt: '2026-09-22T00:00:00Z', models, variants: [] });
writeFileSync(new URL('../models/narrafork-builtin.json', import.meta.url), JSON.stringify(models, null, 2) + '\n');
console.log(`Imported ${models.length} legacy-unverified models; source sha256 ${hash}`);
