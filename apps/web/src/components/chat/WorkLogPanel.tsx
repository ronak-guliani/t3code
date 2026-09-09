import { useState, type ReactNode } from "react";
import { CollapsibleContent } from "../ui/collapsible";

/** Keep visited, bounded history warm until its virtual timeline row unmounts. */
export function WorkLogPanel({ open, children }: { open: boolean; children: ReactNode }) {
  const [body, setBody] = useState<ReactNode>(open ? children : null);
  // Freeze hidden props so streaming does not keep rebuilding collapsed output.
  if (open && body !== children) setBody(children);
  return (
    <CollapsibleContent keepMounted={body !== null} className="chat-work-panel">
      {body !== null ? <div className="chat-work-panel-body">{body}</div> : null}
    </CollapsibleContent>
  );
}
