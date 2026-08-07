import { useEffect } from "react";

interface GlobalCommandHandlers {
  disabled?: boolean;
  queryDisabled?: boolean;
  onSearch: () => void;
  onSort: () => void;
  onOperations: () => void;
  onQuery: () => void;
}

function isEditingArea(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(
    'input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])',
  ));
}

/** Keep the CLI command grammar available anywhere in the active Zeus page. */
export function useGlobalCommands({
  disabled = false,
  queryDisabled = false,
  onSearch,
  onSort,
  onOperations,
  onQuery,
}: GlobalCommandHandlers) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        disabled
        || event.defaultPrevented
        || event.isComposing
        || event.repeat
        || event.altKey
        || event.metaKey
        || isEditingArea(event.target)
      ) return;

      const key = event.key.toLowerCase();
      if (event.ctrlKey) {
        if (key === "f") {
          event.preventDefault();
          onSearch();
        }
        return;
      }

      if (key === "s") onSort();
      else if (key === "m") onOperations();
      else if (key === "r" && !queryDisabled) onQuery();
      else return;
      event.preventDefault();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [disabled, onOperations, onQuery, onSearch, onSort, queryDisabled]);
}
