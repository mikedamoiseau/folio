import { useState, useCallback } from "react";

const STORAGE_KEY = "folio-onboarding-complete";

type Step = 1 | 2 | 3;

export interface UseOnboarding {
  isActive: boolean;
  currentStep: Step;
  advance: () => void;
  skip: () => void;
  complete: () => void;
}

export function useOnboarding(): UseOnboarding {
  const [isActive, setIsActive] = useState(
    () => localStorage.getItem(STORAGE_KEY) !== "true"
  );
  const [currentStep, setCurrentStep] = useState<Step>(1);

  const dismiss = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, "true");
    setIsActive(false);
  }, []);

  const advance = useCallback(() => {
    setCurrentStep((s) => (s < 3 ? ((s + 1) as Step) : s));
  }, []);

  return { isActive, currentStep, advance, skip: dismiss, complete: dismiss };
}
