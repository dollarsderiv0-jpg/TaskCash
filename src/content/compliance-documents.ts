/**
 * Statutory documents for TASK CASH PRO LIMITED, shown behind the "KRA" button
 * on the signed-in dashboard.
 *
 * These are scans, not links to an external register, so they are served as
 * static files from `public/documents/` and listed here. That keeps the button
 * honest: what it shows is exactly what was supplied, and nothing about it can
 * silently change under a visitor because a third-party page was edited.
 *
 * The label on the button is "KRA" — the wording that was asked for. Worth
 * knowing when these are next reviewed: the two documents are Registrar of
 * Companies filings (the certificate is issued by the Registrar, and the second
 * is a Registrar of Companies letter under the Companies Act), which is a
 * different authority from the Kenya Revenue Authority. Renaming the button is
 * changing the label in `compliance-documents.tsx` and nothing else.
 *
 * Both are A4 portrait, so the dialog renders them at full width and stacks
 * them; a `title` is provided for each because it is the image's alt text, and a
 * document that fails to load must still say which document it is.
 */

export type ComplianceDocument = {
  /** Site-local path. Served straight from `public/`. */
  file: string;
  /** Shown under the scan, and used as the link text for the full-size copy. */
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
