/**
 * Statutory documents for TASK CASH PRO LIMITED, shown behind the "KRA" button.
 *
 * These are the same scans the production application serves, copied verbatim
 * into `public/documents/` so the prototype shows real company paperwork rather
 * than a placeholder. They are static files, so what a visitor sees cannot drift
 * from what was supplied.
 *
 * Worth knowing when these are next reviewed: both are Registrar of Companies
 * filings — the certificate is issued by the Registrar, and the second is a
 * Registrar of Companies letter under the Companies Act — which is a different
 * authority from the Kenya Revenue Authority. "KRA" is the label that was asked
 * for and is left alone on the button; the panel names each document properly.
 */

export type ComplianceDocument = {
  /** Site-local path, served straight from `public/`. */
  file: string;
  /** Shown under the scan and used as the link text for the full-size copy. */
  title: string;
  /** The image's alt text — the document's own identity, not a slogan. */
  alt: string;
  /** One line of context, so a viewer knows what they are looking at. */
  note: string;
};

export const COMPLIANCE_DOCUMENTS: ComplianceDocument[] = [
  {
    file: "/documents/certificate-of-incorporation.jpeg",
    title: "Certificate of Incorporation · No. PVT-PQ3120LO",
    alt:
      "Certificate of Incorporation from the Registrar of Companies, certifying that " +
      "TASK CASH PRO LIMITED, number PVT-PQ3120LO, was incorporated as a private limited " +
      "company on 12 August 2024 under the Companies Act, 2020.",
    note: "Issued by the Registrar of Companies. Confirms the company's legal existence and name.",
  },
  {
    file: "/documents/registrar-directors-shareholders.jpeg",
    title: "Directors and shareholders · No. PVT-3QUBBY7",
    alt:
      "Letter from the Registrar of Companies dated 12 July 2020 setting out the directors and " +
      "shareholders of TASK CASH PRO LIMITED, with a total of 3,000 ordinary shares, and the " +
      "registered office at Nairobi City Centre, Harambe Avenue, P.O. Box 53870, Nairobi.",
    note: "Issued by the Registrar of Companies. States the company's share capital and registered office.",
  },
];
