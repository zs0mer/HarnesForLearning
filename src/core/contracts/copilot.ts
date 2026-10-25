/** Safe desktop status. Device codes are transient; bearer credentials never reach the renderer. */
export interface CopilotStatus {
  available: boolean;
  connected: boolean;
  pending: boolean;
  revision: number;
  modelIds: string[];
  device: { userCode: string; verificationUri: string } | null;
  error: string | null;
}
export interface CopilotControlBridge {
  status(): Promise<CopilotStatus>;
  login(consent: boolean): Promise<CopilotStatus>;
  cancel(): Promise<CopilotStatus>;
  disconnect(): Promise<CopilotStatus>;
  open(): Promise<CopilotStatus>;
  onChange(callback: () => void): () => void;
}