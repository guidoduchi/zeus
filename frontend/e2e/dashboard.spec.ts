import { expect, test } from "@playwright/test";

test("the dashboard wheel scrolls the table while activation remains click or Enter only", async ({ page }) => {
  await page.goto("/");
  const rows = page.locator("[data-ticket-id]");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(25);
  await expect(page.getByLabel("Service Requests summary")).toContainText("Pending");
  await expect(rows.first().locator(".column-done")).toHaveText("Pending");
  await expect(page.locator('[data-ticket-id="39400001"] .email-count-badge')).toHaveText("1");
  await expect(page.locator('[data-ticket-id="39400001"] .email-count-badge')).toHaveClass(/email-count-positive/);
  await expect(page.locator('[data-ticket-id="39400002"] .email-count-badge')).toHaveText("0");
  await expect(page.locator('[data-ticket-id="39400002"] .email-count-badge')).toHaveClass(/email-count-zero/);

  const list = page.getByTestId("dashboard-scroll");
  const before = await page.evaluate(() => ({
    body: document.scrollingElement?.scrollTop || 0,
    list: document.querySelector<HTMLElement>(".ticket-scroll")?.scrollTop || 0,
  }));
  await list.hover();
  await page.mouse.wheel(0, 900);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(before.list);
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop || 0)).toBe(before.body);
  await expect(page.locator(".ticket-row.selected")).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: /SR \d{8} detail/ })).toHaveCount(0);

  await list.focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".grid-status")).toContainText("Customer contact: Customer");
  await expect(page.locator(".grid-status")).not.toContainText(/Wheel/i);
  await expect(page.locator(".grid-status")).not.toContainText(/Enter opens/i);
  await expect(page.getByRole("complementary", { name: /SR \d{8} detail/ })).toHaveCount(0);
  await page.keyboard.press("Enter");
  const firstId = await rows.first().getAttribute("data-ticket-id");
  const secondId = await rows.nth(1).getAttribute("data-ticket-id");
  if (!firstId || !secondId) throw new Error("Expected two service-request rows");
  await expect(page.getByRole("complementary", { name: `SR ${firstId} detail` })).toBeVisible();
  await expect(page.locator(".grid-status")).not.toContainText("Customer contact:");
  await expect(page.getByRole("button", { name: "Work fields" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("complementary", { name: `SR ${secondId} detail` })).toBeVisible();
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
});

test("Escape closes details without losing the row cursor in either workspace", async ({ page }) => {
  await page.goto("/");
  const serviceRows = page.locator("[data-ticket-id]");
  const secondService = serviceRows.nth(1);
  const thirdService = serviceRows.nth(2);
  const secondServiceId = await secondService.getAttribute("data-ticket-id");
  const thirdServiceId = await thirdService.getAttribute("data-ticket-id");
  if (!secondServiceId || !thirdServiceId) throw new Error("Expected three service-request rows");

  await secondService.click();
  let serviceDetail = page.getByRole("complementary", { name: `SR ${secondServiceId} detail` });
  await serviceDetail.getByRole("button", { name: "Work fields" }).click();
  await serviceDetail.getByLabel("Notes").click();
  await page.keyboard.press("Escape");

  await expect(serviceDetail).toHaveCount(0);
  await expect(secondService).toHaveAttribute("aria-selected", "true");
  await expect(secondService).toHaveClass(/selected/);
  await expect(secondService).toBeFocused();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(secondService).toHaveClass(/selected/);

  await page.keyboard.press("Enter");
  serviceDetail = page.getByRole("complementary", { name: `SR ${secondServiceId} detail` });
  await expect(serviceDetail).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(secondService).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("complementary", { name: `SR ${thirdServiceId} detail` })).toHaveCount(0);
  await expect(thirdService).toHaveAttribute("aria-selected", "true");
  await expect(thirdService).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: `SR ${thirdServiceId} detail` })).toBeVisible();

  await page.getByRole("button", { name: "Spare Requests" }).click();
  const spareRows = page.locator("[data-row-id]");
  const firstSpare = spareRows.nth(0);
  const secondSpare = spareRows.nth(1);
  const firstRequestId = await firstSpare.getAttribute("data-row-id");
  const secondRequestId = await secondSpare.getAttribute("data-row-id");
  if (!firstRequestId || !secondRequestId) throw new Error("Expected two Spare Request rows");
  const firstSpareRequestId = firstRequestId.slice(0, 12);
  const secondSpareRequestId = secondRequestId.slice(0, 12);

  await firstSpare.click();
  let spareDetail = page.getByRole("complementary", { name: `Spare Request ${firstSpareRequestId} detail` });
  await spareDetail.getByLabel("Spare SR").click();
  await page.keyboard.press("Escape");

  await expect(spareDetail).toHaveCount(0);
  await expect(firstSpare).toHaveAttribute("aria-selected", "true");
  await expect(firstSpare).toHaveClass(/selected/);
  await expect(firstSpare).toBeFocused();

  await page.keyboard.press("Enter");
  spareDetail = page.getByRole("complementary", { name: `Spare Request ${firstSpareRequestId} detail` });
  await expect(spareDetail).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(firstSpare).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("complementary", { name: `Spare Request ${secondSpareRequestId} detail` })).toHaveCount(0);
  await expect(secondSpare).toHaveAttribute("aria-selected", "true");
  await expect(secondSpare).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: `Spare Request ${secondSpareRequestId} detail` })).toBeVisible();
});

