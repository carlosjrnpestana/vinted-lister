import { browserbase, localBrowser, Stagehand } from "@browserbasehq/stagehand";
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
    const current = await page.url();
    if (isListingUrl(current) || isAuthWallUrl(current)) {
      return current;
    }
    if (current.includes("session-refresh")) {
      console.log(`Waiting on session-refresh: ${current}`);
      try {
        await page.waitForLoadState("networkidle", Math.min(12000, deadline - Date.now()));
      } catch {
        /* ignore */
      }
    }
    await page.waitForTimeout(1000);
  }
  return await page.url();
}

async function diagnosePage(page: any): Promise<void> {
  try {
    const title = await page.title();
    const snippet = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    console.error(
      `Page diagnose title="${title}" snippet=${JSON.stringify(String(snippet).slice(0, 400))}`
    );
  } catch (err) {
    console.error("Page diagnose failed:", err);
  }
}

function sanitizeCookies(rawCookies: any[], domainName: string): any[] {
  return rawCookies
    .map((cookie: any) => {
      const value = cookie?.value == null ? "" : String(cookie.value);
      if (!value) return null;

      let cleanDomain = cookie.domain || `.${domainName}`;
      // ".www.vinted.pt" is invalid — Chromium won't send it.
      if (/^\.www\./i.test(cleanDomain)) {
        cleanDomain = `.${domainName}`;
      }
      if (!cleanDomain.includes(domainName) && !cleanDomain.endsWith(".com")) {
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
        else if (val === "none" || val === "no_restriction") {
          cleanCookie.sameSite = "None";
          cleanCookie.secure = true;
        }
      }

      if (cookie.expirationDate) {
        cleanCookie.expires = Math.floor(cookie.expirationDate);
      }

      return cleanCookie;
    })
    .filter(Boolean);
}

async function main() {
  const browserbaseApiKey = process.env.BROWSERBASE_API_KEY;
  const useBrowserbase = Boolean(browserbaseApiKey);

  // Free plan: Model Gateway uses the Browserbase key (no separate LLM key required).
  // Optional BYOK: set GEMINI_API_KEY / GOOGLE_API_KEY to use your own Gemini key instead.
  const geminiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY;

  const BASE_URL = (process.env.VINTED_DOMAIN || "https://www.vinted.pt").replace(/\/$/, "");
  const NEW_ITEM_URL = `${BASE_URL}/items/new`;
  const domainName = new URL(BASE_URL).hostname.replace(/^www\./, "");

  if (useBrowserbase) {
    console.log("Browser env: BROWSERBASE (cloud Chrome)");
  } else {
    console.log("Browser env: LOCAL (set BROWSERBASE_API_KEY to use Browserbase)");
  }

  // Free plan does not include proxies — only enable when explicitly requested.
  const enableProxies = process.env.BROWSERBASE_PROXIES === "true";

  const browser = useBrowserbase
    ? await browserbase.launch({
        apiKey: browserbaseApiKey!,
        ...(enableProxies ? { proxies: true } : {}),
      })
    : await localBrowser.launch({ headless: false });

  const sessionId = browser.sessionId;
  if (sessionId) {
    console.log(`Browserbase session: https://www.browserbase.com/sessions/${sessionId}`);
  }

  let exitCode = 0;
  const downloadedPaths: string[] = [];

  try {
    const stagehand = await Stagehand.create({
      browser,
      // Prefer Model Gateway on Free (Browserbase key). Use Gemini BYOK only if provided.
      ...(geminiKey
        ? {
            model: {
              modelName: "google/gemini-2.5-flash",
              apiKey: geminiKey,
            },
          }
        : {}),
    });

    try {
      const context = browser.context;
      const pages = await context.pages();
      const page = pages[0] ?? (await context.newPage());

      await context.setExtraHTTPHeaders({
        "accept-language": "pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      });

      const imageUrls = (process.env.IMAGE_URLS || "")
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean);

      console.log("Downloading images...");
      for (let i = 0; i < imageUrls.length; i++) {
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

        const sanitizedCookies = sanitizeCookies(rawCookies, domainName);
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
          console.log(`Injecting ${sanitizedCookies.length} cookies before navigation...`);
          await context.addCookies(sanitizedCookies);
          const applied = await context.cookies(BASE_URL);
          console.log(
            `Browser has ${applied.length} cookies for ${BASE_URL}: ${applied
              .map((c: any) => c.name)
              .sort()
              .join(", ")}`
          );

          console.log(`Navigating to ${NEW_ITEM_URL}...`);
          await page.goto(NEW_ITEM_URL, { waitUntil: "domcontentloaded" });
          console.log(`Immediate URL: ${await page.url()}`);

          let currentUrl = await waitForListingPage(page, 45000);
          console.log(`Settled page URL: ${currentUrl}`);

          if (!isListingUrl(currentUrl)) {
            console.log("Retry once: re-inject cookies and goto /items/new...");
            await context.addCookies(sanitizedCookies);
            await page.goto(NEW_ITEM_URL, { waitUntil: "domcontentloaded" });
            currentUrl = await waitForListingPage(page, 45000);
            console.log(`Retry settled URL: ${currentUrl}`);
          }

          const bodyText = await page
            .locator("body")
            .innerText()
            .catch(() => "");
          const looksLoggedOut =
            /Iniciar sessão/i.test(bodyText) || /Criar conta/i.test(bodyText);

          if (isAuthWallUrl(currentUrl) || looksLoggedOut) {
            console.error(
              "Authentication Error: not logged in on Vinted. Re-export VINTED_COOKIES from a logged-in browser."
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
            const found = await page.waitForSelector('input[type="file"]', {
              state: "attached",
              timeout: 20000,
            });

            if (!found) {
              console.error("Error: listing file input not found on /items/new.");
              await diagnosePage(page);
              exitCode = 1;
            } else {
              if (downloadedPaths.length > 0) {
                console.log("Uploading images...");
                await page.locator('input[type="file"]').setInputFiles(downloadedPaths);
                await page.waitForTimeout(4000);
              }

              console.log("Filling listing form via AI...");
              await stagehand.act(
                `Fill in the listing title with: ${process.env.ITEM_TITLE}`
              );
              await stagehand.act(
                `Fill the description box with: ${process.env.ITEM_DESC}`
              );
              await stagehand.act(`Enter the price as: ${process.env.ITEM_PRICE}`);

              console.log("Setting category...");
              await stagehand.act(
                `Click the category selector and navigate through this exact category path to select the final option: ${process.env.ITEM_CATEGORY}`
              );

              if (process.env.ITEM_BRAND && process.env.ITEM_BRAND.trim() !== "") {
                console.log(`Setting brand to: ${process.env.ITEM_BRAND}`);
                await stagehand.act(`Set the brand to: ${process.env.ITEM_BRAND}`);
              }

              const finalUrl = await page.url();
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
    } finally {
      await stagehand.close();
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
      await browser.close();
    } catch (closeErr) {
      console.error("Error closing browser:", closeErr);
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
