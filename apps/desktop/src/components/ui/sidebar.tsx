import * as React from "react";

import { cn } from "@/lib/utils";
import { translate } from "@/i18n/context";

type SidebarProps = React.ComponentProps<"aside"> & {
  collapsed?: boolean;
};

function Sidebar({ className, collapsed = false, ...props }: SidebarProps) {
  return (
    <aside
      data-collapsed={collapsed}
      data-slot="sidebar"
      className={cn(
        "group/sidebar flex h-full min-h-0 w-[150px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-linear data-[collapsed=true]:w-[4.25rem]",
        className,
      )}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      /* 46px. 네 열의 헤더 밴드가 같은 높이여야 가로선이 화면을 가로지릅니다(DESIGN.md). */
      className={cn(
        "flex h-[46px] items-center border-b border-sidebar-border px-3 group-data-[collapsed=true]/sidebar:px-2",
        className,
      )}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      data-slot="sidebar-content"
      aria-label={translate("주요 탐색")}
      className={cn("min-h-0 flex-1 overflow-y-auto px-2 py-3 group-data-[collapsed=true]/sidebar:px-2", className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn("border-t border-sidebar-border p-2 group-data-[collapsed=true]/sidebar:px-2", className)}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-group" className={cn("mb-4", className)} {...props} />;
}

function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="sidebar-group-label"
      className={cn(
        "px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground group-data-[collapsed=true]/sidebar:hidden",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul data-slot="sidebar-menu" className={cn("grid gap-1", className)} {...props} />;
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-item" className={className} {...props} />;
}

function SidebarMenuButton({
  active = false,
  className,
  ...props
}: React.ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      data-slot="sidebar-menu-button"
      data-active={active || undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        // hover와 선택이 같은 배경·같은 글자색이면 레일이 «어디에 있나»에 답하지 못합니다
        // (DESIGN.md 4열 셸). 포인터는 누르고 나면 늘 레일 위에 남으므로 예외가 아니라 기본
        // 상황입니다. 위계는 크기가 아니라 무게와 색으로 만듭니다 — hover는 한 단계 낮추고
        // 선택만 글자 무게를 올립니다.
        "flex h-[27px] w-full items-center gap-2 rounded-[5px] px-2.5 text-left text-[13px] text-secondary outline-none transition-colors hover:bg-surface-1 hover:text-primary data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-foreground group-data-[collapsed=true]/sidebar:justify-center group-data-[collapsed=true]/sidebar:px-0 group-data-[collapsed=true]/sidebar:[&>span:not(.sr-only)]:hidden",
        className,
      )}
      type="button"
      {...props}
    />
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
};
