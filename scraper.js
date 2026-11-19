import { chromium } from 'playwright';

const BASE_URL = 'https://oferty.praca.gov.pl/portal/lista-ofert';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log('[Diag2] Start analizy ładowania Angulara i endpointów portal-api...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    viewport: { width: 1366, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  const errors = [];
  const apiCalls = [];
  const discoveredEndpoints = new Set();

  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      errors.push(`CONSOLE[${msg.type()}]: ${msg.text().slice(0, 220)}`);
    }
  });
  page.on('requestfailed', (req) => {
    errors.push(`REQ_FAIL: ${req.url()} -> ${req.failure()?.errorText}`);
  });

  page.on('response', async (res) => {
    try {
      const url = res.url();
      const ct = res.headers()['content-type'] || '';

      // 1. Przechwyć wszystkie wywołania portal-api
      if (url.includes('portal-api')) {
        const req = res.request();
        let bodyPreview = '';
        try {
          bodyPreview = (await res.text()).slice(0, 900).replace(/\s+/g, ' ');
        } catch {}
        apiCalls.push({
          method: req.method(),
          status: res.status(),
          url,
          postData: (req.postData() || '').slice(0, 500),
          bodyPreview
        });
      }

      // 2. Zeskanuj pliki JS aplikacji pod kątem ścieżek API ofert
      if (url.includes('oferty.praca.gov.pl/portal/') && (url.endsWith('.js') || ct.includes('javascript'))) {
        const js = await res.text();
        const matches = js.match(/["'`](\/v\d+\/[a-zA-Z0-9/_-]*oferta[a-zA-Z0-9/_-]*|\/[a-zA-Z0-9/_-]*wyszukiw[a-zA-Z0-9/_-]*|\/[a-zA-Z0-9/_-]*teryt[a-zA-Z0-9/_-]*)["'`]/gi);
        if (matches) {
          matches.forEach((m) => discoveredEndpoints.add(m.replace(/["'`]/g, '')));
        }
      }
    } catch {}
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    const start = Date.now();
    const rendered = await page
      .waitForFunction(() => (document.body?.innerText || '').trim().length > 80, { timeout: 25000 })
      .then(() => true)
      .catch(() => false);

    console.log(`[Diag2] Wyrenderowano treść: ${rendered} (po ${((Date.now() - start) / 1000).toFixed(1)} s)`);
    if (rendered) await delay(3000);

    const domInfo = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      return {
        url: location.href,
        textLength: (document.body?.innerText || '').length,
        textPreview: clean(document.body?.innerText).slice(0, 500),
        htmlPreview: (document.body?.innerHTML || '').slice(0, 400).replace(/\s+/g, ' ')
      };
    });

    console.log(`[Diag2] Final URL: ${domInfo.url} | Długość tekstu: ${domInfo.textLength}`);
    console.log(`[Diag2] Tekst: ${domInfo.textPreview}`);
    if (domInfo.textLength === 0) {
      console.log(`[Diag2] HTML body: ${domInfo.htmlPreview}`);
    }

    console.log(`[Diag2] Błędy/Ostrzeżenia (${errors.length}):`);
    errors.slice(0, 15).forEach((e) => console.log('  -', e));

    console.log(`[Diag2] Wywołania portal-api (${apiCalls.length}):`);
    apiCalls.slice(0, 15).forEach((c, i) => {
      console.log(`  #${i + 1} [${c.method} ${c.status}] ${c.url}`);
      if (c.postData) console.log(`     POST: ${c.postData}`);
      if (c.bodyPreview) console.log(`     RESP: ${c.bodyPreview}`);
    });

    console.log(`[Diag2] Ścieżki API znalezione w kodzie JS (${discoveredEndpoints.size}):`);
    Array.from(discoveredEndpoints).slice(0, 40).forEach((ep) => console.log('  *', ep));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[Diag2] Błąd krytyczny:', err);
  process.exit(1);
});
