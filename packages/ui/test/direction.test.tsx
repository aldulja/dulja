import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DirectionProvider, useDirection } from "../src/direction";

const Probe = () => {
  const { locale, dir } = useDirection();
  return <span data-testid="probe">{`${locale}/${dir}`}</span>;
};

describe("DirectionProvider", () => {
  it("puts lang and dir on the document root for English", () => {
    render(
      <DirectionProvider locale="en">
        <Probe />
      </DirectionProvider>,
    );
    expect(document.documentElement.getAttribute("lang")).toBe("en");
    expect(document.documentElement.getAttribute("dir")).toBe("ltr");
    expect(screen.getByTestId("probe")).toHaveTextContent("en/ltr");
  });

  it("switches the document root to rtl for Arabic", () => {
    render(
      <DirectionProvider locale="ar">
        <Probe />
      </DirectionProvider>,
    );
    expect(document.documentElement.getAttribute("lang")).toBe("ar");
    expect(document.documentElement.getAttribute("dir")).toBe("rtl");
    expect(screen.getByTestId("probe")).toHaveTextContent("ar/rtl");
  });

  it("refuses to be used outside the provider", () => {
    expect(() => render(<Probe />)).toThrow("useDirection must be used inside <DirectionProvider>");
  });
});
