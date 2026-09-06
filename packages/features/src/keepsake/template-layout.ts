import type { KeepsakeKind, KeepsakeVisualSpec } from "@personasim/contracts";

interface TextBox {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  color: string;
}
const SEGMENTER = new Intl.Segmenter("zh", { granularity: "grapheme" });

/** Versioned SVG layout; coordinates are in a canonical canvas, independent of output size. */
export function renderKeepsakeV2(
  kind: KeepsakeKind,
  rawTitle: string,
  spec: KeepsakeVisualSpec,
  width: number,
  height: number,
): string {
  const canvasWidth = kind === "postcard" ? 1200 : 900;
  const canvasHeight = kind === "postcard" ? 800 : 1100;
  const [paper, ink] = spec.palette;
  const accent = spec.palette[2] ?? ink!;
  const title = [...rawTitle.trim()].slice(0, 160).join("");
  const caption = [...spec.caption.trim()].slice(0, 500).join("");
  const background = `<rect width="${canvasWidth}" height="${canvasHeight}" fill="${paper}"/>`;
  let markup: string;
  if (kind === "recipe_or_note_card") {
    const lines = Array.from(
      { length: 11 },
      (_, index) =>
        `<path d="M 176 ${370 + index * 58} H 826" stroke="${ink}" stroke-width="1.5" opacity="0.15"/>`,
    ).join("\n");
    markup = `<path d="M 138 0 V 1100" stroke="${accent}" stroke-width="3" opacity="0.4"/>
${lines}
${textBox(title, { x: 184, y: 72, width: 638, height: 230, fontSize: 48, color: ink! })}
${textBox(caption, { x: 184, y: 340, width: 638, height: 636, fontSize: 30, color: ink! })}
<path d="M 184 1014 H 284" stroke="${accent}" stroke-width="4"/>`;
  } else if (kind === "ticket_stub") {
    markup = `<rect x="38" y="38" width="824" height="1024" rx="24" fill="none" stroke="${ink}" stroke-width="4"/>
<path d="M 648 38 V 1062" stroke="${ink}" stroke-width="3" stroke-dasharray="12 12" opacity="0.65"/>
${textBox("ADMIT ONE", { x: 78, y: 130, width: 516, height: 60, fontSize: 42, color: accent })}
${textBox(title, { x: 78, y: 252, width: 516, height: 300, fontSize: 52, color: ink! })}
${textBox(caption, { x: 78, y: 616, width: 516, height: 356, fontSize: 28, color: ink! })}
<circle cx="752" cy="550" r="72" fill="none" stroke="${accent}" stroke-width="8"/>`;
  } else if (kind === "postcard") {
    markup = `<rect x="32" y="32" width="1136" height="736" fill="none" stroke="${ink}" stroke-width="3"/>
<circle cx="912" cy="320" r="110" fill="${accent}" opacity="0.5"/>
<path d="M 32 478 Q 288 300, 564 478 T 1168 478 V 768 H 32 Z" fill="${ink}" opacity="0.12"/>
${textBox(title, { x: 72, y: 62, width: 1056, height: 208, fontSize: 50, color: ink! })}
${textBox(caption, { x: 72, y: 516, width: 1056, height: 216, fontSize: 27, color: ink! })}`;
  } else {
    markup = `<rect x="48" y="48" width="804" height="1004" rx="20" fill="none" stroke="${ink}" stroke-width="4"/>
<circle cx="450" cy="330" r="170" fill="${accent}" opacity="0.42"/>
${textBox(title, { x: 88, y: 550, width: 724, height: 220, fontSize: 48, color: ink! })}
${textBox(caption, { x: 88, y: 804, width: 724, height: 198, fontSize: 24, color: ink! })}`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
<title>${escapeXml(title)}</title>
${background}
${markup}
</svg>`;
}

function textBox(text: string, box: TextBox): string {
  const characters = [...SEGMENTER.segment(text)].map(
    (segment) => segment.segment,
  );
  let fontSize = box.fontSize;
  let lines = wrap(characters, box.width, fontSize);
  while (lines.length * fontSize * 1.4 > box.height && fontSize > 12) {
    fontSize -= 1;
    lines = wrap(characters, box.width, fontSize);
  }
  const maximumLines = Math.max(1, Math.floor(box.height / (fontSize * 1.4)));
  if (lines.length > maximumLines) {
    lines = lines.slice(0, maximumLines);
    const last = lines.at(-1)!;
    while (measure(last.join("") + "…", fontSize) > box.width) last.pop();
    last.push("…");
  }
  const content = lines
    .map((line, index) => {
      const value = line.join("");
      if (value.trim() === "") return "";
      const baseline = box.y + fontSize + index * fontSize * 1.4;
      // Explicit length bounds make font substitution unable to overflow the card.
      const textLength = Math.min(box.width, measure(value, fontSize));
      return `<text x="${box.x}" y="${baseline.toFixed(2)}" font-size="${fontSize}" textLength="${textLength.toFixed(2)}" lengthAdjust="spacingAndGlyphs">${escapeXml(value)}</text>`;
    })
    .join("\n");
  return `<g data-text-box="${box.x} ${box.y} ${box.width} ${box.height}" fill="${box.color}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif">\n${content}\n</g>`;
}

function wrap(
  characters: readonly string[],
  width: number,
  fontSize: number,
): string[][] {
  const lines: string[][] = [[]];
  let lineWidth = 0;
  for (const character of characters) {
    if (character === "\n" || character === "\r\n") {
      lines.push([]);
      lineWidth = 0;
      continue;
    }
    let line = lines.at(-1)!;
    const nextWidth = glyphWidth(character, fontSize);
    if (line.length && lineWidth + nextWidth > width) {
      line = [];
      lines.push(line);
      lineWidth = 0;
    }
    line.push(character);
    lineWidth += nextWidth;
  }
  return lines;
}

function measure(value: string, fontSize: number): number {
  return [...SEGMENTER.segment(value)].reduce(
    (total, item) => total + glyphWidth(item.segment, fontSize),
    0,
  );
}

function glyphWidth(value: string, fontSize: number): number {
  return (/^[\x20-\x7e]$/u.test(value) ? 0.65 : 1) * fontSize;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
