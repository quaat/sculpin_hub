# Sculpin Knowledge Hub UI design specification

## Status and source material

This specification defines the foundation visual direction for **Sculpin Knowledge Hub**. The original product mockup is not present in this repository; do not fabricate or generate a replacement binary. If the approved original becomes available, store it at `docs/assets/sculpin-knowledge-hub-mockup.png`, add it to this section, and reconcile—not silently override—this accessible specification.

## Visual language

The interface is a clean, professional SaaS experience with a predominantly white background, subtle lavender and violet accents, dark navy typography, spacious composition, rounded cards, restrained shadows, and quiet borders. Decoration must never reduce readability or obscure system state. Motion is optional and must respect reduced-motion preferences.

## Public information architecture and content

The public header provides **Products**, **Agents**, **Pricing**, and **Documentation** navigation. The landing hero explains managed access to Sculpin products and agents without claiming that unfinished functionality works. Product and agent cards show the intended catalog hierarchy and are explicitly labeled as presentation previews until backed by production records.

Benefit summaries cover security, transparent plan limits, usage visibility, team-ready ownership, compliance, and operational confidence. Free and Professional plan previews demonstrate hierarchy without presenting unapproved prices or working checkout. Pages must never imply that a visitor is authenticated or subscribed.

## Responsive behavior

Desktop layouts use a centered content width, generous whitespace, two- or three-column card grids, and visible primary navigation. Tablet grids reduce columns. Mobile uses one-column cards, wrapped or horizontally usable navigation, full-width calls to action, comfortable touch targets, and no horizontal page overflow. Information order and meaning remain equivalent at every viewport.

## Accessibility target

WCAG 2.2 AA is the target. Use landmarks and semantic headings, one descriptive `h1` per page, keyboard-visible focus, a skip link, labelled navigation, sufficient text/control contrast, descriptive link text, disabled-state explanations, reduced-motion support, and non-color status cues. Test keyboard navigation and automated semantic basics; complete manual screen-reader and contrast review before production launch.

## Content safety

Never put bearer tokens, provider credentials, prompts, completions, payment data, or internal upstream configuration in browser telemetry. Clearly distinguish demonstration content from persisted catalog data. Do not add fake OAuth, checkout, subscription, or token-management interactions.
