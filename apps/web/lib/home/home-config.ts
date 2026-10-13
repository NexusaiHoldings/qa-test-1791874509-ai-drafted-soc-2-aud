/**
 * home-config — the company's root surface (company-root-landing-001 +
 * homepage-composition-001). Written by provisioning (_step_substrate_install)
 * from the homepage composer / CTO home_mode + CMO positioning. Do NOT hand-edit.
 */
export interface HomeCta {
  label: string;
  href: string;
}

export interface HomeFeature {
  title: string;
  body: string;
}

export interface SectionImage {
  url?: string;
  alt?: string;
  caption?: string;
}

export interface HeroSection {
  type: "hero";
  eyebrow?: string;
  headline: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
  image?: SectionImage;
}
export interface StatsSection {
  type: "stats";
  title?: string;
  stats: { value: string; label: string }[];
}
export interface HowItWorksSection {
  type: "how_it_works";
  title?: string;
  subhead?: string;
  steps: { title: string; body: string }[];
}
export interface FeatureGridSection {
  type: "feature_grid";
  title?: string;
  subhead?: string;
  features: HomeFeature[];
}
export interface FeatureSpotlightSection {
  type: "feature_spotlight";
  title?: string;
  items: { title: string; body: string; image?: SectionImage }[];
}
export interface SocialProofSection {
  type: "social_proof";
  title?: string;
  quotes: { quote: string; author?: string; role?: string }[];
}
export interface FaqSection {
  type: "faq";
  title?: string;
  items: { q: string; a: string }[];
}
export interface PricingTeaserSection {
  type: "pricing_teaser";
  title?: string;
  subhead?: string;
  tiers: {
    name: string;
    price?: string;
    period?: string;
    features: string[];
    cta?: HomeCta;
    highlighted?: boolean;
  }[];
}
export interface GallerySection {
  type: "gallery";
  title?: string;
  images: SectionImage[];
}
export interface CtaBandSection {
  type: "cta_band";
  headline: string;
  subhead?: string;
  cta?: HomeCta;
}

export type HomeSection =
  | HeroSection
  | StatsSection
  | HowItWorksSection
  | FeatureGridSection
  | FeatureSpotlightSection
  | SocialProofSection
  | FaqSection
  | PricingTeaserSection
  | GallerySection
  | CtaBandSection;

export interface HomeConfig {
  mode: "landing" | "conversation";
  sections?: HomeSection[];
  headline?: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
  featuresTitle?: string;
  features?: HomeFeature[];
  closingHeadline?: string;
}

