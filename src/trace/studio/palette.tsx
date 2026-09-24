/**
 * Command palette.
 *
 * Built on cmdk rather than hand-rolled: filtering, roving focus, the
 * arrow/Enter/Escape contract, and the ARIA combobox wiring are a day's work to
 * get right and a permanent liability to get wrong. The dialog itself is a
 * native <dialog>, so focus trapping, inertness of the page behind it, and
 * Escape-to-close come from the platform.
 *
 * Deliberately not animated on open beyond a 180ms scale: this is invoked
 * dozens of times a day, and anything slower reads as lag.
 */

import * as React from "react";
import { Command } from "cmdk";

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

export function CommandPalette({ open, actions, onClose }: {
  open: boolean;
  actions: PaletteAction[];
  onClose: () => void;
}) {
  const dialogRef = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className="palette-backdrop"
      onClose={onClose}
      onClick={e => { if (e.target === dialogRef.current) onClose(); }}
      aria-label="Command palette"
    >
      <div className="palette" onClick={e => e.stopPropagation()}>
        <Command loop>
          <Command.Input autoFocus placeholder="Type a command…" />
          <Command.List>
            <Command.Empty>No matching command.</Command.Empty>
            {actions.map(action => (
              <Command.Item
                key={action.id}
                value={`${action.label} ${action.keywords ?? ""}`}
                onSelect={() => { onClose(); action.run(); }}
              >
                <span>{action.label}</span>
                {action.hint && <kbd>{action.hint}</kbd>}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </div>
    </dialog>
  );
}
