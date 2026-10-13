/**
 * Navigation configuration consumed by the substrate's <TopNav /> strip.
 *
 * F1-001 — Homepage + Top Navigation.
 *
 * Shape contract (substrate-owned, do not change):
 *   - `primary` renders as the always-visible link strip.
 *   - `groups` render as dropdown sections beneath the strip.
 *   - Links (and groups) flagged `adminOnly` — and any href under
 *     `/admin/*` — are marked admin-only by the nav generator and are
 *     never rendered in the public nav.
 *
 * Every href below maps to a feature page in the mvp_scope.
 */

export interface NavLink {
  /** Visible label rendered in the top nav. */
  label: string;
  /** App Router href the link navigates to. */
  href: string;
  /** When true, the nav generator hides this link from the public nav. */
  adminOnly?: boolean;
}

export interface NavGroup {
  /** Dropdown/section label. */
  label: string;
  /** Links contained in this group. */
  links: NavLink[];
  /** When true, the entire group is hidden from the public nav. */
  adminOnly?: boolean;
}

export interface NavConfig {
  /** Always-visible primary links, rendered left to right. */
  primary: NavLink[];
  /** Grouped dropdown sections rendered after the primary links. */
  groups: NavGroup[];
}

export const NAV_CONFIG: NavConfig = {
  primary: [
    { label: "Home", href: "/" },
    { label: "Gap Analysis", href: "/gaps" },
    { label: "Policies", href: "/policies" },
    { label: "Controls", href: "/controls" },
    { label: "Connectors", href: "/connectors" },
  ],
  groups: [
    {
      label: "Evidence",
      links: [
        { label: "Upload Evidence", href: "/evidence/upload" },
        { label: "Audit Package", href: "/package" },
      ],
    },
    {
      label: "Try It",
      links: [{ label: "Free Gap Check", href: "/gap-check" }],
    },
    {
      label: "Admin",
      adminOnly: true,
      links: [
        {
          label: "Review Queue",
          href: "/admin/review-queue",
          adminOnly: true,
        },
        {
          label: "Control Library",
          href: "/admin/controls",
          adminOnly: true,
        },
      ],
    },
  ],
};
