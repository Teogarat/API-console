const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scriptMatch = html.match(/<script>\s*([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, 'The console must contain its application script');
const eventMarker = scriptMatch[1].indexOf('// === EVENTS ===');
assert.ok(eventMarker > 0, 'The harness must stop before application initialization');
const application = new vm.Script(scriptMatch[1].slice(0, eventMarker), {
  filename: 'index.html:application',
});
const applicationEvents = new vm.Script(scriptMatch[1].slice(eventMarker), {
  filename: 'index.html:events',
});
const fixtureText = fs.readFileSync(path.join(__dirname, 'fixtures', 'menu-v3.json'), 'utf8');

const ORG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_ORG = 'dddddddd-dddd-4ddd-8ddd-ddddddddddde';
const CATEGORY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const fixture = () => JSON.parse(fixtureText);
const plain = value => JSON.parse(JSON.stringify(value));

function decodeHtml(value) {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'",
  })[entity]);
}

function readAttributes(source) {
  const attributes = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    attributes[match[1]] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

// A deliberately small DOM stand-in. It captures the real renderer's listeners
// and lets tests operate its actual buttons/selects; it is not a browser layout test.
class Element {
  constructor(tagName = 'div', attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
    this.value = attributes.value ?? '';
    this.textContent = '';
    this.checked = false;
    this.disabled = false;
    this.style = {};
    this.dataset = {};
    this.options = [];
    this.children = [];
    this.listeners = new Map();
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.parentElement = { querySelector: () => ({ className: '' }) };
    this._html = '';
    this._nodes = [];
  }

  set innerHTML(value) {
    this._html = String(value);
    this._nodes = [];
    this.children = [];
    for (const match of this._html.matchAll(/<(button|select|details)\b([^>]*)>/g)) {
      const attributes = readAttributes(match[2]);
      const node = new Element(match[1], attributes);
      if (match[1] === 'select') {
        const body = this._html.slice(match.index + match[0].length).split('</select>')[0];
        node.setOptions(body);
      }
      this._nodes.push(node);
    }
    if (this.tagName === 'SELECT') this.setOptions(this._html);
  }

  get innerHTML() { return this._html; }

  setOptions(markup) {
    this.options = [...markup.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(match => {
      const option = new Element('option', readAttributes(match[1]));
      option.textContent = decodeHtml(match[2]);
      return option;
    });
    this.value = (this.options.find(option => 'selected' in option.attributes) || this.options[0])?.value ?? '';
  }

  appendChild(child) {
    this.children.push(child);
    if (child.tagName === 'OPTION') {
      this.options.push(child);
      if (this.options.length === 1) this.value = child.value;
    }
  }

  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  closest() { return this; }
  focus() {}

  querySelectorAll(selector) {
    const attribute = selector.match(/\[([^\]=]+)\]/)?.[1];
    if (!attribute) return [];
    return this._nodes.filter(node => Object.hasOwn(node.attributes, attribute));
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) ?? [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }

  dispatch(name, fields = {}) {
    const event = { target: this, preventDefault() {}, stopPropagation() {}, shiftKey: false, ...fields };
    for (const handler of this.listeners.get(name) ?? []) handler(event);
  }
}

function harness({ initialize = false } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const tag = /Select$|Filter$|workerActive$/.test(id) ? 'select' : 'div';
      elements.set(id, new Element(tag));
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    document: {
      getElementById: element,
      querySelector: selector => selector.startsWith('#') ? element(selector.slice(1)) : null,
      querySelectorAll: () => [],
      createElement: tag => new Element(tag),
    },
    window: {},
    localStorage: { getItem() { return null; }, setItem() {} },
    URL,
    TextEncoder,
    TextDecoder,
    setTimeout: () => 0,
    clearTimeout() {},
    fetch() { throw new Error('Unexpected network request in regression test'); },
    alert(message) { throw new Error(`Unexpected alert: ${message}`); },
  });
  application.runInContext(context);
  vm.runInContext(`
    decryptDefaultCloudCredentials = () => { throw new Error('Test must not decrypt embedded credentials'); };
    globalThis.subject = {
      state, normalizeExternalMenuV3, flattenMenu, buildExternalMenuV3Request,
      buildCloudOrderItems, buildApiExplorerSample, prepareApiExplorerRequestBody,
      getFilteredApiEndpoints, loadMenuApi1, loadMenuApi3External, clearCloudMenuState,
      reloadOrgDeps, renderItemsList, renderCart, api, catalogue: API_DOCS_EMBEDDED,
    };
  `, context);
  const subject = context.subject;
  const setContext = ({ orgId = ORG, externalMenuId = '15#3', priceCategoryId = null } = {}) => {
    element('orgSelect').value = orgId;
    element('menuSelect').value = externalMenuId;
    element('priceCatSelect').value = priceCategoryId ?? '';
  };
  setContext();
  element('workerActive').value = 'vc';
  element('workerVC').value = 'https://proxy.example.test/api/proxy';
  element('timeout').value = '15';
  subject.state.orgId = ORG;
  if (initialize) applicationEvents.runInContext(context);
  return {
    ...subject,
    context,
    element,
    setContext,
    stubApi(fn) {
      context.testApi = fn;
      vm.runInContext('api = globalThis.testApi;', context);
    },
    setMode(mode) {
      context.testMode = mode;
      vm.runInContext('apiMode = globalThis.testMode;', context);
    },
    setFetch(fn) { context.fetch = fn; },
  };
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function loadFixture(h, source = fixture()) {
  h.state.menu = h.normalizeExternalMenuV3(source, ORG);
  h.state.itemsFlat = h.flattenMenu(h.state.menu);
  h.renderItemsList();
  return h.state.menu;
}

