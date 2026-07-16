// OpenLimits' upstream gateway rejects request bodies around 54 MiB. Keep a
// safety margin so headers/serialization changes do not move requests over it.
export const OPENLIMITS_BODY_COMPACTION_BYTES = 50 * 1024 * 1024;
const BODY_MEASUREMENT_IMAGE_BYTES = 32 * 1024 * 1024;
const OMITTED_IMAGE_TEXT = "[Historical image omitted while generating an automatic compaction summary]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function countEmbeddedImageBytes(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((total, item) => total + countEmbeddedImageBytes(item), 0);
  if (!isRecord(value)) return 0;

  let total = 0;
  if (value.type === "input_image" && typeof value.image_url === "string") {
    total += Buffer.byteLength(value.image_url);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "image_url") total += countEmbeddedImageBytes(child);
  }
  return total;
}

export function measureImageHeavyPayload(value: unknown): number | undefined {
  if (countEmbeddedImageBytes(value) < BODY_MEASUREMENT_IMAGE_BYTES) return undefined;
  return Buffer.byteLength(JSON.stringify(value));
}

export function omitImagesForCompaction<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => omitImagesForCompaction(item)) as T;
  if (!isRecord(value)) return value;
  if (value.type === "input_image" && typeof value.image_url === "string") {
    return { type: "input_text", text: OMITTED_IMAGE_TEXT } as T;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, omitImagesForCompaction(child)]),
  ) as T;
}

function isGoalCheckpoint(value: unknown): boolean {
  if (!isRecord(value) || value.role !== "user" || !Array.isArray(value.content)) return false;
  return value.content.some((part) =>
    isRecord(part)
    && part.type === "input_text"
    && typeof part.text === "string"
    && part.text.includes("<pi_goal_continuation")
    && part.text.includes("kind=\"checkpoint\""),
  );
}

export function preparePayloadForCompaction<T>(value: T): T {
  const compacted = omitImagesForCompaction(value);
  if (!isRecord(compacted) || !Array.isArray(compacted.input)) return compacted;

  let lastCheckpoint = -1;
  for (let index = compacted.input.length - 1; index >= 0; index -= 1) {
    if (isGoalCheckpoint(compacted.input[index])) {
      lastCheckpoint = index;
      break;
    }
  }
  if (lastCheckpoint < 0) return compacted;
  return {
    ...compacted,
    input: compacted.input.filter((item, index) => !isGoalCheckpoint(item) || index === lastCheckpoint),
  } as T;
}
