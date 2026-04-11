import { describe, it, expect } from "vitest";
import { futuresValueRating } from "@/lib/collegeFuturesModel";
import { devigImpliedProbs } from "@/lib/collegeFuturesOddsApi";

describe("college futures helpers", () => {
  it("maps edge to value grades", () => {
    expect(futuresValueRating(0.06)).toBe("A");
    expect(futuresValueRating(0.035)).toBe("B");
    expect(futuresValueRating(0)).toBe("C");
    expect(futuresValueRating(-0.035)).toBe("D");
    expect(futuresValueRating(-0.08)).toBe("F");
  });

  it("devigs implied probabilities", () => {
    const d = devigImpliedProbs([0.5, 0.5]);
    expect(d[0] + d[1]).toBeCloseTo(1, 5);
    expect(d[0]).toBeCloseTo(0.5, 5);
  });
});
