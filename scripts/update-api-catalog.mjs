#!/usr/bin/env node
/**
 * Refresh the standalone console's catalogue from the official iiko OpenAPI.
 *
 * Review a local snapshot without editing the application:
 *   node scripts/update-api-catalog.mjs --input openapi.json --output catalog.json
 * Fetch the official snapshot and explicitly embed it in index.html:
 *   node scripts/update-api-catalog.mjs --write-html
 *
 * No restaurant API methods are called. Only the public specification is read.
 */
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OPENAPI_URL = "https://api-ru.iiko.services/api-docs/docs";
const DEFAULT_HTML = fileURLToPath(new URL("../index.html", import.meta.url));
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const OWN = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const CONTEXT_FIELDS = {
  organizationId: "orgId", orgId: "orgId", terminalGroupId: "terminalGroupId",
  externalMenuId: "externalMenuId", orderId: "orderId", productId: "productId",
  paymentTypeId: "paymentTypeId", orderTypeId: "orderTypeId",
  apiKey: "apiKey", apiLogin: "apiKey", appId: "appId", clientSecret: "clientSecret",
};
const ARRAY_FIELDS = {
  organizationIds: "organizationId", terminalGroupIds: "terminalGroupId",
  terminalGroupsIds: "terminalGroupId", orderIds: "orderId", productIds: "productId",
};
const USEFUL_OPTIONAL_FIELDS = new Set([
  ...Object.keys(CONTEXT_FIELDS), ...Object.keys(ARRAY_FIELDS),
  "order", "priceCategoryId", "limit", "offset", "returnAdditionalInfo", "startRevision",
]);

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function dereference(document, reference) {
  if (!reference.startsWith("#/")) throw new Error(`External schema reference is unsupported: ${reference}`);
  let value = document;
  for (const token of reference.slice(2).split("/")) {
    value = value?.[token.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  if (!value) throw new Error(`Unresolved OpenAPI reference: ${reference}`);
  return value;
}

function mergeSchemas(left, right) {
  const out = { ...left, ...right };
  if (left.properties || right.properties) out.properties = { ...left.properties, ...right.properties };
  if (left.required || right.required) out.required = [...new Set([...(left.required || []), ...(right.required || [])])];
  return out;
}

/** Resolve references and allOf inheritance; retain alternatives for sample choice. */
export function resolveSchema(document, source, seen = new Set()) {
  if (!source || typeof source !== "object") return {};
  let schema = { ...source };
  if (schema.$ref) {
    const ref = schema.$ref;
    if (seen.has(ref)) return { type: "object", circularReference: ref };
    const next = new Set(seen).add(ref);
    delete schema.$ref;
    schema = mergeSchemas(resolveSchema(document, dereference(document, ref), next), schema);
  }
  if (schema.allOf) {
    let combined = {};
    for (const member of schema.allOf) combined = mergeSchemas(combined, resolveSchema(document, member, seen));
    const own = { ...schema };
    delete own.allOf;
    schema = mergeSchemas(combined, own);
  }
  return schema;
}

function schemaType(schema) {
  if (Array.isArray(schema.type)) return schema.type.find(type => type !== "null") || "null";
  return schema.type || (schema.properties ? "object" : schema.items ? "array" : undefined);
}

function hasValidType(value, schema) {
  const type = schemaType(schema);
  if (value === null) return schema.nullable === true || schema.type === "null" || schema.type?.includes?.("null");
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "array") return Array.isArray(value);
  if (type === "object") return typeof value === "object" && !Array.isArray(value);
  return !type || typeof value === type;
}

function chooseDiscriminator(schema) {
  const mapping = schema.discriminator?.mapping;
  if (!mapping) return null;
  // Choose one documented concrete request type, never a blank discriminator.
  for (const key of ["Product", "Cash", "regular", "phone", "DeliveryByClient", "city"]) {
    if (OWN(mapping, key)) return [key, mapping[key]];
  }
  return Object.entries(mapping)[0] || null;
}

function numericSample(schema, field) {
  let value = /^(amount|quantity|qty|durationInMinutes)$/.test(field) ? 1 : field === "limit" ? 100 : 0;
  if (typeof schema.minimum === "number") value = Math.max(value, schema.minimum);
  if (typeof schema.exclusiveMinimum === "number") value = Math.max(value, schema.exclusiveMinimum + 1);
  if (schema.exclusiveMinimum === true && value <= schema.minimum) value = schema.minimum + 1;
  if (typeof schema.maximum === "number") value = Math.min(value, schema.maximum);
  if (typeof schema.exclusiveMaximum === "number") value = Math.min(value, schema.exclusiveMaximum - 1);
  if (schema.exclusiveMaximum === true && value >= schema.maximum) value = schema.maximum - 1;
  return schemaType(schema) === "integer" ? Math.ceil(value) : value;
}

/**
 * Produce an editable template, not a promise of a valid business operation.
 * Required fields, enum values, inheritance and JSON types come from the spec.
 * Optional fields without required metadata are shown to make generated APIs usable.
 */
export function buildSample(document, source, options = {}) {
  const notes = options.notes || new Set();
  const date = options.date || "2026-01-01";

  function sample(raw, field = "", depth = 0, ancestors = new Set(), extra = {}) {
    let schema = resolveSchema(document, raw);
    const type = schemaType(schema);
    if (depth > 14 || (raw?.$ref && ancestors.has(raw.$ref))) {
      notes.add("Рекурсивная или слишком глубокая схема сокращена; вложенные поля заполни по документации.");
      return schema.nullable ? null : type === "array" ? [] : type === "object" ? {} : "";
    }
    const nextAncestors = new Set(ancestors);
    if (raw?.$ref) nextAncestors.add(raw.$ref);

    const alternatives = schema.oneOf || schema.anyOf;
    if (alternatives?.length) {
      const selected = alternatives.find(item => schemaType(resolveSchema(document, item)) !== "null") || alternatives[0];
      const common = { ...schema };
      delete common.oneOf;
      delete common.anyOf;
      return sample(mergeSchemas(resolveSchema(document, selected), common), field, depth, nextAncestors, extra);
    }

    if (OWN(schema, "const")) return clone(schema.const);
    if (OWN(schema, "default") && hasValidType(schema.default, schema)) return clone(schema.default);
    if (schema.enum?.length) return clone(schema.enum.find(value => value !== null) ?? schema.enum[0]);

    const discriminator = !extra.skipDiscriminator && chooseDiscriminator(schema);
    if (discriminator) {
      const [value, reference] = discriminator;
      const branch = dereference(document, reference);
      const concrete = mergeSchemas(schema, resolveSchema(document, branch));
      const result = sample(concrete, field, depth, nextAncestors, {
        skipDiscriminator: true,
        include: new Set(Object.keys(branch.properties || {})),
      });
      if (result && typeof result === "object" && !Array.isArray(result)) {
        result[schema.discriminator.propertyName] = value;
      }
      return result;
    }

    // The console interpolates context only into string fields. Numeric IDs stay numbers.
    if (type === "string" && CONTEXT_FIELDS[field]) return `{{${CONTEXT_FIELDS[field]}}}`;
    if (OWN(schema, "example") && hasValidType(schema.example, schema) && type !== "object" && type !== "array") {
      return clone(schema.example);
    }

    if (type === "object") {
      const properties = schema.properties || {};
      const required = new Set(schema.required || []);
      const result = {};
      for (const [name, child] of Object.entries(properties)) {
        const resolved = resolveSchema(document, child);
        if (resolved.readOnly) continue;
        const explicitlyRequired = required.has(name);
        const include = explicitlyRequired || extra.include?.has(name) || USEFUL_OPTIONAL_FIELDS.has(name)
          || OWN(resolved, "default") || OWN(resolved, "example") || required.size === 0;
        if (!include || (resolved.deprecated && !explicitlyRequired)) continue;
        // A fabricated optional ID narrows a list to a non-existent record.
        if (!explicitlyRequired && /^(ids|productIds|groupIds)$/.test(name) && !OWN(resolved, "default") && !OWN(resolved, "example")) continue;
        // Null is meaningful, especially for the base price category; never replace it with 0/"".
        if (!explicitlyRequired && resolved.nullable && !CONTEXT_FIELDS[name]) {
          result[name] = OWN(resolved, "default") ? clone(resolved.default) : null;
        } else {
          result[name] = sample(child, name, depth + 1, nextAncestors);
        }
      }
      return result;
    }
    if (type === "array") {
      if (schema.maxItems === 0 || (field === "filters" && !schema.minItems)) return [];
      const count = Math.max(1, Math.min(5, Number(schema.minItems) || 1));
      if ((schema.minItems || 0) > 5) notes.add("Массив сокращён до пяти примеров; проверь minItems в документации.");
      const itemField = ARRAY_FIELDS[field] || field.replace(/Ids$/, "Id");
      return Array.from({ length: count }, () => sample(schema.items || {}, itemField, depth + 1, nextAncestors));
    }
    if (type === "boolean") return false;
    if (type === "integer" || type === "number") return numericSample(schema, field);
    if (type === "null") return null;
    if (type === "string") {
      if (schema.format === "uuid") return "{{uuid}}";
      if (schema.format === "date") return date;
      if (schema.format === "date-time") return `${date}T00:00:00.000Z`;
      if (schema.format === "email") return "guest@example.com";
      if (schema.format === "uri" || schema.format === "url") return "https://example.com/";
      if (schema.minLength > 0) return "x".repeat(Math.min(schema.minLength, 100));
      return "";
    }
    return schema.nullable ? null : {};
  }
  return sample(source);
}

function requestFields(document, schema) {
  const resolved = resolveSchema(document, schema);
  const required = new Set(resolved.required || []);
  return Object.entries(resolved.properties || {}).filter(([, value]) => !resolveSchema(document, value).readOnly)
    .map(([name, value]) => {
      const field = resolveSchema(document, value);
      const result = { name, type: schemaType(field) || "any", required: required.has(name) };
      for (const key of ["format", "description", "nullable", "enum", "default", "minimum", "maximum", "minItems", "maxItems"]) {
        if (OWN(field, key)) result[key] = field[key];
      }
      return result;
    });
}

function documentedReplacement(operation, knownOperations) {
  if (!operation.deprecated) return {};
  const match = (operation.description || "").match(/Deprecated[^\n]*?use\s+`(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(\/?(?:api|purchasing)\/[^`\s]+)`/i);
  if (!match) return {};
  const replacementPath = `/${match[2].replace(/^\/+/, "")}`;
  const replacementMethod = (match[1] || "POST").toUpperCase();
  return knownOperations.has(`${replacementMethod} ${replacementPath}`) ? { replacementPath, replacementMethod } : {};
}

export function extractEmbeddedCatalog(html) {
  const marker = /\bconst\s+API_DOCS_EMBEDDED\s*=\s*/g.exec(html);
  if (!marker) throw new Error("API_DOCS_EMBEDDED was not found in the HTML file");
  const start = marker.index + marker[0].length;
  let string = false, escaped = false, depth = 0;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (string) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') string = false;
    } else if (char === '"') string = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return { start, end: index + 1, catalog: JSON.parse(html.slice(start, index + 1)) };
    }
  }
  throw new Error("API_DOCS_EMBEDDED contains incomplete JSON");
}

export function embedCatalog(html, catalog) {
  const { start, end } = extractEmbeddedCatalog(html);
  // A specification description must never terminate the HTML script element.
  const encoded = JSON.stringify(catalog).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return html.slice(0, start) + encoded + html.slice(end);
}

export function createCatalog(document, { previous = {}, sourceText, retrievedAt = new Date().toISOString() } = {}) {
  if (!document.openapi || !document.paths) throw new Error("Input is not an OpenAPI document with paths");
  const operations = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (HTTP_METHODS.has(method)) operations.push({ method: method.toUpperCase(), path, operation });
    }
  }
  const keys = new Set(operations.map(({ method, path }) => `${method} ${path}`));
  const activeOperations = operations.filter(({ operation }) => operation.deprecated !== true);
  const endpoints = activeOperations.map(({ method, path, operation }) => {
    const body = operation.requestBody?.$ref ? dereference(document, operation.requestBody.$ref) : operation.requestBody;
    const content = body?.content || {};
    const contentType = OWN(content, "application/json") ? "application/json" : Object.keys(content)[0];
    const schema = contentType ? content[contentType]?.schema || {} : {};
    const notes = new Set();
    const sample = body ? buildSample(document, schema, { date: retrievedAt.slice(0, 10), notes }) : {};
    const endpoint = {
      method, path, tag: operation.tags?.[0] || "Other",
      summary: operation.summary || "", description: operation.description || "",
      deprecated: operation.deprecated === true, sourceStatus: "current",
      requestSchema: schema.$ref ? schema.$ref.split("/").at(-1) : null,
      hasRequestBody: !!body, requestBodyRequired: body?.required === true,
      requestContentType: contentType || null,
      sample, requestFields: body ? requestFields(document, schema) : [],
      ...documentedReplacement(operation, keys),
    };
    if (notes.size) endpoint.sampleNotes = [...notes];
    return endpoint;
  });

  // Removed/deprecated operations are intentionally not offered or preserved.
  endpoints.sort((a, b) => a.tag.localeCompare(b.tag, "en") || a.path.localeCompare(b.path, "en") || a.method.localeCompare(b.method));
  return {
    title: document.info?.title || "iikoCloud API", openapi: document.openapi,
    endpointCount: endpoints.length, currentEndpointCount: endpoints.length,
    legacyEndpointCount: 0,
    removedDeprecatedCount: operations.length - endpoints.length,
    source: {
      url: OPENAPI_URL, retrievedAt,
      sha256: createHash("sha256").update(sourceText ?? JSON.stringify(document)).digest("hex"),
    },
    tags: [...new Set(endpoints.map(endpoint => endpoint.tag))].sort((a, b) => a.localeCompare(b, "en")),
    endpoints,
  };
}

function parseArgs(args) {
  const options = { html: DEFAULT_HTML, writeHtml: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--write-html") options.writeHtml = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (["--input", "--output", "--html", "--retrieved-at"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function main(args) {
  const options = parseArgs(args);
  if (options.help) {
    console.log("Usage: node scripts/update-api-catalog.mjs [--input openapi.json] [--output catalog.json] [--write-html] [--html index.html] [--retrieved-at ISO-date]");
    console.log("Without --input, downloads only the public iiko OpenAPI. Without --write-html, leaves index.html untouched.");
    return;
  }
  let retrievedAt;
  if (options.retrievedAt) {
    if (!Number.isFinite(Date.parse(options.retrievedAt))) throw new Error("--retrieved-at must be an ISO date");
    retrievedAt = new Date(options.retrievedAt).toISOString();
  }
  const html = await readFile(options.html, "utf8");
  let sourceText;
  if (options.input) {
    sourceText = await readFile(options.input, "utf8");
    // A reused local snapshot must not appear freshly downloaded on every rebuild.
    retrievedAt ||= (await stat(options.input)).mtime.toISOString();
  }
  else {
    const response = await fetch(OPENAPI_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`OpenAPI download failed: HTTP ${response.status}`);
    sourceText = await response.text();
    retrievedAt ||= new Date().toISOString();
  }
  const catalog = createCatalog(JSON.parse(sourceText), {
    previous: extractEmbeddedCatalog(html).catalog, sourceText, retrievedAt,
  });
  if (options.output) await writeFile(options.output, JSON.stringify(catalog, null, 2) + "\n");
  if (options.writeHtml) await writeFile(options.html, embedCatalog(html, catalog));
  if (!options.output && !options.writeHtml) process.stdout.write(JSON.stringify(catalog, null, 2) + "\n");
  else console.log(`Catalogue: ${catalog.currentEndpointCount} current-spec operations + ${catalog.legacyEndpointCount} legacy; SHA-256 ${catalog.source.sha256}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