function control(h, attribute, value) {
  const node = h.element('itemsList').querySelectorAll(`[${attribute}]`)
    .find(candidate => candidate.getAttribute(attribute) === value);
  assert.ok(node, `Rendered control ${attribute}=${value} must exist`);
  return node;
}

test('menu v3 preserves duplicate placements, size prices, null prices and the immutable raw response', () => {
  const h = harness();
  const source = freezeDeep(fixture());
  const before = JSON.stringify(source);
  const menu = h.normalizeExternalMenuV3(source, ORG);
  const main = menu.itemCategories[0].items[0];
  const promo = menu.itemCategories[1].items[0];
  const unknownPrice = menu.itemCategories[0].items[1];
  const freeHidden = menu.itemCategories[2].items[0];

  assert.equal(main.productId, promo.productId);
  assert.notEqual(main.placementKey, promo.placementKey);
  assert.equal(main.name, 'Пицца — основное размещение');
  assert.equal(main.sku, '1001');
  assert.deepEqual(plain(main.itemSizes.map(size => size.prices[0].price)), [390, 590]);
  assert.equal(promo.itemSizes[0].prices[0].price, 350);
  assert.equal(unknownPrice.itemSizes[0].prices[0].price, null);
  assert.equal(freeHidden.itemSizes[0].prices[0].price, 0);
  assert.equal(freeHidden.isHidden, true);
  assert.equal(freeHidden.itemSizes[0].isHidden, true);
  assert.notEqual(main.itemSizes[0].placementKey, main.itemSizes[1].placementKey);

  const flat = h.flattenMenu(menu);
  assert.equal(flat.length, 4);
  assert.deepEqual(plain(flat.map(item => item.price)), [390, null, 350, 0]);
  assert.equal(flat.filter(item => item.productId === main.productId).length, 2);
  assert.equal(menu.raw, source);
  assert.equal(main.raw, source.itemsGroups[0].items[0]);
  assert.equal(JSON.stringify(source), before);
});

