import type { DateTime } from "luxon";

import { normalizeText, parseInstant, parseZone } from "./shared.js";

export interface TemporalAnchorLike {
  id: string;
  label: string;
  startAtUtc: string;
  endAtUtc?: string;
  certainty: "exact" | "date_only" | "approximate" | "unknown";
}

export interface ResolvedTemporalQuery {
  kind: "resolved";
  expression:
    | "yesterday"
    | "day_before_yesterday"
    | "last_week"
    | "last_month"
    | "last_tuesday"
    | "before_anchor"
    | "after_anchor";
  fromUtc: string;
  toUtc: string;
  anchorId?: string;
}

export interface AmbiguousTemporalQuery {
  kind: "ambiguous";
  reasonCode:
    | "multiple_temporal_expressions"
    | "anchor_not_found"
    | "ambiguous_anchor"
    | "anchor_time_uncertain";
}

export interface NoTemporalQuery {
  kind: "none";
}

export type TemporalQueryResolution =
  ResolvedTemporalQuery | AmbiguousTemporalQuery | NoTemporalQuery;

function utc(value: DateTime): string {
  return value.toUTC().toISO()!;
}

function localDayRange(
  localDay: DateTime,
  expression: ResolvedTemporalQuery["expression"],
): ResolvedTemporalQuery {
  const start = localDay.startOf("day");
  return {
    kind: "resolved",
    expression,
    fromUtc: utc(start),
    toUtc: utc(start.plus({ days: 1 })),
  };
}

function anchorDirection(
  text: string,
  anchorLabel: string,
): "before" | "after" | "both" | undefined {
  const normalizedText = normalizeText(text);
  const normalizedLabel = normalizeText(anchorLabel);
  if (
    normalizedLabel.length === 0 ||
    !normalizedText.includes(normalizedLabel)
  ) {
    return undefined;
  }
  const before =
    normalizedText.includes(`before ${normalizedLabel}`) ||
    normalizedText.includes(`before the ${normalizedLabel}`) ||
    normalizedText.includes(`${normalizedLabel} before`) ||
    text.includes(`${anchorLabel}\u524d`) ||
    text.includes(`${anchorLabel}\u4e4b\u524d`);
  const after =
    normalizedText.includes(`after ${normalizedLabel}`) ||
    normalizedText.includes(`after the ${normalizedLabel}`) ||
    normalizedText.includes(`${normalizedLabel} after`) ||
    text.includes(`${anchorLabel}\u540e`) ||
    text.includes(`${anchorLabel}\u4e4b\u540e`);
  if (before && after) return "both";
  if (before) return "before";
  if (after) return "after";
  return undefined;
}

function isGenericCompletionPreference(text: string): boolean {
  const chinesePreference =
    /(?:\u559c\u6b22|\u504f\u597d|\u4e60\u60ef|\u901a\u5e38|\u4e00\u822c|\u5f80\u5f80|\u603b\u662f|\u503e\u5411|\u66f4\u613f\u610f)/u.test(
      text,
    );
  const chineseCompletion =
    /(?:(?:\u4efb\u52a1|\u5de5\u4f5c|\u4e8b\u60c5|\u8fd4\u5de5|\u9879\u76ee)(?:\u5b8c\u6210|\u7ed3\u675f|\u505a\u5b8c|\u5fd9\u5b8c)|(?:\u505a\u5b8c|\u5fd9\u5b8c|\u6536\u5de5))\u4e4b?\u540e/u.test(
      text,
    );
  const englishPreference =
    /\b(?:prefer|usually|generally|habitually|tend to)\b/iu.test(text);
  const englishCompletion =
    /\bafter\s+(?:(?:finishing|completing)\s+(?:(?:a|the|my)\s+)?(?:task|work|project)|(?:(?:a|the|my)\s+)?(?:task|work|project)\s+(?:finishes|ends))\b/iu.test(
      text,
    );
  return (
    (chinesePreference && chineseCompletion) ||
    (englishPreference && englishCompletion)
  );
}

