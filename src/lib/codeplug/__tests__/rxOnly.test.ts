import { describe, it, expect } from "vitest";
import { collectRxOnly, isRxOnlyChannel } from "../rxOnly";
import { makeChannel } from "./helpers";

describe("isRxOnlyChannel", () => {
  it("är false för en vanlig repeater", () => {
    expect(isRxOnlyChannel(makeChannel())).toBe(false);
  });

  it("är true när rx_only är satt", () => {
    expect(isRxOnlyChannel(makeChannel({ rx_only: true }))).toBe(true);
  });

  it("är true när tx_allowed=false utan rx_only", () => {
    expect(isRxOnlyChannel(makeChannel({ tx_allowed: false, rx_only: false }))).toBe(true);
  });

  it('är true när duplex="off" (block_tx-policyn)', () => {
    expect(isRxOnlyChannel(makeChannel({ duplex: "off" }))).toBe(true);
  });
});

describe("collectRxOnly", () => {
  it("returnerar bara RX-only-kanaler, i ordning", () => {
    const list = [
      makeChannel({ generated_name_final: "A" }),
      makeChannel({ generated_name_final: "B", rx_only: true }),
      makeChannel({ generated_name_final: "C", tx_allowed: false }),
    ];
    expect(collectRxOnly(list).map((c) => c.generated_name_final)).toEqual(["B", "C"]);
  });

  it("returnerar tom lista när inget är RX-only", () => {
    expect(collectRxOnly([makeChannel()])).toEqual([]);
  });
});