test("Service Requests and Spare Requests switch as independent management views", async ({ page }) => {
  const sparePrefetch = page.waitForResponse((response) =>
    response.url().includes("/api/dashboard?")
      && response.url().includes("workspace=spare-requests")
      && response.ok()
  );
  await page.goto("/");
  const serviceRequests = page.getByRole("button", { name: "Service Requests" });
  const spareRequests = page.getByRole("button", { name: "Spare Requests" });
  await expect(serviceRequests).toHaveAttribute("aria-pressed", "true");
  await sparePrefetch;
  await page.evaluate(() => {
    (window as typeof window & { __zeusBootSeen?: boolean }).__zeusBootSeen = false;
    new MutationObserver(() => {
      if (document.querySelector(".boot-screen")) {
        (window as typeof window & { __zeusBootSeen?: boolean }).__zeusBootSeen = true;
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  await spareRequests.click();
  await expect(spareRequests).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Spare Requests summary")).toContainText("Active requests 1");
  await expect(page.getByLabel("Spare Requests summary")).toContainText("Unit items 2");
  await expect(page.getByRole("columnheader", { name: "RMA" })).toBeVisible();
  await expect(page.getByPlaceholder("Search TT, tracking ID, RMA, BOM, serial, site…")).toBeVisible();

  const spareRows = page.locator("[data-row-id]");
  await expect(spareRows.first()).toBeVisible();
  expect(await spareRows.count()).toBe(2);
  await spareRows.first().click();
  const detail = page.getByRole("complementary", { name: /Spare Request \d{12} detail/ });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("button", { name: /^Items/ })).toHaveClass(/active/);
  await expect(detail.getByText("Requested BOM").first()).toBeVisible();

  await serviceRequests.click();
  await expect(serviceRequests).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByPlaceholder("Search SR, summary, handler, site…")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Last Email" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Emails" })).toHaveCount(0);
  expect(await page.evaluate(() =>
    (window as typeof window & { __zeusBootSeen?: boolean }).__zeusBootSeen
  )).toBe(false);
});

test("eligible SR parts seed exports and completed items stay read-only", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Spare Requests" }).click();
  await page.getByRole("tab", { name: "Eligible SR Parts" }).click();
  const headers = page.locator(".grid-header [role=columnheader]");
  await expect(headers.first()).toHaveText("TT");

  const search = page.getByPlaceholder("Search TT, tracking ID, RMA, BOM, serial, site…");
  await search.fill("39400001");
  const eligible = page.locator('[data-row-id="39400001:1:1"]');
  await expect(eligible).toBeVisible();
  const eligibleGrid = page.getByRole("grid");
  await eligibleGrid.focus();
  await page.keyboard.press("ArrowDown");
  await expect(eligible).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("dialog", { name: "Export Spare Request" })).toHaveCount(0);
  await page.keyboard.press("Enter");
  const exportDialog = page.getByRole("dialog", { name: "Export Spare Request" });
  await expect(exportDialog).toBeVisible();
  await expect(exportDialog.getByLabel("TT · 8 digits")).toHaveValue("39400001");
  await exportDialog.getByLabel("Customer organization *").fill("Customer Network Team");
  await exportDialog.getByLabel("Customer email *").fill("customer@example.com");
  await exportDialog.getByLabel("Customer phone *").fill("+593980000000");
  await exportDialog.getByLabel("Site address *").fill("Guayaquil operations center");
  const alreadySent = exportDialog.getByRole("button", { name: "Already sent manually" });
  await expect(alreadySent).toBeEnabled();
  await alreadySent.click();
  await expect(page.getByRole("tab", { name: "Active Requests" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(/Registered as already sent manually/i)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Spare Request created" })).toHaveCount(0);

  await page.getByRole("tab", { name: "Completed" }).click();
  await search.fill("39400003");
  const archived = page.locator('[data-row-id="260807123456-0001"]');
  await expect(archived).toBeVisible();
  await expect(archived).toHaveAttribute("data-read-only", "true");
});

test("Escape on blank table space never outlines the entire work area", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Spare Requests" }).click();
  await page.getByRole("tab", { name: "Completed" }).click();
  await page.getByPlaceholder("Search TT, tracking ID, RMA, BOM, serial, site…").fill("no-such-record");
  await expect(page.getByText("No matching Spare Request items.")).toBeVisible();

  const grid = page.getByTestId("dashboard-scroll");
  await grid.click({ position: { x: 20, y: 120 } });
  await page.keyboard.press("Escape");
  await expect(page.locator(".ticket-row.selected")).toHaveCount(0);
  expect(await grid.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
});

test("Spare Request controls form two clean rows and collapse to icons", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Spare Requests" }).click();

  const tabs = page.getByRole("tablist", { name: "Spare Request view" });
  const search = page.getByPlaceholder("Search TT, tracking ID, RMA, BOM, serial, site…");
  const geometry = await page.locator(".dashboard-toolbar").evaluate((toolbar) => {
    const tabsBox = toolbar.querySelector(".spare-view-switcher")?.getBoundingClientRect();
    const searchBox = toolbar.querySelector(".search-box")?.getBoundingClientRect();
    const queryBox = toolbar.querySelector<HTMLButtonElement>('button[aria-label="Check Advanced Search"]')?.getBoundingClientRect();
    const fieldsBox = toolbar.querySelector<HTMLButtonElement>('button[aria-label="Fields"]')?.getBoundingClientRect();
    if (!tabsBox || !searchBox || !queryBox || !fieldsBox) throw new Error("Responsive toolbar controls missing");
    return {
      separateRows: tabsBox.bottom <= searchBox.top,
      controlsShareSecondRow: Math.abs(searchBox.top - queryBox.top) <= 1 && Math.abs(searchBox.top - fieldsBox.top) <= 1,
      fits: toolbar.scrollWidth <= toolbar.clientWidth + 1,
    };
  });
  expect(geometry).toEqual({ separateRows: true, controlsShareSecondRow: true, fits: true });
  await expect(tabs).toBeVisible();

  await page.evaluate(() => { document.documentElement.dataset.fontScale = "large"; });
  expect(await page.locator(".dashboard-controls").evaluate((controls) => controls.scrollWidth <= controls.clientWidth + 1)).toBe(true);
  expect(await page.getByRole("button", { name: "Check Advanced Search" }).locator(".toolbar-label").evaluate((element) => getComputedStyle(element).display)).toBe("none");

  await page.setViewportSize({ width: 1080, height: 900 });
  const query = page.getByRole("button", { name: "Check Advanced Search" });
  await expect(query).toBeVisible();
  expect(await query.locator(".toolbar-label").evaluate((element) => getComputedStyle(element).display)).toBe("none");
  await expect(page.getByRole("button", { name: "Manual request" })).toBeVisible();
  await expect(page.getByRole("button", { name: "BOM catalog" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Filters" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fields" })).toBeVisible();
  expect(await page.locator(".dashboard-toolbar").evaluate((toolbar) => {
    const searchBox = toolbar.querySelector(".search-box")?.getBoundingClientRect();
    const fieldsBox = toolbar.querySelector<HTMLButtonElement>('button[aria-label="Fields"]')?.getBoundingClientRect();
    return Boolean(searchBox && fieldsBox)
      && Math.abs(searchBox.top - fieldsBox.top) <= 1
      && toolbar.scrollWidth <= toolbar.clientWidth + 1;
  })).toBe(true);
});

test("field choices persist and a manual source query is visible", async ({ page }) => {
  await page.goto("/");
  const query = page.getByRole("button", { name: /Check Advanced Search/ });
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
  await expect(page.getByLabel("Active operation").getByText("Checking Advanced Search", { exact: true })).toBeVisible();
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
  await expect(page.getByLabel("Active operation").getByText("Checking Advanced Search", { exact: true })).toBeVisible();
});

test("saving to Zeus keeps the workstation mounted", async ({ page }, testInfo) => {
  const browserLabel = testInfo.project.name;
  const note = `Saved from the real browser regression (${browserLabel})`;
  const bomValue = `BOM-${browserLabel.toUpperCase()}`;
  const plannedDate = browserLabel === "edge" ? "2026-08-22" : "2026-08-21";
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Check Advanced Search/ })).toBeEnabled();

  await page.locator("[data-ticket-id]").first().click();
  await page.getByRole("button", { name: "Work fields" }).click();
  const planned = page.getByLabel("Planned Date");
  await expect(planned).toHaveAttribute("type", "date");
  await expect(page.getByLabel("Spare")).toHaveCount(0);
  await planned.fill(plannedDate);
  await page.getByLabel("Notes").fill(note);
  await page.getByRole("button", { name: /Save to Zeus/ }).click();

  await expect(page.getByText(/saved to the Zeus database/i)).toBeVisible();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.getByRole("button", { name: "History" })).toBeVisible();
  await expect(page.getByLabel("Notes")).toHaveValue(note);
  await expect(page.getByLabel("Planned Date")).toHaveValue(plannedDate);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("zeus3.ticket-draft.")).length)).toBe(0);
  await expect(page.getByRole("button", { name: /protected draft/i })).toHaveCount(0);
  await expect(page.getByText("No unsaved changes")).toBeVisible();

  const detail = page.getByRole("complementary", { name: /SR \d{8} detail/ });
  await detail.getByRole("button", { name: /^Spare Parts/ }).click();
  const bom = page.getByLabel("Device 1 part 1 BOM (part number)");
  await bom.fill(bomValue);
  await page.getByRole("button", { name: /Save to Zeus/ }).click();
  await expect(page.getByText(/saved to the Zeus database/i)).toBeVisible();
  await expect(bom).toHaveValue(bomValue);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("zeus3.ticket-draft.")).length)).toBe(0);
});

