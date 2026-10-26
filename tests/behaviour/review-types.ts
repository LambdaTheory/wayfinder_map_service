// Review annotations are not Driver evidence. Type-only imports keep the two contracts independent.
export interface Review {
  itemId: string;
  status: 'holds' | 'violated' | 'undecided';
  reason: string;
  by: string;
  role: 'review' | 'arbitration' | 'human';
  readingId?: string;
  roundId?: string;
  evidence?: string[];
  /** A quotation and item-specific explanation for each cited source; bare locator padding is not evidence. */
  support?: { location: string; quote: string; explanation: string }[];
  /** Keep the original answer, including violation claims, even when it is not a valid reading. */
  rejected?: string;
  /** All earlier review IDs considered by this arbitration, including rejected claims. */
  basedOn?: string[];
}

export interface ReviewSummary {
  schema: 'wayfinder-model-review/1';
  roundId: string;
  evidenceHash: string;
  path: string;
  reviews: Review[];
  /** Includes probes, rejected outputs and native IDs from every invocation. */
  responseIds?: string[];
  pending: { itemId: string; reason: string; next: 'human' | 'retry' }[];
}
