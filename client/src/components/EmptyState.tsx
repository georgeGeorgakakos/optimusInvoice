import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import type { LucideIcon } from "lucide-react";

/**
 * Branded empty state. Use on any list/table when there's no data yet.
 *
 * <EmptyState
 *   icon={FileText}
 *   title="No invoices yet"
 *   description="Drop a PDF to start automating your accounts payable."
 *   actionLabel="Upload invoice"
 *   onAction={() => setLocation('/invoices/upload')}
 * />
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <Empty className="py-14">
      <EmptyHeader>
        <EmptyMedia
          variant="icon"
          className="text-white"
          style={{ backgroundImage: "linear-gradient(120deg,#22D3EE,#6366F1,#A855F7)" }}
        >
          <Icon className="h-6 w-6" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {(actionLabel || secondaryLabel) && (
        <EmptyContent>
          <div className="flex items-center justify-center gap-2">
            {actionLabel && (
              <Button
                onClick={onAction}
                className="border-0 text-white hover:brightness-110"
                style={{ backgroundImage: "linear-gradient(120deg,#22D3EE,#6366F1,#A855F7)" }}
              >
                {actionLabel}
              </Button>
            )}
            {secondaryLabel && (
              <Button variant="outline" onClick={onSecondary}>
                {secondaryLabel}
              </Button>
            )}
          </div>
        </EmptyContent>
      )}
    </Empty>
  );
}
