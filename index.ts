import { Stagehand } from "@browserbasehq/stagehand";
import fs from "fs";
import { pipeline } from "stream/promises";

const AUTH_COOKIE_NAMES = new Set([
  "access_token_web",
  "refresh_token_web",
  "_vinted_fr_session",
]);

function normalizeCookieDomain(domain: string | undefined, domainName: string): string {
  let clean = (domain || `.${domainName}`).trim();
  // Playwright rejects odd hosts like ".www.vinted.pt"; collapse www → apex.
  clean = clean.replace(/^\.?www\./i, ".");
  if (!clean.includes(domainName) && !clean.endsWith(".com")) {
    clean = `.${domainName}`;
  }
  if (!clean.startsWith(".") && clean !== "localhost") {
    // Keep host-only cookies as-is; apex session cookies use leading dot.
    if (clean === domainName || clean === `www.${domainName}`) {
      clean = `.${domainName}`;
    }
  }
  return clean;
}

function sanitizeCookies(
  rawCookies: any[],
  domainName: string
): { cookies: any[]; skippedEmpty: number; authPresent: string[] } {
  const cookies: any[] = [];
  let skippedEmpty = 0;
  const authPresent: string[] = [];

  for (const cookie of rawCookies) {
    const value = cookie?.value == null ? "" : String(cookie.value);
    if (!value) {
      skippedEmpty += 1;
      continue;
    }

    const cleanDomain = normalizeCookieDomain(cookie.domain, domainName);
    const cleanCookie: any = {
      name: cookie.name,
      value,
      domain: cleanDomain,
      path: cookie.path || "/",
      secure: typeof cookie.secure === "boolean" ? cookie.secure : true,
      httpOnly: typeof cookie.httpOnly === "boolean" ? cookie.httpOnly : false,
    };

    if (cookie.sameSite) {
      const val = String(cookie.sameSite).toLowerCase();
      if (val === "lax") cleanCookie.sameSite = "Lax";
      else if (val === "strict") cleanCookie.sameSite = "Strict";
      else if (val === "none" || val === "no_restriction") {
        cleanCookie.sameSite = "None";
        cleanCookie.secure = true;
      }
    }

    if (cookie.expirationDate) {
      cleanCookie.expires = Math.floor(cookie.expirationDate);
    }

    cookies.push(cleanCookie);
    if (AUTH_COOKIE_NAMES.has(String(cookie.name))) {
      authPresent.push(`${cookie.name}(len=${value.length},domain=${cleanDomain})`);
    }
  }

  return { cookies, skippedEmpty, authPresent };
}

