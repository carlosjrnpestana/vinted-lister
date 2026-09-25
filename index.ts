import { Stagehand } from "@browserbasehq/stagehand";
import fs from "fs";
import { pipeline } from "stream/promises";

async function main() {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;

  const stagehand = new Stagehand({
    env: "LOCAL", 
    headless: false, 
    llmProvider: "google",
    modelName: "gemini-2.5-flash",
    // Fix: Supply key at root and inside modelClientOptions for Stagehand v2 compatibility
    apiKey: apiKey,
    modelClientOptions: {
      apiKey: apiKey
    }
  });

  await stagehand.init();
  const page = stagehand.page; 
  
  const imageUrls = (process.env.IMAGE_URLS || "").split(",").map(url => url.trim());
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

    console.log("Injecting cookies...");
    const rawCookies = JSON.parse(process.env.VINTED_COOKIES as string);
    const sanitizedCookies = rawCookies.map((cookie: any) => {
      if (cookie.sameSite) {
        const val = cookie.sameSite.toLowerCase();
        if (val === 'lax') cookie.sameSite = 'Lax';
        else if (val === 'strict') cookie.sameSite = 'Strict';
        else if (val === 'none' || val === 'no_restriction') cookie.sameSite = 'None';
        else delete cookie.sameSite;
      }
      return cookie;
    });

    await page.context().addCookies(sanitizedCookies);

    console.log("Navigating to Vinted...");
    await page.goto("https://www.vinted.com/items/new");

    // Diagnostic check: verify if Vinted redirected us to a login page
    const currentUrl = page.url();
    console.log(`Current page URL: ${currentUrl}`);
    if (currentUrl.includes("login") || currentUrl.includes("member")) {
      console.log("Warning: Vinted redirected to login. The provided session cookies may be expired or invalid.");
    }

    console.log("Waiting for Vinted UI to load...");
    const fileInput = await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 15000 }).catch(() => null);
    
    if (fileInput && downloadedPaths.length > 0) {
      console.log("Uploading photos via Playwright...");
      await fileInput.setInputFiles(downloadedPaths);
      await page.waitForTimeout(5000); 
    } else {
      console.log("Warning: No file input found on the page or no images downloaded.");
    }

    console.log("Filling form details via Gemini...");
    await page.act({ action: `Fill in the listing title with: ${process.env.ITEM_TITLE}` });
    await page.act({ action: `Fill the description box with: ${process.env.ITEM_DESC}` });
    await page.act({ action: `Enter the price as: ${process.env.ITEM_PRICE}` });

    console.log("Setting category path...");
    await page.act({ action: `Click the category selector and navigate through this exact category path to select the final option: ${process.env.ITEM_CATEGORY}` });

    if (process.env.ITEM_BRAND && process.env.ITEM_BRAND.trim() !== "") {
      console.log(`Setting brand to: ${process.env.ITEM_BRAND}`);
      await page.act({ action: `Set the brand to: ${process.env.ITEM_BRAND}` });
    } else {
      console.log("No brand provided, skipping brand field.");
    }

    console.log("Success! Listing drafted on Vinted.");

  } catch (error) {
    console.error("Automation error:", error);
  } finally {
    console.log("Cleaning up files and closing browser...");
    downloadedPaths.forEach(path => {
      if (fs.existsSync(path)) fs.unlinkSync(path);
    });
    await stagehand.close();
  }
}

main();
