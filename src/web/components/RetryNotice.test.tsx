import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiRetryInfo } from "../../shared/index.ts";
import { RetryNotice } from "./RetryNotice.tsx";

afterEach(() => vi.useRealTimers());

const info = (over: Partial<ApiRetryInfo> = {}): ApiRetryInfo => ({
  attempt: 3,
  maxRetries: 10,
  retryAt: 10_000,
  errorStatus: null,
  error: "unknown",
  ...over,
});

describe("RetryNotice", () => {
  it("第几次 / 共几次，倒计时每秒减一，到点后不再显示倒计时", () => {
    vi.useFakeTimers({ now: 5_000 });
    render(<RetryNotice info={info()} />);
    expect(screen.getByText(/Retrying 3\/10/)).toBeInTheDocument();
    expect(screen.getByText("in 5s")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText("in 3s")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.queryByText(/^in \d+s$/)).not.toBeInTheDocument();
    expect(screen.getByText(/Retrying 3\/10/)).toBeInTheDocument();
  });

  it("换成新的一次：倒计时按新的时间点算", () => {
    vi.useFakeTimers({ now: 5_000 });
    const { rerender } = render(<RetryNotice info={info()} />);
    rerender(<RetryNotice info={info({ attempt: 4, retryAt: 25_000 })} />);
    expect(screen.getByText(/Retrying 4\/10/)).toBeInTheDocument();
    expect(screen.getByText("in 20s")).toBeInTheDocument();
  });

  it("没有时间点：不写倒计时", () => {
    render(<RetryNotice info={info({ retryAt: null })} />);
    expect(screen.queryByText(/^in \d+s$/)).not.toBeInTheDocument();
  });

  it("鼠标放上去能看到原始的错误：状态码和 error", () => {
    render(<RetryNotice info={info({ errorStatus: 529, error: "overloaded" })} />);
    expect(screen.getByText(/Retrying/).closest("[title]")).toHaveAttribute("title", "529 overloaded");
  });
});
