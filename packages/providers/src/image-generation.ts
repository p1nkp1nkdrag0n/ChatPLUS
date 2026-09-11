import {
  VisualPromptSpecSchema,
  AchievementBadgeVisualSpecSchema,
  type AchievementBadgeVisualSpec,
  type VisualPromptSpec,
} from "@personasim/contracts";

export interface ImageGenerationInput {
  readonly visualSpec: VisualPromptSpec | AchievementBadgeVisualSpec;
  readonly width: number;
  readonly height: number;
  readonly idempotencyKey: string;
}

export interface GeneratedImageAsset {
  readonly bytes: Uint8Array;
  readonly mimeType:
    "image/svg+xml" | "image/png" | "image/webp" | "image/jpeg";
  readonly width: number;
  readonly height: number;
}

export interface ImageGenerationProvider {
  readonly name: string;
  readonly model: string;
  generate(input: ImageGenerationInput): Promise<GeneratedImageAsset>;
}

export class FixtureImageGenerationProvider implements ImageGenerationProvider {
  readonly name = "fixture-image";
  readonly model = "deterministic-svg-v1";

  async generate(input: ImageGenerationInput): Promise<GeneratedImageAsset> {
    // Preserve an asynchronous provider boundary even for the deterministic
    // fixture so validation failures have the same Promise semantics as real
    // network providers.
    await Promise.resolve();
    const parsed =
      input.visualSpec.version === "achievement_badge_v1" ||
      input.visualSpec.version === "achievement_badge_v2"
        ? AchievementBadgeVisualSpecSchema.parse(input.visualSpec)
        : VisualPromptSpecSchema.parse(input.visualSpec);
    const spec = {
      ...parsed,
      mood: "mood" in parsed ? parsed.mood : parsed.theme,
    };
    const width = boundedDimension(input.width);
    const height = boundedDimension(input.height);
    if (parsed.version === "achievement_badge_v2") {
      const color = parsed.finish === "gold" ? "#C69A4F" : "url(#aurora)";
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 100 100"><defs><linearGradient id="aurora" x2="1" y2="1"><stop stop-color="#DBB2C9"/><stop offset=".34" stop-color="#B3DEDE"/><stop offset=".65" stop-color="#B8A8D7"/><stop offset="1" stop-color="#E6D19F"/></linearGradient></defs><path d="M49 10C61 8 65 15 77 17C88 23 82 33 89 44C93 57 82 63 83 76C72 85 64 81 52 90C38 91 36 83 23 81C12 74 17 63 10 52C8 38 17 35 17 24C24 13 38 17 49 10Z" fill="${color}" stroke="#A87B43" stroke-width="1.5"/><circle cx="50" cy="50" r="29" fill="none" stroke="#E8D09A" stroke-width="1.5"/><path d="M48 69V39M49 52C34 50 34 35 34 35C50 33 54 43 49 52ZM49 44C64 43 67 28 67 28C49 29 46 37 49 44Z" fill="none" stroke="#E8D09A" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
      return {
        bytes: new TextEncoder().encode(svg),
        mimeType: "image/svg+xml",
        width,
        height,
      };
    }
    const [paper, ink, accent] = [
      spec.palette[0]!,
      spec.palette[1]!,
      spec.palette[2] ?? spec.palette[1]!,
    ];
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" rx="24" fill="${paper}"/>
  <rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="16" fill="none" stroke="${ink}" stroke-width="3"/>
  <circle cx="${Math.round(width * 0.78)}" cy="${Math.round(height * 0.28)}" r="${Math.round(Math.min(width, height) * 0.13)}" fill="${accent}" opacity="0.72"/>
  <path d="M ${Math.round(width * 0.1)} ${Math.round(height * 0.68)} Q ${Math.round(width * 0.36)} ${Math.round(height * 0.42)}, ${Math.round(width * 0.58)} ${Math.round(height * 0.68)} T ${Math.round(width * 0.92)} ${Math.round(height * 0.68)} L ${Math.round(width * 0.92)} ${Math.round(height * 0.88)} L ${Math.round(width * 0.1)} ${Math.round(height * 0.88)} Z" fill="${ink}" opacity="0.18"/>
  <text x="${Math.round(width * 0.09)}" y="${Math.round(height * 0.17)}" fill="${ink}" font-family="serif" font-size="${Math.max(18, Math.round(width * 0.045))}">${escapeXml(spec.subject)}</text>
  <text x="${Math.round(width * 0.09)}" y="${Math.round(height * 0.24)}" fill="${ink}" opacity="0.72" font-family="sans-serif" font-size="${Math.max(12, Math.round(width * 0.024))}">${escapeXml(spec.mood)}</text>
</svg>`;
    return {
      bytes: new TextEncoder().encode(svg),
      mimeType: "image/svg+xml",
      width,
      height,
    };
  }
}

export function createFixtureImageGenerationProvider(): ImageGenerationProvider {
  return new FixtureImageGenerationProvider();
}

function boundedDimension(value: number): number {
  if (!Number.isInteger(value) || value < 64 || value > 4_096) {
    throw new RangeError("Image dimensions must be integers from 64 to 4096");
  }
  return value;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
