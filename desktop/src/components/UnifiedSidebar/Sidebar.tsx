import { memo } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button, useMediaQuery } from '@librechat/client';
import type { NavLink } from '~/common';
import { isRtlElement } from '~/hooks/Nav/useDirection';
import SidePanelNav from '~/components/SidePanel/Nav';
import ExpandedPanel from './ExpandedPanel';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

function Sidebar({
  links,
  expanded,
  width,
  minWidth,
  maxWidth,
  onCollapse,
  onExpand,
  onLeaveInsights,
  switchToHistory,
  focusWorkspace = false,
  focusWorkspaceTitle,
  onReturnToChat,
  onResizeStart,
  onResizeKeyboard,
}: {
  links: NavLink[];
  expanded: boolean;
  width: number;
  minWidth: number;
  maxWidth: number;
  onCollapse: () => void;
  onExpand: () => void;
  onLeaveInsights: () => void;
  switchToHistory: boolean;
  focusWorkspace?: boolean;
  focusWorkspaceTitle?: string;
  onReturnToChat?: () => void;
  onResizeStart: (e: React.MouseEvent<HTMLElement>) => void;
  onResizeKeyboard: (direction: 'shrink' | 'grow') => void;
}) {
  const localize = useLocalize();
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  let transition = 'none';
  if (!prefersReducedMotion) {
    transition = expanded ? 'opacity 160ms ease' : 'opacity 150ms ease';
  }
  return (
    <>
      <div className="flex h-full w-full overflow-hidden">
        <ExpandedPanel
          links={links}
          expanded={expanded}
          onCollapse={onCollapse}
          onExpand={onExpand}
          onLeaveInsights={onLeaveInsights}
          switchToHistory={switchToHistory}
        />
        {focusWorkspace ? (
          <section className="bg-surface-primary min-w-0 flex-1 overflow-hidden">
            <div
              data-testid="configuration-workspace-frame"
              className="mx-auto flex h-full w-full max-w-[88rem] flex-col"
            >
              <header className="border-border-light flex min-h-16 items-center justify-between gap-6 border-b px-8 py-4">
                <div className="min-w-0">
                  <p className="text-text-secondary text-xs font-medium tracking-wide uppercase">
                    {localize('com_ui_configuration_workspace')}
                  </p>
                  <h1 className="text-text-primary mt-1 truncate text-lg font-semibold">
                    {focusWorkspaceTitle ?? localize('com_nav_control_panel')}
                  </h1>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-2"
                  onClick={onReturnToChat}
                >
                  <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden="true" />
                  {localize('com_ui_back_to_chat')}
                </Button>
              </header>
              <div
                data-testid="configuration-workspace-content"
                className="min-h-0 flex-1 px-8 py-6"
              >
                <SidePanelNav links={links} />
              </div>
            </div>
          </section>
        ) : (
          <nav
            className={cn(
              'border-border-light bg-surface-sidebar min-h-0 flex-1 overflow-hidden border-e',
              expanded ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
            style={{ transition }}
            aria-hidden={!expanded}
          >
            <SidePanelNav links={links} />
          </nav>
        )}
      </div>
      {!focusWorkspace && (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- This adjustable separator supports pointer and keyboard resizing.
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={localize('com_ui_resize_sidebar')}
          aria-valuenow={Math.round(width)}
          aria-valuemin={Math.round(minWidth)}
          aria-valuemax={Math.round(maxWidth)}
          tabIndex={expanded ? 0 : -1}
          className={cn(
            'hover:bg-border-medium active:bg-border-heavy absolute inset-e-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors',
            expanded ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          style={{ transition }}
          onMouseDown={onResizeStart}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
              return;
            }
            /** The handle sits on the inline-end edge, so the arrow pointing away from the
             *  sidebar grows it: right in LTR, left in RTL. */
            const towardEnd = (e.key === 'ArrowRight') !== isRtlElement(e.currentTarget);
            onResizeKeyboard(towardEnd ? 'grow' : 'shrink');
          }}
        />
      )}
    </>
  );
}

export default memo(Sidebar);