async function main() {
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY;

  if (!apiKey) {
    throw new Error("Missing Gemini/Google API Key environment variable.");
  }

  process.env.GEMINI_API_KEY = apiKey;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
  process.env.GOOGLE_API_KEY = apiKey;

  const BASE_URL = process.env.VINTED_DOMAIN || "https://www.vinted.pt";
  const NEW_ITEM_URL = `${BASE_URL.replace(/\/$/, "")}/items/new`;
  const urlObj = new URL(BASE_URL);
  const domainName = urlObj.hostname.replace(/^www\./, "");

  const stagehand = new Stagehand({
    env: "LOCAL",
    modelName: "google/gemini-3.8-flash",
    modelClientOptions: {
      apiKey,
    },
    localBrowserLaunchOptions: {
      headless: false,
      locale: "pt-PT",
      args: ["--disable-blink-features=AutomationControlled"],
    },
  });

  await stagehand.init();

  if (!stagehand.llmClient) {
    throw new Error(
      "Stagehand LLM client failed to initialize. Check GEMINI_API_KEY / modelName."
    );
  }

  const page = stagehand.page;
  const context = page.context();

  // Locale only — do not spoof a mismatched Chrome UA (triggers Datadome).
  await context.setExtraHTTPHeaders({
    "accept-language": "pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  });

  const imageUrls = (process.env.IMAGE_URLS || "")
    .split(",")
    .map((url) => url.trim());
  const downloadedPaths: string[] = [];
  let exitCode = 0;

  try {
    console.log("Downloading images...");
    for (let i = 0; i < imageUrls.length; i++) {
      if (!imageUrls[i]) continue;
      const path = `./temp-photo-${i}.jpg`;
      const response = await fetch(imageUrls[i]);
      if (!response.ok) throw new Error(`Failed to fetch image at index ${i}`);
      await pipeline(response.body as any, fs.createWriteStream(path));
      downloadedPaths.push(path);
    }

    if (!process.env.VINTED_COOKIES) {
      console.error("Error: VINTED_COOKIES environment variable is missing.");
      exitCode = 1;
      return;
    }

    console.log("Parsing and sanitizing VINTED_COOKIES secret...");
    const rawCookies = JSON.parse(process.env.VINTED_COOKIES);
    if (!Array.isArray(rawCookies)) {
      throw new Error("VINTED_COOKIES must be a JSON array of cookie objects.");
    }

    const { cookies: sanitizedCookies, skippedEmpty, authPresent } = sanitizeCookies(
      rawCookies,
      domainName
    );

    console.log(
      `Cookies: kept=${sanitizedCookies.length} skippedEmpty=${skippedEmpty} auth=[${authPresent.join(", ") || "none"}]`
    );

    if (sanitizedCookies.length === 0) {
      console.error("Error: VINTED_COOKIES contained no non-empty cookie values.");
      exitCode = 1;
      return;
    }

    if (authPresent.length === 0) {
      console.error(
        "Error: No auth cookies (access_token_web / refresh_token_web / _vinted_fr_session) with values."
      );
      exitCode = 1;
      return;
    }

    // Establish site context, then inject cookies, then open the listing form.
    console.log(`Warming session on ${BASE_URL}...`);
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);

    console.log(`Injecting ${sanitizedCookies.length} cookies...`);
    await context.addCookies(sanitizedCookies);

    console.log(`Navigating to ${NEW_ITEM_URL}...`);
    await page.goto(NEW_ITEM_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);

    let currentUrl = page.url();
    console.log(`Current page URL: ${currentUrl}`);

    if (!currentUrl.includes("/items/new")) {
      console.log("Not on /items/new yet — re-injecting cookies and retrying once...");
      await context.addCookies(sanitizedCookies);
      await page.goto(NEW_ITEM_URL, { waitUntil: "load", timeout: 60000 });
      await page.waitForTimeout(4000);
      currentUrl = page.url();
      console.log(`Retry page URL: ${currentUrl}`);
    }

    if (
      currentUrl.includes("register") ||
      currentUrl.includes("select_type") ||
      currentUrl.includes("login")
    ) {
      console.error(
        "Authentication Error: Vinted redirected to login/register. Refresh VINTED_COOKIES (expired) or Datadome blocked the runner IP."
      );
      exitCode = 1;
      return;
    }

    if (!currentUrl.includes("/items/new")) {
      console.error(
        `Navigation Error: expected ${NEW_ITEM_URL}, got ${currentUrl}. Refusing to fill the wrong page.`
      );
      exitCode = 1;
      return;
    }

    console.log("On /items/new — waiting for listing form...");
    const fileInput = await page
      .waitForSelector('input[type="file"]', { state: "attached", timeout: 20000 })
      .catch(() => null);

    if (fileInput && downloadedPaths.length > 0) {
      console.log("Uploading images...");
      await fileInput.setInputFiles(downloadedPaths);
      await page.waitForTimeout(4000);
    } else if (!fileInput) {
      console.error("Error: listing file input not found on /items/new.");
      exitCode = 1;
      return;
    } else {
      console.log("Warning: no IMAGE_URLS to upload.");
    }

    console.log("Filling listing form via AI...");
    await page.act({ action: `Fill in the listing title with: ${process.env.ITEM_TITLE}` });
    await page.act({ action: `Fill the description box with: ${process.env.ITEM_DESC}` });
    await page.act({ action: `Enter the price as: ${process.env.ITEM_PRICE}` });

    console.log("Setting category...");
    await page.act({
      action: `Click the category selector and navigate through this exact category path to select the final option: ${process.env.ITEM_CATEGORY}`,
    });

    if (process.env.ITEM_BRAND && process.env.ITEM_BRAND.trim() !== "") {
      console.log(`Setting brand to: ${process.env.ITEM_BRAND}`);
      await page.act({ action: `Set the brand to: ${process.env.ITEM_BRAND}` });
    }

    console.log("Listing draft complete!");
  } catch (error) {
    console.error("Automation error:", error);
    exitCode = 1;
  } finally {
    console.log("Cleaning up local files and closing browser...");
    downloadedPaths.forEach((path) => {
      if (fs.existsSync(path)) fs.unlinkSync(path);
    });
    await stagehand.close();
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
