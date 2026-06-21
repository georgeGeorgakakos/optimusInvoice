import { useEffect, useRef } from "react";
import { useLocation } from "wouter";

/**
 * Global keyboard shortcuts. Mount once in the authenticated shell.
 *
 *   g d → Dashboard      g i → Invoices       g a → Approvals
 *   g e → Extractions    g r → Learned rules  g k → Knowledge base
 *   g c → Configuration
 *   u   → Upload invoice
 *   ?   → Show shortcuts help (calls onShowHelp)
 *
 * ⌘K / Ctrl-K is handled by CommandPalette itself.
 *
 * Shortcuts are ignored while typing in an input, textarea, select, or any
 * contentEditable element, so they never interfere with form entry.
 */
export function useKeyboardShortcuts(opts?: { onShowHelp?: () => void }) {
  const [, setLocation] = useLocation();
  // Tracks whether the last key was the `g` prefix (for two-key chords).
  const pendingG = useRef(false);
  const gTimer = useRef<number | null>(null);

  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) => {
      const node = el as HTMLElement | null;
      if (!node) return false;
      const tag = node.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        node.isContentEditable
      );
    };

    const clearG = () => {
      pendingG.current = false;
      if (gTimer.current) {
        window.clearTimeout(gTimer.current);
        gTimer.current = null;
      }
    };

    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      const key = e.key.toLowerCase();

      // Two-key "g <x>" chords.
      if (pendingG.current) {
        const routes: Record<string, string> = {
          d: "/dashboard",
          i: "/invoices",
          a: "/approvals",
          e: "/extractions",
          r: "/rules",
          k: "/knowledge-base",
          c: "/configuration",
        };
        if (routes[key]) {
          e.preventDefault();
          setLocation(routes[key]);
        }
        clearG();
        return;
      }

      if (key === "g") {
        pendingG.current = true;
        gTimer.current = window.setTimeout(clearG, 1200);
        return;
      }

      // Single-key shortcuts.
      if (key === "u") {
        e.preventDefault();
        setLocation("/invoices/upload");
        return;
      }
      if (key === "?" || (key === "/" && e.shiftKey)) {
        e.preventDefault();
        opts?.onShowHelp?.();
        return;
      }
    };

    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      clearG();
    };
  }, [setLocation, opts]);
}

export const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["⌘", "K"], label: "Open command palette" },
  { keys: ["G", "D"], label: "Go to dashboard" },
  { keys: ["G", "I"], label: "Go to invoices" },
  { keys: ["G", "A"], label: "Go to approvals" },
  { keys: ["G", "E"], label: "Go to extractions" },
  { keys: ["G", "R"], label: "Go to learned rules" },
  { keys: ["G", "K"], label: "Go to knowledge base" },
  { keys: ["G", "C"], label: "Go to configuration" },
  { keys: ["U"], label: "Upload invoice" },
  { keys: ["?"], label: "Show this help" },
];
