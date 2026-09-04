import {
  VisualPromptSpecSchema,
  type VisualPromptSpec,
} from "@personasim/contracts";

export interface ImageGenerationInput {
  readonly visualSpec: VisualPromptSpec;
  readonly width: number;
  readonly height: number;
  readonly idempotencyKey: string;
}

export interface GeneratedImageAsset {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/svg+xml" | "image/png" | "image/webp";
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
    const spec = VisualPromptSpecSchema.parse(input.visualSpec);
    const width = boundedDimension(input.width);
    const height = boundedDimension(input.height);
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
