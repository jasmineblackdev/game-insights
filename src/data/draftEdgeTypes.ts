import type { League } from "@/data/mockGames";

export type DraftEdgeCardKind =
  | "exact_pick"
  | "position_ou"
  | "round_yes_no"
  | "team_position"
  | "position_first";

/** Rich draft prediction card (mirrors `draft_predictions` / API). NFL · NBA · MLB · soccer window. */
export interface DraftEdgeCard {
  id: string;
  kind: DraftEdgeCardKind;
  league: League;
  year: number;
  player_id: string;
  player_name: string;
  position: string;
  college: string;
  confidence: "HIGH" | "MED" | "LOW";
  grade: string;
  tier?: string;
  reason_1: string;
  reason_2: string;
  risk_factor: string;
  updated_at?: string;
  /** Filter tags from model (mock or DB). */
  tags: string[];
  pick_number?: number;
  predicted_team?: string;
  predicted_team_abbr?: string;
  /** 0–100 */
  probability?: number;
  prob_low?: number;
  prob_high?: number;
  ou_line?: number;
  ou_prediction?: "OVER" | "UNDER";
  projected_pick?: number;
  round_prediction?: "yes" | "no";
  /** For team_position: e.g. DAL */
  team_target_abbr?: string;
  team_need_position?: string;
  first_position_label?: string;
  /** Narrative for “Big movers” filter */
  mover_note?: string;
}

export type DraftEdgeFilterId =
  | "all"
  | "top10"
  | "round1"
  | "position_props"
  | "team_needs"
  | "high_confidence"
  | "big_movers";
