import { ReactNode } from 'react';

interface HoverTooltipProps {
  content: string;
  children: ReactNode;
  className?: string;
  triggerClassName?: string;
  tooltipClassName?: string;
}

export default function HoverTooltip({
  content,
  children,
  className = '',
  triggerClassName = '',
  tooltipClassName = '',
}: HoverTooltipProps) {
  return (
    <div className={`relative inline-block group/hover-tooltip ${className}`}>
      <div
        tabIndex={0}
        className={`focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 rounded ${triggerClassName}`}
      >
        {children}
      </div>
      <div
        role="tooltip"
        className={`pointer-events-none absolute left-1/2 top-full z-[60] mt-2 w-72 max-w-[calc(100vw-2rem)] -translate-x-1/2 translate-y-1 rounded-lg border border-zinc-200/90 bg-white/95 px-3 py-2 text-xs leading-relaxed text-zinc-700 shadow-lg opacity-0 transition-all duration-150 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 group-hover/hover-tooltip:translate-y-0 group-hover/hover-tooltip:opacity-100 group-focus-within/hover-tooltip:translate-y-0 group-focus-within/hover-tooltip:opacity-100 ${tooltipClassName}`}
      >
        {content}
      </div>
    </div>
  );
}
