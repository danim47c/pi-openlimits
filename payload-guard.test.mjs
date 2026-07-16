import { describe, expect, test } from "bun:test";
import {
  countEmbeddedImageBytes,
  measureImageHeavyPayload,
  omitImagesForCompaction,
  preparePayloadForCompaction,
} from "./payload-guard.ts";

describe("OpenLimits image payload guard", () => {
  const payload = {
    input: [{
      type: "function_call_output",
      output: [
        { type: "input_text", text: "Read image" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ],
    }],
  };

  test("counts embedded image URLs without counting normal text", () => {
    expect(countEmbeddedImageBytes(payload)).toBe(Buffer.byteLength("data:image/png;base64,AAAA"));
  });

  test("skips full JSON measurement for small image payloads", () => {
    expect(measureImageHeavyPayload(payload)).toBeUndefined();
  });

  test("replaces images with valid Responses input text for compaction", () => {
    const compacted = omitImagesForCompaction(payload);
    expect(compacted.input[0].output).toEqual([
      { type: "input_text", text: "Read image" },
      {
        type: "input_text",
        text: "[Historical image omitted while generating an automatic compaction summary]",
      },
    ]);
    expect(countEmbeddedImageBytes(compacted)).toBe(0);
  });

  test("keeps only the latest repeated pi-goal checkpoint during compaction", () => {
    const checkpoint = (goal) => ({
      role: "user",
      content: [{
        type: "input_text",
        text: `<pi_goal_continuation goal_id="${goal}" kind="checkpoint">GOAL CHECKPOINT`,
      }],
    });
    const compacted = preparePayloadForCompaction({
      input: [checkpoint("a"), { role: "assistant", content: [{ type: "output_text", text: "work" }] }, checkpoint("a")],
    });
    expect(compacted.input).toEqual([
      { role: "assistant", content: [{ type: "output_text", text: "work" }] },
      checkpoint("a"),
    ]);
  });
});
