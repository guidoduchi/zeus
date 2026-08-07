import { expect, test } from "@playwright/test";

test("the dashboard owns wheel scrolling and opens the ticket panel", async ({ page }) => {
  await page.goto("/");
  const rows = page.locator("[data-ticket-id]");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(25);

  const list = page.getByTestId("dashboard-scroll");
  const before = await page.evaluate(() => ({
    body: document.scrollingElement?.scrollTop || 0,
    list: document.querySelector<HTMLElement>(".ticket-scroll")?.scrollTop || 0,
  }));
  await list.hover();
  await page.mouse.wheel(0, 900);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(before.list);
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop || 0)).toBe(before.body);

  await rows.first().click();
  await expect(page.getByRole("complementary", { name: /SR \d{8} detail/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Work fields" })).toBeVisible();
});

test("field choices persist and a manual source query is visible", async ({ page }) => {
  await page.goto("/");
  const query = page.getByRole("button", { name: /Query data/ });
  await expect(query).toBeEnabled();

  await page.getByRole("button", { name: /Fields/ }).click();
  const severity = page.getByRole("checkbox", { name: "Severity" });
  await expect(severity).toBeChecked();
  await severity.uncheck();
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("zeus3.dashboard.columns") || "{}");
    return Array.isArray(saved.visible) && saved.visible.includes("severity");
  })).toBe(false);
  await page.reload();
  await expect(page.getByRole("columnheader", { name: "SR" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Severity" })).toHaveCount(0);

  await query.click();
  await page.getByRole("button", { name: "Operations" }).click();
  await expect(page.getByLabel("Active operation").getByText("Querying data sources", { exact: true })).toBeVisible();
});

test("saving through Pendings keeps the workstation mounted", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Query data/ })).toBeEnabled();

  await page.locator("[data-ticket-id]").first().click();
  await page.getByRole("button", { name: "Work fields" }).click();
  await page.getByLabel("Notes").fill("Saved from the real browser regression");
  await page.getByRole("button", { name: /Save through Pendings/ }).click();

  await expect(page.getByText(/saved through Pendings\.xlsx/i)).toBeVisible();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.getByRole("button", { name: "History" })).toBeVisible();
  await expect(page.getByLabel("Notes")).toHaveValue("Saved from the real browser regression");
});
