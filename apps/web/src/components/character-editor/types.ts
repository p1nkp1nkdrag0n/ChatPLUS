import type { ProvenanceRule } from "../../api/types";

export interface SelectedField {
  path: string;
  label: string;
  provenance?: Partial<ProvenanceRule>;
  excerpt?: string;
}
