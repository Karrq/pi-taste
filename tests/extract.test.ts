import { describe, expect, it } from "vitest";
import { normalizeSourceEntryIds } from "../src/agents/extract/agent.js";

describe("normalizeSourceEntryIds", () => {
	const allowed = ["m1", "m2", "m3"];

	it("accepts allowed ids and orders them by chunk position", () => {
		expect(normalizeSourceEntryIds(["m3", "m1"], allowed)).toEqual(["m1", "m3"]);
	});

	it("rejects the whole signal when any cited id is unknown", () => {
		expect(normalizeSourceEntryIds(["m1", "ghost"], allowed)).toBeUndefined();
	});

	it("rejects empty or missing citations", () => {
		expect(normalizeSourceEntryIds(undefined, allowed)).toBeUndefined();
		expect(normalizeSourceEntryIds([], allowed)).toBeUndefined();
	});
});
