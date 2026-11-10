#!/usr/bin/env node
// Read-only audit. Downloads only the public specification; never calls restaurant operations.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCatalog, extractEmbeddedCatalog, OPENAPI_URL } from './update-api-catalog.mjs';
const input = process.argv[2];
const text = input ? await readFile(input, 'utf8') : await (async () => {
  const response = await fetch(OPENAPI_URL, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`OpenAPI HTTP ${response.status}`);
  return response.text();
})();
const spec = JSON.parse(text);
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const embedded = extractEmbeddedCatalog(html);
const regenerated = createCatalog(spec, { sourceText: text, retrievedAt: embedded.catalog.source.retrievedAt });
const keys = catalogue => catalogue.endpoints.map(e => `${e.method} ${e.path}`).sort();
assert.deepEqual(keys(embedded.catalog), keys(regenerated), 'Embedded operations differ from current, nondeprecated specification');
assert.deepEqual(embedded.catalog.endpoints, regenerated.endpoints, 'Request contracts/templates differ from the specification');
const source = html.slice(0, embedded.start) + '{}' + html.slice(embedded.end);
const direct = [...source.matchAll(/\bapi\(\s*(["'])(\/[^"']+)\1/g)].map(match => match[2]);
const available = new Set(regenerated.endpoints.map(e => e.path));
for (const path of direct) assert.ok(available.has(path), `Undocumented/deprecated direct request: ${path}`);
for (const path of ['/api/nomenclature/v2/product/list', '/api/nomenclature/v2/group/list', '/api/nomenclature/v1/product-scale/list']) assert.ok(available.has(path));
assert.equal(source.includes('api("/api/1/nomenclature"'), false);
assert.equal(source.includes('api("/api/1/access_token"'), false);
console.log(JSON.stringify({ operations: regenerated.endpointCount, excludedDeprecated: regenerated.removedDeprecatedCount, directPaths: [...new Set(direct)].length, sourceSha256: regenerated.source.sha256, liveRestaurantOperations: 0 }, null, 2));