test('modifier references inherit null fields without discarding explicit false, zero or empty overrides', () => {
  const h = harness();
  const menu = h.normalizeExternalMenuV3(fixture(), ORG);
  const main = menu.itemCategories[0].items[0];
  const smallGroup = main.itemSizes[0].itemModifierGroups[0];
  const largeGroup = main.itemSizes[1].itemModifierGroups[0];
  const cheese = smallGroup.items[0];
  const sauce = smallGroup.items[1];

  assert.equal(cheese.name, 'Сыр из справочника');
  assert.equal(cheese.sku, '2001');
  assert.equal(cheese.description, '');
  assert.equal(cheese.isHidden, false);
  assert.equal(cheese.weight, 0);
  assert.equal(cheese.measureUnitType, 'GRAM');
  assert.deepEqual(plain(cheese.tags), []);
  assert.equal(cheese.restrictions.defaultQuantity, 1);
  assert.equal(cheese.prices[0].price, 0);
  assert.equal(largeGroup.items[0].prices[0].price, 35);
  assert.equal(sauce.name, 'Соус к пицце');
  assert.equal(sauce.description, 'Описание соуса из справочника');
  assert.equal(sauce.isHidden, false);
  assert.equal(sauce.prices[0].price, null);
  assert.equal(largeGroup.items[1].prices[0].price, 0);

  // An unsized reference price is not silently used for a sized product.
  assert.equal(smallGroup.items[2].prices[0].price, null);
  assert.equal(menu.itemCategories[2].items[0].itemSizes[0].itemModifierGroups[0].items[0].prices[0].price, 5);
  const hiddenGroupCheese = main.itemSizes[0].itemModifierGroups[1].items[0];
  assert.equal(hiddenGroupCheese.isHidden, true);
  assert.notEqual(hiddenGroupCheese.selectionKey, cheese.selectionKey);
  assert.notEqual(largeGroup.items[0].selectionKey, cheese.selectionKey);
});

test('renderer buttons retain separate cart lines for placements and sizes with real order IDs', () => {
  const h = harness();
  const menu = loadFixture(h);
  const main = menu.itemCategories[0].items[0];
  const promo = menu.itemCategories[1].items[0];
  control(h, 'data-add-item', main.itemSizes[0].placementKey).dispatch('click');
  control(h, 'data-add-item', promo.itemSizes[0].placementKey).dispatch('click');
  const sizeSelect = control(h, 'data-menu-size', main.placementKey);
  sizeSelect.value = '1';
  sizeSelect.dispatch('change');
  control(h, 'data-add-item', main.itemSizes[1].placementKey).dispatch('click');

  assert.equal(h.state.cart.length, 3);
  assert.deepEqual(plain(h.state.cart.map(line => line.basePrice)), [390, 350, 590]);
  assert.equal(h.element('totalSum').textContent, '1365.00');
  const order = plain(h.buildCloudOrderItems(h.state.cart, ORG));
  assert.deepEqual(order.map(item => item.productId), [main.productId, main.productId, main.productId]);
  assert.deepEqual(order.map(item => item.productSizeId), [
    main.itemSizes[0].sizeId, promo.itemSizes[0].sizeId, main.itemSizes[1].sizeId,
  ]);
  assert.deepEqual(order.map(item => item.price), [390, 350, 590]);
  assert.equal(order[0].modifiers[0].productGroupId, main.itemSizes[0].itemModifierGroups[0].id);
  assert.equal(order[2].modifiers[0].price, 35);
  for (const item of order) {
    assert.equal(Object.hasOwn(item, 'menuItemId'), false);
    assert.equal(Object.hasOwn(item, 'menuItemSizeId'), false);
    assert.equal(Object.hasOwn(item, 'placementKey'), false);
    assert.equal(Object.hasOwn(item, 'baseId'), false);
  }
});