test("unsaved Work Fields survive open-detail arrow navigation and keyboard reload is blocked", async ({ page }) => {
  await page.goto("/");
  const rows = page.locator("[data-ticket-id]");
  const firstId = await rows.nth(0).getAttribute("data-ticket-id");
  const secondId = await rows.nth(1).getAttribute("data-ticket-id");
  if (!firstId || !secondId) throw new Error("Expected two service-request rows");
  expect(firstId).not.toBe(secondId);

  await rows.nth(0).click();
  const detail = page.getByRole("complementary", { name: /SR \d{8} detail/ });
  await detail.getByRole("button", { name: "Work fields" }).click();
  await detail.getByLabel("Notes").fill("Protected navigation draft");
  await page.locator(".stats-bar").click();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("complementary", { name: `SR ${secondId} detail` })).toBeVisible();
  await expect(page.locator(`[data-ticket-id="${secondId}"]`)).toBeFocused();
  await expect(page.locator(`[data-ticket-id="${secondId}"]`)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(new RegExp(`Unsaved SR ${firstId} draft kept safely`))).toBeVisible();
  await expect(page.getByRole("button", { name: "Work fields" })).toHaveClass(/active/);
  await expect(page.locator(`[data-ticket-id="${secondId}"]`)).toBeFocused();
  await expect(page.locator(`[data-ticket-id="${firstId}"]`)).toHaveClass(/draft-protected/);

  await page.locator(".stats-bar").click();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: /^Spare Parts/ })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: /^Spare Parts/ })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("button", { name: "Work fields" })).toBeFocused();

  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("complementary", { name: `SR ${firstId} detail` })).toBeVisible();
  await expect(page.locator(`[data-ticket-id="${firstId}"]`)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Notes")).toHaveValue("Protected navigation draft");
  await page.getByRole("button", { name: /1 protected draft/i }).click();
  const drafts = page.getByRole("dialog", { name: "Protected drafts" });
  await expect(drafts.getByText(`SR ${firstId}`)).toBeVisible();
  await expect(drafts.getByText("Notes", { exact: true })).toBeVisible();
  await drafts.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".stats-bar").click();
  await page.keyboard.press("Control+R");
  await expect(page.getByText(/Reload blocked: save or discard the protected draft first/i)).toBeVisible();
  await expect(page.getByLabel("Notes")).toHaveValue("Protected navigation draft");
});

