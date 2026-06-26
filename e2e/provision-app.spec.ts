// Playwright: provision a push app in the admin dashboard — the P1 steps for
// polycule (create the app, require a wallet signature, add the frontend CORS
// origin, mint the PUSH_API_KEY). Selectors match dashboard/src/pages/Apps.tsx
// and AppDetail.tsx.
//
// The dashboard logs in with a thirdweb in-app wallet (Google/email) -> SIWE, and
// the server whitelists admin wallets via ADMIN_WALLETS. That login is interactive
// and admin-credentialed, so the script PAUSES for a manual login and then
// automates the rest. Run headed:
//
//   npm i -D @playwright/test && npx playwright install chromium
//   DASHBOARD_URL=https://<dashboard> APP_ID=polycule APP_NAME=Polycule \
//     CORS_ORIGIN=https://polycule.bet \
//     npx playwright test e2e/provision-app.spec.ts --headed
//
// NOTE: the Base verification RPC (SUBSCRIBE_VERIFY_RPC_URL) for smart-account
// (ERC-1271/6492) signatures is a push-SERVER env var, not a dashboard field —
// set it on the push service deploy separately. The dashboard only covers the
// app, the signature flag, CORS origins, and API keys.
import { test, expect } from "@playwright/test";

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "";
const APP_ID = process.env.APP_ID ?? "polycule";
const APP_NAME = process.env.APP_NAME ?? "Polycule";
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "https://polycule.bet";
const REQUIRE_SIG = (process.env.REQUIRE_SIG ?? "true") === "true";

test("provision push app", async ({ page }) => {
  test.skip(!DASHBOARD_URL, "set DASHBOARD_URL to the deployed admin dashboard");
  test.setTimeout(5 * 60_000); // includes the manual wallet login

  await page.goto(DASHBOARD_URL);

  // 1. Manual admin login (thirdweb in-app wallet -> SIWE). The Apps UI only
  //    renders the "Create" control once the wallet is authorized.
  console.log("\n>>> Log in with an ADMIN wallet (in ADMIN_WALLETS); the script then continues.\n");
  await expect(page.getByRole("button", { name: "Create" })).toBeVisible({ timeout: 5 * 60_000 });

  // 2. Create the app (idempotent — skip if it already exists).
  const appLink = page.getByRole("link", { name: APP_ID, exact: true });
  if ((await appLink.count()) === 0) {
    await page.getByPlaceholder("app-id").fill(APP_ID);
    await page.getByPlaceholder("Display name").fill(APP_NAME);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(appLink).toBeVisible();
  }

  // 3. Open the app detail page.
  await appLink.click();
  await expect(page.getByRole("heading", { name: APP_ID })).toBeVisible();

  // 4. Require a wallet signature to subscribe.
  const sig = page.getByLabel(/require a wallet signature to subscribe/i);
  if (REQUIRE_SIG && (await sig.count()) > 0 && !(await sig.isChecked())) await sig.check();

  // 5. Add the frontend CORS origin (skip if already listed).
  if ((await page.getByText(CORS_ORIGIN, { exact: false }).count()) === 0) {
    await page.getByPlaceholder("https://app.example.com").fill(CORS_ORIGIN);
    await page.getByRole("button", { name: "Add origin" }).click();
    await expect(page.getByText(CORS_ORIGIN, { exact: false })).toBeVisible();
  }

  // 6. Mint an API key and capture it (the server shows the secret exactly once).
  await page.getByPlaceholder("label (optional)").fill("polycule backend (PUSH_API_KEY)");
  await page.getByRole("button", { name: "Issue key" }).click();
  const issued = page.locator("p", { hasText: "shown once" }).locator("code").first();
  await expect(issued).toBeVisible();
  const key = (await issued.textContent())?.trim();
  console.log("\n>>> PUSH_API_KEY (store as the backend secret — shown once):\n" + key + "\n");
  expect(Boolean(key && key.length > 0)).toBeTruthy();
});
