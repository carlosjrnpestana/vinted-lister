import { Stagehand } from "@browserbasehq/stagehand";
import fs from "fs";
import { pipeline } from "stream/promises";

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
    if (current.includes("session-refresh")) {
      console.log(`Waiting on session-refresh: ${current}`);
      try {
        await page.waitForLoadState("networkidle", {
          timeout: Math.min(12000, deadline - Date.now()),
        });
      } catch {
        /* ignore */
      }
      try {
        await page.waitForFunction(
          () => !window.location.pathname.includes("session-refresh"),
          { timeout: Math.min(15000, deadline - Date.now()) }
        );
        continue;
      } catch {
        /* poll */
      }
    }
    await page.waitForTimeout(1000);
  }
  return page.url();
}

async function diagnosePage(page: any): Promise<void> {
  try {
    const title = await page.title();
    const snippet = await page
      .locator("body")
      .innerText({ timeout: 3000 })
      .catch(() => "");
    console.error(`Page diagnose title="${title}" snippet=${JSON.stringify(snippet.slice(0, 400))}`);
  } catch (err) {
    console.error("Page diagnose failed:", err);
  }
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

  const browserbaseApiKey = process.env.BROWSERBASE_API_KEY;
  const browserbaseProjectId = process.env.BROWSERBASE_PROJECT_ID;
  const useBrowserbase = Boolean(browserbaseApiKey && browserbaseProjectId);

  if (useBrowserbase) {
    console.log("Browser env: BROWSERBASE (remote + proxies)");
  } else {
    console.log(
      "Browser env: LOCAL (set BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID to use Browserbase)"
    );
  }

  const stagehand = new Stagehand({
    env: useBrowserbase ? "BROWSERBASE" : "LOCAL",
    apiKey: browserbaseApiKey,
    projectId: browserbaseProjectId,
    modelName: "google/gemini-3.8-flash",
    modelClientOptions: { apiKey },
    waitForCaptchaSolves: useBrowserbase,
    ...(useBrowserbase
      ? {
          browserbaseSessionCreateParams: {
            projectId: browserbaseProjectId,
            // Residential proxies (Browserbase paid feature) help with Datadome.
            proxies: process.env.BROWSERBASE_PROXIES !== "false",
            browserSettings: {
              // Scale-plan feature; enable with BROWSERBASE_ADVANCED_STEALTH=true
              ...(process.env.BROWSERBASE_ADVANCED_STEALTH === "true"
                ? { advancedStealth: true }
                : {}),
              viewport: { width: 1280, height: 800 },
            },
          },
        }
      : {
          localBrowserLaunchOptions: {
            headless: false,
            locale: "pt-PT",
            args: ["--disable-blink-features=AutomationControlled"],
          },
        }),
  });

  await stagehand.init();
  console.log(`Stagehand ready (env=${stagehand.env})`);

  if (!stagehand.llmClient) {
    throw new Error(
      "Stagehand LLM client failed to initialize. Check GEMINI_API_KEY / modelName."
    );
  }

  const page = stagehand.page;
  const context = page.context();

  // Language preference only when on Browserbase (UA is managed remotely).
  // Keep the #14 Chrome UA spoof for LOCAL.
  if (useBrowserbase) {
    await context.setExtraHTTPHeaders({
      "accept-language": "pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    });
  } else {
    await context.setExtraHTTPHeaders({
      "accept-language": "pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Linux"',
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
  }

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

      // Same sanitization as successful run #14 — keep original domains when possible.
      const sanitizedCookies = rawCookies
        .map((cookie: any) => {
          const value = cookie?.value == null ? "" : String(cookie.value);
          if (!value) return null;

          let cleanDomain = cookie.domain || `.${domainName}`;
          // ".www.vinted.pt" is invalid — Playwright may accept it but Chromium won't send it.
          if (/^\.www\./i.test(cleanDomain)) {
            cleanDomain = `.${domainName}`;
          }
          if (cleanDomain.toLowerCase() === `www.${domainName}`) {
            cleanDomain = `www.${domainName}`;
          }
          if (!cleanDomain.includes(domainName)) {
            cleanDomain = `.${domainName}`;
          }

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
            else if (val === "none" || val === "no_restriction") cleanCookie.sameSite = "None";
          }

          if (cookie.expirationDate) {
            cleanCookie.expires = Math.floor(cookie.expirationDate);
          }

          return cleanCookie;
        })
        .filter(Boolean);

      const authNames = sanitizedCookies
        .filter((c: any) =>
          ["access_token_web", "refresh_token_web", "_vinted_fr_session"].includes(c.name)
        )
        .map((c: any) => `${c.name}(len=${c.value.length},domain=${c.domain})`);

      console.log(
        `Cookies: kept=${sanitizedCookies.length} auth=[${authNames.join(", ") || "none"}]`
      );

      if (sanitizedCookies.length === 0 || authNames.length === 0) {
        console.error("Error: VINTED_COOKIES missing usable auth cookie values.");
        exitCode = 1;
      } else {
        console.log(`Injecting ${sanitizedCookies.length} cookies before first navigation...`);
        await context.addCookies(sanitizedCookies);
        const applied = await context.cookies(BASE_URL);
        console.log(
          `Browser now has ${applied.length} cookies for ${BASE_URL}: ${applied
            .map((c: any) => c.name)
            .sort()
            .join(", ")}`
        );
        const hasAccess = applied.some((c: any) => c.name === "access_token_web");
        const hasSession = applied.some((c: any) => c.name === "_vinted_fr_session");
        console.log(`Auth cookie presence: access_token_web=${hasAccess} _vinted_fr_session=${hasSession}`);
        if (!hasAccess && !hasSession) {
          console.error(
            "Auth cookies were not accepted by the browser context. Check cookie domains in VINTED_COOKIES."
          );
          exitCode = 1;
        } else {
        console.log(`Navigating to ${NEW_ITEM_URL}...`);
        await page.goto(NEW_ITEM_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
        console.log(`Immediate URL: ${page.url()}`);

        let currentUrl = await waitForListingPage(page, 45000);
        console.log(`Settled page URL: ${currentUrl}`);

        if (!isListingUrl(currentUrl)) {
          console.log("Retry once: re-inject cookies and goto /items/new...");
          await context.addCookies(sanitizedCookies);
          await page.goto(NEW_ITEM_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
          currentUrl = await waitForListingPage(page, 45000);
          console.log(`Retry settled URL: ${currentUrl}`);
        }

        const bodyText = await page
          .locator("body")
          .innerText({ timeout: 3000 })
          .catch(() => "");
        const looksLoggedOut =
          /Iniciar sessão/i.test(bodyText) || /Criar conta/i.test(bodyText);

        if (isAuthWallUrl(currentUrl) || looksLoggedOut) {
          console.error(
            "Authentication Error: not logged in on Vinted (login CTA visible or auth redirect). Re-export VINTED_COOKIES from a logged-in browser and update the repo secret."
          );
          await diagnosePage(page);
          exitCode = 1;
        } else if (!isListingUrl(currentUrl)) {
          console.error(
            `Navigation Error: expected ${NEW_ITEM_URL}, got ${currentUrl}. Refusing to fill the wrong page.`
          );
          await diagnosePage(page);
          exitCode = 1;
        } else {
          console.log("On /items/new — waiting for listing form...");
          const fileInput = await page
            .waitForSelector('input[type="file"]', { state: "attached", timeout: 20000 })
            .catch(() => null);

          if (!fileInput) {
            console.error("Error: listing file input not found on /items/new.");
            await diagnosePage(page);
            exitCode = 1;
          } else {
            if (downloadedPaths.length > 0) {
              console.log("Uploading images...");
              await fileInput.setInputFiles(downloadedPaths);
              await page.waitForTimeout(4000);
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

            const finalUrl = page.url();
            if (!isListingUrl(finalUrl)) {
              console.error(`Left /items/new during fill. Final URL: ${finalUrl}`);
              exitCode = 1;
            } else {
              console.log(`Listing draft complete! Final URL: ${finalUrl}`);
            }
          }
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

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
