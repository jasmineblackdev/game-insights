/**
 * /builder — Single advanced-use Build surface.
 *
 * Phase 1 of the consolidation: the Plan / Build / Recommended tab
 * structure is gone. Today's Decision lives on Home; parlay history
 * lives in Paper. Builder is now an "advanced use only" surface that
 * renders the inline parlay builder via Index's parlay_builder
 * viewMode.
 *
 * Kept as a separate page-level component (rather than just routing
 * /builder → Index) so future Builder-only chrome (e.g. an Advanced
 * Settings disclosure) has a place to live.
 */

import Index from "./Index";

export default function BuilderPage() {
  return <Index defaultView="parlay_builder" />;
}
