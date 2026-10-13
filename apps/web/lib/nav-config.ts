
/**
 * Navigation configuration consumed by the substrate's <TopNav />.
 *
 * Shape contract (substrate-owned): NAV_CONFIG is an object literal with
 * `primary` (flat list of top-level links) and `groups` (labelled dropdown
 * groups). Links whose href sits under /admin/* are flagged admin-only and
 * are filtered out of the public nav by the nav generator; we also mark
 * them explicitly via `adminOnly` so the intent is unambiguous.
 */

export interface NavLink {
  /** URL path the link points at (App Router path). */
  href: string;
  /** Human-readable label rendered in the nav strip. */
  label: string;
  /** When true, the link is restricted to admin users and hidden publicly. */
  adminOnly?: boolean;
}

export interface NavGroup {
  /** Dropdown / section label for this group of links. */
  label: string;
  /** Ordered links rendered inside the group. */
  links: NavLink[];
}

export interface NavConfig {
  /** Flat, always-visible top-level links. */
  primary: NavLink[];
  /** Labelled groups rendered as dropdowns after the primary links. */
  groups: NavGroup[];
}

export const NAV_CONFIG: NavConfig = {
  primary: [
    { href: "/", label: "Home" },
    { href: "/gaps", label: "Gap Analysis" },
    { href: "/policies", label: "Policies" },
    { href: "/controls", label: "Controls" },
    { href: "/connectors", label: "Connectors" },
  ],
  groups: [
    {
      label: "Evidence",
      links: [
        { href: "/evidence/upload", label: "Upload Evidence" },
        { href: "/package", label: "Audit Package" },
      ],
    },
    {
      label: "Try It",
      links: [{ href: "/gap-check", label: "Free Gap Check" }],
    },
    {
      label: "Admin",
      links: [
        {
          href: "/admin/review-queue",
          label: "Review Queue",
          adminOnly: true,
        },
        {
          href: "/admin/controls",
          label: "Control Library",
          adminOnly: true,
        },
      ],
    },
  ],
};