test("Global data protects dirty forms and stays open after save", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Global data" }).click();
  const modal = page.getByRole("dialog", { name: "Global data" });
  await expect(modal.getByRole("button", { name: "Save global data" })).toBeDisabled();
  const globalDataLayout = await modal.evaluate((dialog) => {
    const navigation = dialog.querySelector(".global-category-grid")?.getBoundingClientRect();
    const manager = dialog.querySelector(".manager-workspace")?.getBoundingClientRect();
    if (!navigation || !manager) throw new Error("Global data layout missing");
    return {
      navigationIsLeft: navigation.right <= manager.left,
      navigationStartsLeft: navigation.left < manager.left,
    };
  });
  expect(globalDataLayout).toEqual({ navigationIsLeft: true, navigationStartsLeft: true });

  await modal.getByRole("button", { name: "Customer contacts", exact: true }).click();
  const srImport = modal.getByRole("combobox", { name: "Service Request to import" });
  await expect(modal.getByRole("listbox", { name: "Matching Service Requests" })).toHaveCount(0);
  await srImport.fill("394");
  const suggestions = modal.getByRole("listbox", { name: "Matching Service Requests" });
  await expect(suggestions).toBeVisible();
  await expect(suggestions.getByRole("option")).toHaveCount(30);
  expect(await suggestions.getByRole("option").evaluateAll((options) => options.every((option) => option.textContent?.includes("SR 394")))).toBe(true);
  const suggestionGeometry = await suggestions.evaluate((element) => ({
    bounded: element.clientHeight < element.scrollHeight,
    overflow: getComputedStyle(element).overflowY,
  }));
  expect(suggestionGeometry).toEqual({ bounded: true, overflow: "auto" });
  const suggestionScroll = await suggestions.evaluate((element) => element.scrollTop);
  await suggestions.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => suggestions.evaluate((element) => element.scrollTop)).toBeGreaterThan(suggestionScroll);

  await modal.getByRole("button", { name: "Customer organizations", exact: true }).click();
  await expect(modal.getByText("Customer organizations group customer contacts.")).toBeVisible();
  await modal.getByRole("button", { name: "+ Add" }).click();
  await modal.getByLabel("Customer organization *").fill(`E2E Organization ${testInfo.project.name}`);
  await expect(modal.getByRole("button", { name: "Close Global data" })).toBeDisabled();
  await expect(modal.getByRole("button", { name: "Save global data" })).toBeEnabled();
  await modal.getByRole("button", { name: "Save global data" }).click();

  await expect(page.getByText("Global data saved locally.")).toBeVisible();
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("button", { name: "Save global data" })).toBeDisabled();
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await expect(modal).toHaveCount(0);
});

