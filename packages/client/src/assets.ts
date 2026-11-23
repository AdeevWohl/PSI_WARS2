/** Art manifest, URL resolution (WebP with JPEG fallback) and preloading. */
export type ArtSize = 'sm' | 'md' | 'lg';

interface Variant {
  w: number;
  h: number;
  webp: string;
  jpg: string;
}
interface Asset {
  hash: string;
  width: number;
  height: number;
  variants: Record<string, Variant>;
  placeholder?: string;
  generated?: boolean;
  standIn?: boolean;
}
interface Manifest {
  version: number;
  basePath: string;
  assets: Record<string, Asset>;
}

let manifest: Manifest | null = null;
let useWebp = true;
const loaded = new Set<string>();

async function webpSupported(): Promise<boolean> {
  const img = new Image();
  img.src = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
  try {
    await img.decode();
    return img.width === 1;
  } catch {
    return false;
  }
}

export async function loadManifest(): Promise<void> {
  useWebp = await webpSupported();
  try {
    const r = await fetch('art/assets.manifest.json');
    manifest = r.ok ? await r.json() : null;
  } catch {
    manifest = null;
  }
}

export function hasArt(key: string | undefined): boolean {
  return !!key && !!manifest?.assets[key];
}

export function artUrl(key: string | undefined, size: ArtSize | '1920' = 'sm'): string | null {
  if (!key || !manifest) return null;
  const a = manifest.assets[key];
  if (!a) return null;
  const v = a.variants[size] ?? a.variants.md ?? Object.values(a.variants)[0];
  if (!v) return null;
  return `art/${useWebp ? v.webp : v.jpg}?v=${a.hash}`;
}

export function placeholder(key: string | undefined): string | null {
  return (key && manifest?.assets[key]?.placeholder) || null;
}

export function isStandIn(key: string): boolean {
  return !!manifest?.assets[key]?.standIn || !!manifest?.assets[key]?.generated;
}

/** Preload a set of images; calls onProgress(done, total). Never rejects. */
export async function preload(urls: string[], onProgress?: (done: number, total: number) => void): Promise<void> {
  const todo = [...new Set(urls)].filter((u) => !loaded.has(u));
  let done = 0;
  onProgress?.(0, todo.length);
  await Promise.all(
    todo.map(async (u) => {
      const img = new Image();
      img.src = u;
      try {
        await img.decode();
        loaded.add(u);
      } catch {
        /* missing art falls back to the procedural face */
      }
      done++;
      onProgress?.(done, todo.length);
    }),
  );
}
