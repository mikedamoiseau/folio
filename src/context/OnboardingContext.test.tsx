// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { OnboardingProvider, useOnboardingContext } from "./OnboardingContext";
import { STORAGE_KEY } from "../hooks/useOnboarding";

function Probe() {
  const { isActive, currentStep, advance, restart } = useOnboardingContext();
  return (
    <div>
      <span data-testid="active">{String(isActive)}</span>
      <span data-testid="step">{currentStep}</span>
      <button onClick={advance}>advance</button>
      <button onClick={restart}>restart</button>
    </div>
  );
}

describe("OnboardingContext", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it("provides onboarding state to consumers", () => {
    render(
      <OnboardingProvider>
        <Probe />
      </OnboardingProvider>
    );
    expect(screen.getByTestId("active")).toHaveTextContent("true");
    expect(screen.getByTestId("step")).toHaveTextContent("1");
  });

  it("advance updates shared step", () => {
    render(
      <OnboardingProvider>
        <Probe />
      </OnboardingProvider>
    );
    fireEvent.click(screen.getByText("advance"));
    expect(screen.getByTestId("step")).toHaveTextContent("2");
  });

  it("restart reactivates after completion", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    render(
      <OnboardingProvider>
        <Probe />
      </OnboardingProvider>
    );
    expect(screen.getByTestId("active")).toHaveTextContent("false");
    fireEvent.click(screen.getByText("restart"));
    expect(screen.getByTestId("active")).toHaveTextContent("true");
    expect(screen.getByTestId("step")).toHaveTextContent("1");
  });

  it("throws when used outside provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow();
    spy.mockRestore();
  });
});
