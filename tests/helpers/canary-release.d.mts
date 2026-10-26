export interface CanaryContract {
  version: string;
  markdown: string;
  instructions: string;
  toolDescriptions: Record<string, string>;
  prompt: string;
}
export const canaryVersion: string;
export const replyRule: string;
export const ticketRule: string;
export function canaryContract(contract: CanaryContract): CanaryContract;
export function writeCanaryCheckout(checkout: string, target: string): Promise<{ before: CanaryContract; after: CanaryContract }>;
