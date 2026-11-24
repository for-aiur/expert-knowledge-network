import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const base = process.env.EKN_URL ?? 'http://localhost:8788';
const key = process.env.EKN_CLIENT_KEY;
if (!key) throw new Error('A local client key and the synthetic repair seed are required.');
const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() };
for (const name of ['reviewer-a', 'reviewer-b']) {
  const login = await fetch(base + '/api/login', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: name + '@repair.example.invalid', password: 'synthetic-repair-demo' }),
  });
  assert.equal(login.status, 200);
  const profile = await fetch(base + '/api/profile/expertise', {
    method: 'PUT', headers: { Origin: base, 'Content-Type': 'application/json', Cookie: login.headers.get('Set-Cookie').split(';')[0] },
    body: JSON.stringify({ expertise: ['hvac', 'industrial_equipment'] }),
  });
  assert.equal(profile.status, 200);
}
const context = 'إشارة D-17 لا تظهر في المحاكي.';
const created = await fetch(base + '/api/v1/tasks', { method: 'POST', headers, body: JSON.stringify({
  schema_version: 1, equipment_category: 'industrial_equipment', content_language: 'ar', symptoms: context,
  proposed_diagnosis: 'Synthetic simulator input is unrecognized.',
  recommended_next_steps: 'Inspect the simulator event log.',
}) });
assert.equal(created.status, 201);
const { id } = await created.json();

const browser = await chromium.launch({ channel: process.env.EKN_BROWSER ?? 'chrome' });
try {
  for (const [name, locale, title, width] of [
    ['reviewer-a', 'ar', 'مراجعة التشخيص', 390],
    ['reviewer-b', 'de', 'Diagnoseprüfung', 1440],
  ]) {
    const session = await browser.newContext({ locale, viewport: { width, height: 820 }, hasTouch: width < 768, isMobile: width < 768 });
    const page = await session.newPage();
    await page.goto(base + '/profile');
    await page.locator('[name=email]').fill(name + '@repair.example.invalid');
    await page.locator('[name=password]').fill('synthetic-repair-demo');
    await page.locator('main form button:not([type])').first().click();
    await page.locator('.identity').waitFor();
    await page.goto(base + '/reviews');
    const task = page.locator('.review-card').filter({ hasText: context });
    await task.getByText(title, { exact: true }).waitFor();
    await task.locator('button').click();
    assert.equal(await page.locator('html').getAttribute('dir'), locale === 'ar' ? 'rtl' : 'ltr');
    assert.equal(await task.locator('[name=resolution_consistency]').count(), 0);
    await task.locator('[name=technical_plausibility]').selectOption('yes');
    await task.locator('[name=next_step_safety]').selectOption('safe');
    await task.locator('[name=explanation_sufficient]').selectOption('yes');
    await task.locator('[name=overall_assessment]').selectOption('valid');
    await task.locator('[name=reasoning]').fill('The supplied simulator log would be an appropriate source of evidence.');
    const response = page.waitForResponse(item => /\/api\/v1\/me\/reviews\/[a-f0-9]{32}$/.test(item.url()) &&
      item.request().method() === 'POST');
    await task.locator('form button').click();
    assert.equal((await response).status(), 200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    await session.close();
  }
  const response = await fetch(base + '/api/v1/tasks/' + id, { headers });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 'peer_reviewed');
  assert.equal(result.reviews.length, 2);
  console.log('Diagnosis Review Queue passed at Arabic 390 px and German 1440 px; client received both anonymized reviews.');
} finally {
  await browser.close();
}
