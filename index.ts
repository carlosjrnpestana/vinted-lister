import { Stagehand } from "@browserbasehq/stagehand";
import fs from "fs";
import { pipeline } from "stream/promises";

async function main() {
  const stagehand = new Stagehand({
    env: "LOCAL", 
    model: {
        modelName: "google/gemini-2.5-flash",
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY
    }
  });

  await stagehand.init();
  const page = stagehand.context.pages()[0];
  
  // Split the comma-separated string from the webhook into an array
  const imageUrls = (process.env.IMAGE_URLS || "").split(",").map(url => url.trim());
  const downloadedPaths: string[] = [];

  try {
    console.log("Downloading images...");
    for (let i = 0; i < imageUrls.length; i++) {
      if (!imageUrls[i]) continue;
      const path = `./temp-photo-${i}.jpg`;
      const response = await fetch(imageUrls[i]);
      if (!response.ok) throw new Error(`Failed to fetch image ${i}`);
      await pipeline(response.body as any, fs.createWriteStream(path));
      downloadedPaths.push(path);
    }

    console.log("Injecting cookies & navigating...");
    const cookies = JSON.parse(process.env.VINTED_COOKIES as string);
    await page.context().addCookies(cookies);
    await page.goto("https://www.vinted.com/items/new");

    console.log("Uploading multiple photos via Playwright...");
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      // Playwright natively accepts an array of paths for multiple uploads
      await fileInput.setInputFiles(downloadedPaths);
      await page.waitForTimeout(5000); 
    }

    console.log("Filling form details via Gemini...");
    await stagehand.act(`Fill in the listing title with: ${process.env.ITEM_TITLE}`);
    await stagehand.act(`Fill the description box with: ${process.env.ITEM_DESC}`);
    await stagehand.act(`Set the brand to: ${process.env.ITEM_BRAND}`);
    await stagehand.act(`Enter the price as: ${process.env.ITEM_PRICE}`);
    
    // Instruct Stagehand to navigate the multi-layer category dropdown
    await stagehand.act(`Click the category selector and navigate through this exact category path to select the final option: ${process.env.ITEM_CATEGORY}`);
    
    console.log("Success! Listing drafted.");
  } catch (error) {
    console.error("Script failed:", error);
  } finally {
    // Clean up all temporary images
    downloadedPaths.forEach(path => {
      if (fs.existsSync(path)) fs.unlinkSync(path);
    });
    await stagehand.close();
  }
}

main();
