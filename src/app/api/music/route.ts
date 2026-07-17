import { readdir } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const AUDIO_EXT = /\.(mp3|ogg|m4a|wav)$/i;

async function listAudioFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && AUDIO_EXT.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Music manifest.
 *
 * BGM lives in public/music/BGM/<context>/*.mp3 where <context> is a shelf
 * the client asks for: lobby, weaving, main, calm, tense, adrenaline, battle,
 * boss, mystery, dread, triumph, wonder, somber, plus the end-credit shelves
 * outro and outro-<kind> (victory/defeat/bittersweet/escape/draw/cliffhanger).
 * Each shelf may hold per-genre subfolders (BGM/<context>/<theme>/ → the
 * "<context>-<theme>" shelf, preferred when the campaign's theme matches).
 * Loose files directly in BGM/ are exposed under the "any" shelf (a
 * general-purpose pool). SFX overrides live in public/music/SFX/<cue>.mp3
 * (see src/lib/client/sfx.ts for cue names).
 */
export async function GET() {
  try {
    const musicRoot = path.join(process.cwd(), "public", "music");
    const bgmRoot = path.join(musicRoot, "BGM");

    const byContext: Record<string, string[]> = {};
    const tracks: string[] = [];

    const looseFiles = await listAudioFiles(bgmRoot);
    if (looseFiles.length) {
      byContext.any = looseFiles.map((file) => `/music/BGM/${file}`);
      tracks.push(...byContext.any);
    }

    const entries = await readdir(bgmRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const contextKey = entry.name.toLowerCase();
      const contextDir = path.join(bgmRoot, entry.name);
      const files = await listAudioFiles(contextDir);
      if (files.length) {
        const urls = files.map((file) => `/music/BGM/${entry.name}/${file}`);
        byContext[contextKey] = urls;
        tracks.push(...urls);
      }
      // Themed variants one level down: BGM/calm/fantasy/*.mp3 becomes the
      // "calm-fantasy" shelf, preferred when the client sets that theme.
      const subEntries = await readdir(contextDir, { withFileTypes: true }).catch(() => []);
      for (const sub of subEntries) {
        if (!sub.isDirectory()) continue;
        const subFiles = await listAudioFiles(path.join(contextDir, sub.name));
        if (!subFiles.length) continue;
        const subUrls = subFiles.map((file) => `/music/BGM/${entry.name}/${sub.name}/${file}`);
        byContext[`${contextKey}-${sub.name.toLowerCase()}`] = subUrls;
        tracks.push(...subUrls);
      }
    }

    const sfx = (await listAudioFiles(path.join(musicRoot, "SFX"))).map((file) => `/music/SFX/${file}`);

    return NextResponse.json({ tracks, byContext, sfx });
  } catch (error) {
    console.error("Failed to list music files:", error);
    return NextResponse.json({ tracks: [], byContext: {}, sfx: [] });
  }
}
