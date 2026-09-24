import { Stagehand } from "@browserbasehq/stagehand";
import fs from "fs";
import { pipeline } from "stream/promises";

async function main() {
  // 1. Initialize Stagehand for local GitHub Actions execution
  const stagehand = new Stagehand({
    env: "LOCAL", 
    model: {
        modelName: "google/gemini-2.5-flash",
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY
    }
  });

  await stagehand.init();
  const page = stagehand.context.pages()[0];
  const imagePath = "./temp-vinted-photo.jpg";

  try {
    // 2. Download the image from the webhook payload URL
    console.log("Downloading image...");
    const response = await fetch(process.env.IMAGE_URL as string);
    if (!response.ok) throw new Error("Failed to fetch image");
    
    // Save it temporarily to the GitHub Actions server drive
    await pipeline(response.body as any, fs.createWriteStream(imagePath));

    // 3. Inject your Vinted cookies to bypass login
    console.log("Injecting cookies...");
    const cookies = JSON.parse(process.env.VINTED_COOKIES as string);
    await page.context().addCookies(cookies);

    // 4. Navigate directly to the new listing page
    console.log("Navigating to Vinted...");
    await page.goto("https://www.vinted.com/items/new");

    // 5. Bypass AI to securely upload the image using native Playwright
    console.log("Uploading photo via Playwright...");
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.setInputFiles(imagePath);
      await page.waitForTimeout(4000); // Wait for Vinted UI to process the image
    } else {
      console.log("Error: Could not find the file upload input.");
    }

    // 6. Hand control to Gemini to fill the text fields dynamically
    console.log("Filling form details via Gemini...");
    await stagehand.act(`Fill in the listing title with: ${process.env.ITEM_TITLE}`);
    await stagehand.act(`Fill the description box with: ${process.env.ITEM_DESC}`);
    await stagehand.act(`Set the brand to: ${process.env.ITEM_BRAND}`);
    await stagehand.act(`Enter the price as: ${process.env.ITEM_PRICE}`);
    
    // Optional: Uncomment this to auto-publish once you verify it works reliably
    // await stagehand.act("Click the final 'Upload' or 'Publish' button");

    console.log("Success! Listing drafted.");

  } catch (error) {
    console.error("Script failed:", error);
  } finally {
    // 7. Clean up the server environment
    if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
    }
    await stagehand.close();
  }
}

main();
