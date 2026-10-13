export type NavLink = {
  label: string;
  href: string;
};

export type NavGroup = {
  label: string;
  links: NavLink[];
};

export type NavConfig = {
  primary: NavLink[];
  groups: NavGroup[];
};

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
      links: [
        { label: "Review Queue", href: "/admin/review-queue" },
        { label: "Control Library", href: "/admin/controls" },
      ],
    },
  ],
};
