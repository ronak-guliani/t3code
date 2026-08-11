import DiffPanel from "./DiffPanel";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function RightPanelDiff() {
  return (
    <DiffWorkerPoolProvider>
      <DiffPanel mode="sheet" />
    </DiffWorkerPoolProvider>
  );
}
