"""Offline browser smoke tests. Every HTTP request is intercepted; no real keys/operations."""
import json
import shutil
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ORG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
FIXTURE = json.loads((ROOT / 'tests/fixtures/menu-v3.json').read_text())


def main():
    with sync_playwright() as pw:
        executable = shutil.which('chromium') or shutil.which('google-chrome')
        browser = pw.chromium.launch(headless=True, executable_path=executable, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1600, 'height': 1000})
        errors, requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))

        # The test has no network origin. Use an in-memory Storage stand-in.
        page.evaluate("Object.defineProperty(window, 'localStorage', {value: {getItem(){return null},setItem(){}}})")
        page.evaluate("""fixture => {
          window.mockRequests = [];
          window.fetch = async (url, options = {}) => {
            const path = '/' + (new URL(url).searchParams.get('path') || '');
            const body = options.body ? JSON.parse(options.body) : undefined;
            window.mockRequests.push({path,body});
            let response;
            if(path === '/api/nomenclature/v2/product/list') response = {items:[{productId:'test-product',name:'Тест номенклатуры без веба',type:'DISH',defaultSalePrice:125,parentGroupId:'test-group',defaultIncludedInMenu:true}],totalCount:1,offset:0};
            else if(path === '/api/nomenclature/v2/group/list') response = {groups:body.offset === 0 ? [{groupId:'test-group',name:'Тестовая кухня'}] : []};
            else if(path === '/api/menu/v3/by_id') response = fixture;
            else throw new Error('Blocked unexpected network call: ' + path);
            return new Response(JSON.stringify(response),{status:200,headers:{'Content-Type':'application/json'}});
          };
        }""", FIXTURE)
        page.set_content((ROOT / 'index.html').read_text())
        assert page.locator('#apiDocCount').inner_text() == '361', errors
        assert page.locator('#apiEndpointList .endpoint-row').count() == 361
        # Select every endpoint and verify valid editable JSON or a genuinely bodyless request.
        selected = page.evaluate('''() => {
          for (let i = 0; i < API_DOCS_EMBEDDED.endpoints.length; i++) {
            selectApiEndpoint(i);
            const e = API_DOCS_EMBEDDED.endpoints[i];
            if (e.hasRequestBody) JSON.parse($("apiBody").value);
            else if ($("apiBody").value !== "") throw new Error("Fabricated request body");
          }
          return API_DOCS_EMBEDDED.endpoints.length;
        }''')
        assert selected == 361
        page.evaluate('''org => {
          $("orgSelect").innerHTML = `<option value="${org}">Test organization</option>`;
          $("menuSelect").innerHTML = '<option value="15#3">Test external menu</option>';
          state.orgId = org; state.token = 'synthetic-test-token';
          state.paymentTypes = [{id:'preserve-payment'}];
          $("workerVC").value = 'http://127.0.0.1:12345/api/proxy';
        }''', ORG)
        page.locator('#useNomenclatureMenu').check()
        assert page.locator('#menuSelect').is_disabled()
        assert page.evaluate('state.paymentTypes[0].id') == 'preserve-payment'
        page.evaluate('loadMenu()')
        assert page.locator('#itemsList').get_by_text('Тест номенклатуры без веба', exact=True).count() == 1
        page.locator('details.cat > summary').first.click()
        page.locator('[data-add-item]').first.click()
        assert page.locator('#totalSum').inner_text() == '125.00'
        blocked = page.evaluate('''() => { try {buildCloudOrderItems(state.cart,state.orgId);return false;}catch(e){return e.message.includes('Подтверди');}}''')
        assert blocked
        page.locator('#catalogPricesConfirmed').check()
        assert page.evaluate('buildCloudOrderItems(state.cart,state.orgId)[0].price') == 125
        page.locator('#useNomenclatureMenu').uncheck()
        assert page.evaluate('state.cart.length') == 0
        assert not page.locator('#menuSelect').is_disabled()
        page.evaluate('loadMenu()')
        assert page.locator('#itemCount').inner_text() == '4'
        requests = page.evaluate('window.mockRequests')
        assert '/api/1/nomenclature' not in [r['path'] for r in requests]
        assert errors == [], errors
        print(json.dumps({'browser': 'Chromium', 'explorerTemplates': selected, 'menuModes': 2, 'pageErrors': len(errors), 'mockRequests': len(requests), 'liveRestaurantRequests': 0}))
        browser.close()

if __name__ == '__main__':
    main()
