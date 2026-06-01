import { createContext, useContext, type ReactNode } from "react";
import { useOnboarding, type UseOnboarding } from "../hooks/useOnboarding";

const OnboardingContext = createContext<UseOnboarding | null>(null);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const value = useOnboarding();
  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboardingContext(): UseOnboarding {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error("useOnboardingContext must be used within OnboardingProvider");
  return ctx;
}
