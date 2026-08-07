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

test("window commands and sort direction work outside editable fields", async ({ page }) => {
  await page.goto("/");
  const sort = page.getByLabel("Sort field");
  const direction = page.getByLabel("Sort direction");
  const search = page.getByPlaceholder("Search SR, summary, handler, site…");

  await expect(sort).toHaveValue("report");
  await page.locator(".stats-bar").click();
  await page.keyboard.press("s");
  await expect(sort).toHaveValue("sr");
  await expect(direction).toHaveValue("desc");

  await direction.selectOption("asc");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("zeus3.dashboard.direction"))).toBe("asc");
  await page.reload();
  await expect(sort).toHaveValue("sr");
  await expect(direction).toHaveValue("asc");

  await search.click();
  await page.keyboard.type("s");
  await expect(sort).toHaveValue("sr");
  await search.fill("");
  await page.locator(".stats-bar").click();
  await page.keyboard.press("m");
  await expect(page.getByRole("dialog", { name: "Zeus operations" })).toBeVisible();
  await page.getByRole("button", { name: "Close Zeus operations" }).click();

  await page.keyboard.press("r");
  await expect(page.getByLabel("Active operation").getByText("Querying data sources", { exact: true })).toBeVisible();
});

test("saving through Pendings keeps the workstation mounted", async ({ page }, testInfo) => {
  const browserLabel = testInfo.project.name;
  const note = `Saved from the real browser regression (${browserLabel})`;
  const bomValue = `BOM-${browserLabel.toUpperCase()}`;
  const plannedDate = browserLabel === "edge" ? "2026-08-22" : "2026-08-21";
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Query data/ })).toBeEnabled();

  await page.locator("[data-ticket-id]").first().click();
  await page.getByRole("button", { name: "Work fields" }).click();
  const planned = page.getByLabel("Planned Date");
  const bom = page.getByLabel("BOM");
  const spare = page.getByLabel("Spare");
  await expect(planned).toHaveAttribute("type", "date");
  await expect(spare).not.toBeEditable();
  await bom.fill("");
  await expect(spare).toHaveValue("N");
  await bom.fill(bomValue);
  await expect(spare).toHaveValue("Y");
  await planned.fill(plannedDate);
  await page.getByLabel("Notes").fill(note);
  await page.getByRole("button", { name: /Save through Pendings/ }).click();

  await expect(page.getByText(/saved through Pendings\.xlsx/i)).toBeVisible();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.getByRole("button", { name: "History" })).toBeVisible();
  await expect(page.getByLabel("Notes")).toHaveValue(note);
  await expect(page.getByLabel("Planned Date")).toHaveValue(plannedDate);
  await expect(page.getByLabel("Spare")).toHaveValue("Y");
});
