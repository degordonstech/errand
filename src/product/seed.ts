import type { RegisterEntry } from "./greenbook.js";

/**
 * Real Greenbook entries fetched from greenbook.nafdac.gov.ng on 26 October 2026.
 * Used only when the live register cannot be reached and nothing is cached, so a check
 * still works when the government site is down. Answers from here say so.
 */
export const SEED_ENTRIES: Record<string, RegisterEntry[]> = {
  "04-2467": [
    {
      nafdacNo: "04-2467",
      productName: "Zentel Suspension",
      ingredient: "Albendazole",
      strength: "100 mg/5 mL",
      form: "Suspension",
      category: "Drugs",
      applicant: "GlaxoSmithKline Consumer Nigeria PLC (GSK)",
      status: "Active",
      approvalDate: "2023-07-06",
      registrationExpires: "2028-07-05",
    },
  ],
  "03-6514": [
    {
      nafdacNo: "03-6514",
      productName: "Accu-Chek Instant Wireless Blood Glucose Monitoring System",
      ingredient: "Blood Glucose Mointors",
      strength: "NA",
      form: "NA",
      category: "Medical devices",
      applicant: "Roche Products Limited",
      status: "Active",
      approvalDate: "2024-02-29",
      registrationExpires: "2029-02-27",
    },
  ],
};
