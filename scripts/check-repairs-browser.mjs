import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.EKN_URL ?? 'http://localhost:18788';
execFileSync(process.execPath, ['scripts/seed-repairs.mjs'], { env: { ...process.env, EKN_URL: base } });
const browser = await chromium.launch({ channel: process.env.EKN_BROWSER ?? 'chrome' });
const password = 'synthetic-repair-demo';
const captures = resolve(process.env.EKN_SCREENSHOTS ?? '.wrangler/screenshots');
await mkdir(captures, { recursive: true });

async function login(name, locale, width = 390) {
  const context = await browser.newContext({
    locale, viewport: { width, height: 820 }, hasTouch: width < 768, isMobile: width < 768,
  });
  const page = await context.newPage();
  await page.goto(base + '/profile');
  await page.locator('[name=email]').fill(name + '@repair.example.invalid');
  await page.locator('[name=password]').fill(password);
  await page.locator('main form button[type=submit], main form button:not([type])').first().click();
  await page.locator('.identity').waitFor();
  await page.goto(base + '/');
  await page.locator('.dashboard-heading').waitFor();
  await page.locator('.dashboard-stats article').nth(3).waitFor();
  assert.equal(await page.locator('.dashboard-stats article').count(), 4);
  assert.equal(await page.locator('.achievement-list .achievement-item').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
  if (width === 390 && locale === 'ar') await page.screenshot({ path: resolve(captures, 'dashboard-ar-390.png'), fullPage: true });
  if (width === 1440 && locale === 'en') await page.screenshot({ path: resolve(captures, 'dashboard-en-1440.png'), fullPage: true });
  await page.goto(base + '/profile');
  await page.locator('.identity').waitFor();
  return page;
}

async function evaluate(page, decision) {
  await page.goto(base + '/reviews');
  await page.locator('.review-card button').first().click();
  for (const name of ['technical_plausibility', 'explanation_sufficient', 'resolution_consistency']) {
    await page.locator('[name=' + name + ']').selectOption('yes');
  }
  await page.locator('[name=overall_assessment]').selectOption(decision);
  await page.locator('[name=reasoning]').fill('Synthetic bench logs provide enough details for this assessment.');
  const sent = page.waitForResponse(response => /\/api\/v1\/me\/reviews\/[a-f0-9]{32}$/.test(response.url()) &&
    response.request().method() === 'POST');
  await page.locator('.review-card form button').click();
  assert.equal((await sent).status(), 200);
  await page.locator('.review-card form').waitFor({ state: 'hidden' });
}

const next = page => page.locator('[data-action=next-step]').click();

try {
  const author = await login('author', 'ar');
  assert.equal(await author.locator('html').getAttribute('dir'), 'rtl');
  await author.goto(base + '/cases');
  const drafts = author.waitForResponse(response => response.url().includes('/api/v1/me/submissions?') &&
    response.url().includes('status=draft') && response.status() === 200);
  await author.getByRole('button', { name: 'مسودة', exact: true }).click();
  await drafts;
  await author.locator('.record-link').first().waitFor();
  await author.locator('.record-link').first().click();
  assert.equal(await author.getByText('تنزيل كتقرير', { exact: false }).first().getAttribute('aria-disabled'), 'true');
  await author.getByRole('link', { name: 'تعديل المسودة' }).click();
  await next(author);
  await author.locator('#symptoms').fill('عطل تجريبي E-42/A');
  await author.getByRole('button', { name: 'حفظ المسودة' }).click();
  await author.getByRole('status').filter({ hasText: 'حُفظت المسودة.' }).waitFor();
  await author.reload();
  await next(author);
  assert.equal(await author.locator('#symptoms').inputValue(), 'عطل تجريبي E-42/A');
  await next(author);
  await author.locator('#review-consent').check();
  await author.getByRole('button', { name: 'إرسال للمراجعة' }).click();
  await author.waitForURL('**/cases/*');
  await author.getByText('قيد المراجعة', { exact: true }).waitFor();
  const first = await login('reviewer-a', 'de');
  const second = await login('reviewer-b', 'pl');
  await Promise.all([evaluate(first, 'valid'), evaluate(second, 'invalid')]);
  await author.reload();
  await author.getByText('غير حاسمة', { exact: true }).waitFor();

  const third = await login('reviewer-c', 'tr');
  await third.locator('.choice').nth(1).click();
  await third.locator('main form button').first().click();
  await third.locator('main form [role=status]').waitFor();
  await evaluate(third, 'valid');
  await author.reload();
  await author.getByText('خضعت لمراجعة الأقران', { exact: true }).waitFor();
  await author.goto(base + '/community');
  await author.getByText('عطل تجريبي E-42/A', { exact: true }).waitFor();
  await author.goto(base + '/leaderboard');
  await author.locator('.ranking-list li').first().waitFor();
  assert.equal(await author.locator('.ranking-list li').count(), 4);
  await third.goto(base + '/profile');
  await third.locator('.achievement-full .achievement-item').first().waitFor();
  assert.equal(await third.locator('.achievement-full .achievement-item').count(), 5);
  await third.locator('.choice').nth(1).click();
  await third.locator('main form button').first().click();
  await third.locator('main form [role=status]').waitFor();

  await author.goto(base + '/submit');
  await author.locator('#equipment_category').selectOption('hvac');
  await next(author);
  await author.locator('#symptoms').fill('توقف المروحة في المحاكاة');
  await next(author);
  await author.locator('#outcome').selectOption('unresolved');
  await author.locator('#source_type').selectOption('firsthand');
  assert.equal(await author.locator('#sharing_permission').isChecked(), false);
  await author.locator('#review-consent').check();
  await author.getByRole('button', { name: 'إرسال للمراجعة' }).click();
  await author.waitForURL('**/cases/*');
  const original = author.url();
  await Promise.all([evaluate(first, 'valid'), evaluate(second, 'needs_improvement')]);
  await author.reload();
  await author.getByText('يحتاج إلى توضيح', { exact: true }).waitFor();
  assert.equal(await author.getByText('Synthetic bench logs provide enough details for this assessment.', { exact: true }).count(), 2);
  await author.getByRole('button', { name: 'تعديل التقرير' }).click();
  await author.waitForURL('**/submit?draft=*');
  await next(author);
  await author.locator('#symptoms').fill('توقف المروحة في المحاكاة بعد إعادة التشغيل');
  await next(author);
  assert.equal(await author.locator('#review-consent').isChecked(), false);
  await author.locator('#review-consent').check();
  await author.getByRole('button', { name: 'إرسال للمراجعة' }).click();
  await author.waitForURL('**/cases/*');
  assert.notEqual(author.url(), original);
  await author.getByRole('link', { name: 'عرض التقرير السابق ومراجعاته' }).click();
  assert.equal(author.url(), original);
  await author.getByText('يحتاج إلى توضيح', { exact: true }).waitFor();

  for (const page of [author, first, second, third]) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  }
  const desktop = await login('author', 'en', 1440);
  await desktop.goto(base + '/submit');
  await desktop.locator('#equipment_category').selectOption('hvac');
  await desktop.locator('#manufacturer').fill('Desktop Test');
  await next(desktop);
  await desktop.locator('#symptoms').fill('Synthetic desktop test of a reported repair.');
  await desktop.getByRole('button', { name: 'Back', exact: true }).click();
  assert.equal(await desktop.locator('#manufacturer').inputValue(), 'Desktop Test');
  await next(desktop);
  assert.equal(await desktop.locator('#symptoms').inputValue(), 'Synthetic desktop test of a reported repair.');
  await next(desktop);
  await desktop.locator('#outcome').selectOption('resolved');
  await desktop.locator('#source_type').selectOption('firsthand');
  await desktop.getByRole('button', { name: 'Submit for review' }).click();
  assert.equal(await desktop.locator(':focus').getAttribute('id'), 'resolution');
  await desktop.locator('#resolution').fill('Synthetic bench adjustment.');
  await desktop.locator('#review-consent').check();
  assert.equal(await desktop.locator('#sharing_permission').isChecked(), false);
  await desktop.getByRole('button', { name: 'Submit for review' }).click();
  await desktop.waitForURL('**/cases/*');
  await desktop.getByText('Synthetic bench adjustment.', { exact: true }).waitFor();
  assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth), 1440);
  console.log('Desktop Chrome passed steps, conditional validation and private submission.');
  console.log('Mobile Chrome passed draft save/reload, consent, structured assessment, disagreement, escalation, clarification, preserved history, community publication and ranking.');
} finally {
  await browser.close();
}
