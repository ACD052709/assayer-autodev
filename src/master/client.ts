export interface MasterModelRequest {
  readonly systemPrompt: string;
  readonly userPayload: unknown;
}

export interface MasterModelCallResult {
  readonly output: unknown;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface MasterModelClient {
  complete(request: MasterModelRequest): Promise<MasterModelCallResult>;
}

export class FakeMasterModelClient implements MasterModelClient {
  readonly calls: MasterModelRequest[] = [];
  private callCount = 0;

  constructor(
    private readonly handler: (
      request: MasterModelRequest,
      callIndex: number,
    ) => MasterModelCallResult | Promise<MasterModelCallResult>,
  ) {}

  async complete(request: MasterModelRequest): Promise<MasterModelCallResult> {
    this.calls.push(request);
    const index = this.callCount;
    this.callCount += 1;
    return this.handler(request, index);
  }
}
