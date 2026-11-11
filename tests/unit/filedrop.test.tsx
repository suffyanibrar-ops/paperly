import { describe, expect, it, vi } from "vitest";

// The upload component only needs two pure formatting helpers; mocking the PDF
// engine keeps this component test fast (the engine is covered by Playwright).
vi.mock("@/lib/pdf", () => ({
  fileExt: (name: string) => (name.split(".").pop() ?? "").toLowerCase(),
  formatBytes: (bytes: number) => `${bytes} B`,
}));
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileDrop } from "@/components/ui";

const textFile = (contents: string, name = "fake.pdf") => new File([contents], name, { type: "application/pdf" });

describe("FileDrop validation", () => {
  it("accepts a valid PDF signature and passes it to the tool", async () => {
    const onFiles = vi.fn();
    render(<FileDrop accept="application/pdf,.pdf" acceptLabel="PDF files" onFiles={onFiles} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const valid = new File(["%PDF-1.7\n"], "ok.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [valid] } });
    await waitFor(() => expect(onFiles).toHaveBeenCalledWith([valid]));
  });

  it("rejects a text file renamed to .pdf without calling the tool", async () => {
    const onFiles = vi.fn();
    render(<FileDrop accept="application/pdf,.pdf" acceptLabel="PDF files" onFiles={onFiles} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [textFile("not a pdf at all")] } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/doesn’t look like a real PDF/));
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("rejects the wrong file type with a descriptive message", async () => {
    const onFiles = vi.fn();
    render(<FileDrop accept="application/pdf,.pdf" acceptLabel="PDF files" onFiles={onFiles} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["img"], "photo.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/isn’t supported here/));
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("associates a labelled drop zone with a native file input", () => {
    render(<FileDrop accept="application/pdf,.pdf" acceptLabel="PDF files" onFiles={() => {}} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.getAttribute("aria-label")).toMatch(/choose pdf files/i);
    const label = document.querySelector(`label[for="${input.id}"]`) as HTMLLabelElement;
    expect(label).toBeInTheDocument();
    // The native label/input pair is keyboard and screen-reader operable without a nested
    // interactive role (axe: nested-interactive).
    expect(input.closest('[role="button"]')).toBeNull();
  });
});
