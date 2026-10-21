/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test, expect } from '@playwright/test';

test('App signs in and lands on the GenAI stacks', async ({ page }) => {
  await page.goto('/');

  const enterButton = page.getByRole('button', { name: 'Enter' });
  await expect(enterButton).toBeVisible();
  await enterButton.click();

  await expect(page).toHaveURL(/\/basis\/stacks$/);
  const nav = page.getByRole('navigation', { name: 'sidebar nav' });
  await expect(nav.getByRole('link', { name: 'GenAI stacks', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Model gateways', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'PostgreSQL', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Audit logs', exact: true })).toBeVisible();
});
