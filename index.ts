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
  // ".www.vinted.pt" is invalid for Playwright — use host-only "www.vinted.pt".
  if (/^\.www\./i.test(clean)) {
    clean = clean.slice(1);
  }
  if (!clean.includes(domainName) && !clean.endsWith(".com")) {
    clean = `.${domainName}`;
  }
  return clean;
}

function buildCookie(
  cookie: any,
  domain: string,
  value: string
): any {
  const cleanCookie: any = {
    name: cookie.name,
    value,
    domain,
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

  return cleanCookie;
}

function sanitizeCookies(
  rawCookies: any[],
  domainName: string
): { cookies: any[]; skippedEmpty: number; authPresent: string[] } {
  const cookies: any[] = [];
  let skippedEmpty = 0;
  const authPresent: string[] = [];
  const seen = new Set<string>();

  const pushUnique = (c: any) => {
    const key = `${c.name}|${c.domain}|${c.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    cookies.push(c);
  };

  for (const cookie of rawCookies) {
    const value = cookie?.value == null ? "" : String(cookie.value);
    if (!value) {
      skippedEmpty += 1;
      continue;
    }

    const cleanDomain = normalizeCookieDomain(cookie.domain, domainName);
    const primary = buildCookie(cookie, cleanDomain, value);
    pushUnique(primary);

    // Mirror auth cookies onto apex + www so Playwright sends them on www.vinted.pt.
    if (AUTH_COOKIE_NAMES.has(String(cookie.name))) {
      pushUnique(buildCookie(cookie, `.${domainName}`, value));
      pushUnique(buildCookie(cookie, `www.${domainName}`, value));
      authPresent.push(`${cookie.name}(len=${value.length},domain=${cleanDomain})`);
    }
  }

  return { cookies, skippedEmpty, authPresent };
}

function isListingUrl(url: string): boolean {
  try {
    return new URL(url).pathname.includes("/items/new");
  } catch {
    return url.includes("/items/new");
  }
}

function isAuthWallUrl(url: string): boolean {
  return (
    url.includes("/member/login") ||
    url.includes("select_type") ||
    url.includes("/register")
  );
}

async function waitForListingPage(page: any, timeoutMs = 60000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = page.url();
    if (isListingUrl(current) || isAuthWallUrl(current)) {
      return current;
    }

    // session-refresh is a client-side hop — let JS run, then wait for navigation.
    if (current.includes("session-refresh")) {
      console.log(`Waiting on session-refresh: ${current}`);
      try {
        await page.waitForLoadState("networkidle", {
          timeout: Math.min(15000, deadline - Date.now()),
        });
      } catch {
        /* ignore */
      }
      try {
        await page.waitForFunction(
          () => !window.location.pathname.includes("session-refresh"),
          { timeout: Math.min(20000, deadline - Date.now()) }
        );
        continue;
      } catch {
        // Fall through and poll
      }
    }

    try {
      await page.waitForURL(
        (url: URL) =>
          url.pathname.includes("/items/new") ||
          url.pathname.includes("/member/login") ||
          url.pathname.includes("select_type") ||
          url.pathname.includes("/register") ||
          !url.pathname.includes("session-refresh"),
        { timeout: Math.min(8000, Math.max(1000, deadline - Date.now())) }
      );
    } catch {
      await page.waitForTimeout(1000);
    }
  }
  return page.url();
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

  const BASE_URL = (process.env.VINTED_DOMAIN || "https://www.vinted.pt").replace(/\/$/, "");
  const NEW_ITEM_URL = `${BASE_URL}/items/new`;
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
    } else {
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
      } else if (authPresent.length === 0) {
        console.error(
          "Error: No auth cookies (access_token_web / refresh_token_web / _vinted_fr_session) with values."
        );
        exitCode = 1;
      } else {
        // Inject before any navigation so the first request carries the session.
        console.log(`Injecting ${sanitizedCookies.length} cookies before navigation...`);
        await context.addCookies(sanitizedCookies);
        // Also bind via url= so Playwright associates them with www.vinted.pt.
        await context.addCookies(
          sanitizedCookies.map((c) => ({
            name: c.name,
            value: c.value,
            url: BASE_URL,
            path: c.path || "/",
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite,
            expires: c.expires,
          }))
        );

        console.log(`Navigating to ${NEW_ITEM_URL}...`);
        await page.goto(NEW_ITEM_URL, { waitUntil: "load", timeout: 90000 });
        console.log(`Immediate URL: ${page.url()}`);

        let currentUrl = await waitForListingPage(page, 60000);
        console.log(`Settled page URL: ${currentUrl}`);

        if (!isListingUrl(currentUrl)) {
          console.log("Retry: homepage warm-up + re-inject cookies...");
          await context.clearCookies();
          await context.addCookies(sanitizedCookies);
          await page.goto(BASE_URL, { waitUntil: "load", timeout: 90000 });
          await page.waitForTimeout(2000);
          await context.addCookies(sanitizedCookies);
          await page.goto(NEW_ITEM_URL, { waitUntil: "load", timeout: 90000 });
          console.log(`Retry immediate URL: ${page.url()}`);
          currentUrl = await waitForListingPage(page, 60000);
          console.log(`Retry settled URL: ${currentUrl}`);
        }

        if (isAuthWallUrl(currentUrl)) {
          console.error(
            "Authentication Error: Vinted redirected to login/register. Refresh VINTED_COOKIES or Datadome blocked the runner IP."
          );
          exitCode = 1;
        } else if (!isListingUrl(currentUrl)) {
          console.error(
            `Navigation Error: expected ${NEW_ITEM_URL}, got ${currentUrl}. Refusing to fill the wrong page.`
          );
          exitCode = 1;
        } else {
          console.log("On /items/new — waiting for listing form...");
          const fileInput = await page
            .waitForSelector('input[type="file"]', { state: "attached", timeout: 20000 })
            .catch(() => null);

          if (!fileInput) {
            console.error("Error: listing file input not found on /items/new.");
            exitCode = 1;
          } else {
            if (downloadedPaths.length > 0) {
              console.log("Uploading images...");
              await fileInput.setInputFiles(downloadedPaths);
              await page.waitForTimeout(4000);
            } else {
              console.log("Warning: no IMAGE_URLS to upload.");
            }

            console.log("Filling listing form via AI...");
            await page.act({
              action: `Fill in the listing title with: ${process.env.ITEM_TITLE}`,
            });
            await page.act({
              action: `Fill the description box with: ${process.env.ITEM_DESC}`,
            });
            await page.act({
              action: `Enter the price as: ${process.env.ITEM_PRICE}`,
            });

            console.log("Setting category...");
            await page.act({
              action: `Click the category selector and navigate through this exact category path to select the final option: ${process.env.ITEM_CATEGORY}`,
            });

            if (process.env.ITEM_BRAND && process.env.ITEM_BRAND.trim() !== "") {
              console.log(`Setting brand to: ${process.env.ITEM_BRAND}`);
              await page.act({ action: `Set the brand to: ${process.env.ITEM_BRAND}` });
            }

            console.log(`Listing draft complete! Final URL: ${page.url()}`);
          }
        }
      }
    }
  } catch (error) {
    console.error("Automation error:", error);
    exitCode = 1;
  } finally {
    console.log("Cleaning up local files and closing browser...");
    downloadedPaths.forEach((path) => {
      if (fs.existsSync(path)) fs.unlinkSync(path);
    });
    try {
      await stagehand.close();
    } catch (closeErr) {
      console.error("Error closing Stagehand:", closeErr);
    }
  }

  // Must exit after finally — early `return` inside try would skip a trailing exit check.
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