test('selecting the same modifier in two groups preserves both group identities', () => {
  const h = harness();
  const source = fixture();
  source.itemsGroups[0].items[0].modifierGroups[1].isHidden = false;
  const menu = loadFixture(h, source);
  const main = menu.itemCategories[0].items[0];
  const size = main.itemSizes[0];
  const secondCheese = size.itemModifierGroups[1].items[0];
  const secondButton = h.element('itemsList').querySelectorAll('[data-add-mod]')
    .find(button => button.getAttribute('data-modifier-id') === secondCheese.selectionKey);
  assert.ok(secondButton);
  secondButton.dispatch('click');
  control(h, 'data-add-item', size.placementKey).dispatch('click');
  const modifiers = plain(h.buildCloudOrderItems(h.state.cart, ORG))[0].modifiers;
  assert.equal(modifiers.length, 2);
  assert.equal(modifiers[0].productId, modifiers[1].productId);
  assert.notEqual(modifiers[0].productGroupId, modifiers[1].productGroupId);
  assert.deepEqual(modifiers.map(modifier => modifier.amount), [1, 1]);
});

test('missing product identity is not replaced by menu placement ID or SKU', () => {
  const h = harness();
  const source = fixture();
  source.itemsGroups[0].items[0].productId = null;
  source.itemsGroups[0].items[0].sku = 'NOT-A-PRODUCT-ID';
  const menu = loadFixture(h, source);
  const item = menu.itemCategories[0].items[0];
  assert.equal(item.productId, null);
  control(h, 'data-add-item', item.itemSizes[0].placementKey).dispatch('click');
  assert.equal(h.state.cart.length, 0);
  assert.throws(() => h.buildCloudOrderItems([{
    baseId: item.placementKey, baseProductId: null, name: item.name, qty: 1, basePrice: 390,
  }], ORG), /productId/);
});

test('order serialization rejects unsupported, foreign and unpriced lines while accepting a true zero price', () => {
  const h = harness();
  const source = fixture();
  const good = {
    baseProductId: source.products[0].id,
    productSizeId: source.itemsGroups[0].items[0].sizePrices[0].sizeId,
    sourceMode: 'cloud', organizationId: ORG, name: 'Проверка', orderItemType: 'Product',
    qty: 1, basePrice: 0, modifiers: [],
  };
  assert.equal(h.buildCloudOrderItems([good], ORG)[0].price, 0);
  for (const [patch, message] of [
    [{ orderItemType: 'Compound' }, /Compound/],
    [{ organizationId: OTHER_ORG }, /другой организации/],
    [{ sourceMode: 'yandex' }, /другого API/],
    [{ basePrice: null }, /цена блюда/],
    [{ qty: 0 }, /Количество/],
    [{ modifiers: [{ productId: source.modifiers[0].id, qty: 1, price: null }] }, /цена модификатора/],
    [{ modifiers: [{ productId: null, qty: 1, price: 0 }] }, /productId/],
  ]) {
    assert.throws(() => h.buildCloudOrderItems([{ ...good, ...patch }], ORG), message);
  }
});

test('v3 request and Explorer samples use live singular organization while v2 retains its own contract', () => {
  const h = harness();
  h.state.orgId = OTHER_ORG;
  h.state.externalMenuId = 'stale-menu';
  h.state.priceCategoryId = CATEGORY;
  assert.deepEqual(plain(h.buildExternalMenuV3Request({ orgId: ORG, externalMenuId: '15#3', priceCategoryId: null })), {
    externalMenuId: '15#3', organizationId: ORG, priceCategoryId: null,
  });
  assert.deepEqual(plain(h.buildApiExplorerSample({ path: '/api/menu/v3/by_id' })), {
    externalMenuId: '15#3', organizationId: ORG, priceCategoryId: null,
  });
  assert.deepEqual(plain(h.buildApiExplorerSample({ path: '/api/2/menu/by_id' })), {
    externalMenuId: '15#3', organizationIds: [ORG], priceCategoryId: null, version: 2,
  });
  assert.deepEqual(plain(h.buildApiExplorerSample({ path: '/api/2/menu' })), {});
});

