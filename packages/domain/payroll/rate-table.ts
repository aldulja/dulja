// GENERATED FILE — do not edit by hand.
// Source: packages/domain/payroll/rate-table.schema.json ($id urn:dulja:rate-table:1)
// Regenerate: bun run --cwd packages/domain rate-table:types
export interface RateTable {
  schema_version: 1;
  scheme: string;
  version: number;
  kind: "banded_contribution" | "percentage_with_ceiling" | "progressive_schedule";
  effective_from: string;
  effective_to?: string | null;
  source: {
    authority: string;
    publication: string;
    url: string;
    retrieved_on: string;
    notes?: string;
  };
  verification?: {
    verified_by: string;
    verified_on: string;
    method: "accountant_sign_off" | "worked_examples" | "synthetic_test";
  };
  rounding_mode?: "HALF_AWAY_FROM_ZERO" | "HALF_EVEN" | "TOWARD_ZERO" | "AWAY_FROM_ZERO";
  required_profile_fields?: string[];
  table:
    | {
        /**
         * @minItems 1
         */
        bands: [
          {
            from: string;
            to: string | null;
            employee: string;
            employer: string;
          },
          ...{
            from: string;
            to: string | null;
            employee: string;
            employer: string;
          }[]
        ];
      }
    | {
        employee_rate: string;
        employer_rate: string;
        ceiling: string | null;
        floor?: string | null;
      }
    | {
        brackets: {
          from: string;
          to: string | null;
          rate: string;
          cumulative: string;
        }[];
        reliefs: {
          [k: string]: string;
        };
      };
}