test("work and spare editors remain bounded above the global command strip", async ({ page }) => {
  await page.goto("/");
  await page.locator("[data-ticket-id]").first().click();
  const detail = page.getByRole("complementary", { name: /SR \d{8} detail/ });
  await detail.getByRole("button", { name: "Work fields" }).click();
  const fieldScroll = detail.locator(".edit-tab-scroll");
  await fieldScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".detail-panel");
    const actions = document.querySelector<HTMLElement>(".edit-actions");
    const command = document.querySelector<HTMLElement>(".command-strip");
    const outer = document.querySelector<HTMLElement>(".bounded-edit-scroll");
    if (!panel || !actions || !command || !outer) throw new Error("Bounded editor elements missing");
    const panelBox = panel.getBoundingClientRect();
    const actionBox = actions.getBoundingClientRect();
    const commandBox = command.getBoundingClientRect();
    return {
      outerOverflow: getComputedStyle(outer).overflowY,
      outerFits: outer.scrollHeight <= outer.clientHeight + 1,
      actionsInsidePanel: actionBox.bottom <= panelBox.bottom + 1,
      panelBeforeCommand: panelBox.bottom <= commandBox.top + 1,
      actionsBeforeCommand: actionBox.bottom <= commandBox.top + 1,
    };
  });
  expect(geometry).toEqual({
    outerOverflow: "hidden",
    outerFits: true,
    actionsInsidePanel: true,
    panelBeforeCommand: true,
    actionsBeforeCommand: true,
  });

  await detail.getByRole("button", { name: /^Spare Parts/ }).click();
  await expect(detail.locator(".edit-actions")).toBeVisible();
  await expect(detail.locator(".edit-tab-scroll")).toBeVisible();
});

