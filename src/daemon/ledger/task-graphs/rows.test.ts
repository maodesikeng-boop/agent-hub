import { expect, it } from "vitest";
import { artifactWithoutCheckpoint, readStoredArtifact } from "./rows.ts";

it.each([
  { branch: 123, commit: "abc1234", expected: { commit: "abc1234" } },
  { branch: "topic", commit: [], expected: { branch: "topic" } },
])("preserves the valid delivery fields when clearing a checkpoint with branch $branch and commit $commit", ({ branch, commit, expected }) => {
  const artifact_json = JSON.stringify({ branch, commit, summary: "Ready", checkpointPending: true });
  const artifact = { ...expected, summary: "Ready" };

  expect(readStoredArtifact(artifact_json)).toEqual({ artifact, checkpointPending: true });
  expect(JSON.parse(artifactWithoutCheckpoint({ artifact_json })!)).toEqual(artifact);
});
