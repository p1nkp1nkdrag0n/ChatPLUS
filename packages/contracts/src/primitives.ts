import { z } from "zod";

const UTC_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** An RFC 3339 instant normalized to UTC (the `Z` designator is mandatory). */
export const UtcDateTimeSchema = z
  .string()
  .regex(
    UTC_DATE_TIME_PATTERN,
    "Expected an ISO 8601 UTC timestamp ending in Z",
  )
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "Expected a valid UTC timestamp",
  );

/** A wall-clock time without a date, represented as 24-hour HH:mm. */
export const LocalTimeSchema = z
  .string()
  .regex(LOCAL_TIME_PATTERN, "Expected local time in HH:mm format");

export const EntityIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(IDENTIFIER_PATTERN, "Invalid identifier");
export const NonEmptyTextSchema = z.string().trim().min(1).max(4_000);
export const ShortTextSchema = z.string().trim().min(1).max(240);
export const ReasonCodeSchema = z
  .string()
  .regex(REASON_CODE_PATTERN, "Invalid reason code");
export const UnitIntervalSchema = z.number().finite().min(0).max(1);
export const SignedUnitIntervalSchema = z.number().finite().min(-1).max(1);
export const RevisionSchema = z.number().int().nonnegative();

export const IanaTimezoneSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((timezone) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
      return timezone.includes("/") || timezone === "UTC";
    } catch {
      return false;
    }
  }, "Expected a valid IANA timezone");

export const SimulationTierSchema = z.enum([
  "lightweight",
  "daily",
  "high_fidelity",
]);
export type SimulationTier = z.infer<typeof SimulationTierSchema>;

export const JsonPrimitiveSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type JsonPrimitive = z.infer<typeof JsonPrimitiveSchema>;

export type JsonValue =
  JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    JsonPrimitiveSchema,
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export function isChronologicalRange(
  startAtUtc: string,
  endAtUtc: string,
): boolean {
  return Date.parse(startAtUtc) < Date.parse(endAtUtc);
}
