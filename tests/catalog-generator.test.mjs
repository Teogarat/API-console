import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildSample, createCatalog, embedCatalog, extractEmbeddedCatalog, resolveSchema,
} from "../scripts/update-api-catalog.mjs";

const ref = name => ({ $ref: `#/components/schemas/${name}` });
const fixture = schemas => ({ openapi: "3.0.1", info: { title: "Test API" }, paths: {}, components: { schemas } });

test("request templates preserve required false, zero, enum values and optional null", () => {
  const document = fixture({});
  const sample = buildSample(document, {
    type: "object", required: ["enabled", "count", "status"],
    properties: {
      enabled: { type: "boolean", default: false },
      count: { type: "integer", default: 0 },
      status: { type: "integer", enum: [0, 1, 2] },
      priceCategoryId: { type: "string", format: "uuid", nullable: true },
      unused: { type: "string" },
    },
  });
  assert.deepEqual(sample, { enabled: false, count: 0, status: 0, priceCategoryId: null });
});

test("date-time templates use RFC 3339 and preserve documented legacy date examples", () => {
  const document = fixture({});
  const options = { date: "2026-11-05" };
  assert.equal(buildSample(document, { type: "string", format: "date-time" }, options), "2026-11-05T00:00:00.000Z");
  assert.equal(buildSample(document, { type: "string", format: "date" }, options), "2026-11-05");

  const legacyExample = "2019-08-24 14:15:22.123";
  assert.equal(buildSample(document, { type: "string", format: "yyyy-MM-dd HH:mm:ss.fff", example: legacyExample }, options), legacyExample);
  assert.equal(buildSample(document, { type: "string", example: legacyExample }, options), legacyExample);

  const isoExample = "2025-12-26T12:40:26.801+03:00";
  assert.equal(buildSample(document, { type: "string", format: "date-time", example: isoExample }, options), isoExample);
});

test("allOf retains inherited required properties and concrete product fields", () => {
  const document = fixture({
    Base: { type: "object", required: ["type", "amount"], properties: { type: { type: "string" }, amount: { type: "number", minimum: 0 } } },
    Product: { type: "object", allOf: [ref("Base")], required: ["productId", "price"], properties: { productId: { type: "string", format: "uuid" }, price: { type: "number" } } },
  });
  assert.deepEqual(resolveSchema(document, ref("Product")).required, ["type", "amount", "productId", "price"]);
  assert.deepEqual(buildSample(document, ref("Product")), { type: "", amount: 1, productId: "{{productId}}", price: 0 });
});

test("polymorphic templates choose a concrete documented discriminator and include its fields", () => {
  const document = fixture({
    OrderItem: {
      type: "object", required: ["type", "amount"],
      properties: { type: { type: "string" }, amount: { type: "number" } },
      discriminator: { propertyName: "type", mapping: { Product: "#/components/schemas/ProductItem" } },
    },
    ProductItem: {
      type: "object", allOf: [ref("OrderItem")], required: ["productId", "price"],
      properties: { productId: { type: "string", format: "uuid" }, price: { type: "number" } },
    },
  });
  assert.deepEqual(buildSample(document, ref("OrderItem")), {
    type: "Product", amount: 1, productId: "{{productId}}", price: 0,
  });
});

test("oneOf/anyOf select a non-null branch and retain shared properties", () => {
  const document = fixture({});
  assert.equal(buildSample(document, { oneOf: [{ type: "null" }, { type: "integer", minimum: 7 }] }), 7);
  assert.deepEqual(buildSample(document, {
    type: "object", required: ["shared"], properties: { shared: { type: "boolean" } },
    anyOf: [{ type: "object", required: ["id"], properties: { id: { type: "integer", minimum: 2 } } }],
  }), { id: 2, shared: false });
});

test("context placeholders apply only to strings, including array element types", () => {
  const document = fixture({});
  assert.deepEqual(buildSample(document, {
    type: "object", properties: {
      organizationId: { type: "integer", minimum: 1 },
      organizationIds: { type: "array", items: { type: "integer", minimum: 1 } },
      terminalGroupId: { type: "string", format: "uuid" },
      terminalGroupIds: { type: "array", items: { type: "string", format: "uuid" } },
      externalMenuId: { type: "string" },
      id: { type: "integer", example: 19 },
    },
  }), {
    organizationId: 1, organizationIds: [1], terminalGroupId: "{{terminalGroupId}}",
    terminalGroupIds: ["{{terminalGroupId}}"], externalMenuId: "{{externalMenuId}}", id: 19,
  });
});

test("recursive references terminate with a note, while unresolved references fail", () => {
  const document = fixture({
    Node: { type: "object", properties: { name: { type: "string" }, children: { type: "array", items: ref("Node") } } },
  });
  const notes = new Set();
  assert.deepEqual(buildSample(document, ref("Node"), { notes }), { name: "", children: [{}] });
  assert.equal(notes.size, 1);
  assert.throws(() => buildSample(document, ref("Missing")), /Unresolved OpenAPI reference/);
});

test("read-only response fields never become request inputs", () => {
  const document = fixture({});
  assert.deepEqual(buildSample(document, {
    type: "object", required: ["id", "name"],
    properties: { id: { type: "string", readOnly: true }, name: { type: "string" } },
  }), { name: "" });
});

