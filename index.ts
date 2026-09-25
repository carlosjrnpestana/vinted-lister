import { Stagehand } from "@browserbasehq/stagehand";
import fs from "fs";
import { pipeline } from "stream/promises";

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

  const BASE_URL = process.env.VINTED_DOMAIN || "https://www.vinted.pt";
  const urlObj = new URL(BASE_URL);
  const domainName = urlObj.hostname.replace("www.", "");

  const stagehand = new Stagehand({
    env: "LOCAL",
    headless: false,
    llmProvider: "google",
    modelName: "gemini-2.5-flash",
    enableVision: false,
    llmClientOptions: {
      apiKey: apiKey,
    },
  });

  await stagehand.init();
  const page = stagehand.page;
  const context = page.context();

  // Stealth headers to bypass Cloudflare / Datadome checks
  await context.setExtraHTTPHeaders({
    "accept-language": "pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  const imageUrls = (process.env.IMAGE_URLS || "")
    .split(",")
    .map((url) => url.trim());
  const downloadedPaths: string[] = [];

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

    if (process.env.VINTED_COOKIES) {
      console.log("Parsing and sanitizing VINTED_COOKIES secret...");
      const rawCookies = JSON.parse(process.env.VINTED_COOKIES);

      const sanitizedCookies = rawCookies.map((cookie: any) => {
        let cleanDomain = cookie.domain || `.${domainName}`;
        if (!cleanDomain.includes(domainName)) {
          cleanDomain = `.${domainName}`;
        }

        const cleanCookie: any = {
          name: cookie.name,
          value: String(cookie.value),
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
      });

      console.log(`Injecting ${sanitizedCookies.length} cookies before first navigation...`);
      await context.addCookies(sanitizedCookies);
    } else {
      console.error("Error: VINTED_COOKIES environment variable is missing.");
      return;
    }

    console.log(`Navigating directly to ${BASE_URL}/items/new...`);
    await page.goto(`${BASE_URL}/items/new`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    console.log(`Current page URL: ${currentUrl}`);

    if (
      currentUrl.includes("register") ||
      currentUrl.includes("select_type") ||
      currentUrl.includes("login")
    ) {
      console.error(
        "Authentication Error: Vinted redirected to login/register. The cookies exported are expired or Datadome blocked the US datacenter runner IP."
      );
      return;
    }

    console.log("Waiting for listing form to display...");
    const fileInput = await page
      .waitForSelector('input[type="file"]', { state: "attached", timeout: 15000 })
      .catch(() => null);

    if (fileInput && downloadedPaths.length > 0) {
      console.log("Uploading images...");
      await fileInput.setInputFiles(downloadedPaths);
      await page.waitForTimeout(4000);
    } else {
      console.log("Warning: File input not found on the page.");
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
  } finally {
    console.log("Cleaning up local files and closing browser...");
    downloadedPaths.forEach((path) => {
      if (fs.existsSync(path)) fs.unlinkSync(path);
    });
    await stagehand.close();
  }
}

main();