function resolveAnchorQuery(
  text: string,
  anchors: readonly TemporalAnchorLike[],
): TemporalQueryResolution | undefined {
  const matches = anchors.flatMap((anchor) => {
    const direction = anchorDirection(text, anchor.label);
    return direction === undefined ? [] : [{ anchor, direction }];
  });
  const hasDirectionWord =
    !isGenericCompletionPreference(text) &&
    (/\bbefore\b|\bafter\b/iu.test(text) ||
      /\u4e4b\u524d|\u4e4b\u540e/u.test(text));
  if (matches.length === 0) {
    return hasDirectionWord
      ? { kind: "ambiguous", reasonCode: "anchor_not_found" }
      : undefined;
  }
  if (
    matches.length !== 1 ||
    matches.some((match) => match.direction === "both")
  ) {
    return { kind: "ambiguous", reasonCode: "ambiguous_anchor" };
  }
  const match = matches[0];
  if (match === undefined) {
    return { kind: "ambiguous", reasonCode: "anchor_not_found" };
  }
  if (
    match.anchor.certainty === "unknown" ||
    match.anchor.certainty === "approximate"
  ) {
    return { kind: "ambiguous", reasonCode: "anchor_time_uncertain" };
  }
  const start = parseInstant(match.anchor.startAtUtc);
  const end =
    match.anchor.endAtUtc === undefined
      ? start
      : parseInstant(match.anchor.endAtUtc);
  if (match.direction === "before") {
    return {
      kind: "resolved",
      expression: "before_anchor",
      fromUtc: utc(start.minus({ hours: 24 })),
      toUtc: utc(start),
      anchorId: match.anchor.id,
    };
  }
  return {
    kind: "resolved",
    expression: "after_anchor",
    fromUtc: utc(end),
    toUtc: utc(end.plus({ hours: 24 })),
    anchorId: match.anchor.id,
  };
}

export function resolveTemporalQuery(input: {
  text: string;
  nowUtc: string;
  timezone: string;
  anchors?: readonly TemporalAnchorLike[];
}): TemporalQueryResolution {
  parseZone(input.timezone);
  const now = parseInstant(input.nowUtc).setZone(input.timezone);
  const text = input.text.normalize("NFKC");
  const dayBeforeYesterday =
    /\bday before yesterday\b/iu.test(text) || /\u524d\u5929/u.test(text);
  const yesterday =
    !dayBeforeYesterday &&
    (/\byesterday\b/iu.test(text) || /\u6628\u5929/u.test(text));
  const lastWeek =
    /\blast week\b/iu.test(text) ||
    /\u4e0a\u5468|\u4e0a\u661f\u671f/u.test(text);
  const lastMonth =
    /\blast month\b/iu.test(text) ||
    /\u4e0a\u4e2a\u6708|\u4e0a\u6708/u.test(text);
  const tuesday =
    /\b(?:last )?tuesday\b/iu.test(text) ||
    /\u5468\u4e8c|\u661f\u671f\u4e8c/u.test(text);
  const calendarMatches = [
    dayBeforeYesterday,
    yesterday,
    lastWeek,
    lastMonth,
    tuesday,
  ].filter(Boolean).length;
  const anchor = resolveAnchorQuery(input.text, input.anchors ?? []);

  if (
    calendarMatches > 1 ||
    (calendarMatches > 0 && anchor?.kind !== undefined)
  ) {
    return {
      kind: "ambiguous",
      reasonCode: "multiple_temporal_expressions",
    };
  }
  if (anchor !== undefined) return anchor;
  if (dayBeforeYesterday) {
    return localDayRange(now.minus({ days: 2 }), "day_before_yesterday");
  }
  if (yesterday) {
    return localDayRange(now.minus({ days: 1 }), "yesterday");
  }
  if (lastWeek) {
    const thisWeekStart = now.startOf("day").minus({ days: now.weekday - 1 });
    return {
      kind: "resolved",
      expression: "last_week",
      fromUtc: utc(thisWeekStart.minus({ weeks: 1 })),
      toUtc: utc(thisWeekStart),
    };
  }
  if (lastMonth) {
    const thisMonthStart = now.startOf("month");
    return {
      kind: "resolved",
      expression: "last_month",
      fromUtc: utc(thisMonthStart.minus({ months: 1 })),
      toUtc: utc(thisMonthStart),
    };
  }
  if (tuesday) {
    const thisWeekStart = now.startOf("day").minus({ days: now.weekday - 1 });
    let candidate = thisWeekStart.plus({ days: 1 });
    if (candidate.plus({ days: 1 }) > now) {
      candidate = candidate.minus({ weeks: 1 });
    }
    return localDayRange(candidate, "last_tuesday");
  }
  return { kind: "none" };
}
