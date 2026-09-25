import { Stagehand } from "@browserbasehq/stagehand";
import fs from "fs";
import { pipeline } from "stream/promises";

async function main() {
  // Initialize Stagehand to run in default (headful) mode on our fake virtual monitor
  const stagehand = new Stagehand({
    env: "LOCAL", 
    headless: false, 
    llmProvider: "google",
    modelName: "gemini-2.5-flash"
  });

  await stagehand.init();
  const page = stagehand.context.pages()[0];
  
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
    const cookies = JSON.parse(process.env.VINTED_COOKIES as string);
    await page.context().addCookies(cookies);

    console.log("Navigating to Vinted...");
    await page.goto("https://www.vinted.com/items/new");

    console.log("Uploading photos via Playwright...");
    const fileInput = await page.$('input[type="file"]');
    if (fileInput && downloadedPaths.length > 0) {
      await fileInput.setInputFiles(downloadedPaths);
      await page.waitForTimeout(5000); 
    } else {
      console.log("Warning: No file input found or no images downloaded.");
    }

    console.log("Filling form details via Gemini...");
    await stagehand.act(`Fill in the listing title with: ${process.env.ITEM_TITLE}`);
    await stagehand.act(`Fill the description box with: ${process.env.ITEM_DESC}`);
    await stagehand.act(`Enter the price as: ${process.env.ITEM_PRICE}`);

    console.log("Setting category path...");
    await stagehand.act(`Click the category selector and navigate through this exact category path to select the final option: ${process.env.ITEM_CATEGORY}`);

    if (process.env.ITEM_BRAND && process.env.ITEM_BRAND.trim() !== "") {
      console.log(`Setting brand to: ${process.env.ITEM_BRAND}`);
      await stagehand.act(`Set the brand to: ${process.env.ITEM_BRAND}`);
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
