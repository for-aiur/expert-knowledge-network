import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.EKN_URL ?? 'http://localhost:8787';
const captures = resolve(process.env.EKN_SCREENSHOTS ?? '.wrangler/screenshots');
const config = JSON.parse(await readFile(new URL('../src/generated/workflows.json', import.meta.url)));
const locales = ['en', 'de', 'tr', 'pl', 'ru', 'ar'];
const widths = [360, 375, 390, 430, 768, 1440];
const browser = await chromium.launch({ channel: process.env.EKN_BROWSER ?? 'chrome' });
await mkdir(captures, { recursive: true });

async function layout(page, detail) {
  const issues = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const problems = [];
    if (document.documentElement.scrollWidth !== viewport) problems.push('horizontal overflow');
    for (const node of document.querySelectorAll('nav a, button, input:not([type=checkbox]), select, textarea, .choice, .button, summary')) {
      if (node.closest('details:not([open])') && node.tagName !== 'SUMMARY') continue;
      const rect = node.getBoundingClientRect();
      if (rect.height < 44 || rect.left < -1 || rect.right > viewport + 1 || node.scrollWidth > node.clientWidth + 2) {
        problems.push(node.textContent.trim().slice(0, 70) || node.name || node.tagName);
      }
    }
    return problems;
  });
  assert.deepEqual(issues, [], detail);
}

async function visit(page, path, heading) {
  await page.goto(base + path);
  await page.locator('h1').filter({ hasText: heading }).waitFor();
}