test("legacy reply chains stay compact inside bounded email panes", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-ticket-id="39400001"]').click();
  const detail = page.getByRole("complementary", { name: "SR 39400001 detail" });
  await detail.getByRole("button", { name: /Emails/ }).click();

  const list = detail.getByRole("listbox", { name: "Retained email replies" });
  const reader = detail.locator(".email-reader");
  const body = reader.locator("pre");
  await expect(list).toBeVisible();
  await expect(reader).toBeVisible();
  await expect(body).toContainText("Newest field response: the DIMM alarm is clear.");
  await expect(body).not.toContainText("Quoted historical line 240");
  await expect(detail.getByRole("button", { name: "Full thread" })).toBeVisible();

  const compactGeometry = await detail.evaluate((panel) => {
    const scroll = panel.querySelector<HTMLElement>(".email-detail-scroll");
    const listElement = panel.querySelector<HTMLElement>(".email-list");
    const readerElement = panel.querySelector<HTMLElement>(".email-reader");
    if (!scroll || !listElement || !readerElement) throw new Error("Email panes missing");
    const listBox = listElement.getBoundingClientRect();
    const readerBox = readerElement.getBoundingClientRect();
    const scrollBox = scroll.getBoundingClientRect();
    return {
      outerOverflow: getComputedStyle(scroll).overflowY,
      outerFits: scroll.scrollHeight <= scroll.clientHeight + 1,
      readerFollowsList: Math.abs(readerBox.top - listBox.bottom) <= 1,
      readerFits: readerBox.bottom <= scrollBox.bottom + 1,
    };
  });
  expect(compactGeometry).toEqual({
    outerOverflow: "hidden",
    outerFits: true,
    readerFollowsList: true,
    readerFits: true,
  });

  await detail.getByRole("button", { name: "Full thread" }).click();
  await expect(body).toContainText("Quoted historical line 240");
  await expect.poll(() => body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect.poll(() => detail.locator(".email-detail-scroll").evaluate(
    (element) => element.scrollHeight <= element.clientHeight + 1,
  )).toBe(true);
});
