import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = 'https://oferty.praca.gov.pl/portal/lista-ofert';
const OUTPUT_PATH = path.resolve('docs/oferty.json');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log('[Scraper] Uruchamianie Chromium z diagnostyką API/DOM...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  // Przechwytywanie zapytań JSON (wewnętrznego API ePraca)
  const apiCalls = [];
  page.on('response', async (res) => {
    try {
      const url = res.url();
      const ct = res.headers()['content-type'] || '';
      if (ct.includes('json') && url.includes('praca.gov.pl')) {
        const req = res.request();
        let preview = '';
        try {
          const txt = await res.text();
          preview = txt.slice(0, 350).replace(/\s+/g, ' ');
        } catch {}
        apiCalls.push({
          method: req.method(),
          status: res.status(),
          url,
          postData: (req.postData() || '').slice(0, 250),
          preview
        });
      }
    } catch {}
  });

  try {
    const response = await page.goto(BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    console.log(`[Diag] HTTP status: ${response?.status()} | Final URL: ${page.url()}`);

    // Poczekaj aż aplikacja SPA się załaduje i wykona zapytania sieciowe
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await delay(5000);

    const info = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map((a) => ({ text: clean(a.textContent).slice(0, 60), href: a.getAttribute('href') }))
        .filter((l) => l.href && !l.href.startsWith('#') && !l.href.startsWith('mailto:'));

      const inputs = Array.from(document.querySelectorAll('input, select')).map((el) => ({
        tag: el.tagName,
        type: el.getAttribute('type'),
        id: el.id,
        name: el.getAttribute('name'),
        placeholder: el.getAttribute('placeholder'),
        ariaLabel: el.getAttribute('aria-label')
      }));

      return {
        title: document.title,
        textLength: (document.body?.innerText || '').length,
        textPreview: clean(document.body?.innerText).slice(0, 500),
        totalLinks: links.length,
        sampleLinks: links.slice(0, 15),
        inputs: inputs.slice(0, 12)
      };
    });

    console.log(`[Diag] Tytuł strony: "${info.title}" | Długość tekstu: ${info.textLength}`);
    console.log(`[Diag] Fragment tekstu: ${info.textPreview}`);
    console.log(`[Diag] Pola formularza (${info.inputs.length}):`, JSON.stringify(info.inputs, null, 2));
    console.log(`[Diag] Przykładowe linki (${info.totalLinks} łącznie):`, JSON.stringify(info.sampleLinks, null, 2));

    console.log(`[Diag] Przechwycone zapytania API JSON (${apiCalls.length}):`);
    apiCalls.slice(0, 15).forEach((c, idx) => {
      console.log(`  #${idx + 1} [${c.method} ${c.status}] ${c.url}`);
      if (c.postData) console.log(`     Body: ${c.postData}`);
      if (c.preview) console.log(`     Resp: ${c.preview}`);
    });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[Scraper] Błąd krytyczny:', err);
  process.exit(1);
});