test("catalogue preserves verbs, actual routes, body metadata and explicit replacements", () => {
  const document = fixture({ MenuRequest: {
    type: "object", required: ["externalMenuId", "organizationId"],
    properties: { externalMenuId: { type: "string" }, organizationId: { type: "string", format: "uuid" }, priceCategoryId: { type: "string", nullable: true } },
  } });
  document.paths = {
    "/api/1/organizations": {
      get: { tags: ["Organizations"], deprecated: true, description: "Deprecated, use `POST api/1/organizations`." },
      post: { tags: ["Organizations"], requestBody: { content: { "application/json": { schema: { type: "object" } } } } },
    },
    "/api/menu/v3/by_id": { post: { tags: ["Menu"], requestBody: { required: true, content: { "application/json": { schema: ref("MenuRequest") } } } } },
    "/api/2/menu": { post: { tags: ["Menu"] } },
    "/api/2/menu/by_id": { post: { tags: ["Menu"], deprecated: true, description: "Deprecated, use `api/menu/v3/by_id` method instead." } },
    "/api/inventory/v1/costings/calculate": { post: { tags: ["Inventory"], deprecated: true, description: "Calculates costs." } },
    "/api/inventory/v2/costings/calculate": { post: { tags: ["Inventory"] } },
  };
  const catalog = createCatalog(document, { retrievedAt: "2026-11-05T12:00:00.000Z", sourceText: "official snapshot" });
  assert.equal(catalog.endpointCount, 4);
  assert.equal(catalog.removedDeprecatedCount, 3);
  const v3 = catalog.endpoints.find(endpoint => endpoint.path === "/api/menu/v3/by_id");
  assert.equal(v3.requestBodyRequired, true);
  assert.equal(v3.requestSchema, "MenuRequest");
  assert.deepEqual(v3.sample, { externalMenuId: "{{externalMenuId}}", organizationId: "{{orgId}}", priceCategoryId: null });
  assert.equal(catalog.endpoints.find(endpoint => endpoint.path === "/api/2/menu").hasRequestBody, false);
  assert.equal(catalog.endpoints.some(endpoint => endpoint.method === "GET" || endpoint.deprecated), false);
  assert.equal(catalog.endpoints.some(endpoint => endpoint.path === "/api/2/menu/by_id"), false);
  assert.equal(catalog.source.sha256, "ec010a4a8e2c28ea4daeab923420d7fbabf8c826e9750af874421347e82eb7e4");
});

test("obsolete diagnostics from an older HTML file are not restored", () => {
  const previous = { endpoints: [
    { method: "POST", path: "/api/1/access_token", tag: "Authorization", sample: { apiLogin: "" } },
    { method: "POST", path: "/api/1/nomenclature", tag: "Menu", sample: { organizationId: "{{orgId}}" } },
  ] };
  const catalog = createCatalog(fixture({}), { previous });
  assert.equal(catalog.endpointCount, 0);
  assert.equal(catalog.currentEndpointCount, 0);
  assert.equal(catalog.legacyEndpointCount, 0);
});

test("list templates do not generate invalid empty filters or fabricated optional IDs", () => {
  const document = fixture({});
  const sample = buildSample(document, {
    type: "object", properties: {
      filters: { type: "array", items: { type: "object", properties: { field: { type: "string" }, op: { type: "string" } } } },
      ids: { type: "array", items: { type: "string", format: "uuid" } },
      limit: { type: "integer" }, offset: { type: "integer" },
    },
  });
  assert.deepEqual(sample, { filters: [], limit: 100, offset: 0 });
});

test("HTML embedding replaces only the JSON constant and escapes script terminators", () => {
  const before = '<script>const unrelated = "preserve";\nconst API_DOCS_EMBEDDED = ';
  const after = ';\nconst tail = "also preserve";</script>';
  const html = before + JSON.stringify({ description: 'Braces { \" ; }', endpoints: [] }) + after;
  assert.deepEqual(extractEmbeddedCatalog(html).catalog.endpoints, []);
  const catalog = { description: "</script><script>unexpected()</script>", endpoints: [] };
  const updated = embedCatalog(html, catalog);
  assert.ok(updated.startsWith(before));
  assert.ok(updated.endsWith(after));
  assert.equal(updated.includes("<script>unexpected"), false);
  assert.deepEqual(extractEmbeddedCatalog(updated).catalog, catalog);
});

test("CLI review writes JSON only; changing HTML requires --write-html", async () => {
  const folder = await mkdtemp(join(tmpdir(), "iiko-catalog-test-"));
  const script = fileURLToPath(new URL("../scripts/update-api-catalog.mjs", import.meta.url));
  try {
    const htmlPath = join(folder, "index.html");
    const specPath = join(folder, "spec.json");
    const output = join(folder, "catalog.json");
    const original = "<script>const API_DOCS_EMBEDDED = {\"endpoints\":[]};</script>";
    await writeFile(htmlPath, original);
    await writeFile(specPath, JSON.stringify(fixture({})));
    const args = [script, "--input", specPath, "--output", output, "--html", htmlPath, "--retrieved-at", "2026-11-05T12:00:00Z"];
    const review = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(review.status, 0, review.stderr);
    assert.equal(await readFile(htmlPath, "utf8"), original);
    assert.equal(JSON.parse(await readFile(output, "utf8")).endpointCount, 0);
    const apply = spawnSync(process.execPath, [...args, "--write-html"], { encoding: "utf8" });
    assert.equal(apply.status, 0, apply.stderr);
    assert.notEqual(await readFile(htmlPath, "utf8"), original);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