test('Explorer fills missing v3 context, preserves explicit null/custom IDs and rejects v2 fields', () => {
  const h = harness();
  const endpoint = { path: '/api/menu/v3/by_id', hasRequestBody: true };
  h.setContext({ priceCategoryId: CATEGORY });
  assert.deepEqual(plain(h.prepareApiExplorerRequestBody(endpoint, {})), {
    externalMenuId: '15#3', organizationId: ORG, priceCategoryId: CATEGORY,
  });
  const custom = { externalMenuId: 'another-menu', organizationId: OTHER_ORG, priceCategoryId: null };
  assert.deepEqual(plain(h.prepareApiExplorerRequestBody(endpoint, custom)), custom);
  assert.deepEqual(custom, { externalMenuId: 'another-menu', organizationId: OTHER_ORG, priceCategoryId: null });
  for (const body of [{ organizationIds: [ORG] }, { version: 2 }, { language: 'ru' }]) {
    assert.throws(() => h.prepareApiExplorerRequestBody(endpoint, body), /не принимает поля/);
  }
  assert.throws(() => h.prepareApiExplorerRequestBody(endpoint, []), /JSON-объектом/);
  h.setContext({ orgId: '', externalMenuId: '' });
  assert.throws(() => h.prepareApiExplorerRequestBody(endpoint, {}), /organizationId и externalMenuId/);
});

test('bodyless menu-list operation stays POST on the wire without fabricating JSON data', async () => {
  const h = harness();
  const calls = [];
  h.state.token = 'synthetic-test-token';
  h.setFetch(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"externalMenus":[]}' };
  });
  const endpoint = { path: '/api/2/menu', method: 'POST', hasRequestBody: false };
  const body = h.prepareApiExplorerRequestBody(endpoint, { organizationIds: [ORG] });
  assert.equal(body, undefined);
  await h.api(endpoint.path, body, endpoint.method);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(new URL(calls[0].url).searchParams.get('path'), 'api/2/menu');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-test-token');
});

test('catalogue defaults to current methods and keeps legacy requests explicitly discoverable', () => {
  const h = harness();
  const current = h.getFilteredApiEndpoints();
  assert.ok(current.some(endpoint => endpoint.path === '/api/menu/v3/by_id'));
  assert.ok(current.some(endpoint => endpoint.path === '/api/1/organizations' && endpoint.method === 'POST'));
  assert.equal(current.some(endpoint => endpoint.deprecated || endpoint.sourceStatus === 'legacy'), false);
  h.element('apiStatusFilter').value = 'legacy';
  const legacy = h.getFilteredApiEndpoints();
  assert.ok(legacy.some(endpoint => endpoint.path === '/api/2/menu/by_id'));
  assert.ok(legacy.some(endpoint => endpoint.path === '/api/1/nomenclature' && endpoint.sourceStatus === 'legacy'));
  h.element('apiStatusFilter').value = 'all';
  assert.equal(h.getFilteredApiEndpoints().length, h.catalogue.endpoints.length);
});

test('menu loader uses the v3 endpoint and renders its actual response', async () => {
  const h = harness();
  const calls = [];
  h.stubApi(async (url, body) => { calls.push({ url, body: plain(body) }); return fixture(); });
  await h.loadMenuApi3External();
  assert.deepEqual(calls, [{
    url: '/api/menu/v3/by_id',
    body: { externalMenuId: '15#3', organizationId: ORG, priceCategoryId: null },
  }]);
  assert.equal(h.state.menu.apiVersion, 3);
  assert.equal(h.state.itemsFlat.length, 4);
  assert.equal(h.element('catCount').textContent, '3');
  assert.equal(h.element('itemCount').textContent, '4');
  assert.match(h.element('itemsList').innerHTML, /Пицца — основное размещение/);
  assert.match(h.element('itemsList').innerHTML, /НЕТ ЦЕНЫ/);
  assert.match(h.element('itemsList').innerHTML, /0\.00/);
});

