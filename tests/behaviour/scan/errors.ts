// Public diagnostics contain only fixed text, never filesystem paths or source values.
const messages = {
  usage: 'usage: scan/cli.ts --input <manifest.json> --out <fresh-private-directory> [--state <previous/state.json>] [--reviews <reviews.json>]',
  node: 'Scan requires Node 26.3.0',
  output: 'Scan output must stay outside the repository',
  reviews: 'Invalid review file; check required fields and quote references',
  redaction: 'Output needs additional redaction',
};
export class ScanError extends Error {
  constructor(code: keyof typeof messages) { super(messages[code]); }
}
export function scanFailure(error: unknown): string {
  return error instanceof ScanError ? `Scan refused: ${error.message}`
    : 'Scan refused: check manifest, input permissions, review/state format and fresh private output path. No model was started.';
}
