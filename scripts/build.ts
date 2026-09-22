import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { CatalogDocument, CatalogManifest, ModelDefinition, ModelVariant } from '../schema/catalog';
import { validateCatalog } from '../src/index';
import config from '../catalog.config.json';
export function stableJson(value: unknown): string {
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value), null, 2) + '\n';
}
export function loadCatalog(): CatalogDocument {
  const readRows = <T>(dir: string): T[] => readdirSync(new URL(`../${dir}/`, import.meta.url)).filter(name => name.endsWith('.json')).sort().flatMap(name => JSON.parse(readFileSync(new URL(`../${dir}/${name}`, import.meta.url), 'utf8')));
  const compare = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return validateCatalog({ ...config, models: readRows<ModelDefinition>('models').sort(compare), variants: readRows<ModelVariant>('variants').sort(compare) });
}
export function build(): { catalog: CatalogDocument; manifest: CatalogManifest; bytes: string } {
  const catalog = loadCatalog();
  const bytes = stableJson(catalog);
  const manifest: CatalogManifest = { schemaVersion: 1, catalogVersion: catalog.catalogVersion, publishedAt: catalog.publishedAt, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes), artifact: 'catalog.json' };
  return { catalog, manifest, bytes };
}
if (import.meta.main) {
  const result = build();
  const dir = new URL('../dist/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('catalog.json', dir), result.bytes);
  writeFileSync(new URL('manifest.json', dir), stableJson(result.manifest));
  writeFileSync(new URL('sha256sum.txt', dir), `${result.manifest.sha256}  catalog.json\n`);
  console.log(`${result.catalog.models.length} models, ${result.catalog.variants.length} variants; sha256 ${result.manifest.sha256}`);
}
