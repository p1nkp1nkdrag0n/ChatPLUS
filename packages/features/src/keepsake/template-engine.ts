import {
  KeepsakeKindSchema,
  KeepsakeVisualSpecSchema,
  type KeepsakeKind,
  type KeepsakeVisualSpec,
} from "@personasim/contracts";

export interface RenderedKeepsakeTemplate {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/svg+xml";
  readonly width: number;
  readonly height: number;
  readonly templateVersion: string;
}

export interface KeepsakeTemplateRenderInput {
  readonly kind: KeepsakeKind;
  readonly title: string;
  readonly visualSpec: KeepsakeVisualSpec;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Deterministic stage-6A renderer. Story facts are already frozen in the
 * KeepsakeVisualSpec; the renderer only projects those facts into markup.
 */
export class KeepsakeTemplateEngine {
  readonly name = "structured-template";

  render(input: KeepsakeTemplateRenderInput): RenderedKeepsakeTemplate {
    const kind = KeepsakeKindSchema.parse(input.kind);
    const spec = KeepsakeVisualSpecSchema.parse(input.visualSpec);
    const width = dimension(input.width ?? (kind === "postcard" ? 1200 : 900));
    const height = dimension(
      input.height ?? (kind === "postcard" ? 800 : 1100),
    );
    const svg = renderByKind(kind, input.title, spec, width, height);
    return {
      bytes: new TextEncoder().encode(svg),
      mimeType: "image/svg+xml",
      width,
      height,
      templateVersion: spec.templateVersion,
    };
  }
}

export function isStructuredKeepsakeKind(kind: KeepsakeKind): boolean {
  return (
    kind === "ticket_stub" ||
    kind === "recipe_or_note_card" ||
    kind === "postcard"
  );
}

function renderByKind(
  kind: KeepsakeKind,
  rawTitle: string,
  spec: KeepsakeVisualSpec,
  width: number,
  height: number,
): string {
  const title = escapeXml(rawTitle.trim().slice(0, 160));
  const caption = escapeXml(spec.caption.trim().slice(0, 500));
  const paper = spec.palette[0]!;
  const ink = spec.palette[1]!;
  const accent = spec.palette[2] ?? ink;
  const common = `<rect width="${width}" height="${height}" fill="${paper}"/>`;
  if (kind === "ticket_stub") {
    const perforation = Math.round(width * 0.72);
    return svgDocument(
      width,
      height,
      `${common}
  <rect x="38" y="38" width="${width - 76}" height="${height - 76}" rx="24" fill="none" stroke="${ink}" stroke-width="4"/>
  <path d="M ${perforation} 38 V ${height - 38}" stroke="${ink}" stroke-width="3" stroke-dasharray="12 12" opacity="0.65"/>
  <text x="82" y="${Math.round(height * 0.24)}" fill="${accent}" font-family="serif" font-size="44">ADMIT ONE</text>
  <text x="82" y="${Math.round(height * 0.39)}" fill="${ink}" font-family="serif" font-size="58">${title}</text>
  <text x="82" y="${Math.round(height * 0.54)}" fill="${ink}" font-family="sans-serif" font-size="28">${caption}</text>
  <circle cx="${Math.round(width * 0.84)}" cy="${Math.round(height * 0.5)}" r="74" fill="none" stroke="${accent}" stroke-width="8"/>`,
    );
  }
  if (kind === "postcard") {
    return svgDocument(
      width,
      height,
      `${common}
  <rect x="32" y="32" width="${width - 64}" height="${height - 64}" fill="none" stroke="${ink}" stroke-width="3"/>
  <circle cx="${Math.round(width * 0.76)}" cy="${Math.round(height * 0.31)}" r="${Math.round(height * 0.16)}" fill="${accent}" opacity="0.65"/>
  <path d="M 32 ${Math.round(height * 0.7)} Q ${Math.round(width * 0.24)} ${Math.round(height * 0.38)}, ${Math.round(width * 0.47)} ${Math.round(height * 0.7)} T ${width - 32} ${Math.round(height * 0.7)} V ${height - 32} H 32 Z" fill="${ink}" opacity="0.18"/>
  <text x="72" y="104" fill="${ink}" font-family="serif" font-size="54">${title}</text>
  <text x="72" y="${height - 86}" fill="${ink}" font-family="sans-serif" font-size="27">${caption}</text>`,
    );
  }
  if (kind === "recipe_or_note_card") {
    const lines = Array.from({ length: 12 }, (_, index) => {
      const y = 230 + index * 62;
      return `<path d="M 58 ${y} H ${width - 58}" stroke="${ink}" stroke-width="2" opacity="0.18"/>`;
    }).join("\n  ");
    return svgDocument(
      width,
      height,
      `${common}
  <path d="M 150 0 V ${height}" stroke="${accent}" stroke-width="3" opacity="0.4"/>
  ${lines}
  <text x="190" y="128" fill="${ink}" font-family="serif" font-size="52">${title}</text>
  <text x="190" y="194" fill="${accent}" font-family="sans-serif" font-size="26">${caption}</text>`,
    );
  }

  // Non-template kinds retain a deterministic fallback for fixture/offline
  // environments. Enforced multimodal mode may replace this with a provider.
  return svgDocument(
    width,
    height,
    `${common}
  <rect x="48" y="48" width="${width - 96}" height="${height - 96}" rx="20" fill="none" stroke="${ink}" stroke-width="4"/>
  <circle cx="${Math.round(width / 2)}" cy="${Math.round(height * 0.42)}" r="${Math.round(Math.min(width, height) * 0.22)}" fill="${accent}" opacity="0.42"/>
  <text x="72" y="${height - 154}" fill="${ink}" font-family="serif" font-size="48">${title}</text>
  <text x="72" y="${height - 96}" fill="${ink}" font-family="sans-serif" font-size="24">${caption}</text>`,
  );
}

function svgDocument(width: number, height: number, content: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${content}
</svg>`;
}

function dimension(value: number): number {
  if (!Number.isInteger(value) || value < 64 || value > 4096) {
    throw new RangeError(
      "Template dimensions must be integers from 64 to 4096",
    );
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
