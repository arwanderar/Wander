#!/usr/bin/env node
/**
 * Deploy a built Vite app to Arweave using Dragon Deploy method
 *
 * Usage:
 *   node scripts/deploy-to-arweave.js [dist-folder] [--title "My App"] [--description "Description"]
 *
 * Examples:
 *   node scripts/deploy-to-arweave.js
 *   node scripts/deploy-to-arweave.js ./dist
 *   node scripts/deploy-to-arweave.js ./build --title "My Vite App"
 *
 * Uses node-arweave-wallet for browser-based signing (no JWK needed)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Arweave from "arweave";
import ArDBModule from "ardb";
import mime from "mime";
import { NodeArweaveWallet, createDataItemSigner } from "node-arweave-wallet";

const ArDB = ArDBModule.default || ArDBModule;

// Constants (matching Dragon Deploy)
const APP_NAME = "Dragon-Deploy";
const APP_VERSION = "0.3.0";
const MANIFEST_CONTENT_TYPE = "application/x.arweave-manifest+json";

// Arweave gateway
const arweave = new Arweave({
  host: "ar-io.net",
  port: 443,
  protocol: "https",
});

const ardb = new ArDB(arweave);

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    distFolder: "./dist",
    title: "Vite App",
    description: "",
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--title" && args[i + 1]) {
      options.title = args[++i];
    } else if (args[i] === "--description" && args[i + 1]) {
      options.description = args[++i];
    } else if (!args[i].startsWith("--")) {
      options.distFolder = args[i];
    }
  }

  return options;
}

// Get all files recursively from a directory
function getAllFiles(dirPath, basePath = dirPath, files = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      getAllFiles(fullPath, basePath, files);
    } else if (entry.isFile()) {
      const relativePath = path.relative(basePath, fullPath);
      files.push({
        path: relativePath.replace(/\\/g, "/"), // Normalize to forward slashes
        fullPath,
        size: fs.statSync(fullPath).size,
      });
    }
  }

  return files;
}

// Hash file content using SHA-256
async function hashContent(data) {
  const hashBuffer = crypto.createHash("sha256").update(data).digest();
  return Array.from(hashBuffer)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Check which files already exist on Arweave (deduplication)
async function getExistingTxIds(hashes) {
  const hashToTxId = {};

  try {
    console.log("🔍 Checking for existing files on Arweave...");
    const txs = await ardb
      .appName(APP_NAME)
      .search("transactions")
      .only(["id", "tags"])
      .tags([{ name: "File-Hash", values: hashes }])
      .findAll();

    txs.forEach((tx) => {
      const hashTag = tx._tags?.find((tag) => tag.name === "File-Hash");
      if (hashTag) {
        hashToTxId[hashTag.value] = tx.id;
      }
    });

    const existingCount = Object.keys(hashToTxId).length;
    if (existingCount > 0) {
      console.log(`✅ Found ${existingCount} existing files (will be reused)`);
    }
  } catch (error) {
    console.log("⚠️  Could not check for existing files, will upload all");
  }

  return hashToTxId;
}

// Check if this is a Next.js app (to handle .html extension removal)
function isNextApp(files) {
  return files.some((file) => /_next[\\/]/.test(file.path));
}

// Main deployment function
async function deploy() {
  const options = parseArgs();
  const distPath = path.resolve(options.distFolder);

  // Validate dist folder exists
  if (!fs.existsSync(distPath)) {
    console.error(`❌ Error: Folder "${distPath}" does not exist`);
    console.error("   Make sure to build your app first (e.g., npm run build)");
    process.exit(1);
  }

  // Get all files
  console.log(`\n📁 Reading files from: ${distPath}`);
  const files = getAllFiles(distPath);

  if (files.length === 0) {
    console.error("❌ Error: No files found in the dist folder");
    process.exit(1);
  }

  // Check for index.html
  const hasIndex = files.some((f) => f.path === "index.html");
  if (!hasIndex) {
    console.error("❌ Error: No index.html found in the dist folder");
    process.exit(1);
  }

  console.log(`📦 Found ${files.length} files`);

  // Calculate total size
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const freeFilesSize = files.filter((f) => f.size <= 100000).reduce((sum, f) => sum + f.size, 0);
  const paidFilesSize = totalSize - freeFilesSize;
  console.log(`📊 Total size: ${(totalSize / 1024).toFixed(2)} KB`);
  console.log(`   Free (≤100KB files): ${(freeFilesSize / 1024).toFixed(2)} KB`);
  console.log(`   Paid (>100KB files): ${(paidFilesSize / 1024).toFixed(2)} KB`);

  // Initialize wallet connection
  console.log("\n🔐 Connecting to wallet...");
  const arweaveWallet = new NodeArweaveWallet();
  await arweaveWallet.initialize();
  await arweaveWallet.connect(["ACCESS_ADDRESS", "SIGN_TRANSACTION", "DISPATCH"]);

  const address = await arweaveWallet.getActiveAddress();
  console.log(`✅ Connected: ${address}`);

  // Hash all files
  console.log("\n🔒 Hashing files...");
  const filesWithHash = await Promise.all(
    files.map(async (file) => {
      const content = fs.readFileSync(file.fullPath);
      const hash = await hashContent(content);
      return { ...file, content, hash };
    }),
  );

  // Check for existing files on Arweave
  const hashes = filesWithHash.map((f) => f.hash);
  const existingTxIds = await getExistingTxIds(hashes);

  // Build manifest
  const manifest = {
    manifest: "arweave/paths",
    version: "0.1.0",
    index: { path: "index.html" },
    paths: {},
  };

  const isNext = isNextApp(files);
  const filesToUpload = [];
  let reusedCount = 0;

  for (const file of filesWithHash) {
    const existingTxId = existingTxIds[file.hash];
    let filePath = file.path;

    // For Next.js apps, remove .html extension from paths (except index.html)
    if (isNext && filePath.endsWith(".html") && filePath !== "index.html") {
      filePath = filePath.replace(".html", "");
    }

    if (existingTxId) {
      manifest.paths[filePath] = { id: existingTxId };
      reusedCount++;
    } else {
      filesToUpload.push({ ...file, manifestPath: filePath });
    }
  }

  console.log(`\n📤 Uploading ${filesToUpload.length} new files (${reusedCount} reused)`);

  // Upload new files
  let uploadedCount = 0;
  for (const file of filesToUpload) {
    const mimeType = mime.getType(file.path) || "application/octet-stream";

    const tx = await arweave.createTransaction({ data: file.content });
    tx.addTag("Content-Type", mimeType);
    tx.addTag("App-Name", APP_NAME);
    tx.addTag("App-Version", APP_VERSION);
    tx.addTag("File-Hash", file.hash);

    await arweaveWallet.sign(tx);

    try {
      // Try dispatch first (for smaller files, often free)
      if (file.size <= 100000) {
        const dispatchResult = await arweaveWallet.dispatch(tx);
        manifest.paths[file.manifestPath] = { id: dispatchResult.id };
      } else {
        const response = await arweave.transactions.post(tx);
        if (response.status !== 200 && response.status !== 202) {
          throw new Error(`Upload failed: ${response.statusText}`);
        }
        manifest.paths[file.manifestPath] = { id: tx.id };
      }
    } catch (error) {
      // Fallback to regular post
      const response = await arweave.transactions.post(tx);
      if (response.status !== 200 && response.status !== 202) {
        console.error(`❌ Failed to upload: ${file.path}`);
        throw error;
      }
      manifest.paths[file.manifestPath] = { id: tx.id };
    }

    uploadedCount++;
    const percent = Math.round((uploadedCount / filesToUpload.length) * 100);
    process.stdout.write(`\r   Progress: ${percent}% (${uploadedCount}/${filesToUpload.length})`);
  }

  if (filesToUpload.length > 0) {
    console.log("\n");
  }

  // Upload manifest
  console.log("📋 Uploading manifest...");
  const unixTimestamp = Math.floor(Date.now() / 1000);

  const manifestTx = await arweave.createTransaction({ data: JSON.stringify(manifest) });
  manifestTx.addTag("Content-Type", MANIFEST_CONTENT_TYPE);
  manifestTx.addTag("Title", options.title);
  manifestTx.addTag("App-Name", APP_NAME);
  manifestTx.addTag("App-Version", APP_VERSION);
  manifestTx.addTag("Unix-Time", String(unixTimestamp));
  manifestTx.addTag("Description", options.description);
  manifestTx.addTag("Type", "web-page");

  await arweaveWallet.sign(manifestTx);

  let manifestId;
  try {
    const dispatchResult = await arweaveWallet.dispatch(manifestTx);
    manifestId = dispatchResult.id;
  } catch {
    const response = await arweave.transactions.post(manifestTx);
    if (response.status !== 200 && response.status !== 202) {
      throw new Error(`Manifest upload failed: ${response.statusText}`);
    }
    manifestId = manifestTx.id;
  }

  // Close wallet connection
  await arweaveWallet.close("success");

  // Print results
  console.log("\n" + "═".repeat(60));
  console.log("🎉 Deployment successful!");
  console.log("═".repeat(60));
  console.log(`\n📍 Manifest ID: ${manifestId}`);
  console.log(`\n🌐 Your app is available at:`);
  console.log(`   https://arweave.net/${manifestId}`);
  console.log(`   https://ar-io.net/${manifestId}`);
  console.log("\n⏳ Note: It may take a few minutes for the deployment to propagate.");
  console.log("═".repeat(60) + "\n");

  return manifestId;
}

// Run
deploy().catch((error) => {
  console.error("\n❌ Deployment failed:", error.message);
  process.exit(1);
});
