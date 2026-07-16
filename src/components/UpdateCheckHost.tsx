import { useOnboardingContext } from "../context/OnboardingContext";
import { useUpdateCheck } from "../hooks/useUpdateCheck";
import UpdateModal from "./UpdateModal";

/**
 * Hosts the update-check hook + modal at the app-shell level so it survives
 * route changes. Rendered only past the profile lock gate, so the hook never
 * runs while the profile is locked. The hard invariant (never stack over the
 * onboarding focus trap) is enforced in the hook; `deferWhilePresent` is a
 * best-effort courtesy that holds the modal while a common app-shell overlay
 * is open (it does not claim to cover every Library-owned dialog).
 */
export default function UpdateCheckHost({ deferWhilePresent }: { deferWhilePresent: boolean }) {
  const { isActive: onboardingActive } = useOnboardingContext();
  const { modal, close } = useUpdateCheck(onboardingActive);
  if (!modal || deferWhilePresent) return null; // held; shows once the overlay closes
  return <UpdateModal state={modal} onClose={close} />;
}
