"use strict";

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const png2icons = require("png2icons");

const ROOT = path.resolve(__dirname, ".."),
  iconRoot = path.join(ROOT, "build", "icons"),
  generated = path.join(iconRoot, "generated"),
  source = path.join(ROOT, "public", "penecho-mark.png"),
  wordmarkSource = path.join(ROOT, "public", "penecho-readme-header.png");

async function png(size, output) {
  const markSize = Math.max(1, Math.round(size * .72)), inset = Math.round(size * .035), radius = Math.round(size * .21),
    tile = Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><rect x="${inset}" y="${inset}" width="${size - inset * 2}" height="${size - inset * 2}" rx="${radius}" fill="#fff"/></svg>`);
  await sharp({ create:{ width:size, height:size, channels:4, background:{ r:255, g:255, b:255, alpha:0 } } })
    .composite([{ input:tile }, { input:await sharp(source).resize(markSize, markSize, { fit:"contain", background:{ r:0, g:0, b:0, alpha:0 } }).png().toBuffer(), gravity:"center" }])
    .png({ compressionLevel:9, palette:false })
    .toFile(output);
}

function dilateAlpha(input, width, height, radius = 1) {
  const output = Buffer.alloc(input.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy += 1) {
        for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx += 1) {
          value = Math.max(value, input[yy * width + xx]);
        }
      }
      output[y * width + x] = value;
    }
  }
  return output;
}

async function installerWordmark() {
  const width = 92, height = 18, insetX = 2, contentWidth = width - insetX * 2,
    crop = await sharp(wordmarkSource)
    .extract({ left:710, top:140, width:1054, height:240 })
    .png()
    .toBuffer(),
    trimmed = await sharp(crop).trim({ background:"#fff" }).png().toBuffer(),
    maskContent = await sharp(trimmed)
      .flatten({ background:"#fff" })
      .grayscale()
      .negate()
      .resize(contentWidth, height, { fit:"contain", background:{ r:255, g:255, b:255 } })
      .raw()
      .toBuffer({ resolveWithObject:true }),
    colorContent = await sharp(trimmed)
      .flatten({ background:"#fff" })
      .resize(contentWidth, height, { fit:"contain", background:{ r:255, g:255, b:255 } })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject:true });
  const mask = Buffer.alloc(width * height),
    colorPixels = Buffer.alloc(width * height * colorContent.info.channels, 255);
  for (let y = 0; y < height; y += 1) {
    maskContent.data.copy(mask, y * width + insetX, y * contentWidth, (y + 1) * contentWidth);
    colorContent.data.copy(
      colorPixels,
      (y * width + insetX) * colorContent.info.channels,
      y * contentWidth * colorContent.info.channels,
      (y + 1) * contentWidth * colorContent.info.channels,
    );
  }
  const regularWordmark = await sharp({ create:{ width, height, channels:3, background:{ r:32, g:36, b:44 } } })
    .joinChannel(mask, { raw:{ width, height, channels:1 } })
    .png()
    .toBuffer(),
    echoMask = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 41; x < width; x += 1) {
      const offset = y * width + x,
        colorOffset = offset * colorContent.info.channels;
      echoMask[offset] = 255 - Math.min(
        colorPixels[colorOffset],
        colorPixels[colorOffset + 1],
        colorPixels[colorOffset + 2],
      );
    }
  }
  const boldEchoMask = dilateAlpha(echoMask, width, height),
    boldEcho = await sharp({ create:{ width, height, channels:3, background:{ r:32, g:36, b:44 } } })
      .joinChannel(boldEchoMask, { raw:{ width, height, channels:1 } })
      .png()
      .toBuffer();
  return sharp(regularWordmark)
    .composite([{ input:boldEcho }])
    .png()
    .toBuffer();
}

async function installerGif(output) {
  const width = 268, height = 167,
    mark = await sharp(source).resize(52, 52, { fit:"contain" }).png().toBuffer(),
    wordmark = await installerWordmark();
  await sharp({ create:{ width, height, channels:4, background:{ r:0, g:0, b:0, alpha:0 } } })
    .composite([
      { input:mark, top:40, left:108 },
      { input:wordmark, top:103, left:88 },
    ])
    .gif()
    .toFile(output);
}

async function main() {
  fs.mkdirSync(generated, { recursive:true });
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024], files = new Map();
  for (const size of sizes) {
    const output = path.join(generated, `penecho-${size}.png`);
    await png(size, output);
    files.set(size, output);
  }
  fs.copyFileSync(files.get(512), path.join(iconRoot, "penecho.png"));
  fs.copyFileSync(files.get(1024), path.join(iconRoot, "penecho-1024.png"));
  await installerGif(path.join(iconRoot, "penecho-install.gif"));
  const sourcePng = fs.readFileSync(files.get(1024)),
    icns = png2icons.createICNS(sourcePng, png2icons.BICUBIC2, 0),
    ico = png2icons.createICO(sourcePng, png2icons.BICUBIC2, 0, false, true);
  if (!icns || !ico) throw new Error("Unable to encode desktop icon files.");
  fs.writeFileSync(path.join(iconRoot, "penecho.icns"), icns);
  fs.writeFileSync(path.join(iconRoot, "penecho.ico"), ico);
  console.log(`Generated PenEcho desktop icons in ${iconRoot}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