test('late menu responses cannot overwrite a different organization, menu, price category or API mode', async t => {
  const cases = [
    ['organization', h => h.element('orgSelect').value = OTHER_ORG],
    ['menu', h => h.element('menuSelect').value = 'other-menu'],
    ['price category', h => h.element('priceCatSelect').value = CATEGORY],
    ['vendor API', h => h.setMode('magnit')],
    ['historical nomenclature', h => h.state.useApi1Menu = true],
  ];
  for (const [name, change] of cases) {
    await t.test(name, async () => {
      const h = harness();
      const previous = loadFixture(h);
      const pending = deferred();
      h.stubApi(() => pending.promise);
      const loading = h.loadMenuApi3External();
      change(h);
      pending.resolve({ ...fixture(), name: 'Must not be applied' });
      await loading;
      assert.equal(h.state.menu, previous);
      assert.equal(h.state.menu.raw.name, 'Синтетическое меню для проверки API v3');
    });
  }
});

test('a newer reload wins over an earlier request for the same menu', async () => {
  const h = harness();
  const earlier = deferred();
  const later = deferred();
  let count = 0;
  h.stubApi(() => (++count === 1 ? earlier.promise : later.promise));
  const oldLoading = h.loadMenuApi3External();
  const newLoading = h.loadMenuApi3External();
  later.resolve({ ...fixture(), name: 'Most recent result' });
  await newLoading;
  earlier.resolve({ ...fixture(), name: 'Old result' });
  await oldLoading;
  assert.equal(h.state.menu.name, 'Most recent result');
});

test('a late historical v1 reply cannot replace an already loaded v3 menu', async () => {
  const h = harness();
  const legacy = deferred();
  const calls = [];
  h.stubApi(async url => {
    calls.push(url);
    if (url === '/api/1/nomenclature') return legacy.promise;
    assert.equal(url, '/api/menu/v3/by_id');
    return fixture();
  });
  h.state.useApi1Menu = true;
  const oldLoading = h.loadMenuApi1();
  h.state.useApi1Menu = false;
  await h.loadMenuApi3External();
  const currentMenu = h.state.menu;
  const currentResponse = h.state.menuModel;
  legacy.resolve({ revision: 999, products: [], productCategories: [] });
  await oldLoading;

  assert.deepEqual(calls, ['/api/1/nomenclature', '/api/menu/v3/by_id']);
  assert.equal(h.state.menu, currentMenu);
  assert.equal(h.state.menuModel, currentResponse);
  assert.equal(h.state.menu.apiVersion, 3);
  assert.equal(h.state.itemsFlat.length, 4);
  assert.equal(h.element('itemCount').textContent, '4');
  assert.equal(h.state.nomenclatureRevision, 0);
});

