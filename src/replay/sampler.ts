import { classifyStep } from "../classify/kinds.js";
import type { Session, StepKind } from "../types.js";
import { stepCanonicalAction } from "./tools.js";

export interface SampledStep {
  stepIndex: number;
  kind: StepKind;
}

/** Stable order so a given seed always consumes the RNG the same way. */
const KIND_ORDER: StepKind[] = [
  "read",
  "search",
  "web",
  "edit",
  "test",
  "shell",
  "plan",
  "delegate",
  "other",
];

/** Small deterministic PRNG (mulberry32) — no dependency, same seed same picks. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function isReplayable(session: Session, stepIndex: number): StepKind | undefined {
  const step = session.steps[stepIndex];
  if (step === undefined || step.isSidechain) return undefined;
  if (step.tools.length > 0 && stepCanonicalAction(step.tools) === null) {
    return undefined;
  }
  return step.kind ?? classifyStep(step);
}

/**
 * Sample up to `perKind` replayable steps per kind.
 *
 * Groups are evenly spaced across the session, with a seeded phase offset so
 * reruns pick the same steps while different seeds explore different points.
 */
export function sampleSteps(
  session: Session,
  perKind: number,
  seed: number,
): SampledStep[] {
  const cap = Math.max(0, Math.floor(perKind));
  if (cap === 0) return [];

  const groups = new Map<StepKind, number[]>();
  for (let index = 0; index < session.steps.length; index += 1) {
    const kind = isReplayable(session, index);
    if (kind === undefined) continue;
    const bucket = groups.get(kind);
    if (bucket === undefined) groups.set(kind, [index]);
    else bucket.push(index);
  }

  const random = mulberry32(seed);
  const sampled: SampledStep[] = [];

  for (const kind of KIND_ORDER) {
    const candidates = groups.get(kind);
    if (candidates === undefined || candidates.length === 0) continue;

    if (candidates.length <= cap) {
      for (const stepIndex of candidates) sampled.push({ stepIndex, kind });
      continue;
    }

    const stride = candidates.length / cap;
    const offset = random() * stride;
    for (let slot = 0; slot < cap; slot += 1) {
      const position = Math.min(
        candidates.length - 1,
        Math.floor(offset + slot * stride),
      );
      sampled.push({ stepIndex: candidates[position] as number, kind });
    }
  }

  return sampled.sort((a, b) => a.stepIndex - b.stepIndex);
}