const OMITTED_IMAGE_TEXT = "[Historical image omitted while generating an automatic compaction summary]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
