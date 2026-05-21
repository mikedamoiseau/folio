import { useParams } from "react-router-dom";
import ReaderPane from "../components/ReaderPane";

interface ReaderProps {
  onOpenSettings: () => void;
  settingsOpen?: boolean;
}

/**
 * Reader screen — layout shell that mounts the per-book reading view.
 *
 * Today it hosts exactly one [`ReaderPane`]; the upcoming split-view
 * work (ROADMAP #40) will let it host two side-by-side. Global UI
 * (settings panel, focus mode, shortcut help) currently lives inside
 * the pane and will migrate up to this shell as that feature lands.
 */
export default function Reader({ onOpenSettings, settingsOpen = false }: ReaderProps) {
  const { bookId } = useParams<{ bookId: string }>();
  if (!bookId) return null;
  return (
    <ReaderPane
      bookId={bookId}
      onOpenSettings={onOpenSettings}
      settingsOpen={settingsOpen}
    />
  );
}
