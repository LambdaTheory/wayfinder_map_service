export function acceptsLocalChatGptToken(servicePort: number, token: string): Promise<boolean>;
export function probeLocalChatGptService(servicePort: number, token: string): Promise<{ accepted: boolean; version: string | undefined }>;
