import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { build } from './build';
import { resolveModelMetadata } from '../src/index';
import type { ResolveModelMetadataInput } from '../schema/catalog';
import fixtures from '../fixtures/resolution.json';
const result = build();
for (const f of fixtures) {
  if ('expectedError' in f) {
    let message: string | undefined;
    try { resolveModelMetadata(f.input as ResolveModelMetadataInput); } catch (e) { message = (e as Error).message; }
    if (message !== f.expectedError) throw new Error(`Fixture ${f.name}: expected ${f.expectedError}, got ${message}`);
  } else {
    const actual = resolveModelMetadata(f.input as ResolveModelMetadataInput);
    if (!isDeepStrictEqual(actual, f.expected)) throw new Error(`Fixture mismatch: ${f.name}`);
  }
}
for (const entry of [...result.catalog.models, ...result.catalog.variants]) {
  if (entry.status !== 'legacy-unverified') throw new Error(`Initial import unexpectedly verified: ${entry.id}`);
  if (entry.sources?.some(s => s.verifiedAt)) throw new Error(`Initial import must not invent verification dates: ${entry.id}`);
}
// Generated artifacts and fixture/schema generators must be reproducible.
const generated = ['schema/catalog.schema.json', 'fixtures/resolution.json'];
const before = generated.map(p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
await import('./schema');
await import('./fixtures');
for (const [i, p] of generated.entries()) if (readFileSync(new URL(`../${p}`, import.meta.url), 'utf8') !== before[i]) throw new Error(`Generated file drift: ${p}; regenerate and review`);
console.log(`Validated ${result.catalog.models.length} models, ${result.catalog.variants.length} variants, ${fixtures.length} resolution fixtures`);