try {
  for (const locale of locales) {
    const strings = JSON.parse(await readFile(new URL('../src/i18n/' + locale + '.json', import.meta.url)));
    for (const width of widths) {
      const context = await browser.newContext({ locale, viewport: { width, height: width > 768 ? 950 : 820 },
        hasTouch: width < 768, isMobile: width < 768, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await visit(page, '/', strings.hero);
      assert.equal(await page.locator('html').getAttribute('lang'), locale);
      assert.equal(await page.locator('html').getAttribute('dir'), locale === 'ar' ? 'rtl' : 'ltr');
      await layout(page, locale + ' ' + width + ' home');
      const capture = (locale === 'en' && [360, 768, 1440].includes(width)) || (locale === 'ar' && width === 390);
      if (capture) await page.screenshot({ path: resolve(captures, `home-${locale}-${width}.png`) });
      await page.locator('nav a[href="/profile"]').click();
      await page.getByRole('heading', { name: strings.signIn }).waitFor();
      await layout(page, locale + ' ' + width + ' login');
      await page.getByRole('button', { name: strings.create }).click();
      await page.getByRole('heading', { name: strings.create }).waitFor();
      await layout(page, locale + ' ' + width + ' signup');
      assert.equal(await page.locator('input[name=email]').getAttribute('type'), 'email');
      assert.equal(await page.locator('input[name=password]').getAttribute('autocomplete'), 'new-password');
      await page.getByRole('button', { name: strings.continue }).click();
      await page.getByRole('alert').filter({ hasText: strings.fieldEmail }).waitFor();
      assert.equal(await page.locator(':focus').getAttribute('name'), 'email');
      await page.locator('nav a[href="/submit"]').click();
      await page.getByRole('heading', { name: strings.newRepair, exact: true }).waitFor();
      const workflow = config.workflows.find(item => item.type === 'repair_case');
      assert.equal(await page.locator('#proposed_diagnosis, #symptoms').count(), 0);
      const expected = ['equipment_category', 'manufacturer', 'model', 'fault_code'];
      for (const field of workflow.fields.filter(field => expected.includes(field.name))) {
        assert.ok((await page.locator('label[for="' + field.name + '"]').textContent()).includes(field.label[locale]));
      }
      assert.equal(await page.locator('#equipment_category option[value=hvac]').textContent(),
        config.categories.find(category => category.value === 'hvac').label[locale]);
      await layout(page, locale + ' ' + width + ' equipment');
      if (capture) {
        await page.locator('.repair-details summary').click();
        await page.locator('#fault_code').fill('E-42/A');
        assert.equal(await page.locator('#fault_code').getAttribute('dir'), 'ltr');
        await page.screenshot({ path: resolve(captures, `repair-${locale}-${width}.png`), fullPage: true });
      }
      await page.locator('#equipment_category').selectOption('hvac');
      await page.locator('[data-action=next-step]').click();
      assert.equal(await page.locator('#repair-step-heading').innerText(), strings.problemStep);
      assert.equal(await page.getByText(strings.dictate, { exact: false }).filter({ hasText: strings.comingSoon }).first()
        .getAttribute('aria-disabled'), 'true');
      await layout(page, locale + ' ' + width + ' problem');
      await page.locator('#symptoms').fill('Synthetic example');
      await page.locator('[data-action=next-step]').click();
      assert.equal(await page.locator('#repair-step-heading').innerText(), strings.outcomeStep);
      assert.equal(await page.locator('#sharing_permission').isChecked(), false);
      await layout(page, locale + ' ' + width + ' outcome');
      await page.locator('nav a[href="/cases"]').click();
      await page.getByRole('heading', { name: strings.reports }).waitFor();
      await layout(page, locale + ' ' + width + ' reports');
      await page.locator('nav a[href="/reviews"]').click();
      await page.getByRole('heading', { name: strings.reviews }).waitFor();
      await layout(page, locale + ' ' + width + ' reviews');
      await page.locator('nav a[href="/leaderboard"]').click();
      await page.getByRole('heading', { name: strings.leaderboard }).waitFor();
      await layout(page, locale + ' ' + width + ' leaderboard');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log(locale + ': all six viewports passed');
  }

  const context = await browser.newContext({ locale: 'fr-CA', viewport: { width: 390, height: 820 },
    isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await visit(page, '/profile', 'Sign in');
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.locator('header select').selectOption('ar');
  await page.reload();
  await page.getByRole('heading', { name: 'تسجيل الدخول' }).waitFor();
  assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
  await page.getByRole('button', { name: 'إنشاء حساب' }).click();
  const email = 'browser-' + Date.now() + '@example.invalid';
  const password = 'synthetic-test-password';
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill(password);
  await page.locator('input[name=nickname]').fill('ورشة E-42');
  await page.getByRole('button', { name: 'متابعة' }).click();
  await page.getByRole('heading', { name: 'إعداد ملفك الشخصي' }).waitFor();
  await page.locator('.choice').nth(0).click();
  await page.locator('.choice').nth(1).click();
  await layout(page, 'Arabic onboarding');
  await page.screenshot({ path: resolve(captures, 'onboarding-ar-390.png'), fullPage: true });
  await page.getByRole('button', { name: 'حفظ مجالات الخبرة' }).click();
  await page.locator('.account-actions select').selectOption('pl');
  await page.reload();
  await page.getByRole('heading', { name: 'Profil' }).waitFor();
  assert.equal(await page.locator('.choice input:checked').count(), 2);
  await page.locator('.choice').nth(0).click();
  await page.getByRole('button', { name: 'Zapisz obszary doświadczenia' }).click();
  await page.getByRole('status').filter({ hasText: 'Zapisano obszary doświadczenia.' }).waitFor();
  await layout(page, 'Polish profile');
  await page.screenshot({ path: resolve(captures, 'profile-pl-390.png'), fullPage: true });
  await page.getByRole('button', { name: 'Wyloguj się' }).click();
  await page.getByRole('heading', { name: 'Zaloguj się' }).waitFor();
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
  await page.getByRole('heading', { name: 'Profil' }).waitFor();
  assert.equal(await page.locator('.choice input:checked').count(), 1);
  await page.locator('header select').selectOption('ar');
  await page.locator('nav a[href="/submit"]').click();
  const next = page.locator('[data-action=next-step]');
  await next.click();
  await page.getByRole('alert').filter({ hasText: 'تحقق من الحقول المميزة.' }).waitFor();
  assert.equal(await page.locator(':focus').getAttribute('id'), 'equipment_category');
  await page.locator('#equipment_category').selectOption('hvac');
  await next.click();
  await next.click();
  assert.equal(await page.locator(':focus').getAttribute('id'), 'symptoms');
  await page.locator('#symptoms').fill('العطل E-42/A');
  await page.locator('header select').selectOption('de');
  assert.equal(await page.locator('html').getAttribute('dir'), 'ltr');
  assert.equal(await page.locator('#symptoms').inputValue(), 'العطل E-42/A');
  await page.locator('header select').selectOption('ar');
  await next.click();
  await page.locator('#outcome').selectOption('resolved');
  assert.equal(await page.locator('#resolution').getAttribute('required'), '');
  await page.locator('#outcome').selectOption('unresolved');
  await page.locator('#source_type').selectOption('firsthand');
  assert.equal(await page.locator('#sharing_permission').isChecked(), false);
  await page.getByRole('button', { name: 'إرسال للمراجعة' }).click();
  assert.equal(await page.locator(':focus').getAttribute('id'), 'review-consent');
  await page.getByRole('button', { name: 'رجوع' }).click();
  assert.equal(await page.locator('#symptoms').inputValue(), 'العطل E-42/A');
  await context.close();
  console.log('Browser fallback, language persistence, registration, expertise editing, logout/login and repair steps passed');
} finally {
  await browser.close();
}