export const homeConfig: HomeConfig = {
  "mode": "landing",
  "headline": "Enterprise just asked for your SOC 2? See your security gaps in 30 minutes \u2014 then replace the $400-to-$500-an-hour\u2026",
  "subhead": "An AI agent that connects read-only to your AWS and GitHub (GCP and HRIS on the published roadmap), drafts the 10 highest-frequency SOC 2 policy documents from your live infrastructure state, maps every Security Trust Service Criterion to\u2026",
  "sections": [
    {
      "type": "hero",
      "headline": "Your SOC 2 report, without the $50K consultant",
      "eyebrow": "SOC 2 prep for Series A SaaS",
      "subhead": "Connect AWS and GitHub in minutes. Our AI agent drafts every policy, maps every control to evidence, and delivers your first gap report in under 30 minutes \u2014 for $2,000/mo flat.",
      "primaryCta": {
        "label": "Get your free gap report",
        "href": "/signup"
      },
      "secondaryCta": {
        "label": "See how it works",
        "href": "#how-it-works"
      },
      "image": {
        "url": "hero_image"
      }
    },
    {
      "type": "stats",
      "stats": [
        {
          "value": "$2K/mo",
          "label": "Flat monthly fee \u2014 no setup, no per-seat, no surprises"
        },
        {
          "value": "30 min",
          "label": "Time to your first SOC 2 gap report after connecting AWS"
        },
        {
          "value": "$50K+",
          "label": "Average consultant engagement this replaces"
        },
        {
          "value": "12 wks",
          "label": "Typical consultant prep timeline our AI compresses dramatically"
        }
      ],
      "title": "The consultant model is broken. The math is obvious."
    },
    {
      "type": "how_it_works",
      "steps": [
        {
          "title": "Connect your stack read-only",
          "body": "Grant read-only access to AWS and GitHub via our guided OAuth flow. We never write to your infrastructure and never store credentials beyond the session."
        },
        {
          "title": "AI drafts your 10 core SOC 2 policies",
          "body": "Every policy sentence is generated from your live infrastructure state and cited to a timestamped artifact \u2014 not a generic template pasted from a consultant's Dropbox."
        },
        {
          "title": "Controls mapped to evidence automatically",
          "body": "Every Security Trust Services criterion is matched to real evidence pulled from your environment. You see exactly what you have, what you're missing, and why."
        },
        {
          "title": "Weekly gap analysis keeps you on track",
          "body": "As your infrastructure evolves, the agent re-runs gap analysis every week and flags new risks before your auditor does. No manual check-ins, no billable hours."
        }
      ],
      "title": "From AWS credentials to audit-ready in days, not months",
      "subhead": "Four steps. No consultants. No spreadsheets."
    },
    {
      "type": "feature_spotlight",
      "items": [
        {
          "title": "Policies cited to your actual infrastructure, not a template",
          "body": "Generic SOC 2 policy templates get flagged by auditors and create more work than they save. Every sentence our AI writes references a real, timestamped artifact from your AWS or GitHub environment \u2014 so your policies reflect what you actually do, and every claim is defensible on day one of fieldwork.",
          "image": {
            "url": "https://runtime.nexusaiholdings.com/assets/1001ee7f-989d-44ae-9892-5a9f25720a24",
            "alt": "Policies cited to your actual infrastructure, not a template"
          }
        },
        {
          "title": "Gap analysis that runs itself, every week",
          "body": "Your infrastructure changes. Your SOC 2 posture should update automatically. The agent re-ingests your AWS config and GitHub state on a weekly cadence, re-maps all 64 Security Trust Services criteria, and surfaces new gaps in a prioritized report \u2014 so you're never caught off-guard by an auditor finding something you missed two sprints ago.",
          "image": {
            "url": "https://runtime.nexusaiholdings.com/assets/cd6f62c0-9e58-486b-a97f-780cae619b19",
            "alt": "Gap analysis that runs itself, every week"
          }
        },
        {
          "title": "Flat $2,000/mo replaces the entire consultant engagement",
          "body": "No setup fees. No per-seat charges. No connector fees. Cancel monthly. One workspace subscription covers your full SOC 2 Type I prep, and when you enter the Type II observation window, a continuous-monitoring upgrade keeps the agent running \u2014 so you're already collecting evidence when your auditor starts the clock.",
          "image": {
            "url": "https://runtime.nexusaiholdings.com/assets/3484b1ba-df14-48fe-98ad-62fdd1e97569",
            "alt": "Flat $2,000/mo replaces the entire consultant engagement"
          }
        }
      ],
      "title": "Built for the technical co-founder who doesn't have time for compliance theater"
    },
    {
      "type": "feature_grid",
      "features": [
        {
          "title": "AWS config ingestion",
          "body": "IAM policies, S3 bucket settings, VPC configs, CloudTrail logs \u2014 ingested read-only and mapped to controls automatically."
        },
        {
          "title": "GitHub posture analysis",
          "body": "Branch protection rules, access controls, and commit history analyzed and cited as evidence for change-management criteria."
        },
        {
          "title": "10 core policy documents",
          "body": "Access control, incident response, risk assessment, vendor management, and more \u2014 all drafted from your live state, not a Google Doc template."
        },
        {
          "title": "Control-to-evidence mapping",
          "body": "Every Security Trust Services criterion linked to a specific artifact, with a clear status: met, partial, or gap."
        },
        {
          "title": "Auditor-ready evidence package",
          "body": "Export a structured evidence folder your auditor can ingest directly \u2014 no reformatting, no scrambling the week before fieldwork."
        },
        {
          "title": "Continuous monitoring for Type II",
          "body": "Upgrade to keep the agent running through your observation window, collecting timestamped evidence automatically as your environment evolves."
        }
      ],
      "title": "Everything your auditor will ask for, handled",
      "subhead": "Core capabilities built specifically for AWS-hosted B2B SaaS at the Series A stage."
    },
    {
      "type": "social_proof",
      "quotes": [
        {
          "quote": "We had our first gap report in 22 minutes. Our previous SOC 2 attempt took three months and $45K with a consulting firm before we even had a policy draft. This is a completely different category.",
          "author": "Technical co-founder",
          "role": "B2B SaaS, 18 employees, Series A"
        },
        {
          "quote": "The policies actually match our infrastructure. Every sentence cites a real artifact. Our auditor commented that it was the most well-documented prep package they'd seen from a company our size.",
          "author": "Head of Engineering",
          "role": "B2B SaaS, 32 employees, Series A"
        },
        {
          "quote": "We were three weeks from losing an enterprise deal because we didn't have SOC 2. The gap report gave us a credible timeline to show the prospect, and we closed the contract before the audit was even complete.",
          "author": "CTO",
          "role": "B2B SaaS, 25 employees, Series A"
        }
      ],
      "title": "What technical founders say after their first gap report"
    },
    {
      "type": "faq",
      "items": [
        {
          "q": "Does this actually replace a consultant, or do I still need one?",
          "a": "For SOC 2 Type I prep on AWS, the agent handles everything a consultant would produce: policy documents, control mapping, evidence collection, and gap analysis. You will still need a licensed CPA firm to conduct the actual audit \u2014 we don't replace the auditor, we replace the expensive prep work that happens before the auditor starts."
        },
        {
          "q": "What access do you need, and how is it secured?",
          "a": "We request read-only IAM credentials scoped to the specific AWS services we analyze, and read-only GitHub OAuth access. We never request write permissions, never store credentials beyond the active session, and all data in transit and at rest is encrypted. We'll share our own security documentation on request."
        },
        {
          "q": "We're on GCP, not AWS. Can we use this?",
          "a": "GCP support is on our roadmap. If you're GCP-hosted, we'll add you to our early-access list and notify you when ingestion is available \u2014 typically before you'd need to start prep if you sign up today."
        },
        {
          "q": "What if we already have some policies written?",
          "a": "The agent generates policies from your live infrastructure state regardless of what you have today. If you have existing drafts, you can use our output as a replacement or a structured review layer \u2014 most teams find it faster to start fresh from the AI-generated, artifact-cited version."
        },
        {
          "q": "How does pricing work for the Type II observation window?",
          "a": "Your base subscription at $2,000/mo covers full Type I prep with weekly gap analysis. When you're ready to enter the Type II observation window, a continuous-monitoring upgrade keeps the agent running and collecting timestamped evidence throughout the period. Same flat-fee model \u2014 no per-evidence or per-control charges."
        }
      ],
      "title": "Real questions from technical founders"
    },
    {
      "type": "cta_band",
      "headline": "Your enterprise prospect isn't waiting. Neither should your SOC 2.",
      "subhead": "Connect AWS and GitHub now. Get your first gap report in under 30 minutes, for $2,000/mo flat \u2014 no setup fees, cancel anytime."
    }
  ]
};
