import { readFileSync } from "node:fs";

export const readProgressFixture = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
export const progressJsonLines = <T>(text: string): T[] => text.trim().split("\n").map((line): T => JSON.parse(line));
export const progressFrames = <T>(name: string): T[] => progressJsonLines(readProgressFixture(name));
export const progressFrame = <T>(name: string): T => JSON.parse(readProgressFixture(name));