test('clearing organization-dependent state also invalidates an in-flight menu request', async () => {
  const h = harness();
  const model = loadFixture(h);
  control(h, 'data-add-item', model.itemCategories[0].items[0].itemSizes[0].placementKey).dispatch('click');
  h.state.stopLists = { terminalGroupStopLists: [] };
  h.state.lastOrderId = 'old-order';
  h.state.cancelCauses = [{ id: 'old-cause' }];
  h.state.paymentTypes = [{ id: 'old-payment' }];
  h.context.window._orderTypesFlat = [{ id: 'old-order-type' }];
  h.state.uiOpenCats.add('old-category');
  h.state.menuSizeSelections.old = 1;
  h.element('lastOrderIdDisplay').value = 'old-order';
  h.element('btnCancelOrder').disabled = false;
  const pending = deferred();
  h.stubApi(() => pending.promise);
  const loading = h.loadMenuApi3External();
  h.clearCloudMenuState();
  pending.resolve(fixture());
  await loading;
  assert.equal(h.state.menu, null);
  assert.equal(h.state.menuModel, null);
  assert.equal(h.state.itemsFlat.length, 0);
  assert.equal(h.state.cart.length, 0);
  assert.equal(Object.keys(h.state.builderSelections).length, 0);
  assert.equal(Object.keys(h.state.menuSizeSelections).length, 0);
  assert.equal(h.state.uiOpenCats.size, 0);
  assert.equal(h.state.stopLists, null);
  assert.equal(h.state.lastOrderId, null);
  assert.equal(h.state.cancelCauses.length, 0);
  assert.equal(h.state.paymentTypes.length, 0);
  assert.equal(h.context.window._orderTypesFlat.length, 0);
  assert.equal(h.element('lastOrderIdDisplay').value, '');
  assert.equal(h.element('btnCancelOrder').disabled, true);
  assert.equal(h.element('totalSum').textContent, '0.00');
});

test('deselecting the organization resets its dependent menus, terminals and cart without requests', async () => {
  const h = harness();
  loadFixture(h);
  h.state.externalMenus = [{ id: 'old-menu' }];
  h.state.externalMenuId = 'old-menu';
  h.state.priceCategories = [{ id: CATEGORY }];
  h.state.priceCategoryId = CATEGORY;
  h.state.terminalGroups = [{ id: 'old-terminal' }];
  h.state.terminalGroupId = 'old-terminal';
  h.state.terminalAlive.set('old-terminal', true);
  h.element('orgSelect').value = '';
  h.stubApi(() => { throw new Error('Empty organization must not send requests'); });
  await h.reloadOrgDeps();
  assert.equal(h.state.orgId, '');
  assert.equal(h.state.menu, null);
  assert.equal(h.state.externalMenuId, '');
  assert.equal(h.state.externalMenus.length, 0);
  assert.equal(h.state.priceCategoryId, null);
  assert.equal(h.state.priceCategories.length, 0);
  assert.equal(h.state.terminalGroupId, '');
  assert.equal(h.state.terminalGroups.length, 0);
  assert.equal(h.state.terminalAlive.size, 0);
  assert.equal(h.element('menuSelect').value, '');
  assert.equal(h.element('priceCatSelect').value, '');
  assert.equal(h.element('tgSelect').value, '');
});

test('v3 normalizer rejects a v2 response instead of silently producing an empty successful menu', () => {
  const h = harness();
  assert.throws(() => h.normalizeExternalMenuV3({ itemCategories: [] }, ORG), /itemsGroups/);
  assert.throws(() => h.normalizeExternalMenuV3([], ORG), /объект/);
  assert.equal(h.normalizeExternalMenuV3({ id: 'empty', name: 'Empty menu', itemsGroups: null }, ORG).itemCategories.length, 0);
});

test('application startup wires version filtering and Clear invalidates an actual pending menu load', async () => {
  const h = harness({ initialize: true });
  assert.equal(h.element('apiDocCount').textContent, String(h.catalogue.endpointCount));
  assert.ok(h.element('apiDocSource').textContent.includes('в спецификации'));
  h.element('apiStatusFilter').value = 'legacy';
  h.element('apiStatusFilter').dispatch('change');
  assert.ok(h.getFilteredApiEndpoints().every(endpoint => endpoint.deprecated || endpoint.sourceStatus === 'legacy'));
  assert.equal(h.element('btnApiSend').disabled, false);
  const pending = deferred();
  h.stubApi(() => pending.promise);
  const loading = h.loadMenuApi3External();
  h.element('btnClear').dispatch('click');
  pending.resolve(fixture());
  await loading;
  assert.equal(h.state.menu, null);
  assert.equal(h.state.menuModel, null);
  assert.equal(h.state.itemsFlat.length, 0);
  assert.equal(h.element('catCount').textContent, '0');
});
