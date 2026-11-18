import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RangeField } from "@/components/toolParts";

describe("RangeField", () => {
  it("offers quick page shortcuts and reports them upward", () => {
    const onChange = vi.fn();
    render(<RangeField value="" onChange={onChange} total={6} />);
    fireEvent.click(screen.getByRole("button", { name: "Odd" }));
    expect(onChange).toHaveBeenCalledWith("odd");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.getByText(/6 pages available/i)).toBeInTheDocument();
  });

  it("validates a typed range live and describes the selection", () => {
    const { rerender } = render(<RangeField value="1-3" onChange={() => {}} total={6} />);
    expect(screen.getByText(/3 selected pages|Pages 1, 2, 3|6 pages available/i)).toBeInTheDocument();
    rerender(<RangeField value="9" onChange={() => {}} total={6} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/doesn’t exist/i);
    expect(screen.getByLabelText(/pages/i)).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps the page-range id for deep links and tests", () => {
    render(<RangeField value="" onChange={() => {}} total={3} />);
    expect(document.querySelector("#page-range")).toBeInTheDocument();
  });
});
